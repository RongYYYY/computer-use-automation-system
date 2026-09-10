import { setTimeout as delay } from "node:timers/promises";
import type {
  CapabilityArtifact,
  KnownOutcomeSchema,
  ReplayResult,
  Scalar,
  Step,
} from "../artifact/schema.js";
import { parseCapabilityArtifact } from "../artifact/schema.js";
import { resolveValue, validateInputs } from "../artifact/values.js";
import type { z } from "zod";
import type { HandoffHandler } from "../handoff/types.js";
import { RunLogger } from "../observability/run-logger.js";
import { assertPolicy } from "../policy/engine.js";
import type { SurfaceAdapter } from "../surface/types.js";

type KnownOutcome = z.infer<typeof KnownOutcomeSchema>;

export interface ReplayOptions {
  readonly artifact: CapabilityArtifact;
  readonly inputs: Readonly<Record<string, Scalar>>;
  readonly surface: SurfaceAdapter;
  readonly logger?: RunLogger;
  readonly handoff?: HandoffHandler;
}

interface OutcomeMatch {
  readonly outcome: KnownOutcome;
}

class ClassifiedRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly stepId?: string,
    readonly expected?: string,
    readonly observed?: string,
  ) {
    super(message);
    this.name = "ClassifiedRunError";
  }
}

export async function replayCapability(options: ReplayOptions): Promise<ReplayResult> {
  const artifact = parseCapabilityArtifact(options.artifact);
  const inputs = validateInputs(artifact.inputs, options.inputs);
  const sensitiveValues = Object.fromEntries(
    artifact.inputs
      .filter(({ sensitive }) => sensitive)
      .flatMap(({ name }) => (inputs[name] === undefined ? [] : [[name, inputs[name]]] as const)),
  );
  const logger = options.logger ?? new RunLogger({ sensitiveValues });
  const outputs: Record<string, Scalar> = {};
  const recoveries = new Map<string, number>();

  await logger.event("replay.started", {
    capabilityId: artifact.id,
    capabilityVersion: artifact.version,
    inputs,
  });

  try {
    for (const step of artifact.steps) {
      const priorOutcome = await detectKnownOutcome(artifact, options.surface, inputs);
      const priorResult = await handleTerminalOutcome(priorOutcome, logger, step.id);
      if (priorResult) return priorResult;

      const executionResult = await executeStep({
        step,
        artifact,
        inputs,
        outputs,
        surface: options.surface,
        logger,
        ...(options.handoff ? { handoff: options.handoff } : {}),
        recoveries,
      });
      if (executionResult) return executionResult;
    }

    const finalOutcome = await detectKnownOutcome(artifact, options.surface, inputs);
    const finalResult = await handleTerminalOutcome(finalOutcome, logger);
    if (finalResult) return finalResult;

    for (const condition of artifact.success.conditions) {
      if (!(await options.surface.check(condition, inputs, 5_000))) {
        throw new ClassifiedRunError(
          "checkpoint_failed",
          "The final capability checkpoint was not satisfied",
          undefined,
          JSON.stringify(condition),
          options.surface.currentUrl(),
        );
      }
    }

    for (const output of artifact.outputs) {
      if (output.required && outputs[output.name] === undefined) {
        throw new ClassifiedRunError(
          "missing_output",
          `Required output was not extracted: ${output.name}`,
        );
      }
      const value = outputs[output.name];
      if (value !== undefined && typeof value !== output.type) {
        throw new ClassifiedRunError(
          "output_type_mismatch",
          `Output ${output.name} expected ${output.type}, got ${typeof value}`,
        );
      }
    }

    const result: ReplayResult = { status: "success", outputs, runId: logger.runId };
    await logger.event("replay.completed", result);
    return result;
  } catch (error) {
    const screenshotPath = logger.evidencePath("failure.png");
    const evidence: Array<{
      kind: "screenshot" | "trace" | "log";
      path: string;
    }> = [
      { kind: "log", path: logger.logPath },
    ];
    try {
      await options.surface.screenshot(screenshotPath);
      evidence.push({ kind: "screenshot", path: screenshotPath });
    } catch (screenshotError) {
      await logger.event("evidence.capture_failed", { error: errorMessage(screenshotError) });
    }

    const classified =
      error instanceof ClassifiedRunError
        ? error
        : new ClassifiedRunError("unhandled_replay_error", errorMessage(error));
    const result: ReplayResult = {
      status: "failure",
      code: classified.code,
      message: classified.message,
      ...(classified.stepId ? { stepId: classified.stepId } : {}),
      ...(classified.expected ? { expected: classified.expected } : {}),
      ...(classified.observed ? { observed: classified.observed } : {}),
      evidence,
      runId: logger.runId,
    };
    await logger.event("replay.failed", result);
    return result;
  }
}

interface ExecuteStepOptions {
  readonly step: Step;
  readonly artifact: CapabilityArtifact;
  readonly inputs: Readonly<Record<string, Scalar>>;
  readonly outputs: Record<string, Scalar>;
  readonly surface: SurfaceAdapter;
  readonly logger: RunLogger;
  readonly handoff?: HandoffHandler;
  readonly recoveries: Map<string, number>;
}

async function executeStep(options: ExecuteStepOptions): Promise<ReplayResult | undefined> {
  const { step, artifact, inputs, outputs, surface, logger } = options;
  await logger.event("step.started", { stepId: step.id, action: step.action.kind });

  const blockingOutcome = await detectKnownOutcome(artifact, surface, inputs);
  if (blockingOutcome?.outcome.classification === "recoverable") {
    const didRecover = await recover(blockingOutcome.outcome, options);
    if (!didRecover) {
      throw new ClassifiedRunError(
        "recovery_exhausted",
        `Recovery limit reached for ${blockingOutcome.outcome.code}`,
        step.id,
      );
    }
  }

  for (const condition of step.preconditions) {
    let match: OutcomeMatch | undefined;
    while (true) {
      match = await waitForPreconditionOrOutcome(
        artifact,
        surface,
        condition,
        inputs,
        step.timeoutMs,
        step.id,
      );
      if (match?.outcome.classification !== "recoverable") break;
      if (!(await recover(match.outcome, options))) {
        throw new ClassifiedRunError(
          "recovery_exhausted",
          `Recovery limit reached for ${match.outcome.code}`,
          step.id,
        );
      }
    }
    if (match?.outcome.classification === "business") {
      const result = businessResult(match.outcome, logger.runId);
      await logger.event("replay.business_outcome", result);
      return result;
    }
    if (match?.outcome.classification === "failure") {
      throw new ClassifiedRunError(
        match.outcome.code,
        match.outcome.description,
        step.id,
        undefined,
        surface.currentUrl(),
      );
    }
  }

  const decision = assertPolicy(step.action, artifact.policy, inputs);
  let performedByHuman = false;
  if (decision.requiresHuman) {
    if (!options.handoff) {
      throw new ClassifiedRunError(
        "human_intervention_required",
        decision.reason,
        step.id,
      );
    }
    const screenshotPath = logger.evidencePath(`intervention-${step.id}.png`);
    await surface.screenshot(screenshotPath);
    const handoff = await options.handoff.request({
      runId: logger.runId,
      reason: decision.reason,
      stepId: step.id,
      risk: step.action.risk,
      screenshotPath,
      currentUrl: surface.currentUrl(),
    });
    await logger.event("handoff.resolved", { stepId: step.id, ...handoff });
    if (handoff.resolution === "abort") {
      throw new ClassifiedRunError("human_aborted", handoff.note, step.id);
    }
    performedByHuman = handoff.resolution === "completed";
  }

  for (let attempt = 1; attempt <= step.retry.maxAttempts; attempt += 1) {
    try {
      if (!performedByHuman) {
        await performAction(step, artifact, surface, inputs, outputs, logger);
      }
      for (const condition of step.postconditions) {
        await surface.waitFor(condition, inputs, step.timeoutMs);
      }
      await logger.event("step.completed", { stepId: step.id, attempt, performedByHuman });
      return undefined;
    } catch (error) {
      await logger.event("step.attempt_failed", {
        stepId: step.id,
        attempt,
        error: errorMessage(error),
      });
      const match = await detectKnownOutcome(artifact, surface, inputs);
      if (match?.outcome.classification === "business") {
        const result = businessResult(match.outcome, logger.runId);
        await logger.event("replay.business_outcome", result);
        return result;
      }
      if (match?.outcome.classification === "failure") {
        throw new ClassifiedRunError(
          match.outcome.code,
          match.outcome.description,
          step.id,
          undefined,
          surface.currentUrl(),
        );
      }
      if (match?.outcome.classification === "recoverable") {
        const didRecover = await recover(match.outcome, options);
        if (didRecover) continue;
      }
      if (attempt < step.retry.maxAttempts) {
        await delay(step.retry.backoffMs * attempt);
        continue;
      }
      throw new ClassifiedRunError(
        "step_failed",
        `Step ${step.id} failed after ${attempt} attempt(s): ${errorMessage(error)}`,
        step.id,
        JSON.stringify(step.postconditions),
        surface.currentUrl(),
      );
    }
  }
  return undefined;
}

async function performAction(
  step: Step,
  artifact: CapabilityArtifact,
  surface: SurfaceAdapter,
  inputs: Readonly<Record<string, Scalar>>,
  outputs: Record<string, Scalar>,
  logger: RunLogger,
): Promise<void> {
  const { action } = step;
  switch (action.kind) {
    case "navigate":
      await surface.navigate(String(resolveValue(action.url, inputs)));
      return;
    case "click": {
      const resolution = await surface.click(action.target, step.timeoutMs);
      await logger.event("locator.resolved", { stepId: step.id, ...resolution });
      return;
    }
    case "type": {
      const resolution = await surface.type(
        action.target,
        String(resolveValue(action.value, inputs)),
        action.clearFirst,
        step.timeoutMs,
      );
      await logger.event("locator.resolved", { stepId: step.id, ...resolution });
      return;
    }
    case "extract": {
      const extracted = await surface.extract(action.target, step.timeoutMs);
      outputs[action.output] = parseExtracted(extracted.value, action.parser);
      const contract = artifact.outputs.find(({ name }) => name === action.output);
      if (contract?.sensitive) logger.registerSensitive(action.output, outputs[action.output]);
      await logger.event("output.extracted", {
        stepId: step.id,
        output: action.output,
        value: outputs[action.output],
        resolution: extracted.resolution,
      });
      return;
    }
    case "wait_for":
      await surface.waitFor(action.condition, inputs, step.timeoutMs);
  }
}

async function detectKnownOutcome(
  artifact: CapabilityArtifact,
  surface: SurfaceAdapter,
  inputs: Readonly<Record<string, Scalar>>,
  waitMs = 0,
): Promise<OutcomeMatch | undefined> {
  const deadline = Date.now() + waitMs;
  do {
    for (const outcome of artifact.knownOutcomes) {
      if (await surface.check(outcome.condition, inputs, 100)) {
        return { outcome };
      }
    }
    if (Date.now() < deadline) await delay(25);
  } while (Date.now() < deadline);
  return undefined;
}

async function waitForPreconditionOrOutcome(
  artifact: CapabilityArtifact,
  surface: SurfaceAdapter,
  condition: Step["preconditions"][number],
  inputs: Readonly<Record<string, Scalar>>,
  timeoutMs: number,
  stepId: string,
): Promise<OutcomeMatch | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const outcome = await detectKnownOutcome(artifact, surface, inputs);
    if (outcome) return outcome;
    if (await surface.check(condition, inputs, 100)) return undefined;
    await delay(50);
  } while (Date.now() < deadline);
  throw new ClassifiedRunError(
    "precondition_failed",
    `Precondition failed for step ${stepId}`,
    stepId,
    JSON.stringify(condition),
    surface.currentUrl(),
  );
}

async function handleTerminalOutcome(
  match: OutcomeMatch | undefined,
  logger: RunLogger,
  stepId?: string,
): Promise<ReplayResult | undefined> {
  if (!match || match.outcome.classification === "recoverable") return undefined;
  if (match.outcome.classification === "business") {
    const result = businessResult(match.outcome, logger.runId);
    await logger.event("replay.business_outcome", result);
    return result;
  }
  throw new ClassifiedRunError(match.outcome.code, match.outcome.description, stepId);
}

async function recover(outcome: KnownOutcome, options: ExecuteStepOptions): Promise<boolean> {
  const recovery = outcome.recovery;
  if (!recovery) return false;
  const count = options.recoveries.get(outcome.code) ?? 0;
  if (count >= recovery.maxAttempts) return false;
  options.recoveries.set(outcome.code, count + 1);
  await options.logger.event("recovery.started", {
    code: outcome.code,
    attempt: count + 1,
    action: recovery.action,
  });
  if (recovery.action === "dismiss_and_retry") {
    if (!recovery.target) return false;
    const resolution = await options.surface.click(recovery.target, options.step.timeoutMs);
    await options.logger.event("recovery.completed", { code: outcome.code, resolution });
  } else {
    await delay(options.step.retry.backoffMs || 100);
    await options.logger.event("recovery.completed", { code: outcome.code });
  }
  return true;
}

function businessResult(outcome: KnownOutcome, runId: string): ReplayResult {
  return {
    status: "business_outcome",
    code: outcome.code,
    details: { description: outcome.description },
    runId,
  };
}

export function parseExtracted(
  value: string,
  parser: "text" | "currency" | "number" | "boolean",
): Scalar {
  switch (parser) {
    case "text":
      return value.trim();
    case "currency":
    case "number": {
      const parsed = Number(value.replace(/[^0-9.-]/g, ""));
      if (!Number.isFinite(parsed)) throw new Error(`Could not parse numeric value: ${value}`);
      return parsed;
    }
    case "boolean": {
      const normalized = value.trim().toLowerCase();
      if (["true", "yes", "active"].includes(normalized)) return true;
      if (["false", "no", "inactive"].includes(normalized)) return false;
      throw new Error(`Could not parse boolean value: ${value}`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
