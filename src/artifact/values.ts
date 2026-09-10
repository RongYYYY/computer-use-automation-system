import type { FieldContract, Scalar, ValueExpression } from "./schema.js";

export function validateInputs(
  contracts: readonly FieldContract[],
  values: Readonly<Record<string, Scalar>>,
): Record<string, Scalar> {
  const result: Record<string, Scalar> = {};
  const known = new Set(contracts.map(({ name }) => name));

  for (const supplied of Object.keys(values)) {
    if (!known.has(supplied)) {
      throw new Error(`Unknown input: ${supplied}`);
    }
  }

  for (const contract of contracts) {
    const value = values[contract.name];
    if (value === undefined) {
      if (contract.required) {
        throw new Error(`Missing required input: ${contract.name}`);
      }
      continue;
    }
    if (typeof value !== contract.type) {
      throw new Error(
        `Invalid input ${contract.name}: expected ${contract.type}, got ${typeof value}`,
      );
    }
    result[contract.name] = value;
  }

  return result;
}

export function resolveValue(
  expression: ValueExpression,
  inputs: Readonly<Record<string, Scalar>>,
): Scalar {
  if (expression.source === "literal") {
    return expression.value;
  }
  const value = inputs[expression.key];
  if (value === undefined) {
    throw new Error(`Input is unavailable at execution time: ${expression.key}`);
  }
  return value;
}
