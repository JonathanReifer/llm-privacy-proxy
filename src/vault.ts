import { Database } from "bun:sqlite";
import { renameSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import type { IVault, PatternType, VaultEntry } from "./types.js";

interface VaultData { version: 1; entries: Record<string, VaultEntry>; }
interface Envelope  { v: 1; iv: string; tag: string; ciphertext: string; }
type Row = { token: string; original_enc: string; type: string; created_at: string; session_id: string | null };

function b64uEncode(bytes: Uint8Array): string {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function b64uDecode(s: string): Uint8Array {
  const n = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + (4 - s.length % 4) % 4, "=");
  const b = atob(n); const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

async function aesKey(): Promise<CryptoKey> {
  const raw = process.env.LLM_PRIVACY_VAULT_KEY;
  if (!raw) throw new Error("LLM_PRIVACY_VAULT_KEY is required");
  return crypto.subtle.importKey("raw", b64uDecode(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptString(s: string): Promise<string> {
  const key = await aesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const full = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(s)));
  const env: Envelope = { v: 1, iv: b64uEncode(iv), tag: b64uEncode(full.slice(-16)), ciphertext: b64uEncode(full.slice(0, -16)) };
  return JSON.stringify(env);
}

async function decryptString(enc: string): Promise<string> {
  const env: Envelope = JSON.parse(enc);
  const key = await aesKey();
  const iv = b64uDecode(env.iv), ct = b64uDecode(env.ciphertext), tag = b64uDecode(env.tag);
  const combined = new Uint8Array(ct.length + tag.length);
  combined.set(ct); combined.set(tag, ct.length);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, combined));
}

// Decrypts the old FileVault format (single encrypted VaultData blob) — migration only
async function decryptVaultData(raw: string): Promise<VaultData> {
  const env: Envelope = JSON.parse(raw);
  const key = await aesKey();
  const iv = b64uDecode(env.iv), ct = b64uDecode(env.ciphertext), tag = b64uDecode(env.tag);
  const combined = new Uint8Array(ct.length + tag.length);
  combined.set(ct); combined.set(tag, ct.length);
  return JSON.parse(new TextDecoder().decode(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, combined)
  )) as VaultData;
}

function rowToEntry(row: Row, original: string): VaultEntry {
  const e: VaultEntry = { token: row.token, original, type: row.type as PatternType, createdAt: row.created_at };
  if (row.session_id) e.sessionId = row.session_id;
  return e;
}

export class SqliteVault implements IVault {
  readonly mode = "sqlite" as const;
  readonly path: string;
  private db: Database;

  constructor(dbPath?: string) {
    this.path = dbPath ?? join(process.env.HOME ?? "~", ".llm-privacy", "vault.db");
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS entries (
      token        TEXT PRIMARY KEY,
      original_enc TEXT NOT NULL,
      type         TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      session_id   TEXT
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_created_at ON entries(created_at DESC)");
    void this.migrateFromFile();
  }

  private async migrateFromFile(): Promise<void> {
    const oldPath = join(dirname(this.path), "vault.enc.json");
    if (!existsSync(oldPath)) return;
    try {
      const data = await decryptVaultData(await Bun.file(oldPath).text());
      const stmt = this.db.prepare(
        "INSERT OR IGNORE INTO entries (token, original_enc, type, created_at, session_id) VALUES (?, ?, ?, ?, ?)"
      );
      let n = 0;
      for (const e of Object.values(data.entries)) {
        stmt.run(e.token, await encryptString(e.original), e.type, e.createdAt, e.sessionId ?? null);
        n++;
      }
      renameSync(oldPath, oldPath + ".migrated");
      process.stderr.write(`[llm-proxy] migrated ${n} vault entries from file vault\n`);
    } catch {
      // Old vault absent or unreadable — start fresh
    }
  }

  async get(token: string): Promise<VaultEntry | null> {
    const row = this.db.query<Row, [string]>(
      "SELECT token, original_enc, type, created_at, session_id FROM entries WHERE token = ?"
    ).get(token);
    if (!row) return null;
    return rowToEntry(row, await decryptString(row.original_enc));
  }

  async put(entry: VaultEntry): Promise<void> {
    this.db.run(
      "INSERT OR REPLACE INTO entries (token, original_enc, type, created_at, session_id) VALUES (?, ?, ?, ?, ?)",
      entry.token, await encryptString(entry.original), entry.type, entry.createdAt, entry.sessionId ?? null
    );
  }

  async list(limit = 50): Promise<VaultEntry[]> {
    const rows = this.db.query<Row, [number]>(
      "SELECT token, original_enc, type, created_at, session_id FROM entries ORDER BY created_at DESC LIMIT ?"
    ).all(limit > 0 ? limit : -1);
    return Promise.all(rows.map(async r => rowToEntry(r, await decryptString(r.original_enc))));
  }

  async search(query: string): Promise<VaultEntry[]> {
    const q = query.toLowerCase();
    if (q.startsWith("tok_")) {
      const rows = this.db.query<Row, [string]>(
        "SELECT token, original_enc, type, created_at, session_id FROM entries WHERE token LIKE ?"
      ).all(`%${q}%`);
      return Promise.all(rows.map(async r => rowToEntry(r, await decryptString(r.original_enc))));
    }
    const all = await this.list(0);
    return all.filter(e => e.original.toLowerCase().includes(q));
  }

  async stats(): Promise<Partial<Record<PatternType, number>>> {
    const rows = this.db.query<{ type: string; n: number }, []>(
      "SELECT type, COUNT(*) AS n FROM entries GROUP BY type"
    ).all();
    const c: Partial<Record<PatternType, number>> = {};
    for (const row of rows) c[row.type as PatternType] = row.n;
    return c;
  }
}

export class MemoryVault implements IVault {
  readonly mode = "memory" as const;
  readonly path = null;
  private store = new Map<string, VaultEntry>();
  async get(t: string) { return this.store.get(t) ?? null; }
  async put(e: VaultEntry) { this.store.set(e.token, e); }
  async list(limit = 50) {
    const all = [...this.store.values()].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return limit > 0 ? all.slice(0, limit) : all;
  }
  async search(q: string) { const ql = q.toLowerCase(); return [...this.store.values()].filter(e => e.token.includes(ql) || e.original.toLowerCase().includes(ql)); }
  async stats() { const c: Partial<Record<PatternType, number>> = {}; for (const e of this.store.values()) c[e.type] = (c[e.type] ?? 0) + 1; return c; }
}

export function createVault(path?: string): IVault {
  return process.env.LLM_PRIVACY_VAULT_KEY ? new SqliteVault(path) : new MemoryVault();
}
