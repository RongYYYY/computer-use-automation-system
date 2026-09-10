import type { CapabilityArtifact, TargetSpec } from "../artifact/schema.js";

const memberField: TargetSpec = {
  description: "Member number field",
  frame: { urlPattern: "^/legacy/search(?:\\?.*)?$", name: "workarea" },
  strategies: [
    { kind: "role", role: "textbox", name: "Member number", exact: true },
    { kind: "label", text: "Member number", exact: true },
    { kind: "css", selector: "input[name='member_number']" },
  ],
};

const searchButton: TargetSpec = {
  description: "Search button",
  frame: { urlPattern: "^/legacy/search(?:\\?.*)?$", name: "workarea" },
  strategies: [
    { kind: "role", role: "button", name: "Search", exact: true },
    { kind: "css", selector: "input[type='submit']" },
  ],
};

const savingsLink: TargetSpec = {
  description: "Savings account link",
  frame: { urlPattern: "^/legacy/member(?:\\?.*)?$", name: "workarea" },
  strategies: [
    { kind: "role", role: "link", name: "Savings", exact: true },
    { kind: "text", text: "Savings", exact: true },
  ],
};

const balanceField: TargetSpec = {
  description: "Current account balance",
  frame: { urlPattern: "^/legacy/account(?:\\?.*)?$", name: "workarea" },
  strategies: [
    { kind: "css", selector: "td[data-field='account-balance']" },
    { kind: "text", text: "$12,450.73", exact: true },
  ],
};

export function createLookupCapability(origin: string, fault?: string): CapabilityArtifact {
  const target = `${origin}/legacy${fault ? `?fault=${encodeURIComponent(fault)}` : ""}`;
  return {
    schemaVersion: "1.0",
    id: "northstar.lookup-savings-balance",
    version: "1.0.0",
    name: "Look up savings balance",
    description: "Find a synthetic member and return the current savings balance.",
    createdAt: new Date().toISOString(),
    app: {
      family: "northstar-demo",
      surface: "browser",
      baseUrlPattern: `${origin}/legacy`,
      supportedVariants: ["base", "maintenance-notice"],
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
      allowedOrigins: [origin],
      allowedPathPatterns: ["^/legacy(?:/|$|\\?)"],
      allowedActions: ["navigate", "click", "type", "extract", "wait_for"],
      riskyActionPolicy: "require_human",
    },
    steps: [
      {
        id: "open-member-search",
        description: "Open the member servicing console",
        action: { kind: "navigate", url: { source: "literal", value: target }, risk: "safe" },
        preconditions: [],
        postconditions: [{ kind: "visible", target: memberField }],
        timeoutMs: 8_000,
        retry: { maxAttempts: 2, backoffMs: 200 },
      },
      {
        id: "enter-member-id",
        description: "Enter the supplied member identifier",
        action: {
          kind: "type",
          target: memberField,
          value: { source: "input", key: "memberId" },
          clearFirst: true,
          risk: "safe",
        },
        preconditions: [{ kind: "visible", target: memberField }],
        postconditions: [],
        timeoutMs: 5_000,
        retry: { maxAttempts: 2, backoffMs: 100 },
      },
      {
        id: "submit-member-search",
        description: "Submit the member search",
        action: { kind: "click", target: searchButton, risk: "safe" },
        preconditions: [{ kind: "visible", target: searchButton }],
        postconditions: [],
        timeoutMs: 5_000,
        retry: { maxAttempts: 2, backoffMs: 150 },
      },
      {
        id: "open-savings-account",
        description: "Open the member's savings account",
        action: { kind: "click", target: savingsLink, risk: "safe" },
        preconditions: [{ kind: "visible", target: savingsLink }],
        postconditions: [{ kind: "visible", target: balanceField }],
        timeoutMs: 5_000,
        retry: { maxAttempts: 2, backoffMs: 150 },
      },
      {
        id: "extract-savings-balance",
        description: "Extract the current savings balance",
        action: {
          kind: "extract",
          target: balanceField,
          output: "balance",
          parser: "currency",
          risk: "safe",
        },
        preconditions: [{ kind: "visible", target: balanceField }],
        postconditions: [],
        timeoutMs: 5_000,
        retry: { maxAttempts: 1, backoffMs: 0 },
      },
    ],
    success: {
      conditions: [
        {
          kind: "visible",
          target: {
            description: "Savings Account heading",
            frame: { urlPattern: "^/legacy/account(?:\\?.*)?$", name: "workarea" },
            strategies: [
              { kind: "role", role: "heading", name: "Savings Account", exact: true },
            ],
          },
        },
      ],
    },
    knownOutcomes: [
      {
        code: "member_not_found",
        classification: "business",
        description: "No member exists for the supplied identifier.",
        condition: {
          kind: "visible",
          target: {
            description: "Member not found result",
            frame: { urlPattern: "^/legacy/member(?:\\?.*)?$", name: "workarea" },
            strategies: [
              {
                kind: "text",
                text: "No member found for the supplied member number.",
                exact: true,
              },
            ],
          },
        },
      },
      {
        code: "permission_denied",
        classification: "failure",
        description: "The operator role cannot view this member record.",
        condition: {
          kind: "visible",
          target: {
            description: "Permission denied error",
            frame: { urlPattern: "^/legacy/member(?:\\?.*)?$", name: "workarea" },
            strategies: [
              { kind: "role", role: "heading", name: "Permission denied", exact: true },
            ],
          },
        },
      },
      {
        code: "session_expired",
        classification: "failure",
        description: "The servicing session expired and requires a new login.",
        condition: {
          kind: "visible",
          target: {
            description: "Session expired error",
            frame: { urlPattern: "^/legacy/member(?:\\?.*)?$", name: "workarea" },
            strategies: [
              { kind: "role", role: "heading", name: "Session expired", exact: true },
            ],
          },
        },
      },
      {
        code: "maintenance_notice",
        classification: "recoverable",
        description: "A known maintenance notice blocks the current action.",
        condition: {
          kind: "visible",
          target: {
            description: "Maintenance notice",
            frame: { urlPattern: "^/legacy/search(?:\\?.*)?$", name: "workarea" },
            strategies: [
              { kind: "role", role: "dialog", name: "System notice", exact: true },
            ],
          },
        },
        recovery: {
          action: "dismiss_and_retry",
          target: {
            description: "Continue button on maintenance notice",
            frame: { urlPattern: "^/legacy/search(?:\\?.*)?$", name: "workarea" },
            strategies: [
              { kind: "role", role: "button", name: "Continue", exact: true },
            ],
          },
          maxAttempts: 1,
        },
      },
    ],
  };
}

export function createHandoffCapability(origin: string): CapabilityArtifact {
  const lookup = createLookupCapability(origin);
  const openSubaccount: TargetSpec = {
    description: "Open a new sub-account link",
    frame: { urlPattern: "^/legacy/account(?:\\?.*)?$", name: "workarea" },
    strategies: [
      { kind: "role", role: "link", name: "Open a new sub-account", exact: true },
      { kind: "text", text: "Open a new sub-account", exact: true },
    ],
  };
  const identityVerified: TargetSpec = {
    description: "Identity verified checkbox",
    frame: { urlPattern: "^/legacy/subaccount/start(?:\\?.*)?$", name: "workarea" },
    strategies: [
      { kind: "role", role: "checkbox", name: "Identity verified", exact: true },
      { kind: "label", text: "Identity verified", exact: true },
      { kind: "css", selector: "input[name='verified']" },
    ],
  };
  const continueToReview: TargetSpec = {
    description: "Continue to review button",
    frame: { urlPattern: "^/legacy/subaccount/start(?:\\?.*)?$", name: "workarea" },
    strategies: [
      { kind: "role", role: "button", name: "Continue to review", exact: true },
      { kind: "text", text: "Continue to review", exact: true },
    ],
  };
  const reviewHeading: TargetSpec = {
    description: "Review New Sub-account heading",
    frame: { urlPattern: "^/legacy/subaccount/review(?:\\?.*)?$", name: "workarea" },
    strategies: [
      { kind: "role", role: "heading", name: "Review New Sub-account", exact: true },
    ],
  };

  return {
    ...lookup,
    id: "northstar.review-new-subaccount",
    name: "Reach new sub-account review",
    description:
      "Look up a synthetic member, open the savings account, and reach sub-account review with human identity verification.",
    steps: [
      ...lookup.steps,
      {
        id: "open-subaccount-setup",
        description: "Open the new sub-account workflow",
        action: { kind: "click", target: openSubaccount, risk: "safe" },
        preconditions: [{ kind: "visible", target: openSubaccount }],
        postconditions: [{ kind: "visible", target: identityVerified }],
        timeoutMs: 5_000,
        retry: { maxAttempts: 2, backoffMs: 150 },
      },
      {
        id: "verify-member-identity",
        description: "Require a human operator to attest that identity was verified",
        action: { kind: "click", target: identityVerified, risk: "risky" },
        preconditions: [{ kind: "visible", target: identityVerified }],
        postconditions: [],
        timeoutMs: 5_000,
        retry: { maxAttempts: 1, backoffMs: 0 },
      },
      {
        id: "continue-to-subaccount-review",
        description: "Continue to the non-committing review screen",
        action: { kind: "click", target: continueToReview, risk: "safe" },
        preconditions: [{ kind: "visible", target: continueToReview }],
        postconditions: [{ kind: "visible", target: reviewHeading }],
        timeoutMs: 5_000,
        retry: { maxAttempts: 1, backoffMs: 0 },
      },
    ],
    success: { conditions: [{ kind: "visible", target: reviewHeading }] },
  };
}
