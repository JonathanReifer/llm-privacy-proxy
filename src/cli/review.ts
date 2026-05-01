#!/usr/bin/env bun
import { join } from "path";
import { statSync } from "fs";
import { SqliteVault } from "../vault.js";
import type { VaultEntry } from "../types.js";

const args = process.argv.slice(2);
const subcommand = args[0];

function vaultPath(): string {
  return (
    process.env.LLM_PRIVACY_VAULT_PATH ??
    join(process.env.HOME ?? "~", ".llm-privacy", "vault.db")
  );
}

function truncate(s: string, len = 40): string {
  return s.length > len ? s.slice(0, len - 1) + "…" : s;
}

function formatDate(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").slice(0, 19);
}

function printTable(entries: VaultEntry[]): void {
  if (entries.length === 0) {
    console.log("No entries found.");
    return;
  }
  const colWidths = { token: 16, type: 22, created: 20, original: 42 };
  const header =
    "Token".padEnd(colWidths.token) +
    "Type".padEnd(colWidths.type) +
    "Created".padEnd(colWidths.created) +
    "Original";
  const divider = "─".repeat(header.length + colWidths.original);
  console.log(header);
  console.log(divider);
  for (const e of entries) {
    const row =
      e.token.padEnd(colWidths.token) +
      e.type.padEnd(colWidths.type) +
      formatDate(e.createdAt).padEnd(colWidths.created) +
      truncate(e.original);
    console.log(row);
  }
}

async function cmdList(): Promise<void> {
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1] ?? "50", 10) : 50;
  const vault = new SqliteVault(vaultPath());
  await vault.ready;
  const entries = await vault.list(limit);
  printTable(entries);
  console.log(`\n${entries.length} entries shown.`);
}

async function cmdSearch(): Promise<void> {
  const query = args[1];
  if (!query) {
    console.error("Usage: review search <query>");
    process.exit(1);
  }
  const vault = new SqliteVault(vaultPath());
  await vault.ready;
  const entries = await vault.search(query);
  printTable(entries);
  console.log(`\n${entries.length} match(es) for "${query}".`);
}

async function cmdStats(): Promise<void> {
  const p = vaultPath();
  const vault = new SqliteVault(p);
  await vault.ready;
  const counts = await vault.stats();
  const total = Object.values(counts).reduce((s, n) => s + (n ?? 0), 0);

  console.log("Vault Statistics");
  console.log("─".repeat(40));
  console.log(`Total entries: ${total}`);
  for (const [type, count] of Object.entries(counts).sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))) {
    console.log(`  ${type.padEnd(28)} ${count}`);
  }

  try {
    const stat = statSync(p);
    const kb = (stat.size / 1024).toFixed(1);
    console.log("─".repeat(40));
    console.log(`Vault database: ${p} (${kb} KB)`);
    console.log(`Last write:     ${formatDate(stat.mtime.toISOString())}`);
  } catch {
    console.log(`Vault database: ${p} (not found)`);
  }
}

async function cmdExport(): Promise<void> {
  const format = args.includes("--csv") ? "csv" : "json";
  const vault = new SqliteVault(vaultPath());
  await vault.ready;
  const entries = await vault.list(0);

  if (format === "csv") {
    console.log("token,type,createdAt,original,sessionId");
    for (const e of entries) {
      const fields = [e.token, e.type, e.createdAt, `"${e.original.replace(/"/g, '""')}"`, e.sessionId ?? ""];
      console.log(fields.join(","));
    }
  } else {
    console.log(JSON.stringify(entries, null, 2));
  }
}

function printHelp(): void {
  console.log(`llm-privacy-proxy review — vault inspection CLI

Usage:
  bun run review list [--limit N]      List recent entries (default: 50)
  bun run review search <query>        Search by token or original value
  bun run review stats                 Show counts by pattern type + vault info
  bun run review export [--json|--csv] Dump all entries to stdout

Environment:
  LLM_PRIVACY_VAULT_KEY   Required — base64 AES-256-GCM key
  LLM_PRIVACY_VAULT_PATH  Optional — override vault database path
`);
}

switch (subcommand) {
  case "list":   await cmdList();   break;
  case "search": await cmdSearch(); break;
  case "stats":  await cmdStats();  break;
  case "export": await cmdExport(); break;
  default:       printHelp();
}
