import type { Action, CapabilityArtifact, RiskClass } from "../artifact/schema.js";
import { resolveValue } from "../artifact/values.js";
import type { Scalar } from "../artifact/schema.js";

type ArtifactPolicy = CapabilityArtifact["policy"];

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly requiresHuman: boolean;
  readonly reason: string;
}

export class PolicyViolationError extends Error {
  readonly code = "policy_violation";

  constructor(readonly decision: PolicyDecision) {
    super(decision.reason);
    this.name = "PolicyViolationError";
  }
}

export function evaluateNavigation(urlValue: string, policy: ArtifactPolicy): PolicyDecision {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return deny(`Navigation target is not an absolute URL: ${urlValue}`);
  }

  if (!policy.allowedOrigins.includes(url.origin)) {
    return deny(`Origin is outside the allowlist: ${url.origin}`);
  }
  const route = `${url.pathname}${url.search}`;
  if (!policy.allowedPathPatterns.some((pattern) => new RegExp(pattern).test(route))) {
    return deny(`Route is outside the allowlist: ${route}`);
  }
  return allow("Navigation target is allowlisted");
}

export function evaluateAction(
  action: Action,
  policy: ArtifactPolicy,
  inputs: Readonly<Record<string, Scalar>> = {},
): PolicyDecision {
  if (!policy.allowedActions.includes(action.kind)) {
    return deny(`Action type is outside the allowlist: ${action.kind}`);
  }

  if (action.kind === "navigate") {
    const url = String(resolveValue(action.url, inputs));
    const navigation = evaluateNavigation(url, policy);
    if (!navigation.allowed) return navigation;
  }

  return evaluateRisk(action.risk, policy.riskyActionPolicy);
}

export function assertPolicy(
  action: Action,
  policy: ArtifactPolicy,
  inputs: Readonly<Record<string, Scalar>> = {},
): PolicyDecision {
  const decision = evaluateAction(action, policy, inputs);
  if (!decision.allowed) throw new PolicyViolationError(decision);
  return decision;
}

function evaluateRisk(
  risk: RiskClass,
  riskyActionPolicy: ArtifactPolicy["riskyActionPolicy"],
): PolicyDecision {
  if (risk === "safe" || risk === "reversible") {
    return allow(`${risk} action is permitted`);
  }
  if (riskyActionPolicy === "block") {
    return deny(`${risk} action is blocked by policy`);
  }
  return {
    allowed: true,
    requiresHuman: true,
    reason: `${risk} action requires human control`,
  };
}

function allow(reason: string): PolicyDecision {
  return { allowed: true, requiresHuman: false, reason };
}

function deny(reason: string): PolicyDecision {
  return { allowed: false, requiresHuman: false, reason };
}
