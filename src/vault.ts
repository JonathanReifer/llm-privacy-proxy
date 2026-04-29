import { renameSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type { IVault, PatternType, VaultData, VaultEntry } from "./types.js";

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

interface Envelope { v: 1; iv: string; tag: string; ciphertext: string; }

async function aesKey(): Promise<CryptoKey> {
  const raw = process.env.LLM_PRIVACY_VAULT_KEY;
  if (!raw) throw new Error("LLM_PRIVACY_VAULT_KEY is required");
  return crypto.subtle.importKey("raw", b64uDecode(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encrypt(data: VaultData): Promise<Envelope> {
  const key = await aesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const full = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(data))));
  return { v: 1, iv: b64uEncode(iv), tag: b64uEncode(full.slice(-16)), ciphertext: b64uEncode(full.slice(0, -16)) };
}

async function decrypt(env: Envelope): Promise<VaultData> {
  const key = await aesKey();
  const iv = b64uDecode(env.iv), ct = b64uDecode(env.ciphertext), tag = b64uDecode(env.tag);
  const combined = new Uint8Array(ct.length + tag.length);
  combined.set(ct); combined.set(tag, ct.length);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, combined))) as VaultData;
}

export class FileVault implements IVault {
  private readonly path: string;
  private readonly tmp: string;

  constructor(vaultPath?: string) {
    this.path = vaultPath ?? join(process.env.HOME ?? "~", ".llm-privacy", "vault.enc.json");
    this.tmp = this.path + ".tmp";
    mkdirSync(dirname(this.path), { recursive: true });
  }

  private async read(): Promise<VaultData> {
    try { return await decrypt(JSON.parse(await Bun.file(this.path).text())); }
    catch { return { version: 1, entries: {} }; }
  }

  private async write(data: VaultData): Promise<void> {
    await Bun.write(this.tmp, JSON.stringify(await encrypt(data)));
    renameSync(this.tmp, this.path);
  }

  async get(token: string): Promise<VaultEntry | null> { return (await this.read()).entries[token] ?? null; }
  async put(entry: VaultEntry): Promise<void> { const d = await this.read(); d.entries[entry.token] = entry; await this.write(d); }
  async list(limit = 50): Promise<VaultEntry[]> {
    const all = Object.values((await this.read()).entries).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return limit > 0 ? all.slice(0, limit) : all;
  }
  async search(query: string): Promise<VaultEntry[]> {
    const q = query.toLowerCase();
    return Object.values((await this.read()).entries).filter(e => e.token.includes(q) || e.original.toLowerCase().includes(q));
  }
  async stats(): Promise<Partial<Record<PatternType, number>>> {
    const c: Partial<Record<PatternType, number>> = {};
    for (const e of Object.values((await this.read()).entries)) c[e.type] = (c[e.type] ?? 0) + 1;
    return c;
  }
}

export class MemoryVault implements IVault {
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
  return process.env.LLM_PRIVACY_VAULT_KEY ? new FileVault(path) : new MemoryVault();
}
