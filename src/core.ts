import type { PatternDefinition, PatternType, ScanMatch, ScanResult } from "./types.js";

export const PATTERNS: PatternDefinition[] = [
  { type: "api_key_openai",    regex: /sk-(?:(?:proj|svcacct)-[A-Za-z0-9_\-]{20,100}|[A-Za-z0-9]{20,60})/g,              severity: "block", description: "OpenAI API key" },
  { type: "api_key_anthropic", regex: /sk-ant-[A-Za-z0-9\-_]{20,100}/g,                                                      severity: "block", description: "Anthropic API key" },
  { type: "api_key_xai",       regex: /xai-[A-Za-z0-9]{20,80}/g,                                                             severity: "block", description: "xAI API key" },
  { type: "api_key_aws_access",regex: /\bAKIA[0-9A-Z]{16}\b/g,                                                               severity: "block", description: "AWS Access Key ID" },
  { type: "api_key_github",    regex: /(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82,})/g,                   severity: "block", description: "GitHub token" },
  { type: "api_key_generic",   regex: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"]?([A-Za-z0-9\-_+/=]{20,})/gi,    severity: "block", description: "Generic secret" },
  { type: "pii_email",         regex: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,                                  severity: "warn",  description: "Email address" },
  { type: "pii_phone_us",      regex: /(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,                                severity: "warn",  description: "US phone number" },
  { type: "pii_ssn_us",        regex: /\b(?!000|666|9\d{2})\d{3}[-\s](?!00)\d{2}[-\s](?!0000)\d{4}\b/g,                    severity: "block", description: "US SSN" },
  { type: "pii_credit_card",   regex: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6011)[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,   severity: "block", description: "Credit card number" },
  { type: "api_key_google",     regex: /AIza[0-9A-Za-z\-_]{35}/g,                                                                  severity: "block", description: "Google API key" },
  { type: "api_key_slack",      regex: /xox[baprs]-[0-9A-Za-z\-]{10,}/g,                                                           severity: "block", description: "Slack token" },
  { type: "api_key_stripe",     regex: /(?:sk|pk)_(?:live|test)_[0-9a-zA-Z]{24,}/g,                                                severity: "block", description: "Stripe key" },
  { type: "api_key_twilio",     regex: /SK[0-9a-fA-F]{32}/g,                                                                       severity: "block", description: "Twilio API key" },
  { type: "api_key_sendgrid",   regex: /SG\.[A-Za-z0-9\-_]{22}\.[A-Za-z0-9\-_]{43}/g,                                             severity: "block", description: "SendGrid API key" },
  { type: "api_key_aws_secret", regex: /(?:aws[_\-\s]?secret|secret[_\-\s]?access[_\-\s]?key)\s*[:=]\s*['"]?([A-Za-z0-9+/]{40})/gi, severity: "block", description: "AWS Secret Access Key" },
  { type: "pii_ipv4",           regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,           severity: "warn",  description: "IPv4 address" },
  { type: "pii_passport_us",    regex: /\b[A-Z]{1,2}[0-9]{6,9}\b/g,                                                               severity: "block", description: "US passport number" },
  { type: "pii_dob",            regex: /\b(?:0[1-9]|1[0-2])[-\/](?:0[1-9]|[12]\d|3[01])[-\/](?:19|20)\d{2}\b/g,                  severity: "warn",  description: "Date of birth" },
  // PEM private key blocks — SSH (RSA/EC/DSA/OPENSSH) and PKCS#8 unencrypted
  { type: "ssh_private_key",    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, severity: "block", description: "SSH/PEM private key" },
  // Encrypted PKCS#8 and PGP private keys
  { type: "tls_private_key",    regex: /-----BEGIN (?:ENCRYPTED PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----[\s\S]+?-----END (?:ENCRYPTED PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/g, severity: "block", description: "TLS/PGP private key" },
  // JWT: base64url header always starts with eyJ ({"  encoded)
  { type: "api_key_jwt",        regex: /\beyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g,                      severity: "block", description: "JWT token" },
  // npm access tokens
  { type: "api_key_npm",        regex: /npm_[A-Za-z0-9]{36}/g,                                                            severity: "block", description: "npm access token" },
  // Database URIs with embedded credentials (user:pass@host)
  { type: "db_connection_string", regex: /(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp)s?:\/\/[^:@\s"']+:[^@\s"']+@[^\s"'<>]+/gi, severity: "block", description: "DB connection string with credentials" },
];

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + (4 - (normalized.length % 4)) % 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

let _hmacKey: CryptoKey | null = null;

async function getHmacKey(): Promise<CryptoKey> {
  if (_hmacKey) return _hmacKey;
  const raw = process.env.LLM_PRIVACY_HMAC_KEY;
  if (!raw) throw new Error("LLM_PRIVACY_HMAC_KEY is required");
  _hmacKey = await crypto.subtle.importKey(
    "raw", base64ToBytes(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return _hmacKey;
}

export async function makeToken(original: string): Promise<string> {
  const key = await getHmacKey();
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(original));
  return "tok_" + base64urlEncode(new Uint8Array(sig).slice(0, 9));
}

function activePatterns(): PatternDefinition[] {
  const disabled = (process.env.LLM_PRIVACY_DISABLE_PATTERNS ?? "")
    .split(",").map(s => s.trim()).filter(Boolean) as PatternType[];
  return disabled.length ? PATTERNS.filter(p => !disabled.includes(p.type)) : PATTERNS;
}

export async function scan(text: string): Promise<ScanResult> {
  const matches: ScanMatch[] = [];
  for (const pattern of activePatterns()) {
    const re = new RegExp(pattern.regex.source, pattern.regex.flags);
    for (const m of text.matchAll(re)) {
      const original = m[0];
      matches.push({
        type: pattern.type, severity: pattern.severity,
        original, token: await makeToken(original),
        offset: m.index ?? 0, length: original.length,
      });
    }
  }
  return { matches, hasBlocks: matches.some(m => m.severity === "block"), hasWarnings: matches.some(m => m.severity === "warn") };
}

export async function tokenizeText(text: string): Promise<{ result: string; matches: ScanMatch[] }> {
  const { matches } = await scan(text);
  if (!matches.length) return { result: text, matches: [] };

  // Sort by offset descending so replacements don't shift indices
  const sorted = [...matches].sort((a, b) => b.offset - a.offset);
  let result = text;
  for (const m of sorted) {
    result = result.slice(0, m.offset) + m.token + result.slice(m.offset + m.length);
  }
  return { result, matches };
}
