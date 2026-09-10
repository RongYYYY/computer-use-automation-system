import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Redactor } from "./redactor.js";

export interface RunEvent {
  readonly sequence: number;
  readonly timestamp: string;
  readonly runId: string;
  readonly kind: string;
  readonly data: unknown;
}

export interface RunLoggerOptions {
  readonly rootDirectory?: string;
  readonly runId?: string;
  readonly sensitiveValues?: Readonly<Record<string, unknown>>;
}

export class RunLogger {
  readonly runId: string;
  readonly runDirectory: string;
  readonly logPath: string;
  readonly redactor: Redactor;

  private sequence = 0;
  private ready: Promise<void>;

  constructor(options: RunLoggerOptions = {}) {
    this.runId = options.runId ?? randomUUID();
    this.runDirectory = path.resolve(options.rootDirectory ?? ".runs", this.runId);
    this.logPath = path.join(this.runDirectory, "events.jsonl");
    this.redactor = new Redactor(options.sensitiveValues);
    this.ready = mkdir(this.runDirectory, { recursive: true }).then(() => undefined);
  }

  async event(kind: string, data: unknown): Promise<RunEvent> {
    await this.ready;
    const event: RunEvent = {
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      runId: this.runId,
      kind,
      data: this.redactor.value(data),
    };
    await appendFile(this.logPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    return event;
  }

  registerSensitive(name: string, value: unknown): void {
    this.redactor.add(name, value);
  }

  evidencePath(filename: string): string {
    if (path.basename(filename) !== filename) {
      throw new Error("Evidence filename must not contain a directory component");
    }
    return path.join(this.runDirectory, filename);
  }
}
