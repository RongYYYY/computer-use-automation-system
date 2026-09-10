import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { stdin, stdout } from "node:process";
import type { Frame } from "playwright";
import { RunLogger } from "../observability/run-logger.js";
import type { PlaywrightSurface } from "../surface/playwright-surface.js";
import { ControlLease } from "./control-lease.js";
import type { HandoffHandler, HandoffResult, InterventionRequest } from "./types.js";

export type OperatorPrompt = (request: InterventionRequest) => Promise<HandoffResult>;

export interface SameSessionHandoffOptions {
  readonly surface: PlaywrightSurface;
  readonly logger: RunLogger;
  readonly prompt: OperatorPrompt;
  readonly lease?: ControlLease;
}

export class SameSessionHandoff implements HandoffHandler {
  readonly lease: ControlLease;

  private readonly surface: PlaywrightSurface;
  private readonly logger: RunLogger;
  private readonly prompt: OperatorPrompt;
  private readonly bindingName = `__cuaHumanEvent_${randomUUID().replaceAll("-", "")}`;
  private captureInstalled = false;

  constructor(options: SameSessionHandoffOptions) {
    this.surface = options.surface;
    this.logger = options.logger;
    this.prompt = options.prompt;
    this.lease = options.lease ?? new ControlLease();
  }

  async request(request: InterventionRequest): Promise<HandoffResult> {
    await this.logTransition(this.lease.pauseAutomation());
    await this.installCapture();
    await this.logger.event("handoff.requested", {
      ...request,
      controlOwner: this.lease.owner,
    });
    await this.logTransition(this.lease.grantHumanControl());

    let result: HandoffResult;
    try {
      result = await this.prompt(request);
    } catch (error) {
      result = {
        resolution: "abort",
        note: error instanceof Error ? error.message : String(error),
      };
    }

    if (result.resolution === "abort") {
      await this.logTransition(this.lease.abort());
      await this.logger.event("handoff.operator_response", result);
      return result;
    }

    await this.logTransition(this.lease.beginResume());
    await this.logger.event("handoff.operator_response", result);
    await this.logTransition(this.lease.resumeAutomation());
    return result;
  }

  private async installCapture(): Promise<void> {
    if (this.captureInstalled) return;
    this.captureInstalled = true;
    await this.surface.context.exposeBinding(this.bindingName, async ({ frame }, event) => {
      if (this.lease.owner !== "human") return;
      await this.logger.event("human.action", {
        ...(event as Record<string, unknown>),
        frameUrl: frame.url(),
      });
    });
    await this.surface.context.addInitScript(humanCaptureScript, this.bindingName);
    await Promise.all(this.surface.page.frames().map((frame) => installOnFrame(frame, this.bindingName)));
  }

  private async logTransition(transition: ReturnType<ControlLease["pauseAutomation"]>): Promise<void> {
    await this.logger.event("control.transition", transition);
  }
}

export function terminalOperatorPrompt(): OperatorPrompt {
  return async (request) => {
    stdout.write(
      `\nHuman intervention required\nReason: ${request.reason}\nURL: ${request.currentUrl}\n` +
        `Evidence: ${request.screenshotPath}\nOperate the visible browser in the same session.\n`,
    );
    const readline = createInterface({ input: stdin, output: stdout });
    try {
      while (true) {
        const answer = (await readline.question(
          "Enter [c] if you completed the step, [r] to resume automation, or [a] to abort: ",
        ))
          .trim()
          .toLowerCase();
        if (answer === "c") return { resolution: "completed", note: "Operator completed the step" };
        if (answer === "r") {
          return { resolution: "resume_automation", note: "Operator cleared the blocker" };
        }
        if (answer === "a") return { resolution: "abort", note: "Operator aborted the run" };
      }
    } finally {
      readline.close();
    }
  };
}

async function installOnFrame(frame: Frame, bindingName: string): Promise<void> {
  await frame.evaluate(humanCaptureScript, bindingName).catch(() => undefined);
}

function humanCaptureScript(bindingName: string): void {
  const marker = "__cuaHumanCaptureInstalled";
  const windowRecord = window as unknown as Record<string, unknown>;
  if (windowRecord[marker]) return;
  windowRecord[marker] = true;
  const send = (kind: string, event: Event) => {
    if (!event.isTrusted || !(event.target instanceof HTMLElement)) return;
    const element = event.target;
    const input = element instanceof HTMLInputElement ? element : undefined;
    const label = input?.labels?.[0]?.textContent?.trim();
    const binding = windowRecord[bindingName];
    if (typeof binding !== "function") return;
    void binding({
      kind,
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      name: element.getAttribute("aria-label") || label || element.textContent?.trim().slice(0, 120),
      inputType: input?.type,
      checked: input?.type === "checkbox" ? input.checked : undefined,
    });
  };
  document.addEventListener("click", (event) => send("click", event), true);
  document.addEventListener("change", (event) => send("change", event), true);
}
