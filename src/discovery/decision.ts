import { z } from "zod";
import type { ControlCandidate, SurfaceObservation } from "../surface/types.js";
import type { Scalar } from "../artifact/schema.js";

export const DiscoveryDecisionSchema = z
  .object({
    action: z.enum([
      "click",
      "type",
      "extract",
      "wait",
      "finish",
      "escalate",
      "business_outcome",
    ]),
    candidateId: z.string().nullable(),
    value: z.string().nullable(),
    valueSource: z.enum(["literal", "input"]).nullable(),
    inputKey: z.string().nullable(),
    outputName: z.string().nullable(),
    parser: z.enum(["text", "currency", "number", "boolean"]).nullable(),
    outcomeCode: z.string().nullable(),
    waitMs: z.number().int().min(100).max(5_000).nullable(),
    risk: z.enum(["safe", "reversible", "risky", "irreversible"]),
    reason: z.string().min(1).max(600),
  })
  .strict()
  .superRefine((decision, context) => {
    if (["click", "type", "extract", "finish"].includes(decision.action) && !decision.candidateId) {
      context.addIssue({
        code: "custom",
        path: ["candidateId"],
        message: `${decision.action} requires a candidateId`,
      });
    }
    if (decision.action === "type") {
      if (!decision.valueSource) {
        context.addIssue({ code: "custom", path: ["valueSource"], message: "type requires valueSource" });
      }
      if (decision.valueSource === "input" && !decision.inputKey) {
        context.addIssue({ code: "custom", path: ["inputKey"], message: "input value requires inputKey" });
      }
      if (decision.valueSource === "literal" && decision.value === null) {
        context.addIssue({ code: "custom", path: ["value"], message: "literal value is required" });
      }
    }
    if (decision.action === "extract" && (!decision.outputName || !decision.parser)) {
      context.addIssue({
        code: "custom",
        path: ["outputName"],
        message: "extract requires outputName and parser",
      });
    }
    if (decision.action === "business_outcome" && !decision.outcomeCode) {
      context.addIssue({ code: "custom", path: ["outcomeCode"], message: "outcome code is required" });
    }
  });

export type DiscoveryDecision = z.infer<typeof DiscoveryDecisionSchema>;

export interface DecisionContext {
  readonly goal: string;
  readonly target: string;
  readonly observation: SurfaceObservation;
  readonly inputs: Readonly<Record<string, Scalar>>;
  readonly declaredOutputs: readonly string[];
  readonly extractedOutputs: Readonly<Record<string, Scalar>>;
  readonly history: readonly {
    readonly action: string;
    readonly target?: string;
    readonly result: string;
  }[];
}

export interface DecisionProvider {
  readonly name?: string;
  readonly model?: string;
  decide(context: DecisionContext): Promise<DiscoveryDecision>;
}

export function assertCandidate(
  decision: DiscoveryDecision,
  candidates: readonly ControlCandidate[],
): ControlCandidate {
  const candidate = candidates.find(({ id }) => id === decision.candidateId);
  if (!candidate) throw new Error(`Decision references unknown candidate: ${decision.candidateId}`);
  return candidate;
}

export const discoveryDecisionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "action",
    "candidateId",
    "value",
    "valueSource",
    "inputKey",
    "outputName",
    "parser",
    "outcomeCode",
    "waitMs",
    "risk",
    "reason",
  ],
  properties: {
    action: {
      type: "string",
      enum: ["click", "type", "extract", "wait", "finish", "escalate", "business_outcome"],
    },
    candidateId: { type: ["string", "null"] },
    value: { type: ["string", "null"] },
    valueSource: { type: ["string", "null"], enum: ["literal", "input", null] },
    inputKey: { type: ["string", "null"] },
    outputName: { type: ["string", "null"] },
    parser: { type: ["string", "null"], enum: ["text", "currency", "number", "boolean", null] },
    outcomeCode: { type: ["string", "null"] },
    waitMs: { type: ["integer", "null"], minimum: 100, maximum: 5_000 },
    risk: { type: "string", enum: ["safe", "reversible", "risky", "irreversible"] },
    reason: { type: "string", minLength: 1, maxLength: 600 },
  },
} as const;
