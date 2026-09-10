import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  CapabilityArtifact,
  FieldContract,
  ReplayResult,
  Scalar,
  Step,
  ValueExpression,
} from "../artifact/schema.js";
import { parseCapabilityArtifact } from "../artifact/schema.js";
import type { HandoffHandler, HandoffResult } from "../handoff/types.js";
import { RunLogger } from "../observability/run-logger.js";
import { assertPolicy } from "../policy/engine.js";
import { parseExtracted } from "../replay/engine.js";
import type { SurfaceAdapter, SurfaceObservation } from "../surface/types.js";
import {
  assertCandidate,
  type DecisionContext,
  type DecisionProvider,
  type DiscoveryDecision,
} from "./decision.js";

export interface DiscoveryOptions {
  readonly goal: string;
  readonly target: string;
  readonly capability: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly appFamily: string;
    readonly supportedVariants: readonly string[];
  };
  readonly inputContracts: readonly FieldContract[];
  readonly outputContracts: readonly FieldContract[];
  readonly inputs: Readonly<Record<string, Scalar>>;
  readonly policy: CapabilityArtifact["policy"];
  readonly knownOutcomes: CapabilityArtifact["knownOutcomes"];
  readonly surface: SurfaceAdapter;
  readonly provider: DecisionProvider;
  readonly logger?: RunLogger;
  readonly handoff?: HandoffHandler;
  readonly maxSteps?: number;
  readonly timeoutMs?: number;
}

export type DiscoveryResult =
  | {
      readonly status: "success";
      readonly artifact: CapabilityArtifact;
      readonly outputs: Readonly<Record<string, Scalar>>;
      readonly runId: string;
    }
  | {
      readonly status: "business_outcome";
      readonly code: string;
      readonly runId: string;
    }
  | {
      readonly status: "stopped";
      readonly code: string;
      readonly message: string;
      readonly runId: string;
    };

export async function discoverCapability(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const maxSteps = options.maxSteps ?? 15;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  const sensitiveInputs = Object.fromEntries(
    options.inputContracts
      .filter(({ sensitive }) => sensitive)
      .flatMap(({ name }) =>
        options.inputs[name] === undefined ? [] : ([[name, options.inputs[name]]] as const),
      ),
  );
  const logger = options.logger ?? new RunLogger({ sensitiveValues: sensitiveInputs });
  const steps: Step[] = [];
  const outputs: Record<string, Scalar> = {};
  const history: DecisionContext["history"][number][] = [];
  const fingerprints: string[] = [];

  await logger.event("discovery.started", {
    goal: options.goal,
    target: options.target,
    inputs: options.inputs,
  });

  const navigateStep: Step = {
    id: "step-01-open-target",
    description: "Open the configured target application",
    action: {
      kind: "navigate",
      url: { source: "literal", value: options.target },
      risk: "safe",
    },
    preconditions: [],
    postconditions: [],
    timeoutMs: 10_000,
    retry: { maxAttempts: 2, backoffMs: 200 },
  };
  assertPolicy(navigateStep.action, options.policy, options.inputs);
  await options.surface.navigate(options.target);
  steps.push(navigateStep);

  try {
    for (let iteration = 0; iteration < maxSteps; iteration += 1) {
      if (Date.now() >= deadline) {
        return stopped("discovery_timeout", "Discovery exceeded its configured timeout", logger);
      }

      const observation = await options.surface.observe();
      const fingerprint = observationFingerprint(observation);
      fingerprints.push(fingerprint);
      if (fingerprints.slice(-3).every((item) => item === fingerprint) && fingerprints.length >= 3) {
        const handoff = await requestHandoff(options, logger, "The UI state repeated three times", undefined);
        if (!handoff || handoff.resolution === "abort") {
          return stopped("discovery_stuck", "The UI state repeated three times", logger);
        }
        fingerprints.length = 0;
      }

      await logger.event("observation.captured", {
        iteration,
        url: observation.url,
        title: observation.title,
        candidateCount: observation.candidates.length,
        fingerprint,
      });

      const decision = await options.provider.decide({
        goal: options.goal,
        target: options.target,
        observation,
        inputs: options.inputs,
        declaredOutputs: options.outputContracts.map(({ name }) => name),
        extractedOutputs: outputs,
        history,
      });
      await logger.event("model.decision", {
        iteration,
        action: decision.action,
        candidateId: decision.candidateId,
        outputName: decision.outputName,
        risk: decision.risk,
        reason: decision.reason,
      });

      const result = await executeDecision({
        decision,
        observation,
        options,
        logger,
        steps,
        outputs,
        history,
      });
      if (result) return result;
    }
    return stopped("max_steps", `Discovery reached its ${maxSteps}-step limit`, logger);
  } catch (error) {
    const screenshotPath = logger.evidencePath("discovery-failure.png");
    await options.surface.screenshot(screenshotPath).catch(() => undefined);
    await logger.event("discovery.failed", {
      error: error instanceof Error ? error.message : String(error),
      screenshotPath,
    });
    return stopped(
      "discovery_failed",
      error instanceof Error ? error.message : String(error),
      logger,
    );
  }
}

interface ExecuteDecisionOptions {
  readonly decision: DiscoveryDecision;
  readonly observation: SurfaceObservation;
  readonly options: DiscoveryOptions;
  readonly logger: RunLogger;
  readonly steps: Step[];
  readonly outputs: Record<string, Scalar>;
  readonly history: DecisionContext["history"][number][];
}

async function executeDecision(context: ExecuteDecisionOptions): Promise<DiscoveryResult | undefined> {
  const { decision, observation, options, logger, steps, outputs, history } = context;

  if (decision.action === "wait") {
    await delay(decision.waitMs ?? 500);
    history.push({ action: "wait", result: "completed" });
    return undefined;
  }
  if (decision.action === "business_outcome") {
    const code = decision.outcomeCode ?? "unspecified_business_outcome";
    await logger.event("discovery.business_outcome", { code });
    return { status: "business_outcome", code, runId: logger.runId };
  }
  if (decision.action === "escalate") {
    const resumed = await requestHandoff(options, logger, decision.reason, undefined);
    if (!resumed || resumed.resolution === "abort") {
      return stopped("human_aborted", decision.reason, logger);
    }
    history.push({ action: "escalate", result: "human resumed session" });
    return undefined;
  }

  const candidate = assertCandidate(decision, observation.candidates);
  const observedTarget = options.surface.buildTarget(candidate.id);
  const extractionContract =
    decision.action === "extract"
      ? options.outputContracts.find(({ name }) => name === decision.outputName)
      : undefined;
  if (decision.action === "extract" && !extractionContract) {
    throw new Error(`Model selected undeclared output: ${decision.outputName}`);
  }
  const target =
    decision.action === "extract"
      ? stableExtractionTarget(observedTarget, candidate, extractionContract!)
      : observedTarget;

  if (decision.action === "finish") {
    const missing = options.outputContracts
      .filter(({ required, name }) => required && outputs[name] === undefined)
      .map(({ name }) => name);
    if (missing.length > 0) throw new Error(`Model finished before extracting outputs: ${missing.join(", ")}`);
    const artifact = parseCapabilityArtifact({
      schemaVersion: "1.0",
      id: options.capability.id,
      version: "1.0.0",
      name: options.capability.name,
      description: options.capability.description,
      createdAt: new Date().toISOString(),
      app: {
        family: options.capability.appFamily,
        surface: "browser",
        baseUrlPattern: new URL(options.target).origin,
        supportedVariants: [...options.capability.supportedVariants],
      },
      inputs: [...options.inputContracts],
      outputs: [...options.outputContracts],
      policy: options.policy,
      steps,
      success: { conditions: [{ kind: "visible", target }] },
      knownOutcomes: options.knownOutcomes,
    });
    await logger.event("discovery.completed", {
      capabilityId: artifact.id,
      stepCount: artifact.steps.length,
      outputs: Object.keys(outputs),
    });
    return { status: "success", artifact, outputs, runId: logger.runId };
  }

  const stepSubject =
    decision.action === "extract"
      ? decision.outputName!
      : candidate.label || candidate.name || candidate.text || candidate.tag;
  const stepId = `step-${String(steps.length + 1).padStart(2, "0")}-${slug(decision.action)}-${slug(
    stepSubject,
  )}`;
  const common = {
    id: stepId,
    description: decision.reason,
    preconditions: [{ kind: "visible" as const, target }],
    postconditions: [],
    timeoutMs: 7_000,
    retry: { maxAttempts: 2, backoffMs: 200 },
  };

  let step: Step;
  if (decision.action === "click") {
    step = { ...common, action: { kind: "click", target, risk: decision.risk } };
  } else if (decision.action === "type") {
    const valueExpression = decisionValueExpression(decision, options.inputs);
    step = {
      ...common,
      action: {
        kind: "type",
        target,
        value: valueExpression,
        clearFirst: true,
        risk: decision.risk,
      },
    };
  } else {
    const outputName = decision.outputName!;
    step = {
      ...common,
      action: {
        kind: "extract",
        target,
        output: outputName,
        parser: decision.parser!,
        risk: "safe",
      },
    };
  }

  const policyDecision = assertPolicy(step.action, options.policy, options.inputs);
  let performedByHuman = false;
  if (policyDecision.requiresHuman) {
    const handoff = await requestHandoff(options, logger, policyDecision.reason, step.id);
    if (!handoff || handoff.resolution === "abort") {
      return stopped("human_aborted", policyDecision.reason, logger);
    }
    performedByHuman = handoff.resolution === "completed";
  }

  if (!performedByHuman) {
    if (step.action.kind === "click") {
      await options.surface.clickCandidate(candidate.id);
    } else if (step.action.kind === "type") {
      const actualValue =
        step.action.value.source === "input"
          ? options.inputs[step.action.value.key]
          : step.action.value.value;
      if (actualValue === undefined) throw new Error("Input value is unavailable");
      await options.surface.typeCandidate(candidate.id, String(actualValue), true);
    } else if (step.action.kind === "extract") {
      const raw = await options.surface.extractCandidate(candidate.id);
      const value = parseExtracted(raw, step.action.parser);
      const outputName = step.action.output;
      outputs[outputName] = value;
      const contract = options.outputContracts.find(({ name }) => name === outputName);
      if (contract?.sensitive) logger.registerSensitive(outputName, value);
    } else {
      throw new Error(`Unsupported discovery action: ${step.action.kind}`);
    }
  }

  steps.push(step);
  history.push({
    action: decision.action,
    target: target.description,
    result: performedByHuman ? "completed by human" : "completed",
  });
  await logger.event("discovery.action_completed", {
    stepId,
    action: decision.action,
    target: target.description,
    performedByHuman,
  });
  return undefined;
}

function decisionValueExpression(
  decision: DiscoveryDecision,
  inputs: Readonly<Record<string, Scalar>>,
): ValueExpression {
  if (decision.valueSource === "input") {
    const key = decision.inputKey!;
    if (inputs[key] === undefined) throw new Error(`Model selected undeclared input: ${key}`);
    return { source: "input", key };
  }
  return { source: "literal", value: decision.value ?? "" };
}

async function requestHandoff(
  options: DiscoveryOptions,
  logger: RunLogger,
  reason: string,
  stepId: string | undefined,
): Promise<HandoffResult | undefined> {
  if (!options.handoff) return undefined;
  const screenshotPath = logger.evidencePath(`intervention-${stepId ?? "discovery"}.png`);
  await options.surface.screenshot(screenshotPath);
  const result = await options.handoff.request({
    runId: logger.runId,
    reason,
    ...(stepId ? { stepId } : {}),
    goal: options.goal,
    screenshotPath,
    currentUrl: options.surface.currentUrl(),
  });
  await logger.event("handoff.resolved", result);
  return result;
}

function stopped(code: string, message: string, logger: RunLogger): DiscoveryResult {
  return { status: "stopped", code, message, runId: logger.runId };
}

function observationFingerprint(observation: SurfaceObservation): string {
  return createHash("sha256")
    .update(observation.url)
    .update(observation.pageText)
    .update(observation.candidates.map(({ role, name }) => `${role}:${name}`).join("|"))
    .digest("hex")
    .slice(0, 16);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

function stableExtractionTarget(
  target: ReturnType<SurfaceAdapter["buildTarget"]>,
  candidate: SurfaceObservation["candidates"][number],
  contract: FieldContract,
): ReturnType<SurfaceAdapter["buildTarget"]> {
  const valueIndependent = target.strategies.filter((strategy) => {
    if (strategy.kind === "label") return true;
    if (strategy.kind === "css") return strategy.selector !== candidate.tag;
    if (strategy.kind === "role") return candidate.name !== candidate.text;
    return false;
  });
  if (valueIndependent.length === 0) {
    throw new Error(
      `Output ${contract.name} has no value-independent locator; navigate to a labeled or semantically marked field`,
    );
  }
  return {
    ...target,
    description: contract.description,
    strategies: valueIndependent,
  };
}
