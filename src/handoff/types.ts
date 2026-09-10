import type { RiskClass } from "../artifact/schema.js";

export interface InterventionRequest {
  readonly runId: string;
  readonly reason: string;
  readonly stepId?: string;
  readonly goal?: string;
  readonly risk?: RiskClass;
  readonly screenshotPath: string;
  readonly currentUrl: string;
}

export interface HandoffResult {
  readonly resolution: "completed" | "resume_automation" | "abort";
  readonly note: string;
}

export interface HandoffHandler {
  request(intervention: InterventionRequest): Promise<HandoffResult>;
}
