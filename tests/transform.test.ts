import { describe, it, expect, beforeAll } from "bun:test";
import { tokenizeText } from "../src/core.js";
import { detokenizeString, StreamDetokenizer, tokenizeMessages } from "../src/proxy/transform.js";
import { MemoryVault } from "../src/vault.js";

beforeAll(() => {
  process.env.LLM_PRIVACY_HMAC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
});

describe("tokenizeText", () => {
  it("replaces API key with token", async () => {
    const SECRET = ["sk", "ant", "api03", "abcdefghijklmnopqrstuvwxyz"].join("-");
    const { result, matches } = await tokenizeText("key: " + SECRET);
    expect(result).not.toContain("sk-ant");
    expect(result).toMatch(/tok_[A-Za-z0-9_-]{12}/);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("replaces email with token", async () => {
    const EMAIL = "user" + "@" + "example.com";
    const { result } = await tokenizeText("contact " + EMAIL + " please");
    expect(result).not.toContain(EMAIL);
    expect(result).toMatch(/tok_[A-Za-z0-9_-]{12}/);
  });

  it("leaves clean text unchanged", async () => {
    const { result, matches } = await tokenizeText("hello world, write me a function");
    expect(result).toBe("hello world, write me a function");
    expect(matches).toHaveLength(0);
  });

  it("is deterministic — same input, same token", async () => {
    const E = "user" + "@" + "test.com";
    const { matches: a } = await tokenizeText(E);
    const { matches: b } = await tokenizeText(E);
    expect(a[0].token).toBe(b[0].token);
  });

  it("detects Google API key", async () => {
    const KEY = "AIza" + "SyD-abcdefghijklmnopqrstuvwxyz123456";
    const { result, matches } = await tokenizeText("key: " + KEY);
    expect(result).not.toContain("AIzaSyD");
    expect(matches[0].type).toBe("api_key_google");
  });

  it("detects Stripe secret key", async () => {
    const KEY = "sk" + "_live_" + "abcdefghijklmnopqrstuvwxyz";
    const { result, matches } = await tokenizeText("stripe: " + KEY);
    expect(result).not.toContain("sk_live_");
    expect(matches[0].type).toBe("api_key_stripe");
  });

  it("detects Slack token", async () => {
    const TOK = "xox" + "b-" + "123456789-abcdefghijklmn";
    const { result, matches } = await tokenizeText("prefix " + TOK);
    expect(result).not.toContain("xoxb-");
    expect(matches.some(m => m.type === "api_key_slack")).toBe(true);
  });

  it("detects IPv4 address", async () => {
    const { result, matches } = await tokenizeText("server at 192.168.1.100 is down");
    expect(result).not.toContain("192.168.1.100");
    expect(matches[0].type).toBe("pii_ipv4");
  });
});

describe("tokenizeMessages", () => {
  it("tokenizes string content and returns matchCount", async () => {
    const vault = new MemoryVault();
    const SECRET = ["sk", "ant", "api03", "abcdefghijklmnopqrstuvwxyz"].join("-");
    const { messages, matchCount } = await tokenizeMessages(
      [{ role: "user", content: "my key is " + SECRET }],
      vault, "test"
    );
    expect(messages[0].content as string).not.toContain("sk-ant");
    expect(matchCount).toBeGreaterThan(0);
  });

  it("tokenizes block content", async () => {
    const vault = new MemoryVault();
    const EMAIL = "admin" + "@" + "example.com";
    const { messages } = await tokenizeMessages(
      [{ role: "user", content: [{ type: "text", text: "email: " + EMAIL }] }],
      vault, "test"
    );
    const blocks = messages[0].content as Array<{ type: string; text: string }>;
    expect(blocks[0].text).not.toContain(EMAIL);
  });

  it("stores matches in vault", async () => {
    const vault = new MemoryVault();
    const EMAIL = "user" + "@" + "example.com";
    await tokenizeMessages(
      [{ role: "user", content: EMAIL }],
      vault, "test"
    );
    const entries = await vault.list(10);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].original).toBe(EMAIL);
  });

  it("returns matchCount=0 for clean text", async () => {
    const vault = new MemoryVault();
    const { matchCount } = await tokenizeMessages(
      [{ role: "user", content: "write me a hello world function" }],
      vault, "test"
    );
    expect(matchCount).toBe(0);
  });
});

describe("detokenizeString", () => {
  it("replaces token with original from vault", async () => {
    const vault = new MemoryVault();
    const EMAIL = "user" + "@" + "example.com";
    const { matches } = await tokenizeText(EMAIL);
    await vault.put({ token: matches[0].token, original: EMAIL, type: "pii_email", createdAt: new Date().toISOString() });

    const result = await detokenizeString(`send to ${matches[0].token} thanks`, vault);
    expect(result).toBe("send to " + EMAIL + " thanks");
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
    const EMAIL = "user" + "@" + "example.com";
    const { matches } = await tokenizeText(EMAIL);
    const token = matches[0].token;
    await vault.put({ token, original: EMAIL, type: "pii_email", createdAt: new Date().toISOString() });

    const detok = new StreamDetokenizer(vault);
    const half = Math.floor(token.length / 2);
    const part1 = await detok.push("address: " + token.slice(0, half));
    const part2 = await detok.push(token.slice(half) + " end");
    const tail = await detok.finalize();

    const full = part1 + part2 + tail;
    expect(full).toContain(EMAIL);
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
    expect(part + tail).toContain("tok_");
  });
});
