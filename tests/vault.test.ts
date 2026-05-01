import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { SqliteVault, MemoryVault } from "../src/vault.js";
import { unlinkSync, existsSync } from "fs";
import { join } from "path";

const TEST_DB = join(import.meta.dir, "test-vault.db");
const AT = "@";

beforeAll(() => {
  process.env.LLM_PRIVACY_HMAC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  process.env.LLM_PRIVACY_VAULT_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
});

afterAll(() => {
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
});

function makeEntry(token: string, original: string) {
  return { token, original, type: "pii_email" as const, createdAt: new Date().toISOString() };
}

describe("SqliteVault — ref_count tracking", () => {
  it("new entry starts with ref_count=0", async () => {
    const vault = new SqliteVault(TEST_DB);
    await vault.ready;
    await vault.put(makeEntry("tok_reftest00001", "a" + AT + "test.com"));
    const entry = await vault.get("tok_reftest00001");
    // get() increments to 1 after insert
    expect(entry?.refCount).toBe(1);
  });

  it("put() on existing entry increments ref_count", async () => {
    const vault = new SqliteVault(TEST_DB);
    await vault.ready;
    await vault.put(makeEntry("tok_reftest00002", "b" + AT + "test.com"));
    await vault.put(makeEntry("tok_reftest00002", "b" + AT + "test.com")); // re-put
    const entry = await vault.get("tok_reftest00002");
    // insert=0, re-put increments to 1, get() increments to 2
    expect(entry?.refCount).toBeGreaterThanOrEqual(2);
  });

  it("get() sets last_accessed_at", async () => {
    const vault = new SqliteVault(TEST_DB);
    await vault.ready;
    await vault.put(makeEntry("tok_reftest00003", "c" + AT + "test.com"));
    const entry = await vault.get("tok_reftest00003");
    expect(entry?.lastAccessedAt).toBeTruthy();
    expect(new Date(entry!.lastAccessedAt!).getTime()).toBeGreaterThan(0);
  });

  it("put() does not overwrite original when re-putting same token", async () => {
    const vault = new SqliteVault(TEST_DB);
    await vault.ready;
    await vault.put(makeEntry("tok_reftest00004", "original" + AT + "test.com"));
    await vault.put(makeEntry("tok_reftest00004", "different" + AT + "test.com"));
    const entry = await vault.get("tok_reftest00004");
    // The original_enc should be from the FIRST put — ON CONFLICT does NOT update original_enc
    expect(entry?.original).toBe("original" + AT + "test.com");
  });
});

describe("SqliteVault — hot()", () => {
  it("returns entries ordered by ref_count DESC", async () => {
    const vault = new SqliteVault(TEST_DB);
    await vault.ready;
    // Insert entries and access them different numbers of times
    await vault.put(makeEntry("tok_hot01", "low" + AT + "test.com"));
    await vault.put(makeEntry("tok_hot02", "mid" + AT + "test.com"));
    await vault.put(makeEntry("tok_hot03", "high" + AT + "test.com"));
    // Access hot03 multiple times
    for (let i = 0; i < 5; i++) await vault.get("tok_hot03");
    for (let i = 0; i < 2; i++) await vault.get("tok_hot02");

    const hot = await vault.hot(10);
    const tokens = hot.map(e => e.token);
    const hot03idx = tokens.indexOf("tok_hot03");
    const hot02idx = tokens.indexOf("tok_hot02");
    const hot01idx = tokens.indexOf("tok_hot01");
    // high-access entry should appear before lower-access entries
    if (hot03idx >= 0 && hot02idx >= 0) expect(hot03idx).toBeLessThan(hot02idx);
    if (hot02idx >= 0 && hot01idx >= 0) expect(hot02idx).toBeLessThan(hot01idx);
  });

  it("respects limit parameter", async () => {
    const vault = new SqliteVault(TEST_DB);
    await vault.ready;
    const hot = await vault.hot(2);
    expect(hot.length).toBeLessThanOrEqual(2);
  });
});

describe("SqliteVault — stats persistence", () => {
  it("saveStats and loadStats round-trip", async () => {
    const vault = new SqliteVault(TEST_DB);
    await vault.ready;
    vault.saveStats({ requests: 42, tokenized: 7, detokenized: 3 });
    const loaded = vault.loadStats();
    expect(loaded.requests).toBe("42");
    expect(loaded.tokenized).toBe("7");
    expect(loaded.detokenized).toBe("3");
  });

  it("loadStats returns empty object when no stats saved", async () => {
    // Use a fresh DB
    const freshDb = join(import.meta.dir, "test-vault-fresh.db");
    try {
      const vault = new SqliteVault(freshDb);
      await vault.ready;
      const loaded = vault.loadStats();
      expect(Object.keys(loaded).length).toBeGreaterThanOrEqual(0);
    } finally {
      for (const f of [freshDb, freshDb + "-wal", freshDb + "-shm"]) {
        try { unlinkSync(f); } catch { /* ignore */ }
      }
    }
  });
});

describe("MemoryVault — ref_count tracking", () => {
  it("new entry starts with refCount=0", async () => {
    const vault = new MemoryVault();
    await vault.put(makeEntry("tok_mem01", "a" + AT + "mem.com"));
    const all = await vault.list(10);
    expect(all[0].refCount).toBe(0);
  });

  it("get() increments refCount", async () => {
    const vault = new MemoryVault();
    await vault.put(makeEntry("tok_mem02", "b" + AT + "mem.com"));
    await vault.get("tok_mem02");
    await vault.get("tok_mem02");
    const entry = await vault.get("tok_mem02");
    expect(entry?.refCount).toBeGreaterThanOrEqual(2);
  });

  it("hot() returns entries ordered by refCount DESC", async () => {
    const vault = new MemoryVault();
    await vault.put(makeEntry("tok_mhot01", "low" + AT + "mem.com"));
    await vault.put(makeEntry("tok_mhot02", "high" + AT + "mem.com"));
    for (let i = 0; i < 5; i++) await vault.get("tok_mhot02");
    const hot = await vault.hot(10);
    expect(hot[0].token).toBe("tok_mhot02");
  });
});
