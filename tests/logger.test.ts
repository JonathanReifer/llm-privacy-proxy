import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { PromptLogger } from "../src/proxy/logger.js";
import { unlinkSync, existsSync, readFileSync } from "fs";
import { join } from "path";

const TEST_LOG = join(import.meta.dir, "test-prompts.jsonl");

beforeAll(() => {
  try { unlinkSync(TEST_LOG); } catch { /* ignore */ }
});

afterAll(() => {
  try { unlinkSync(TEST_LOG); } catch { /* ignore */ }
});

describe("PromptLogger", () => {
  it("mode=none writes nothing to disk", () => {
    process.env.LLM_PRIVACY_LOG_PROMPTS = "none";
    process.env.LLM_PRIVACY_LOG_PATH = TEST_LOG;
    const logger = new PromptLogger();
    logger.log({ ts: new Date().toISOString(), sessionId: "s1", matchCount: 0, tokenized: ["hello"] });
    expect(existsSync(TEST_LOG)).toBe(false);
  });

  it("mode=tokenized writes JSONL with tokenized content", () => {
    process.env.LLM_PRIVACY_LOG_PROMPTS = "tokenized";
    process.env.LLM_PRIVACY_LOG_PATH = TEST_LOG;
    const logger = new PromptLogger();
    logger.log({ ts: "2026-01-01T00:00:00Z", sessionId: "s2", matchCount: 1, tokenized: ["tok_abc"] });
    const lines = readFileSync(TEST_LOG, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.sessionId).toBe("s2");
    expect(entry.tokenized).toContain("tok_abc");
    expect(entry.original).toBeUndefined();
  });

  it("mode=full writes JSONL with both original and tokenized", () => {
    process.env.LLM_PRIVACY_LOG_PROMPTS = "full";
    process.env.LLM_PRIVACY_LOG_PATH = TEST_LOG;
    const logger = new PromptLogger();
    const ORIG = "sk" + "-" + "ant" + "-original";
    logger.log({ ts: "2026-01-01T00:00:01Z", sessionId: "s3", matchCount: 1, tokenized: ["tok_xyz"], original: [ORIG] });
    const lines = readFileSync(TEST_LOG, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.original).toContain(ORIG);
    expect(entry.tokenized).toContain("tok_xyz");
  });

  it("LLM_PRIVACY_LOG_PATH overrides default path", () => {
    process.env.LLM_PRIVACY_LOG_PROMPTS = "tokenized";
    process.env.LLM_PRIVACY_LOG_PATH = TEST_LOG;
    const logger = new PromptLogger();
    expect(logger.path).toBe(TEST_LOG);
  });

  it("appends multiple entries to same file", () => {
    process.env.LLM_PRIVACY_LOG_PROMPTS = "tokenized";
    process.env.LLM_PRIVACY_LOG_PATH = TEST_LOG;
    const logger = new PromptLogger();
    const before = existsSync(TEST_LOG) ? readFileSync(TEST_LOG, "utf8").trim().split("\n").length : 0;
    logger.log({ ts: new Date().toISOString(), sessionId: "s4", matchCount: 0, tokenized: ["a"] });
    logger.log({ ts: new Date().toISOString(), sessionId: "s5", matchCount: 0, tokenized: ["b"] });
    const after = readFileSync(TEST_LOG, "utf8").trim().split("\n").length;
    expect(after).toBe(before + 2);
  });
});
