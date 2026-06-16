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
  await Promise.all(matches.map(m =>
    vault.put({ token: m.token, original: m.original, type: m.type, createdAt: new Date().toISOString(), sessionId })
      .catch(() => { /* vault write failure must not break proxying */ })
  ));
}

// ── Inbound: detokenize text in an Anthropic response body ──────────────────

export async function detokenizeBody(body: unknown, vault: IVault): Promise<unknown> {
  if (typeof body !== "object" || body === null) return body;
  const resp = body as Record<string, unknown>;

  if (Array.isArray(resp.content)) {
    resp.content = await Promise.all((resp.content as ContentBlock[]).map(async block => {
      if (block.type === "text" && typeof block.text === "string") {
        return { ...block, text: await detokenizeString(block.text, vault) };
      }
      if (block.type === "tool_use" && block.input !== null && typeof block.input === "object") {
        return { ...block, input: await deepDetokenizeValue(block.input, vault) };
      }
      return block;
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

// Recursively detokenize all string leaves in any JSON value
export async function deepDetokenizeValue(value: unknown, vault: IVault): Promise<unknown> {
  if (typeof value === "string") return detokenizeString(value, vault);
  if (Array.isArray(value)) {
    return Promise.all(value.map(item => deepDetokenizeValue(item, vault)));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = await deepDetokenizeValue(v, vault);
    }
    return result;
  }
  return value; // number, boolean, null — unchanged
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

// ── Streaming: buffer tool_use input_json_delta chunks, flush on block_stop ──

export class ToolUseBuffer {
  private blockIndex: number | null = null;
  private partials: string[] = [];

  constructor(private readonly vault: IVault) {}

  startBlock(index: number): void {
    this.blockIndex = index;
    this.partials = [];
  }

  accumulate(partial: string): void {
    this.partials.push(partial);
  }

  hasData(): boolean {
    return this.blockIndex !== null && this.partials.length > 0;
  }

  async flush(): Promise<string[]> {
    if (!this.hasData()) return [];
    const rawJson = this.partials.join("");
    let detokenizedJson = rawJson;
    try {
      const parsed = JSON.parse(rawJson);
      const detokenized = await deepDetokenizeValue(parsed, this.vault);
      detokenizedJson = JSON.stringify(detokenized);
    } catch {
      // Malformed JSON (shouldn't happen per Anthropic spec) — detokenize as string
      detokenizedJson = await detokenizeString(rawJson, this.vault);
    }
    const deltaEvent = {
      type: "content_block_delta",
      index: this.blockIndex,
      delta: { type: "input_json_delta", partial_json: detokenizedJson },
    };
    this.blockIndex = null;
    this.partials = [];
    return [
      "event: content_block_delta",
      "data: " + JSON.stringify(deltaEvent),
      "",
    ];
  }
}
