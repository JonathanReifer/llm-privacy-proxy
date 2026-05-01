import { appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

export type LogMode = "none" | "tokenized" | "full";

export interface PromptLogEntry {
  ts: string;
  sessionId: string;
  matchCount: number;
  tokenized: string[];
  original?: string[];
}

export class PromptLogger {
  readonly mode: LogMode;
  readonly path: string;

  constructor() {
    const raw = process.env.LLM_PRIVACY_LOG_PROMPTS ?? "none";
    const valid: LogMode[] = ["none", "tokenized", "full"];
    this.mode = valid.includes(raw as LogMode) ? (raw as LogMode) : "none";
    if (raw !== "none" && !valid.includes(raw as LogMode)) {
      process.stderr.write(`[llm-proxy] unknown LLM_PRIVACY_LOG_PROMPTS="${raw}", defaulting to "none"\n`);
    }
    this.path = process.env.LLM_PRIVACY_LOG_PATH
      ?? join(process.env.HOME ?? "~", ".llm-privacy", "prompts.jsonl");
    if (this.mode !== "none") mkdirSync(dirname(this.path), { recursive: true });
  }

  log(entry: PromptLogEntry): void {
    if (this.mode === "none") return;
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
  }
}
