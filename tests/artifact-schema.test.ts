import { describe, expect, it } from "vitest";
import {
  CapabilityArtifactSchema,
  type CapabilityArtifact,
} from "../src/artifact/schema.js";
import { resolveValue, validateInputs } from "../src/artifact/values.js";

const memberIdTarget = {
  description: "Member number field",
  frame: { urlPattern: "/legacy/search" },
  strategies: [
    { kind: "label" as const, text: "Member number", exact: true },
    { kind: "css" as const, selector: "input[name='member_number']" },
  ],
};

function validArtifact(): CapabilityArtifact {
  return {
    schemaVersion: "1.0",
    id: "northstar.lookup-savings-balance",
    version: "1.0.0",
    name: "Look up savings balance",
    description: "Find a synthetic member and return the savings balance.",
    createdAt: "2026-09-09T12:00:00.000Z",
    app: {
      family: "northstar-demo",
      surface: "browser",
      baseUrlPattern: "http://127.0.0.1:4317",
      supportedVariants: ["base"],
    },
    inputs: [
      {
        name: "memberId",
        type: "string",
        description: "Synthetic member identifier",
        required: true,
        sensitive: true,
      },
    ],
    outputs: [
      {
        name: "balance",
        type: "number",
        description: "Savings balance in USD",
        required: true,
        sensitive: true,
      },
    ],
    policy: {
      allowedOrigins: ["http://127.0.0.1:4317"],
      allowedPathPatterns: ["^/legacy/"],
      allowedActions: ["navigate", "type", "click", "extract", "wait_for"],
      riskyActionPolicy: "require_human",
    },
    steps: [
      {
        id: "enter-member-id",
        description: "Enter the member identifier",
        action: {
          kind: "type",
          target: memberIdTarget,
          value: { source: "input", key: "memberId" },
          clearFirst: true,
          risk: "safe",
        },
        preconditions: [{ kind: "visible", target: memberIdTarget }],
        postconditions: [],
        timeoutMs: 5_000,
        retry: { maxAttempts: 2, backoffMs: 100 },
      },
      {
        id: "extract-balance",
        description: "Read the displayed savings balance",
        action: {
          kind: "extract",
          target: {
            description: "Savings balance",
            strategies: [
              { kind: "css", selector: "td[data-field='savings-balance']" },
            ],
          },
          output: "balance",
          parser: "currency",
          risk: "safe",
        },
        preconditions: [],
        postconditions: [],
        timeoutMs: 5_000,
        retry: { maxAttempts: 1, backoffMs: 0 },
      },
    ],
    success: {
      conditions: [{ kind: "url_matches", pattern: "/legacy/member" }],
    },
    knownOutcomes: [],
  };
}

describe("CapabilityArtifactSchema", () => {
  it("accepts a typed and reviewable artifact", () => {
    expect(CapabilityArtifactSchema.parse(validArtifact())).toBeTruthy();
  });

  it("rejects duplicate step identifiers", () => {
    const artifact = validArtifact();
    artifact.steps[1]!.id = artifact.steps[0]!.id;

    const result = CapabilityArtifactSchema.safeParse(artifact);
    expect(result.success).toBe(false);
    expect(result.error?.issues.some(({ message }) => message.includes("Duplicate id"))).toBe(
      true,
    );
  });

  it("rejects dangling input references", () => {
    const artifact = validArtifact();
    const firstAction = artifact.steps[0]!.action;
    if (firstAction.kind !== "type") {
      throw new Error("Unexpected fixture action");
    }
    firstAction.value = { source: "input", key: "undeclared" };

    const result = CapabilityArtifactSchema.safeParse(artifact);
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.some(({ message }) => message.includes("undeclared input")),
    ).toBe(true);
  });

  it("requires bounded recovery for recoverable outcomes", () => {
    const artifact = validArtifact();
    artifact.knownOutcomes.push({
      code: "transient_load",
      classification: "recoverable",
      description: "The legacy screen is still loading.",
      condition: { kind: "url_matches", pattern: "/loading" },
    } as never);

    expect(CapabilityArtifactSchema.safeParse(artifact).success).toBe(false);
  });
});

describe("artifact input values", () => {
  it("validates declared types and resolves references", () => {
    const contracts = validArtifact().inputs;
    const inputs = validateInputs(contracts, { memberId: "10001" });

    expect(resolveValue({ source: "input", key: "memberId" }, inputs)).toBe("10001");
  });

  it("rejects unknown inputs", () => {
    expect(() =>
      validateInputs(validArtifact().inputs, { memberId: "10001", extra: true }),
    ).toThrow("Unknown input: extra");
  });
});
