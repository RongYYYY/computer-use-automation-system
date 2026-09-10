import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseCapabilityArtifact, type CapabilityArtifact, type Scalar } from "./artifact/schema.js";
import { loadConfig } from "./config.js";
import { createHandoffCapability, createLookupCapability } from "./demo/lookup-capability.js";
import { startDemoServer, type RunningDemoServer } from "./demo/server.js";
import { discoverCapability } from "./discovery/agent.js";
import { OpenAIDecisionProvider } from "./discovery/openai-provider.js";
import { SameSessionHandoff, terminalOperatorPrompt } from "./handoff/same-session.js";
import { RunLogger } from "./observability/run-logger.js";
import { replayCapability } from "./replay/engine.js";
import { PlaywrightSurface } from "./surface/playwright-surface.js";

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));

try {
  switch (command) {
    case "discover":
      await runDiscovery();
      break;
    case "replay":
      await runReplay();
      break;
    case "handoff":
      await runHandoff();
      break;
    default:
      usage();
      process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function runDiscovery(): Promise<void> {
  const config = loadConfig();
  if (!config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required in .env.local for live discovery");
  }
  const memberId = stringArg("member-id", "10001");
  const artifactPath = path.resolve(stringArg("artifact", "evidence/capability.json"));
  const goal = stringArg("goal", "Look up the supplied member and return their savings balance");
  const { server, origin } = await startConfiguredDemo(config.demoBaseUrl);
  const surface = await PlaywrightSurface.launch({ headless: !flag("headed") });
  const logger = new RunLogger({
    rootDirectory: "evidence",
    runId: stringArg("run-id", timestampedRunId("discovery")),
    sensitiveValues: { memberId },
  });
  const template = createLookupCapability(origin);

  try {
    const result = await discoverCapability({
      goal,
      target: `${origin}/legacy`,
      capability: {
        id: template.id,
        name: template.name,
        description: template.description,
        appFamily: template.app.family,
        supportedVariants: template.app.supportedVariants,
      },
      inputContracts: template.inputs,
      outputContracts: template.outputs,
      inputs: { memberId },
      policy: template.policy,
      knownOutcomes: template.knownOutcomes,
      surface,
      provider: new OpenAIDecisionProvider({
        apiKey: config.openaiApiKey,
        model: config.openaiModel,
      }),
      logger,
    });
    if (result.status !== "success") {
      throw new Error(`Discovery stopped: ${result.code}${"message" in result ? ` - ${result.message}` : ""}`);
    }
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, `${JSON.stringify(result.artifact, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    printResult(result, logger, { artifactPath, model: config.openaiModel });
  } finally {
    await surface.close();
    await server.close();
  }
}

async function runReplay(): Promise<void> {
  const config = loadConfig();
  const memberId = stringArg("member-id", "10002");
  const artifactPath = path.resolve(stringArg("artifact", "evidence/capability.json"));
  const artifact = parseCapabilityArtifact(JSON.parse(await readFile(artifactPath, "utf8")));
  const { server, origin } = await startConfiguredDemo(config.demoBaseUrl);
  const surface = await PlaywrightSurface.launch({ headless: !flag("headed") });
  const logger = new RunLogger({
    rootDirectory: "evidence",
    runId: stringArg("run-id", timestampedRunId("replay")),
    sensitiveValues: { memberId },
  });

  try {
    const runnableArtifact = relocateArtifact(withFault(artifact, optionalArg("fault")), origin);
    const result = await replayCapability({
      artifact: runnableArtifact,
      inputs: { memberId },
      surface,
      logger,
    });
    printResult(result, logger);
    if (result.status === "failure") process.exitCode = 1;
  } finally {
    await surface.close();
    await server.close();
  }
}

async function runHandoff(): Promise<void> {
  const config = loadConfig();
  const memberId = stringArg("member-id", "10001");
  const { server, origin } = await startConfiguredDemo(config.demoBaseUrl);
  const autoHuman = flag("auto-human");
  const surface = await PlaywrightSurface.launch({ headless: autoHuman ? true : !flag("headed") });
  const logger = new RunLogger({
    rootDirectory: "evidence",
    runId: stringArg("run-id", timestampedRunId("handoff")),
    sensitiveValues: { memberId },
  });
  const handoff = new SameSessionHandoff({
    surface,
    logger,
    prompt: autoHuman
      ? async (_request, control) => {
          const frame = surface.page.frames().find((candidate) =>
            candidate.url().includes("/legacy/subaccount/start"),
          );
          if (!frame) throw new Error("The live sub-account frame was not available");
          await frame.getByLabel("Identity verified", { exact: true }).click();
          await control.recordAction({
            kind: "click",
            target: "Identity verified checkbox",
            checked: true,
          });
          return { resolution: "completed", note: "Demo operator verified identity" };
        }
      : terminalOperatorPrompt(),
  });

  try {
    const result = await replayCapability({
      artifact: createHandoffCapability(origin),
      inputs: { memberId },
      surface,
      logger,
      handoff,
    });
    printResult(result, logger, { transitions: handoff.lease.transitions });
    if (result.status === "failure") process.exitCode = 1;
  } finally {
    await surface.close();
    await server.close();
  }
}

async function startConfiguredDemo(baseUrl: string): Promise<{ server: RunningDemoServer; origin: string }> {
  const url = new URL(baseUrl);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("This demo CLI only starts a local target; set DEMO_BASE_URL to localhost");
  }
  const port = url.port ? Number(url.port) : 4317;
  const server = await startDemoServer(port);
  return { server, origin: server.origin };
}

function relocateArtifact(artifact: CapabilityArtifact, origin: string): CapabilityArtifact {
  const oldOrigin = artifact.policy.allowedOrigins[0];
  const rewrite = (value: Scalar): Scalar =>
    typeof value === "string" && oldOrigin ? value.replace(oldOrigin, origin) : value;
  return parseCapabilityArtifact({
    ...artifact,
    app: { ...artifact.app, baseUrlPattern: rewrite(artifact.app.baseUrlPattern) },
    policy: { ...artifact.policy, allowedOrigins: [origin] },
    steps: artifact.steps.map((step) =>
      step.action.kind === "navigate" && step.action.url.source === "literal"
        ? {
            ...step,
            action: { ...step.action, url: { source: "literal" as const, value: rewrite(step.action.url.value) } },
          }
        : step,
    ),
  });
}

function withFault(artifact: CapabilityArtifact, fault: string | undefined): CapabilityArtifact {
  if (!fault) return artifact;
  return parseCapabilityArtifact({
    ...artifact,
    steps: artifact.steps.map((step) => {
      if (step.action.kind !== "navigate" || step.action.url.source !== "literal") return step;
      const url = new URL(String(step.action.url.value));
      url.searchParams.set("fault", fault);
      return { ...step, action: { ...step.action, url: { source: "literal" as const, value: url.href } } };
    }),
  });
}

function printResult(result: unknown, logger: RunLogger, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify(logger.redactor.value({ result, evidence: logger.runDirectory, ...extra }), null, 2));
}

function parseArgs(values: readonly string[]): Map<string, string | true> {
  const parsed = new Map<string, string | true>();
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index]!;
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) parsed.set(key, true);
    else {
      parsed.set(key, next);
      index += 1;
    }
  }
  return parsed;
}

function stringArg(name: string, fallback: string): string {
  const value = args.get(name);
  if (value === true) throw new Error(`--${name} requires a value`);
  return value ?? fallback;
}

function optionalArg(name: string): string | undefined {
  const value = args.get(name);
  if (value === true) throw new Error(`--${name} requires a value`);
  return value;
}

function flag(name: string): boolean {
  return args.get(name) === true;
}

function timestampedRunId(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

function usage(): void {
  console.error(`Usage:
  pnpm discover -- --member-id 10001 [--goal "..."] [--artifact evidence/capability.json]
  pnpm replay -- --artifact evidence/capability.json --member-id 10002 [--fault dialog|permission|session|slow]
  pnpm demo:handoff -- --member-id 10001 --headed
  pnpm demo:handoff -- --member-id 10001 --auto-human`);
}
