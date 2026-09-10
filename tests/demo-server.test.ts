import { afterEach, describe, expect, it } from "vitest";
import { startDemoServer, type RunningDemoServer } from "../src/demo/server.js";

let running: RunningDemoServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe("Northstar legacy demo", () => {
  it("serves an iframe-based member search without test IDs", async () => {
    running = await startDemoServer(0);

    const shell = await fetch(`${running.origin}/legacy`).then((response) => response.text());
    const search = await fetch(`${running.origin}/legacy/search`).then((response) =>
      response.text(),
    );

    expect(shell).toContain("<iframe");
    expect(search).toContain('name="member_number"');
    expect(`${shell}${search}`).not.toContain("data-testid");
  });

  it("returns a synthetic member and account details", async () => {
    running = await startDemoServer(0);

    const member = await fetch(
      `${running.origin}/legacy/member?member_number=10001`,
    ).then((response) => response.text());
    const account = await fetch(
      `${running.origin}/legacy/account?member_number=10001&type=savings`,
    ).then((response) => response.text());

    expect(member).toContain("Ada Rivera");
    expect(member).toContain("Savings");
    expect(account).toContain('data-field="account-balance">$12,450.73');
  });

  it("represents not found as a business outcome page", async () => {
    running = await startDemoServer(0);

    const response = await fetch(
      `${running.origin}/legacy/member?member_number=99999`,
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("No member found");
  });

  it("exposes a hard permission failure", async () => {
    running = await startDemoServer(0);

    const response = await fetch(
      `${running.origin}/legacy/member?member_number=90001`,
    );
    const html = await response.text();

    expect(response.status).toBe(403);
    expect(html).toContain("Permission denied");
  });
});
