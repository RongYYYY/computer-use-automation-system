import { z } from "zod";

export const ScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
export type Scalar = z.infer<typeof ScalarSchema>;

export const ValueTypeSchema = z.enum(["string", "number", "boolean"]);
export type ValueType = z.infer<typeof ValueTypeSchema>;

export const FieldContractSchema = z
  .object({
    name: z.string().min(1),
    type: ValueTypeSchema,
    description: z.string().min(1),
    required: z.boolean(),
    sensitive: z.boolean(),
  })
  .strict();
export type FieldContract = z.infer<typeof FieldContractSchema>;

export const ValueExpressionSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("literal"),
      value: ScalarSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal("input"),
      key: z.string().min(1),
    })
    .strict(),
]);
export type ValueExpression = z.infer<typeof ValueExpressionSchema>;

export const LocatorStrategySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("role"),
      role: z.string().min(1),
      name: z.string().min(1),
      exact: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("label"),
      text: z.string().min(1),
      exact: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("text"),
      text: z.string().min(1),
      exact: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("css"),
      selector: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("coordinates"),
      x: z.number().nonnegative(),
      y: z.number().nonnegative(),
      viewport: z
        .object({
          width: z.number().positive(),
          height: z.number().positive(),
        })
        .strict(),
    })
    .strict(),
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategySchema>;

export const TargetSpecSchema = z
  .object({
    description: z.string().min(1),
    frame: z
      .object({
        urlPattern: z.string().min(1),
        name: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    strategies: z.array(LocatorStrategySchema).min(1),
  })
  .strict();
export type TargetSpec = z.infer<typeof TargetSpecSchema>;

export const ConditionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("visible"),
      target: TargetSpecSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("text_contains"),
      target: TargetSpecSchema,
      value: ValueExpressionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("url_matches"),
      pattern: z.string().min(1),
    })
    .strict(),
]);
export type Condition = z.infer<typeof ConditionSchema>;

export const RiskClassSchema = z.enum([
  "safe",
  "reversible",
  "risky",
  "irreversible",
]);
export type RiskClass = z.infer<typeof RiskClassSchema>;

export const ActionKindSchema = z.enum([
  "navigate",
  "click",
  "type",
  "extract",
  "wait_for",
]);

const NavigateActionSchema = z
  .object({
    kind: z.literal("navigate"),
    url: ValueExpressionSchema,
    risk: RiskClassSchema,
  })
  .strict();

const ClickActionSchema = z
  .object({
    kind: z.literal("click"),
    target: TargetSpecSchema,
    risk: RiskClassSchema,
  })
  .strict();

const TypeActionSchema = z
  .object({
    kind: z.literal("type"),
    target: TargetSpecSchema,
    value: ValueExpressionSchema,
    clearFirst: z.boolean(),
    risk: RiskClassSchema,
  })
  .strict();

const ExtractActionSchema = z
  .object({
    kind: z.literal("extract"),
    target: TargetSpecSchema,
    output: z.string().min(1),
    parser: z.enum(["text", "currency", "number", "boolean"]),
    risk: z.literal("safe"),
  })
  .strict();

const WaitForActionSchema = z
  .object({
    kind: z.literal("wait_for"),
    condition: ConditionSchema,
    risk: z.literal("safe"),
  })
  .strict();

export const ActionSchema = z.discriminatedUnion("kind", [
  NavigateActionSchema,
  ClickActionSchema,
  TypeActionSchema,
  ExtractActionSchema,
  WaitForActionSchema,
]);
export type Action = z.infer<typeof ActionSchema>;

export const StepSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    description: z.string().min(1),
    action: ActionSchema,
    preconditions: z.array(ConditionSchema),
    postconditions: z.array(ConditionSchema),
    timeoutMs: z.number().int().positive().max(60_000),
    retry: z
      .object({
        maxAttempts: z.number().int().min(1).max(5),
        backoffMs: z.number().int().nonnegative().max(10_000),
      })
      .strict(),
  })
  .strict();
export type Step = z.infer<typeof StepSchema>;

export const KnownOutcomeSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_]*$/),
    classification: z.enum(["business", "recoverable", "failure"]),
    description: z.string().min(1),
    condition: ConditionSchema,
    recovery: z
      .object({
        action: z.enum(["retry_step", "dismiss_and_retry"]),
        target: TargetSpecSchema.optional(),
        maxAttempts: z.number().int().min(1).max(3),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((outcome, context) => {
    if (outcome.classification === "recoverable" && !outcome.recovery) {
      context.addIssue({
        code: "custom",
        path: ["recovery"],
        message: "Recoverable outcomes require a bounded recovery policy",
      });
    }
    if (outcome.classification !== "recoverable" && outcome.recovery) {
      context.addIssue({
        code: "custom",
        path: ["recovery"],
        message: "Only recoverable outcomes may define recovery",
      });
    }
  });

export const CapabilityArtifactSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    id: z.string().regex(/^[a-z][a-z0-9._-]*$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    name: z.string().min(1),
    description: z.string().min(1),
    createdAt: z.string().datetime(),
    app: z
      .object({
        family: z.string().min(1),
        surface: z.literal("browser"),
        baseUrlPattern: z.string().min(1),
        supportedVariants: z.array(z.string().min(1)),
      })
      .strict(),
    inputs: z.array(FieldContractSchema),
    outputs: z.array(FieldContractSchema),
    policy: z
      .object({
        allowedOrigins: z.array(z.string().url()).min(1),
        allowedPathPatterns: z.array(z.string().min(1)).min(1),
        allowedActions: z.array(ActionKindSchema).min(1),
        riskyActionPolicy: z.enum(["block", "require_human"]),
      })
      .strict(),
    steps: z.array(StepSchema).min(1),
    success: z
      .object({
        conditions: z.array(ConditionSchema).min(1),
      })
      .strict(),
    knownOutcomes: z.array(KnownOutcomeSchema),
  })
  .strict()
  .superRefine((artifact, context) => {
    requireUnique(artifact.inputs, "name", "inputs", context);
    requireUnique(artifact.outputs, "name", "outputs", context);
    requireUnique(artifact.steps, "id", "steps", context);
    requireUnique(artifact.knownOutcomes, "code", "knownOutcomes", context);

    const inputNames = new Set(artifact.inputs.map(({ name }) => name));
    const outputNames = new Set(artifact.outputs.map(({ name }) => name));

    artifact.steps.forEach((step, index) => {
      for (const reference of collectInputReferences(step)) {
        if (!inputNames.has(reference)) {
          context.addIssue({
            code: "custom",
            path: ["steps", index],
            message: `Step references undeclared input: ${reference}`,
          });
        }
      }

      if (step.action.kind === "extract" && !outputNames.has(step.action.output)) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "action", "output"],
          message: `Extract step references undeclared output: ${step.action.output}`,
        });
      }
    });
  });

export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;

export const EvidenceReferenceSchema = z
  .object({
    kind: z.enum(["screenshot", "trace", "log"]),
    path: z.string().min(1),
  })
  .strict();

export const ReplayResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("success"),
      outputs: z.record(z.string(), ScalarSchema),
      runId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal("business_outcome"),
      code: z.string().min(1),
      details: z.record(z.string(), ScalarSchema),
      runId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal("failure"),
      code: z.string().min(1),
      message: z.string().min(1),
      stepId: z.string().min(1).optional(),
      expected: z.string().optional(),
      observed: z.string().optional(),
      evidence: z.array(EvidenceReferenceSchema),
      runId: z.string().min(1),
    })
    .strict(),
]);
export type ReplayResult = z.infer<typeof ReplayResultSchema>;

export function parseCapabilityArtifact(value: unknown): CapabilityArtifact {
  return CapabilityArtifactSchema.parse(value);
}

function requireUnique<T extends Record<K, string>, K extends keyof T>(
  values: readonly T[],
  key: K,
  path: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const candidate = value[key];
    if (seen.has(candidate)) {
      context.addIssue({
        code: "custom",
        path: [path, index, key as string],
        message: `Duplicate ${String(key)}: ${candidate}`,
      });
    }
    seen.add(candidate);
  });
}

function collectInputReferences(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectInputReferences);
  }
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const current =
    record.source === "input" && typeof record.key === "string" ? [record.key] : [];
  return current.concat(Object.values(record).flatMap(collectInputReferences));
}
