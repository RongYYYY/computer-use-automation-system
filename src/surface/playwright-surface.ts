import {
  chromium,
  type Browser,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from "playwright";
import { resolveValue } from "../artifact/values.js";
import type { Condition, LocatorStrategy, Scalar, TargetSpec } from "../artifact/schema.js";
import { TargetResolutionError, type ResolutionAttempt } from "./errors.js";
import type {
  ControlCandidate,
  LocatorResolution,
  SurfaceAdapter,
  SurfaceObservation,
  ViewportSize,
} from "./types.js";

const OBSERVABLE_SELECTOR = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "[role]",
  "[data-field]",
  "td",
  "th",
  "h1",
  "h2",
].join(",");

interface RuntimeCandidate extends ControlCandidate {
  readonly runtimeSelector: string;
}

interface ResolvedLocator {
  readonly locator: Locator;
  readonly resolution: LocatorResolution;
}

export interface PlaywrightSurfaceOptions {
  readonly headless?: boolean;
  readonly viewport?: ViewportSize;
}

export class PlaywrightSurface implements SurfaceAdapter {
  readonly kind = "browser" as const;
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;

  private candidates = new Map<string, RuntimeCandidate>();

  private constructor(browser: Browser, context: BrowserContext, page: Page) {
    this.browser = browser;
    this.context = context;
    this.page = page;
  }

  static async launch(options: PlaywrightSurfaceOptions = {}): Promise<PlaywrightSurface> {
    const browser = await chromium.launch({ headless: options.headless ?? true });
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    return new PlaywrightSurface(browser, context, page);
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  async observe(): Promise<SurfaceObservation> {
    const viewport = this.page.viewportSize() ?? { width: 1280, height: 800 };
    const candidates: RuntimeCandidate[] = [];
    let nextId = 0;

    for (const frame of this.page.frames()) {
      const frameCandidates = await frame.locator(OBSERVABLE_SELECTOR).evaluateAll((elements) =>
        elements.flatMap((element, domIndex) => {
          if (!(element instanceof HTMLElement)) return [];
          const style = getComputedStyle(element);
          const bounds = element.getBoundingClientRect();
          const visible =
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            bounds.width > 0 &&
            bounds.height > 0;
          if (!visible) return [];

          const input = element instanceof HTMLInputElement ? element : undefined;
          const label =
            input?.labels?.[0]?.textContent?.trim() ||
            (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement
              ? element.labels?.[0]?.textContent?.trim()
              : undefined);
          const text = (element.innerText || element.textContent || "").trim().replace(/\s+/g, " ");
          const explicitName =
            element.getAttribute("aria-label") ||
            label ||
            (input?.type === "submit" ? input.value : "") ||
            text ||
            element.getAttribute("placeholder") ||
            element.getAttribute("name") ||
            "";
          const tag = element.tagName.toLowerCase();
          const inputType = input?.type || element.getAttribute("type") || undefined;
          const role = inferRole(element, tag, inputType);
          const attributes = Object.fromEntries(
            ["name", "type", "href", "data-field", "value"]
              .map((name) => [name, element.getAttribute(name)] as const)
              .filter((pair): pair is readonly [string, string] => pair[1] !== null),
          );

          return [
            {
              domIndex,
              tag,
              role,
              name: explicitName.slice(0, 200),
              text: text.slice(0, 300),
              label: label?.slice(0, 200),
              inputType,
              attributes,
              bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
            },
          ];

          function inferRole(node: HTMLElement, nodeTag: string, type: string | undefined): string {
            const explicit = node.getAttribute("role");
            if (explicit) return explicit;
            if (nodeTag === "a") return "link";
            if (nodeTag === "button" || (nodeTag === "input" && ["button", "submit"].includes(type ?? ""))) {
              return "button";
            }
            if (nodeTag === "select") return "combobox";
            if (nodeTag === "input" && type === "checkbox") return "checkbox";
            if (nodeTag === "input" || nodeTag === "textarea") return "textbox";
            if (/^h[1-6]$/.test(nodeTag)) return "heading";
            if (nodeTag === "th") return "columnheader";
            if (nodeTag === "td") return "cell";
            return "generic";
          }
        }),
      );

      for (const candidate of frameCandidates) {
        const id = `c${nextId++}`;
        const runtimeSelector = `[data-cua-runtime-ref="${id}"]`;
        const element = frame.locator(OBSERVABLE_SELECTOR).nth(candidate.domIndex);
        await element.evaluate(
          (node, runtimeId) => node.setAttribute("data-cua-runtime-ref", runtimeId),
          id,
        );
        const { domIndex: _domIndex, label, inputType, ...metadata } = candidate;
        candidates.push({
          id,
          frameUrl: frame.url(),
          ...(frame.name() ? { frameName: frame.name() } : {}),
          ...metadata,
          ...(label ? { label } : {}),
          ...(inputType ? { inputType } : {}),
          runtimeSelector,
        });
      }
    }

    this.candidates = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const frameText = await Promise.all(
      this.page.frames().map(async (frame) => {
        const text = await frame.locator("body").innerText().catch(() => "");
        return `[Frame ${frame.url()}]\n${text.trim()}`;
      }),
    );
    const screenshot = await this.page.screenshot({ type: "png" });

    return {
      url: this.page.url(),
      title: await this.page.title(),
      pageText: frameText.join("\n\n").slice(0, 12_000),
      candidates: candidates.map(stripRuntimeSelector),
      screenshotBase64: screenshot.toString("base64"),
      viewport,
    };
  }

  buildTarget(candidateId: string): TargetSpec {
    const candidate = this.requireCandidate(candidateId);
    const strategies: LocatorStrategy[] = [];

    if (candidate.role !== "generic" && candidate.name) {
      strategies.push({
        kind: "role",
        role: candidate.role,
        name: candidate.name,
        exact: true,
      });
    }
    if (candidate.label) {
      strategies.push({ kind: "label", text: candidate.label, exact: true });
    }
    if (candidate.attributes["data-field"]) {
      strategies.push({
        kind: "css",
        selector: `${candidate.tag}[data-field="${cssEscape(candidate.attributes["data-field"])}"]`,
      });
    }
    if (candidate.attributes.name) {
      strategies.push({
        kind: "css",
        selector: `${candidate.tag}[name="${cssEscape(candidate.attributes.name)}"]`,
      });
    }
    if (candidate.text) {
      strategies.push({ kind: "text", text: candidate.text, exact: true });
    }
    if (strategies.length === 0) {
      strategies.push({ kind: "css", selector: candidate.tag });
    }

    const frameUrl = new URL(candidate.frameUrl);
    const frame =
      candidate.frameUrl === this.page.url()
        ? undefined
        : {
            urlPattern: `^${regexpEscape(frameUrl.pathname)}(?:\\?.*)?$`,
            ...(candidate.frameName ? { name: candidate.frameName } : {}),
          };

    return {
      description: candidate.name || candidate.text || `${candidate.tag} control`,
      ...(frame ? { frame } : {}),
      strategies,
    };
  }

  async clickCandidate(candidateId: string): Promise<void> {
    const { frame, candidate } = this.runtimeLocator(candidateId);
    await frame.locator(candidate.runtimeSelector).click();
  }

  async typeCandidate(candidateId: string, value: string, clearFirst: boolean): Promise<void> {
    const { frame, candidate } = this.runtimeLocator(candidateId);
    const locator = frame.locator(candidate.runtimeSelector);
    if (clearFirst) await locator.fill("");
    await locator.fill(value);
  }

  async extractCandidate(candidateId: string): Promise<string> {
    const { frame, candidate } = this.runtimeLocator(candidateId);
    return (await frame.locator(candidate.runtimeSelector).innerText()).trim();
  }

  async click(target: TargetSpec, timeoutMs: number): Promise<LocatorResolution> {
    const resolved = await this.resolve(target, timeoutMs);
    await resolved.locator.click({ timeout: timeoutMs });
    return resolved.resolution;
  }

  async type(
    target: TargetSpec,
    value: string,
    clearFirst: boolean,
    timeoutMs: number,
  ): Promise<LocatorResolution> {
    const resolved = await this.resolve(target, timeoutMs);
    if (clearFirst) await resolved.locator.fill("", { timeout: timeoutMs });
    await resolved.locator.fill(value, { timeout: timeoutMs });
    return resolved.resolution;
  }

  async extract(
    target: TargetSpec,
    timeoutMs: number,
  ): Promise<{ value: string; resolution: LocatorResolution }> {
    const resolved = await this.resolve(target, timeoutMs);
    return {
      value: (await resolved.locator.innerText({ timeout: timeoutMs })).trim(),
      resolution: resolved.resolution,
    };
  }

  async check(
    condition: Condition,
    inputs: Readonly<Record<string, Scalar>>,
    timeoutMs: number,
  ): Promise<boolean> {
    try {
      if (condition.kind === "url_matches") {
        return new RegExp(condition.pattern).test(this.page.url());
      }
      const resolved = await this.resolve(condition.target, timeoutMs);
      if (condition.kind === "visible") {
        return resolved.locator.isVisible();
      }
      const expected = String(resolveValue(condition.value, inputs));
      const actual = await resolved.locator.innerText({ timeout: timeoutMs });
      return actual.includes(expected);
    } catch {
      return false;
    }
  }

  async waitFor(
    condition: Condition,
    inputs: Readonly<Record<string, Scalar>>,
    timeoutMs: number,
  ): Promise<void> {
    if (condition.kind === "url_matches") {
      await this.page.waitForURL(new RegExp(condition.pattern), { timeout: timeoutMs });
      return;
    }
    const resolved = await this.resolve(condition.target, timeoutMs);
    if (condition.kind === "visible") {
      await resolved.locator.waitFor({ state: "visible", timeout: timeoutMs });
      return;
    }
    const expected = String(resolveValue(condition.value, inputs));
    await resolved.locator.filter({ hasText: expected }).waitFor({ state: "visible", timeout: timeoutMs });
  }

  async screenshot(path: string): Promise<void> {
    await this.page.screenshot({ path, type: "png", fullPage: true });
  }

  currentUrl(): string {
    return this.page.url();
  }

  async close(): Promise<void> {
    await this.context.close();
    await this.browser.close();
  }

  private requireCandidate(candidateId: string): RuntimeCandidate {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) {
      throw new Error(`Unknown or stale candidate: ${candidateId}`);
    }
    return candidate;
  }

  private runtimeLocator(candidateId: string): { frame: Frame; candidate: RuntimeCandidate } {
    const candidate = this.requireCandidate(candidateId);
    const frame = this.page.frames().find((item) => item.url() === candidate.frameUrl);
    if (!frame) throw new Error(`Candidate frame is no longer available: ${candidate.frameUrl}`);
    return { frame, candidate };
  }

  private async resolve(target: TargetSpec, timeoutMs: number): Promise<ResolvedLocator> {
    const frames = this.targetFrames(target);
    const attempts: ResolutionAttempt[] = [];

    for (const [strategyIndex, strategy] of target.strategies.entries()) {
      if (strategy.kind === "coordinates") {
        attempts.push({ strategy: "coordinates", matchCount: 0, detail: "Coordinate replay is action-only" });
        continue;
      }

      for (const frame of frames) {
        const locator = locatorFor(frame, strategy);
        const count = await locator.count();
        attempts.push({
          strategy: strategy.kind,
          matchCount: count,
          detail: `${frame.url()} :: ${strategyDescription(strategy)}`,
        });
        if (count !== 1) continue;
        const candidate = locator.first();
        await candidate.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 2_000) }).catch(() => undefined);
        if (!(await candidate.isVisible())) continue;
        return {
          locator: candidate,
          resolution: {
            target: target.description,
            strategyKind: strategy.kind,
            strategyIndex,
            frameUrl: frame.url(),
          },
        };
      }
    }

    throw new TargetResolutionError(target.description, attempts);
  }

  private targetFrames(target: TargetSpec): Frame[] {
    if (!target.frame) return [this.page.mainFrame()];
    const pattern = new RegExp(target.frame.urlPattern);
    return this.page.frames().filter((frame) => {
      const url = new URL(frame.url());
      const matchesUrl = pattern.test(`${url.pathname}${url.search}`) || pattern.test(frame.url());
      const matchesName = target.frame?.name ? frame.name() === target.frame.name : true;
      return matchesUrl && matchesName;
    });
  }
}

function locatorFor(frame: Frame, strategy: Exclude<LocatorStrategy, { kind: "coordinates" }>): Locator {
  switch (strategy.kind) {
    case "role":
      return frame.getByRole(strategy.role as Parameters<Frame["getByRole"]>[0], {
        name: strategy.name,
        exact: strategy.exact,
      });
    case "label":
      return frame.getByLabel(strategy.text, { exact: strategy.exact });
    case "text":
      return frame.getByText(strategy.text, { exact: strategy.exact });
    case "css":
      return frame.locator(strategy.selector);
  }
}

function strategyDescription(strategy: LocatorStrategy): string {
  switch (strategy.kind) {
    case "role":
      return `${strategy.role}:${strategy.name}`;
    case "label":
    case "text":
      return strategy.text;
    case "css":
      return strategy.selector;
    case "coordinates":
      return `${strategy.x},${strategy.y}`;
  }
}

function stripRuntimeSelector(candidate: RuntimeCandidate): ControlCandidate {
  const { runtimeSelector: _runtimeSelector, ...publicCandidate } = candidate;
  return publicCandidate;
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function regexpEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
