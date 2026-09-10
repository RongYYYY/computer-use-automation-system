import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHandoffCapability } from "../src/demo/lookup-capability.js";
import { startDemoServer, type RunningDemoServer } from "../src/demo/server.js";
import { ControlLease } from "../src/handoff/control-lease.js";
import { SameSessionHandoff } from "../src/handoff/same-session.js";
import { RunLogger } from "../src/observability/run-logger.js";
import { replayCapability } from "../src/replay/engine.js";
import { PlaywrightSurface } from "../src/surface/playwright-surface.js";

let server: RunningDemoServer | undefined;
let surface: PlaywrightSurface | undefined;

beforeEach(async () => {
  server = await startDemoServer(0);
  surface = await PlaywrightSurface.launch();
});

afterEach(async () => {
  await surface?.close();
  await server?.close();
  surface = undefined;
  server = undefined;
});

describe("control lease", () => {
  it("enforces exclusive, ordered ownership transitions", () => {
    const lease = new ControlLease();
    expect(() => lease.grantHumanControl()).toThrow(/Invalid control transition/);
    lease.pauseAutomation();
    lease.grantHumanControl();
    lease.beginResume();
    lease.resumeAutomation();

    expect(lease.owner).toBe("automation");
    expect(lease.transitions.map(({ to }) => to)).toEqual([
      "pausing",
      "human",
      "resuming",
      "automation",
    ]);
  });
});

describe("same-session handoff", () => {
  it("cedes the live browser, captures human action, and resumes replay", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cua-handoff-test-"));
    const logger = new RunLogger({
      rootDirectory: directory,
      runId: "same-session",
      sensitiveValues: { memberId: "10001" },
    });
    const handoff = new SameSessionHandoff({
      surface: surface!,
      logger,
      prompt: async (request) => {
        expect(request.stepId).toBe("verify-member-identity");
        const liveFrame = surface!.page.frames().find((frame) =>
          frame.url().includes("/legacy/subaccount/start"),
        );
        if (!liveFrame) throw new Error("Live sub-account frame was not available");
        await liveFrame.getByLabel("Identity verified", { exact: true }).click();
        return { resolution: "completed", note: "Identity verified in the live session" };
      },
    });

    const result = await replayCapability({
      artifact: createHandoffCapability(server!.origin),
      inputs: { memberId: "10001" },
      surface: surface!,
      logger,
      handoff,
    });

    expect(result).toMatchObject({ status: "success", outputs: { balance: 12_450.73 } });
    expect(handoff.lease.owner).toBe("automation");
    expect(surface!.page.frames().some((frame) => frame.url().includes("/legacy/subaccount/review"))).toBe(
      true,
    );
    const events = await readFile(logger.logPath, "utf8");
    expect(events).toContain('"kind":"human.action"');
    expect(events).toContain('"to":"human"');
    expect(events).toContain('"to":"automation"');
    expect(events).not.toContain('"10001"');
    expect(events).not.toContain("12450.73");
  });
});
