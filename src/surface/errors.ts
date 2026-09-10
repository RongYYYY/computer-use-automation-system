export interface ResolutionAttempt {
  readonly strategy: string;
  readonly matchCount: number;
  readonly detail: string;
}

export class TargetResolutionError extends Error {
  readonly code = "target_resolution_failed";

  constructor(
    readonly targetDescription: string,
    readonly attempts: readonly ResolutionAttempt[],
  ) {
    super(
      `Could not uniquely resolve ${targetDescription}: ${attempts
        .map(({ strategy, matchCount }) => `${strategy}=${matchCount}`)
        .join(", ")}`,
    );
    this.name = "TargetResolutionError";
  }
}
