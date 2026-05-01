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

  // ── Fixes: patterns that existed but had gaps ────────────────────────────

  it("detects OpenAI sk-proj- key format", async () => {
    const KEY = "sk-proj-" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ12345678";
    const { matches } = await tokenizeText("key: " + KEY);
    expect(matches.some(m => m.type === "api_key_openai")).toBe(true);
  });

  it("detects OpenAI sk-svcacct- key format", async () => {
    const KEY = "sk-svcacct-" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ12345678";
    const { matches } = await tokenizeText("key: " + KEY);
    expect(matches.some(m => m.type === "api_key_openai")).toBe(true);
  });

  it("detects GitHub OAuth token (gho_)", async () => {
    const TOK = "gho_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890";
    const { matches } = await tokenizeText(TOK);
    expect(matches.some(m => m.type === "api_key_github")).toBe(true);
  });

  it("detects GitHub server-to-server token (ghs_)", async () => {
    const TOK = "ghs_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890";
    const { matches } = await tokenizeText(TOK);
    expect(matches.some(m => m.type === "api_key_github")).toBe(true);
  });

  it("detects GitHub fine-grained PAT (github_pat_)", async () => {
    const TOK = "github_pat_" + "A".repeat(82);
    const { matches } = await tokenizeText(TOK);
    expect(matches.some(m => m.type === "api_key_github")).toBe(true);
  });

  // ── Previously untested existing patterns ───────────────────────────────

  it("detects OpenAI classic key", async () => {
    const KEY = "sk-" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abcde";
    const { matches } = await tokenizeText("key: " + KEY);
    expect(matches.some(m => m.type === "api_key_openai")).toBe(true);
  });

  it("detects xAI key", async () => {
    const KEY = "xai-" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abc";
    const { matches } = await tokenizeText("key: " + KEY);
    expect(matches.some(m => m.type === "api_key_xai")).toBe(true);
  });

  it("detects AWS access key ID", async () => {
    const KEY = "AKIA" + "0123456789ABCDEF";
    const { matches } = await tokenizeText("aws_access_key_id = " + KEY);
    expect(matches.some(m => m.type === "api_key_aws_access")).toBe(true);
  });

  it("detects GitHub classic PAT (ghp_)", async () => {
    const TOK = "ghp_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890";
    const { matches } = await tokenizeText(TOK);
    expect(matches.some(m => m.type === "api_key_github")).toBe(true);
  });

  it("detects Twilio API key", async () => {
    const KEY = "SK" + "0123456789abcdef0123456789abcdef";
    const { matches } = await tokenizeText("twilio_key=" + KEY);
    expect(matches.some(m => m.type === "api_key_twilio")).toBe(true);
  });

  it("detects SendGrid API key", async () => {
    const KEY = "SG." + "A".repeat(22) + "." + "B".repeat(43);
    const { matches } = await tokenizeText(KEY);
    expect(matches.some(m => m.type === "api_key_sendgrid")).toBe(true);
  });

  it("detects AWS secret access key", async () => {
    const KEY = "A".repeat(40);
    const { matches } = await tokenizeText("aws_secret_access_key=" + KEY);
    expect(matches.some(m => m.type === "api_key_aws_secret")).toBe(true);
  });

  it("detects US SSN", async () => {
    const { matches } = await tokenizeText("ssn: 123-45-6789");
    expect(matches.some(m => m.type === "pii_ssn_us")).toBe(true);
  });

  it("detects US credit card", async () => {
    const { matches } = await tokenizeText("card: 4111 1111 1111 1111");
    expect(matches.some(m => m.type === "pii_credit_card")).toBe(true);
  });

  it("detects US passport number", async () => {
    const { matches } = await tokenizeText("passport: A12345678");
    expect(matches.some(m => m.type === "pii_passport_us")).toBe(true);
  });

  it("detects date of birth", async () => {
    const { matches } = await tokenizeText("dob: 01/15/1990");
    expect(matches.some(m => m.type === "pii_dob")).toBe(true);
  });

  // ── New patterns ─────────────────────────────────────────────────────────

  it("detects SSH RSA private key PEM block", async () => {
    const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----";
    const { result, matches } = await tokenizeText("key:\n" + PEM);
    expect(result).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(matches.some(m => m.type === "ssh_private_key")).toBe(true);
  });

  it("detects OpenSSH private key PEM block", async () => {
    const PEM = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA=\n-----END OPENSSH PRIVATE KEY-----";
    const { matches } = await tokenizeText(PEM);
    expect(matches.some(m => m.type === "ssh_private_key")).toBe(true);
  });

  it("detects PKCS#8 unencrypted private key", async () => {
    const PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgk=\n-----END PRIVATE KEY-----";
    const { matches } = await tokenizeText(PEM);
    expect(matches.some(m => m.type === "ssh_private_key")).toBe(true);
  });

  it("detects encrypted PKCS#8 private key", async () => {
    const PEM = "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFHDBOBgkq=\n-----END ENCRYPTED PRIVATE KEY-----";
    const { matches } = await tokenizeText(PEM);
    expect(matches.some(m => m.type === "tls_private_key")).toBe(true);
  });

  it("detects PGP private key block", async () => {
    const PEM = "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQdGBGSomeDataHere=\n-----END PGP PRIVATE KEY BLOCK-----";
    const { matches } = await tokenizeText(PEM);
    expect(matches.some(m => m.type === "tls_private_key")).toBe(true);
  });

  it("detects JWT token", async () => {
    // Split to avoid proxy tokenizing this test file
    const HEADER = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const PAYLOAD = "eyJzdWIiOiIxMjM0NTY3ODkwIn0";
    const SIG = "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV";
    const JWT = HEADER + "." + PAYLOAD + "." + SIG;
    const { result, matches } = await tokenizeText("token: " + JWT);
    expect(result).not.toContain(HEADER);
    expect(matches.some(m => m.type === "api_key_jwt")).toBe(true);
  });

  it("detects npm access token", async () => {
    const TOK = "npm_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890";
    const { matches } = await tokenizeText("NPM_TOKEN=" + TOK);
    expect(matches.some(m => m.type === "api_key_npm")).toBe(true);
  });

  it("detects PostgreSQL connection string with credentials", async () => {
    const URI = "postgres://admin:s3cr3tpass@db.example.com:5432/mydb";
    const { result, matches } = await tokenizeText("DATABASE_URL=" + URI);
    expect(result).not.toContain("s3cr3tpass");
    expect(matches.some(m => m.type === "db_connection_string")).toBe(true);
  });

  it("detects MongoDB connection string with credentials", async () => {
    const URI = "mongodb://user:p4ssw0rd@mongo.example.com:27017/mydb";
    const { matches } = await tokenizeText(URI);
    expect(matches.some(m => m.type === "db_connection_string")).toBe(true);
  });

  it("does NOT flag database URI without credentials", async () => {
    const URI = "postgres://db.example.com:5432/mydb";
    const { matches } = await tokenizeText(URI);
    expect(matches.every(m => m.type !== "db_connection_string")).toBe(true);
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
