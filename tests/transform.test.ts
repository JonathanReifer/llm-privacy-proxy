import { describe, it, expect, beforeAll } from "bun:test";
import { tokenizeText } from "../src/core.js";
import { detokenizeString, StreamDetokenizer, tokenizeMessages } from "../src/proxy/transform.js";
import { MemoryVault } from "../src/vault.js";

beforeAll(() => {
  process.env.LLM_PRIVACY_HMAC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
});

describe("tokenizeText", () => {
  it("replaces API key with token", async () => {
    const { result, matches } = await tokenizeText("key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
    expect(result).not.toContain("sk-ant");
    expect(result).toMatch(/tok_[A-Za-z0-9_-]{12}/);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("replaces email with token", async () => {
    const { result } = await tokenizeText("contact user@example.com please");
    expect(result).not.toContain("user@example.com");
    expect(result).toMatch(/tok_[A-Za-z0-9_-]{12}/);
  });

  it("leaves clean text unchanged", async () => {
    const { result, matches } = await tokenizeText("hello world, write me a function");
    expect(result).toBe("hello world, write me a function");
    expect(matches).toHaveLength(0);
  });

  it("is deterministic — same input, same token", async () => {
    const { matches: a } = await tokenizeText("user@test.com");
    const { matches: b } = await tokenizeText("user@test.com");
    expect(a[0].token).toBe(b[0].token);
  });
});

describe("tokenizeMessages", () => {
  it("tokenizes string content", async () => {
    const vault = new MemoryVault();
    const out = await tokenizeMessages(
      [{ role: "user", content: "my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz" }],
      vault, "test"
    );
    expect(out[0].content as string).not.toContain("sk-ant");
  });

  it("tokenizes block content", async () => {
    const vault = new MemoryVault();
    const out = await tokenizeMessages(
      [{ role: "user", content: [{ type: "text", text: "email: admin@example.com" }] }],
      vault, "test"
    );
    const blocks = out[0].content as Array<{ type: string; text: string }>;
    expect(blocks[0].text).not.toContain("admin@example.com");
  });

  it("stores matches in vault", async () => {
    const vault = new MemoryVault();
    await tokenizeMessages(
      [{ role: "user", content: "user@example.com" }],
      vault, "test"
    );
    const entries = await vault.list(10);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].original).toBe("user@example.com");
  });
});

describe("detokenizeString", () => {
  it("replaces token with original from vault", async () => {
    const vault = new MemoryVault();
    // Tokenize first to get the deterministic token
    const { matches } = await tokenizeText("user@example.com");
    await vault.put({ token: matches[0].token, original: "user@example.com", type: "pii_email", createdAt: new Date().toISOString() });

    const result = await detokenizeString(`send to ${matches[0].token} thanks`, vault);
    expect(result).toBe("send to user@example.com thanks");
  });

  it("leaves unknown tokens unchanged", async () => {
    const vault = new MemoryVault();
    const result = await detokenizeString("tok_unknownABCDEF", vault);
    expect(result).toBe("tok_unknownABCDEF");
  });

  it("handles text with no tokens", async () => {
    const vault = new MemoryVault();
    const result = await detokenizeString("plain text no tokens here", vault);
    expect(result).toBe("plain text no tokens here");
  });
});

describe("StreamDetokenizer", () => {
  it("detokenizes token split across chunks", async () => {
    const vault = new MemoryVault();
    const { matches } = await tokenizeText("user@example.com");
    const token = matches[0].token;
    await vault.put({ token, original: "user@example.com", type: "pii_email", createdAt: new Date().toISOString() });

    const detok = new StreamDetokenizer(vault);
    const half = Math.floor(token.length / 2);
    const part1 = await detok.push("address: " + token.slice(0, half));
    const part2 = await detok.push(token.slice(half) + " end");
    const tail = await detok.finalize();

    const full = part1 + part2 + tail;
    expect(full).toContain("user@example.com");
    expect(full).not.toContain("tok_");
  });

  it("emits non-token text immediately", async () => {
    const vault = new MemoryVault();
    const detok = new StreamDetokenizer(vault);
    const out = await detok.push("hello world ");
    expect(out).toBe("hello wor"); // last 3 chars held as potential tok_ prefix
  });

  it("handles false tok_ prefix gracefully", async () => {
    const vault = new MemoryVault();
    const detok = new StreamDetokenizer(vault);
    const part = await detok.push("tok_notavalidtoken!!");
    const tail = await detok.finalize();
    // Unknown tok_ pattern is emitted as-is (not silently dropped)
    expect(part + tail).toContain("tok_");
  });
});
