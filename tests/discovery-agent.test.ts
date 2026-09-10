import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverCapability } from "../src/discovery/agent.js";
import type { DecisionContext, DecisionProvider, DiscoveryDecision } from "../src/discovery/decision.js";
import { createLookupCapability } from "../src/demo/lookup-capability.js";
import { startDemoServer, type RunningDemoServer } from "../src/demo/server.js";
import { RunLogger } from "../src/observability/run-logger.js";
import { replayCapability } from "../src/replay/engine.js";
import { PlaywrightSurface } from "../src/surface/playwright-surface.js";

let server: RunningDemoServer | undefined;
let surfaces: PlaywrightSurface[] = [];
let evidenceRoot: string;

beforeEach(async () => {
  server = await startDemoServer(0);
  evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "cua-discovery-test-"));
});

afterEach(async () => {
  await Promise.all(surfaces.map((surface) => surface.close()));
  await server?.close();
  surfaces = [];
  server = undefined;
});

describe("capability discovery", () => {
  it("records stable steps that replay with a new input and no model", async () => {
    const template = createLookupCapability(server!.origin);
    const discoverySurface = await newSurface();
    const discovery = await discoverCapability({
      goal: "Look up the member's savings balance",
      target: `${server!.origin}/legacy`,
      capability: {
        id: template.id,
        name: template.name,
        description: template.description,
        appFamily: template.app.family,
        supportedVariants: template.app.supportedVariants,
      },
      inputContracts: template.inputs,
      outputContracts: template.outputs,
      inputs: { memberId: "10001" },
      policy: template.policy,
      knownOutcomes: template.knownOutcomes,
      surface: discoverySurface,
      provider: new ScriptedLookupProvider(),
      logger: new RunLogger({
        rootDirectory: evidenceRoot,
        sensitiveValues: { memberId: "10001" },
      }),
    });

    if (discovery.status !== "success") {
      throw new Error(`Discovery did not succeed: ${JSON.stringify(discovery)}`);
    }
    expect(discovery.outputs).toEqual({ balance: 12_450.73 });
    expect(JSON.stringify(discovery.artifact)).not.toContain("data-cua-runtime-ref");
    expect(JSON.stringify(discovery.artifact)).not.toContain("12,450.73");
    expect(discovery.artifact.steps.map(({ action }) => action.kind)).toEqual([
      "navigate",
      "type",
      "click",
      "click",
      "extract",
    ]);
    expect(discovery.artifact.steps[1]?.action).toMatchObject({
      kind: "type",
      value: { source: "input", key: "memberId" },
    });

    const replaySurface = await newSurface();
    const replay = await replayCapability({
      artifact: discovery.artifact,
      inputs: { memberId: "10002" },
      surface: replaySurface,
      logger: new RunLogger({
        rootDirectory: evidenceRoot,
        sensitiveValues: { memberId: "10002" },
      }),
    });
    if (replay.status !== "success") {
      throw new Error(`Generated artifact did not replay: ${JSON.stringify(replay)}`);
    }
    expect(replay.outputs).toEqual({ balance: 87.14 });
  });
});

class ScriptedLookupProvider implements DecisionProvider {
  async decide(context: DecisionContext): Promise<DiscoveryDecision> {
    const find = (predicate: (candidate: DecisionContext["observation"]["candidates"][number]) => boolean) => {
      const candidate = context.observation.candidates.find(predicate);
      if (!candidate) throw new Error(`Expected control was not observed at ${context.observation.url}`);
      return candidate.id;
    };
    const decision = (
      value: Partial<DiscoveryDecision> & Pick<DiscoveryDecision, "action" | "reason">,
    ): DiscoveryDecision => ({
      candidateId: null,
      value: null,
      valueSource: null,
      inputKey: null,
      outputName: null,
      parser: null,
      outcomeCode: null,
      waitMs: null,
      risk: "safe",
      ...value,
    });

    if (context.observation.pageText.includes("Member Search")) {
      const alreadyTyped = context.history.some(({ action }) => action === "type");
      return alreadyTyped
        ? decision({
            action: "click",
            candidateId: find(({ role, name }) => role === "button" && name === "Search"),
            reason: "Submit the member search",
          })
        : decision({
            action: "type",
            candidateId: find(({ label }) => label === "Member number"),
            valueSource: "input",
            inputKey: "memberId",
            reason: "Enter the declared member identifier",
          });
    }
    if (context.observation.pageText.includes("Member Detail")) {
      return decision({
        action: "click",
        candidateId: find(({ role, name }) => role === "link" && name === "Savings"),
        reason: "Open the savings account",
      });
    }
    if (
      context.observation.pageText.includes("Savings Account") &&
      context.extractedOutputs.balance === undefined
    ) {
      return decision({
        action: "extract",
        candidateId: find(({ attributes }) => attributes["data-field"] === "account-balance"),
        outputName: "balance",
        parser: "currency",
        reason: "Extract the current account balance",
      });
    }
    if (context.extractedOutputs.balance !== undefined) {
      return decision({
        action: "finish",
        candidateId: find(({ role, name }) => role === "heading" && name === "Savings Account"),
        reason: "The requested balance was extracted and the account heading confirms success",
      });
    }
    return decision({ action: "wait", waitMs: 100, reason: "Wait for the iframe navigation" });
  }
}

async function newSurface(): Promise<PlaywrightSurface> {
  const surface = await PlaywrightSurface.launch();
  surfaces.push(surface);
  return surface;
}
