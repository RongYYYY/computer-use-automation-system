import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLookupCapability } from "../src/demo/lookup-capability.js";
import { startDemoServer, type RunningDemoServer } from "../src/demo/server.js";
import { RunLogger } from "../src/observability/run-logger.js";
import { replayCapability } from "../src/replay/engine.js";
import { PlaywrightSurface } from "../src/surface/playwright-surface.js";

let server: RunningDemoServer | undefined;
let surface: PlaywrightSurface | undefined;
let evidenceRoot: string;

beforeEach(async () => {
  server = await startDemoServer(0);
  surface = await PlaywrightSurface.launch();
  evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "cua-replay-test-"));
});

afterEach(async () => {
  await surface?.close();
  await server?.close();
  surface = undefined;
  server = undefined;
});

async function replay(memberId: string, fault?: string) {
  return replayCapability({
    artifact: createLookupCapability(server!.origin, fault),
    inputs: { memberId },
    surface: surface!,
    logger: new RunLogger({
      rootDirectory: evidenceRoot,
      sensitiveValues: { memberId },
    }),
  });
}

describe("deterministic replay", () => {
  it("returns typed outputs without an LLM", async () => {
    await expect(replay("10001")).resolves.toMatchObject({
      status: "success",
      outputs: { balance: 12_450.73 },
    });
  });

  it("returns not-found as a business outcome", async () => {
    await expect(replay("99999")).resolves.toMatchObject({
      status: "business_outcome",
      code: "member_not_found",
    });
  });

  it("returns permission denial as a debuggable hard failure", async () => {
    await expect(replay("90001")).resolves.toMatchObject({
      status: "failure",
      code: "permission_denied",
      stepId: "open-savings-account",
    });
  });

  it("dismisses a known interstitial and retries within its bound", async () => {
    await expect(replay("10002", "dialog")).resolves.toMatchObject({
      status: "success",
      outputs: { balance: 87.14 },
    });
  });
});
