import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "fs";
import { join } from "path";

const REVIEW_CLI = join(import.meta.dir, "../src/cli/review.ts");
const TEST_DB    = join(import.meta.dir, "test-cli-vault.db");
// Separate DB used only for old-schema migration test
const OLD_SCHEMA_DB = join(import.meta.dir, "test-cli-old.db");

const ENV = {
  LLM_PRIVACY_HMAC_KEY:  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  LLM_PRIVACY_VAULT_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  LLM_PRIVACY_VAULT_PATH: TEST_DB,
  HOME: process.env.HOME ?? "/tmp",
};

async function runCLI(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", REVIEW_CLI, ...args], {
    env: { ...process.env, ...ENV },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function seedVault(): Promise<void> {
  await Bun.spawn(["bun", "--eval", `
    const { SqliteVault } = await import("${join(import.meta.dir, "../src/vault.ts")}");
    const v = new SqliteVault("${TEST_DB}");
    await v.ready;
    const entries = [
      { token: "tok_cli00001", original: "alice@test.com",   type: "pii_email",      createdAt: new Date().toISOString() },
      { token: "tok_cli00002", original: "bob@test.com",     type: "pii_email",      createdAt: new Date().toISOString() },
      { token: "tok_cli00003", original: "carol@test.com",   type: "pii_email",      createdAt: new Date().toISOString() },
      { token: "tok_cli00004", original: "192.168.1.1",      type: "pii_ipv4",       createdAt: new Date().toISOString() },
    ];
    for (const e of entries) await v.put(e);
  `], { env: { ...process.env, ...ENV }, stdout: "pipe", stderr: "pipe" }).exited;
}

beforeAll(async () => {
  // Clean up leftover test DBs
  for (const base of [TEST_DB, OLD_SCHEMA_DB]) {
    for (const f of [base, base + "-wal", base + "-shm"]) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  }
  await seedVault();
});

afterAll(() => {
  for (const base of [TEST_DB, OLD_SCHEMA_DB]) {
    for (const f of [base, base + "-wal", base + "-shm"]) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

// ── Migration: existing DB without ref_count column ──────────────────────────

describe("vault migration — old schema DB", () => {
  beforeAll(() => {
    // Build an old-schema vault.db (no ref_count, no last_accessed_at)
    const db = new Database(OLD_SCHEMA_DB);
    db.run("PRAGMA journal_mode=WAL");
    db.run(`CREATE TABLE IF NOT EXISTS entries (
      token        TEXT PRIMARY KEY,
      original_enc TEXT NOT NULL,
      type         TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      session_id   TEXT
    )`);
    db.run("CREATE INDEX IF NOT EXISTS idx_created_at ON entries(created_at DESC)");
    db.close();
  });

  it("opens an old-schema DB without crashing", async () => {
    const proc = Bun.spawn(["bun", REVIEW_CLI, "list"], {
      env: { ...process.env, ...ENV, LLM_PRIVACY_VAULT_PATH: OLD_SCHEMA_DB },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("SQLiteError");
    expect(stderr).not.toContain("no such column");
  });

  it("adds ref_count and last_accessed_at columns to old-schema DB", () => {
    const db = new Database(OLD_SCHEMA_DB);
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(entries)").all().map(r => r.name);
    db.close();
    expect(cols).toContain("ref_count");
    expect(cols).toContain("last_accessed_at");
  });
});

// ── CLI: list ────────────────────────────────────────────────────────────────

describe("review list", () => {
  it("exits 0", async () => {
    const { exitCode } = await runCLI("list");
    expect(exitCode).toBe(0);
  });

  it("shows table header with all expected columns", async () => {
    const { stdout } = await runCLI("list");
    expect(stdout).toContain("Token");
    expect(stdout).toContain("Type");
    expect(stdout).toContain("Created");
    expect(stdout).toContain("Refs");
    expect(stdout).toContain("Original");
  });

  it("lists seeded entries", async () => {
    const { stdout } = await runCLI("list");
    expect(stdout).toContain("tok_cli00001");
    expect(stdout).toContain("pii_email");
    expect(stdout).toMatch(/4 entries shown/);
  });

  it("--limit N restricts entry count", async () => {
    const { stdout } = await runCLI("list", "--limit", "2");
    expect(stdout).toMatch(/2 entries shown/);
  });

  it("shows Refs count column value", async () => {
    const { stdout } = await runCLI("list");
    // refCount defaults to 0 for fresh entries
    expect(stdout).toMatch(/\b0\b/);
  });
});

// ── CLI: search ──────────────────────────────────────────────────────────────

describe("review search", () => {
  it("exits 1 with error when no query given", async () => {
    const { exitCode, stderr } = await runCLI("search");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage");
  });

  it("finds entry by original value", async () => {
    const { exitCode, stdout } = await runCLI("search", "alice@test.com");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("tok_cli00001");
    expect(stdout).toMatch(/1 match/);
  });

  it("finds entry by token prefix", async () => {
    const { exitCode, stdout } = await runCLI("search", "tok_cli00002");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("tok_cli00002");
  });

  it("returns 0 matches for unknown query", async () => {
    const { exitCode, stdout } = await runCLI("search", "nobody@nowhere.xyz");
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/0 match/);
  });

  it("finds entries by type keyword", async () => {
    const { exitCode, stdout } = await runCLI("search", "192.168");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("tok_cli00004");
  });
});

// ── CLI: stats ───────────────────────────────────────────────────────────────

describe("review stats", () => {
  it("exits 0", async () => {
    const { exitCode } = await runCLI("stats");
    expect(exitCode).toBe(0);
  });

  it("shows Vault Statistics header and total", async () => {
    const { stdout } = await runCLI("stats");
    expect(stdout).toContain("Vault Statistics");
    expect(stdout).toContain("Total entries: 4");
  });

  it("shows per-type breakdown", async () => {
    const { stdout } = await runCLI("stats");
    expect(stdout).toMatch(/pii_email\s+3/);
    expect(stdout).toMatch(/pii_ipv4\s+1/);
  });

  it("shows vault database path and file size", async () => {
    const { stdout } = await runCLI("stats");
    expect(stdout).toContain(TEST_DB);
    expect(stdout).toMatch(/\d+\.\d+ KB/);
  });
});

// ── CLI: export ──────────────────────────────────────────────────────────────

describe("review export", () => {
  it("exports valid JSON array by default", async () => {
    const { exitCode, stdout } = await runCLI("export");
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(4);
  });

  it("JSON entries have required fields", async () => {
    const { stdout } = await runCLI("export");
    const parsed = JSON.parse(stdout);
    for (const e of parsed) {
      expect(e).toHaveProperty("token");
      expect(e).toHaveProperty("type");
      expect(e).toHaveProperty("createdAt");
      expect(e).toHaveProperty("original");
    }
  });

  it("JSON entries include refCount field", async () => {
    const { stdout } = await runCLI("export");
    const parsed = JSON.parse(stdout);
    expect(parsed[0]).toHaveProperty("refCount");
  });

  it("exports CSV with correct header when --csv flag used", async () => {
    const { exitCode, stdout } = await runCLI("export", "--csv");
    expect(exitCode).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines[0]).toBe("token,type,createdAt,original,sessionId");
    expect(lines.length).toBe(5); // header + 4 entries
  });

  it("CSV rows contain token values", async () => {
    const { stdout } = await runCLI("export", "--csv");
    expect(stdout).toContain("tok_cli00001");
    expect(stdout).toContain("tok_cli00004");
  });
});

// ── CLI: help / unknown subcommand ───────────────────────────────────────────

describe("review help", () => {
  it("prints usage for unknown subcommand", async () => {
    const { stdout } = await runCLI("unknowncommand");
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("list");
    expect(stdout).toContain("search");
    expect(stdout).toContain("stats");
    expect(stdout).toContain("export");
  });

  it("prints usage when no subcommand given", async () => {
    const { stdout } = await runCLI();
    expect(stdout).toContain("LLM_PRIVACY_VAULT_KEY");
  });
});
