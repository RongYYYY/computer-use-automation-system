const SECRET_KEY_PATTERN = /(?:api[_-]?key|authorization|password|secret|token|credential)/i;
const API_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;

export class Redactor {
  private readonly replacements: { value: string; replacement: string }[] = [];

  constructor(sensitiveValues: Readonly<Record<string, unknown>> = {}) {
    for (const [name, value] of Object.entries(sensitiveValues)) this.add(name, value);
  }

  add(name: string, value: unknown): void {
    if (!["string", "number", "boolean"].includes(typeof value)) return;
    const text = String(value);
    if (!text || this.replacements.some((item) => item.value === text)) return;
    this.replacements.push({ value: text, replacement: `[REDACTED:${name}]` });
    this.replacements.sort((left, right) => right.value.length - left.value.length);
  }

  text(value: string): string {
    let result = value
      .replace(API_KEY_PATTERN, "[REDACTED:api-key]")
      .replace(BEARER_PATTERN, "Bearer [REDACTED:token]")
      .replace(SSN_PATTERN, "[REDACTED:ssn]");
    for (const item of this.replacements) {
      result = result.replaceAll(item.value, item.replacement);
    }
    return result;
  }

  value<T>(value: T): T {
    return this.walk(value, new WeakSet<object>()) as T;
  }

  private walk(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === "string") return this.text(value);
    if (typeof value === "number" || typeof value === "boolean") {
      return this.replacements.find((item) => item.value === String(value))?.replacement ?? value;
    }
    if (Array.isArray(value)) return value.map((item) => this.walk(item, seen));
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? "[REDACTED:secret]" : this.walk(item, seen),
      ]),
    );
  }
}
