import { tokenizeText } from "../core.js";
import type { IVault, VaultEntry } from "../types.js";

// ── Outbound: tokenize all text in an Anthropic messages array ──────────────

type ContentBlock = { type: string; text?: string; [key: string]: unknown };
type Message = { role: string; content: string | ContentBlock[]; [key: string]: unknown };

export async function tokenizeMessages(
  messages: Message[],
  vault: IVault,
  sessionId: string
): Promise<{ messages: Message[]; matchCount: number }> {
  let matchCount = 0;
  const result = await Promise.all(messages.map(async msg => {
    const content = msg.content;
    if (typeof content === "string") {
      const { result, matches } = await tokenizeText(content);
      matchCount += matches.length;
      await storeMatches(matches, vault, sessionId);
      return { ...msg, content: result };
    }
    const blocks = await Promise.all((content as ContentBlock[]).map(async block => {
      if (block.type !== "text" || typeof block.text !== "string") return block;
      const { result, matches } = await tokenizeText(block.text);
      matchCount += matches.length;
      await storeMatches(matches, vault, sessionId);
      return { ...block, text: result };
    }));
    return { ...msg, content: blocks };
  }));
  return { messages: result, matchCount };
}

async function storeMatches(
  matches: Awaited<ReturnType<typeof tokenizeText>>["matches"],
  vault: IVault,
  sessionId: string
): Promise<void> {
  for (const m of matches) {
    try {
      await vault.put({ token: m.token, original: m.original, type: m.type, createdAt: new Date().toISOString(), sessionId });
    } catch { /* vault write failure must not break proxying */ }
  }
}

// ── Inbound: detokenize text in an Anthropic response body ──────────────────

export async function detokenizeBody(body: unknown, vault: IVault): Promise<unknown> {
  if (typeof body !== "object" || body === null) return body;
  const resp = body as Record<string, unknown>;

  if (Array.isArray(resp.content)) {
    resp.content = await Promise.all((resp.content as ContentBlock[]).map(async block => {
      if (block.type !== "text" || typeof block.text !== "string") return block;
      return { ...block, text: await detokenizeString(block.text, vault) };
    }));
  }
  return resp;
}

// Replace all tok_xxxxxxxxxxxx occurrences in a string via vault lookups
export async function detokenizeString(text: string, vault: IVault): Promise<string> {
  const TOKEN_RE = /tok_[A-Za-z0-9_-]{12}/g;
  const tokens = [...new Set(text.match(TOKEN_RE) ?? [])];
  if (!tokens.length) return text;

  const entries = await Promise.all(tokens.map(t => vault.get(t)));
  let result = text;
  for (let i = 0; i < tokens.length; i++) {
    const entry = entries[i];
    if (entry) result = result.replaceAll(tokens[i], entry.original);
  }
  return result;
}

// ── Streaming: buffer-aware detokenizer for SSE text_delta chunks ────────────

export class StreamDetokenizer {
  private buf = "";

  constructor(private readonly vault: IVault) {}

  async push(chunk: string): Promise<string> {
    this.buf += chunk;
    return this.drain();
  }

  async finalize(): Promise<string> {
    // Last chance — try to resolve any complete token still buffered
    const out = await this.drainFull();
    this.buf = "";
    return out;
  }

  private async drain(): Promise<string> {
    let out = "";
    while (true) {
      const idx = this.buf.indexOf("tok_");

      if (idx === -1) {
        // No token prefix anywhere — safe to emit all but last 3 chars
        // (those 3 could be the start of "tok_")
        const safe = Math.max(0, this.buf.length - 3);
        out += this.buf.slice(0, safe);
        this.buf = this.buf.slice(safe);
        break;
      }

      // Emit everything before the prefix
      out += this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx);

      // Need tok_ (4) + 12 chars = 16 total to confirm
      if (this.buf.length < 16) break; // wait for more data

      const candidate = this.buf.slice(0, 16);
      if (/^tok_[A-Za-z0-9_-]{12}$/.test(candidate)) {
        const entry = await this.vault.get(candidate);
        out += entry ? entry.original : candidate;
        this.buf = this.buf.slice(16);
      } else {
        // Looks like "tok_" but not a valid token — emit literal and continue
        out += "tok_";
        this.buf = this.buf.slice(4);
      }
    }
    return out;
  }

  private async drainFull(): Promise<string> {
    // No more data coming — treat full buffer as potentially complete
    if (/^tok_[A-Za-z0-9_-]{12}$/.test(this.buf)) {
      const entry = await this.vault.get(this.buf);
      return entry ? entry.original : this.buf;
    }
    // Normal drain — partial token at end will be emitted as-is
    const out = await this.drain();
    return out + this.buf;
  }
}
