#!/usr/bin/env bun
// Pre-commit secrets scanner — checks staged diff using the proxy's own patterns.
// Usage: bun run check-secrets
//
// Exits 0 (clean) or 1 (matches found). Use `git commit --no-verify` to bypass.

import { execSync } from "child_process";

// Provide a dummy HMAC key if not set — scan() needs it for makeToken() but we
// don't use the tokens here; we only care about match positions and types.
if (!process.env.LLM_PRIVACY_HMAC_KEY) {
  process.env.LLM_PRIVACY_HMAC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
}

import { scan } from "../src/core.js";

let diff: string;
try {
  diff = execSync("git diff --cached -U0", { encoding: "utf8" });
} catch {
  console.error("check-secrets: failed to run git diff --cached");
  process.exit(1);
}

// Extract only added lines from the diff (skip file headers and context)
const addedLines = diff
  .split("\n")
  .filter(l => l.startsWith("+") && !l.startsWith("+++"))
  .map(l => l.slice(1))
  .join("\n");

if (!addedLines.trim()) {
  console.log("✓ No staged changes to scan");
  process.exit(0);
}

const result = await scan(addedLines);

// Ignore warn-only PII if it's from a known high-FP pattern
const blockingMatches = result.matches.filter(m => m.severity === "block");
const warnMatches = result.matches.filter(m => m.severity === "warn");

if (result.matches.length === 0) {
  console.log("✓ No secrets detected in staged diff");
  process.exit(0);
}

const truncate = (s: string, n = 60) => s.length > n ? s.slice(0, n) + "…" : s;

if (blockingMatches.length > 0) {
  console.error("\n⛔  BLOCKED: secrets detected in staged diff\n");
  for (const m of blockingMatches) {
    console.error(`  [${m.type}]  ${truncate(m.original)}`);
  }
  if (warnMatches.length > 0) {
    console.error("\n⚠   PII also detected:");
    for (const m of warnMatches) {
      console.error(`  [${m.type}]  ${truncate(m.original)}`);
    }
  }
  console.error("\nRemove secrets from staged files, or bypass with: git commit --no-verify\n");
  process.exit(1);
}

// Warn-only: print but don't block
console.warn("\n⚠   PII detected in staged diff (non-blocking):\n");
for (const m of warnMatches) {
  console.warn(`  [${m.type}]  ${truncate(m.original)}`);
}
console.warn("\nReview before committing. Bypass with: git commit --no-verify\n");
process.exit(0);
