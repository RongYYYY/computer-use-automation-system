import type {
  Condition,
  Scalar,
  TargetSpec,
  ValueExpression,
} from "../artifact/schema.js";

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface ControlCandidate {
  readonly id: string;
  readonly frameUrl: string;
  readonly frameName?: string;
  readonly tag: string;
  readonly role: string;
  readonly name: string;
  readonly text: string;
  readonly label?: string;
  readonly inputType?: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface SurfaceObservation {
  readonly url: string;
  readonly title: string;
  readonly pageText: string;
  readonly candidates: readonly ControlCandidate[];
  readonly screenshotBase64: string;
  readonly viewport: ViewportSize;
}

export interface LocatorResolution {
  readonly target: string;
  readonly strategyKind: string;
  readonly strategyIndex: number;
  readonly frameUrl: string;
}

export interface SurfaceAdapter {
  readonly kind: "browser";
  navigate(url: string): Promise<void>;
  observe(): Promise<SurfaceObservation>;
  buildTarget(candidateId: string): TargetSpec;
  clickCandidate(candidateId: string): Promise<void>;
  typeCandidate(candidateId: string, value: string, clearFirst: boolean): Promise<void>;
  extractCandidate(candidateId: string): Promise<string>;
  click(target: TargetSpec, timeoutMs: number): Promise<LocatorResolution>;
  type(
    target: TargetSpec,
    value: string,
    clearFirst: boolean,
    timeoutMs: number,
  ): Promise<LocatorResolution>;
  extract(target: TargetSpec, timeoutMs: number): Promise<{
    readonly value: string;
    readonly resolution: LocatorResolution;
  }>;
  check(
    condition: Condition,
    inputs: Readonly<Record<string, Scalar>>,
    timeoutMs: number,
  ): Promise<boolean>;
  waitFor(
    condition: Condition,
    inputs: Readonly<Record<string, Scalar>>,
    timeoutMs: number,
  ): Promise<void>;
  screenshot(path: string): Promise<void>;
  currentUrl(): string;
  close(): Promise<void>;
}

export function expressionDescription(expression: ValueExpression): string {
  return expression.source === "input"
    ? `input:${expression.key}`
    : `literal:${String(expression.value)}`;
}
