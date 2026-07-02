// Reads the session_id -> project mapping written by aih-privacy-middleware's
// hooks (see aih-privacy-middleware/src/project.ts). The proxy is stateless
// HTTP and never sees a cwd of its own, so this file is the only way it learns
// which project a session belongs to. Defined locally on purpose — no shared
// package, matching this repo's zero-cross-repo-imports convention. The file
// format (JSONL, one {session_id, project, ts} object per line, last write
// wins) is the contract between the two repos, not the code.

import { existsSync, readFileSync } from "fs";
import { join } from "path";

function sessionProjectsPath(): string {
  return (
    process.env.LLM_PRIVACY_SESSION_PROJECTS_PATH ??
    join(process.env.HOME ?? "~", ".llm-privacy", "session-projects.jsonl")
  );
}

interface SessionProjectEntry {
  session_id: string;
  project: string;
  ts: string;
}

/**
 * Looks up the project for a session_id. Re-reads the mapping file on every
 * call (no in-memory cache) since this is a low-frequency, non-hot-path
 * lookup relative to request volume, and the file is small. Never throws.
 */
export function lookupProject(sessionId: string): string | undefined {
  try {
    const path = sessionProjectsPath();
    if (!existsSync(path)) return undefined;

    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    let found: string | undefined;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as SessionProjectEntry;
        if (entry.session_id === sessionId) found = entry.project; // last write wins
      } catch {
        // skip malformed line
      }
    }
    return found;
  } catch {
    return undefined;
  }
}
