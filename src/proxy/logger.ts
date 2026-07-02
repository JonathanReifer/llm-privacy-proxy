import { appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { emitLog } from "../telemetry/otel.js";
import { lookupProject } from "../project.js";

export type LogMode = "none" | "tokenized" | "full";

export interface LogFinding {
  scannerId: string;
  description: string;
  severity: "block" | "warn" | "info";
  atlasTechnique?: string;
  owaspCategory?: string;
}

export interface PromptLogEntry {
  ts: string;
  sessionId: string;
  matchCount: number;
  tokenized: string[];
  original?: string[];
  decision?: "allow" | "ask" | "block";
  findings?: LogFinding[];
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
    // Fire-and-forget telemetry — independent of the LLM_PRIVACY_LOG_PROMPTS
    // opt-in below, since telemetry never carries raw prompt content.
    const project = lookupProject(entry.sessionId);
    void emitLog({
      session_id: entry.sessionId,
      project,
      harness: "claude-code",
      scanner_id: "proxy/summary",
      event_type: "prompt_scan",
      decision: entry.decision ?? "allow",
      severity: "info",
    });
    for (const f of entry.findings ?? []) {
      void emitLog({
        session_id: entry.sessionId,
        project,
        harness: "claude-code",
        scanner_id: f.scannerId,
        event_type: "prompt_scan",
        decision: entry.decision,
        severity: f.severity,
        atlas_technique: f.atlasTechnique,
        owasp_category: f.owaspCategory,
      });
    }

    if (this.mode === "none") return;
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
  }
}
