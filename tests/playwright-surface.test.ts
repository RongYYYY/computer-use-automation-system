import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDemoServer, type RunningDemoServer } from "../src/demo/server.js";
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

describe("PlaywrightSurface", () => {
  it("observes and acts through a nested legacy iframe", async () => {
    await surface!.navigate(`${server!.origin}/legacy`);
    const initial = await surface!.observe();
    const memberField = initial.candidates.find(({ label }) => label === "Member number");
    const search = initial.candidates.find(({ role, name }) => role === "button" && name === "Search");

    expect(memberField).toBeTruthy();
    expect(memberField?.frameUrl).toContain("/legacy/search");
    await surface!.typeCandidate(memberField!.id, "10001", true);
    await surface!.clickCandidate(search!.id);

    const detail = await surface!.observe();
    expect(detail.pageText).toContain("Ada Rivera");
  });

  it("replays a generated multi-strategy target without runtime IDs", async () => {
    await surface!.navigate(`${server!.origin}/legacy`);
    const observation = await surface!.observe();
    const memberField = observation.candidates.find(({ label }) => label === "Member number")!;
    const target = surface!.buildTarget(memberField.id);

    expect(target.strategies.map(({ kind }) => kind)).toContain("label");
    expect(JSON.stringify(target)).not.toContain("data-cua-runtime-ref");
    const resolution = await surface!.type(target, "10002", true, 5_000);

    expect(resolution.strategyKind).toBe("role");
  });
});
