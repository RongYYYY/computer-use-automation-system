export type ControlOwner = "automation" | "pausing" | "human" | "resuming" | "aborted";

export interface ControlTransition {
  readonly from: ControlOwner;
  readonly to: ControlOwner;
  readonly at: string;
}

export class ControlLease {
  private state: ControlOwner = "automation";
  private readonly history: ControlTransition[] = [];

  get owner(): ControlOwner {
    return this.state;
  }

  get transitions(): readonly ControlTransition[] {
    return this.history;
  }

  pauseAutomation(): ControlTransition {
    return this.transition("automation", "pausing");
  }

  grantHumanControl(): ControlTransition {
    return this.transition("pausing", "human");
  }

  beginResume(): ControlTransition {
    return this.transition("human", "resuming");
  }

  resumeAutomation(): ControlTransition {
    return this.transition("resuming", "automation");
  }

  abort(): ControlTransition {
    if (this.state !== "human") {
      throw new Error(`Cannot abort while control owner is ${this.state}`);
    }
    return this.transition("human", "aborted");
  }

  private transition(expected: ControlOwner, next: ControlOwner): ControlTransition {
    if (this.state !== expected) {
      throw new Error(`Invalid control transition ${this.state} -> ${next}; expected ${expected}`);
    }
    const transition = { from: this.state, to: next, at: new Date().toISOString() };
    this.state = next;
    this.history.push(transition);
    return transition;
  }
}
