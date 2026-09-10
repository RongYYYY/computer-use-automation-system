import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CapabilityArtifact } from "../src/artifact/schema.js";
import { evaluateAction, evaluateNavigation } from "../src/policy/engine.js";
import { Redactor } from "../src/observability/redactor.js";
import { RunLogger } from "../src/observability/run-logger.js";

const policy: CapabilityArtifact["policy"] = {
  allowedOrigins: ["http://127.0.0.1:4317"],
  allowedPathPatterns: ["^/legacy(?:/|$)"],
  allowedActions: ["navigate", "click", "type", "extract", "wait_for"],
  riskyActionPolicy: "require_human",
};

describe("policy engine", () => {
  it("allows configured local routes and blocks other origins", () => {
    expect(evaluateNavigation("http://127.0.0.1:4317/legacy/search", policy).allowed).toBe(
      true,
    );
    expect(evaluateNavigation("https://example.com/legacy/search", policy).allowed).toBe(false);
  });

  it("requires human control for risky actions", () => {
    const decision = evaluateAction(
      {
        kind: "click",
        target: {
          description: "Submit transfer",
          strategies: [{ kind: "text", text: "Submit", exact: true }],
        },
        risk: "irreversible",
      },
      policy,
    );

    expect(decision).toMatchObject({ allowed: true, requiresHuman: true });
  });
});

describe("redaction", () => {
  it("redacts declared PII and generic secret patterns recursively", () => {
    const redactor = new Redactor({ memberId: "10001" });
    const syntheticApiKey = ["sk", "this-value-must-never-appear"].join("-");
    const redacted = redactor.value({
      message: "Loaded member 10001 with SSN 123-45-6789",
      apiKey: syntheticApiKey,
      nested: ["Bearer abc.def.ghi"],
    });

    expect(JSON.stringify(redacted)).toBe(
      JSON.stringify({
        message: "Loaded member [REDACTED:memberId] with SSN [REDACTED:ssn]",
        apiKey: "[REDACTED:secret]",
        nested: ["Bearer [REDACTED:token]"],
      }),
    );
  });

  it("redacts before structured events reach disk", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cua-log-test-"));
    const logger = new RunLogger({
      rootDirectory: directory,
      runId: "redaction-test",
      sensitiveValues: { memberId: "10001" },
    });

    await logger.event("member.loaded", { memberId: "10001" });
    const persisted = await readFile(logger.logPath, "utf8");

    expect(persisted).toContain("[REDACTED:memberId]");
    expect(persisted).not.toContain('"10001"');
  });

  it("redacts sensitive values registered after extraction", () => {
    const redactor = new Redactor();
    redactor.add("balance", 12_450.73);

    expect(redactor.value({ balance: 12_450.73, summary: "Balance: 12450.73" })).toEqual({
      balance: "[REDACTED:balance]",
      summary: "Balance: [REDACTED:balance]",
    });
  });
});
