import { SqliteVault, createVault } from "../vault.js";
import { tokenizeMessages, detokenizeBody, StreamDetokenizer, ToolUseBuffer } from "./transform.js";
import { PromptLogger } from "./logger.js";
import { forwardToOllama, translateOllamaStreamToAnthropic } from "../backends/ollama.js";
import { createDefaultProxyPipeline } from "../modules/index.js";
import pkg from "../../package.json";

const PORT = parseInt(process.env.LLM_PROXY_PORT ?? "4444", 10);
const BACKEND = (process.env.PROXY_BACKEND ?? "anthropic").toLowerCase();
const TARGET = BACKEND === "ollama"
  ? (process.env.LLM_PROXY_TARGET ?? "http://192.168.30.51:11434").replace(/\/$/, "")
  : (process.env.LLM_PROXY_TARGET ?? "https://api.anthropic.com").replace(/\/$/, "");
const BLOCK_ENABLED = process.env.LLM_PRIVACY_BLOCK_ENABLED !== "false" && process.env.LLM_PRIVACY_BLOCK_ENABLED !== undefined;

const vault = createVault();
const logger = new PromptLogger();
const proxyPipeline = createDefaultProxyPipeline();
const stats = { requests: 0, tokenized: 0, detokenized: 0, startedAt: new Date().toISOString() };
let statsDirty = false;

export async function startProxy(): Promise<void> {
  await vault.ready;

  // Restore persisted counters (startedAt always reflects current process)
  if (vault instanceof SqliteVault) {
    const saved = vault.loadStats();
    if (saved.requests)    stats.requests    = parseInt(saved.requests,    10);
    if (saved.tokenized)   stats.tokenized   = parseInt(saved.tokenized,   10);
    if (saved.detokenized) stats.detokenized = parseInt(saved.detokenized, 10);
  }

  const saveStats = () => {
    if (!statsDirty) return;
    if (vault instanceof SqliteVault) {
      vault.saveStats({ requests: stats.requests, tokenized: stats.tokenized, detokenized: stats.detokenized });
      statsDirty = false;
    }
  };
  setInterval(saveStats, 60_000).unref();

  process.on("SIGTERM", () => {
    saveStats();
    if (vault instanceof SqliteVault) vault.checkpoint();
    process.exit(0);
  });

  // Bun 1.x caps idleTimeout at 255 (8-bit). 255s covers all SSE thinking gaps and still reclaims dead connections.
  const idleTimeout = Math.min(parseInt(process.env.LLM_PROXY_IDLE_TIMEOUT ?? "255", 10), 255);

  Bun.serve({
    port: PORT,
    idleTimeout,
    fetch: handleRequest,
    error(err) {
      process.stderr.write(`[llm-proxy] unhandled server error: ${err}\n`);
      return new Response(JSON.stringify({ error: "internal proxy error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    },
  });
  console.log(`[llm-proxy] listening on http://localhost:${PORT} → ${TARGET} [backend: ${BACKEND}]`);
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/health") {
    return new Response(JSON.stringify({
      status: "ok",
      version: pkg.version,
      backend: BACKEND,
      target: TARGET,
      vaultMode: vault.mode,
      vaultPath: vault.path,
      modulesLoaded: proxyPipeline.getModuleCount(),
      ...stats,
    }), { headers: { "content-type": "application/json" } });
  }

  if (req.method === "GET" && url.pathname === "/vault") {
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
    const entries = await vault.list(limit);
    return new Response(JSON.stringify(entries, null, 2), {
      headers: { "content-type": "application/json" },
    });
  }

  if (req.method === "GET" && url.pathname === "/vault/hot") {
    const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
    const entries = await vault.hot(limit);
    return new Response(JSON.stringify(entries, null, 2), {
      headers: { "content-type": "application/json" },
    });
  }

  if (req.method === "GET" && url.pathname === "/vault/stats") {
    return new Response(JSON.stringify(await vault.stats(), null, 2), {
      headers: { "content-type": "application/json" },
    });
  }

  if (req.method === "GET" && url.pathname === "/vault/search") {
    const q = url.searchParams.get("q") ?? "";
    if (!q) return new Response(JSON.stringify([]), { headers: { "content-type": "application/json" } });
    const results = await vault.search(q);
    return new Response(JSON.stringify(results, null, 2), {
      headers: { "content-type": "application/json" },
    });
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    if (BACKEND === "ollama") {
      try {
        const tagsResp = await fetch(`${TARGET}/api/tags`);
        const tags = await tagsResp.json() as { models?: Array<{ name: string; modified_at: string }> };
        const models = (tags.models ?? []).map(m => ({
          id: m.name,
          object: "model",
          created: Math.floor(new Date(m.modified_at).getTime() / 1000),
          owned_by: "ollama",
        }));
        return new Response(JSON.stringify({ object: "list", data: models }), {
          headers: { "content-type": "application/json" },
        });
      } catch {
        return new Response(JSON.stringify({ object: "list", data: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
    }
    return passthrough(req, url);
  }

  if (req.method === "POST" && url.pathname === "/v1/messages") {
    return handleMessages(req, url);
  }
  return passthrough(req, url);
}

async function handleMessages(req: Request, url: URL): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const sessionId = req.headers.get("x-session-id") ?? "unknown";
  const isStreaming = body.stream === true;
  stats.requests++;
  statsDirty = true;

  // Module scan: request phase (before tokenization)
  const requestText = Array.isArray(body.messages)
    ? (body.messages as Array<{ content: unknown }>)
        .map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content))
        .join("\n")
    : "";
  let requestScanFindings: Array<{ scannerId: string; description: string; severity: "block" | "warn" | "info"; atlasTechnique?: string }> = [];
  let requestScanDecision: "allow" | "ask" | "block" = "allow";
  if (requestText) {
    const scanResult = await proxyPipeline.runPhase("request", requestText, sessionId);
    requestScanDecision = scanResult.decision;
    requestScanFindings = scanResult.findings.map(f => ({
      scannerId: f.scannerId,
      description: f.description,
      severity: f.severity,
      ...(f.atlasTechnique ? { atlasTechnique: f.atlasTechnique } : {}),
    }));
    if (BLOCK_ENABLED && scanResult.decision === "block") {
      return new Response(JSON.stringify({
        error: "blocked",
        findings: requestScanFindings,
      }), { status: 400, headers: { "content-type": "application/json" } });
    }
    if (scanResult.findings.length > 0) {
      process.stderr.write(`[llm-proxy] request scan findings: ${scanResult.findings.map(f => f.description).join(", ")}\n`);
    }
  }

  // Tokenize outbound messages
  let originalMessages: unknown[] | undefined;
  if (Array.isArray(body.messages)) {
    try {
      if (logger.mode === "full") originalMessages = structuredClone(body.messages);
      const { messages, matchCount } = await tokenizeMessages(body.messages as never, vault, sessionId);
      if (matchCount > 0) { stats.tokenized++; statsDirty = true; }
      body.messages = messages;

      if (logger.mode !== "none") {
        logger.log({
          ts: new Date().toISOString(),
          sessionId,
          matchCount,
          tokenized: (messages as Array<{ content: unknown }>).map(m => JSON.stringify(m.content)),
          ...(logger.mode === "full" && originalMessages
            ? { original: (originalMessages as Array<{ content: unknown }>).map(m => JSON.stringify(m.content)) }
            : {}),
          ...(requestScanDecision !== "allow" || requestScanFindings.length > 0
            ? { decision: requestScanDecision, findings: requestScanFindings }
            : {}),
        });
      }
    } catch (err) {
      process.stderr.write(`[llm-proxy] tokenize error: ${err}\n`);
    }
  }

  // Ollama backend: format-translate and forward
  if (BACKEND === "ollama") {
    let ollamaResp: Response;
    try {
      ollamaResp = await forwardToOllama(body);
    } catch (err) {
      process.stderr.write(`[llm-proxy] ollama upstream error: ${err}\n`);
      return new Response(JSON.stringify({ error: "ollama unavailable" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
    if (!ollamaResp.ok) {
      const errText = await ollamaResp.text().catch(() => "");
      process.stderr.write(`[llm-proxy] ollama error ${ollamaResp.status}: ${errText.slice(0, 200)}\n`);
      return new Response(JSON.stringify({ error: `ollama error: ${ollamaResp.status}` }), {
        status: ollamaResp.status,
        headers: { "content-type": "application/json" },
      });
    }
    return translateOllamaStreamToAnthropic(ollamaResp, vault);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${TARGET}${url.pathname}`, {
      method: "POST",
      headers: forwardHeaders(req.headers),
      body: JSON.stringify(body),
    });
  } catch (err) {
    process.stderr.write(`[llm-proxy] upstream fetch error: ${err}\n`);
    return new Response(JSON.stringify({ error: "upstream unavailable" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  if (!upstream.ok) {
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders(upstream.headers) });
  }

  if (isStreaming) {
    return handleStreamingResponse(upstream);
  }

  try {
    const json = await upstream.json();
    const before = JSON.stringify(json);
    const detokenized = await detokenizeBody(json, vault);
    if (JSON.stringify(detokenized) !== before) { stats.detokenized++; statsDirty = true; }
    return new Response(JSON.stringify(detokenized), {
      status: upstream.status,
      headers: { ...responseHeaders(upstream.headers), "content-type": "application/json" },
    });
  } catch (err) {
    process.stderr.write(`[llm-proxy] detokenize error: ${err}\n`);
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders(upstream.headers) });
  }
}

export type StreamState = {
  lastContentIndex: number;
  sawTextDelta: boolean;
  tailInjected: boolean;
};

export function newStreamState(): StreamState {
  return { lastContentIndex: 0, sawTextDelta: false, tailInjected: false };
}

function handleStreamingResponse(upstream: Response): Response {
  const vault_ = vault;
  const upstreamBody = upstream.body;
  if (!upstreamBody) return new Response(null, { status: upstream.status });

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  (async () => {
    const detok = new StreamDetokenizer(vault_);
    const toolUseBuf = new ToolUseBuffer(vault_);
    const reader = upstreamBody.getReader();
    let leftover = "";
    let chunksRead = 0;
    let streamDone = false;
    const terminalBuf: string[] = [];
    let inTerminalPhase = false;
    const state: StreamState = newStreamState();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { streamDone = true; break; }
        chunksRead++;

        leftover += decoder.decode(value, { stream: true });
        const lines = leftover.split("\n");
        leftover = lines.pop() ?? "";

        for (const line of lines) {
          if (inTerminalPhase || isTerminalLine(line)) {
            inTerminalPhase = true;
            terminalBuf.push(line);
          } else {
            const outLines = await processSSELine(line, detok, toolUseBuf, state);
            for (const l of outLines) {
              await writer.write(encoder.encode(l + "\n"));
            }
          }
        }
      }

      if (leftover) {
        if (inTerminalPhase || isTerminalLine(leftover)) {
          inTerminalPhase = true;
          terminalBuf.push(leftover);
        } else {
          const outLines = await processSSELine(leftover, detok, toolUseBuf, state);
          for (const l of outLines) {
            await writer.write(encoder.encode(l + "\n"));
          }
        }
      }

      // Fallback tail injection: only reached if no matching content_block_stop
      // for the text block was ever seen (truncated stream, non-Anthropic
      // backend, or a stream that ends with no content at all).
      if (!state.tailInjected) {
        state.tailInjected = true;
        const tail = await detok.finalize();
        if (inTerminalPhase) {
          if (tail) {
            const syntheticEvent = {
              type: "content_block_delta",
              index: state.lastContentIndex,
              delta: { type: "text_delta", text: tail },
            };
            await writer.write(encoder.encode("event: content_block_delta\n"));
            await writer.write(encoder.encode("data: " + JSON.stringify(syntheticEvent) + "\n\n"));
          }
        } else {
          if (tail) await writer.write(encoder.encode(tail));
        }
      }

      if (inTerminalPhase) {
        // Flush all buffered terminal events in order (message_delta, message_stop, ...)
        for (const line of terminalBuf) {
          await writer.write(encoder.encode(line + "\n"));
        }
      }
    } catch (err) {
      if (err == null) {
        // Bun throws undefined/null when the client cancels the response mid-stream.
        // Log at debug level with context so we can verify this assumption.
        process.stderr.write(`[llm-proxy] stream cancelled by client (chunks=${chunksRead} streamDone=${streamDone})\n`);
      } else {
        const msg = err instanceof Error ? err.message : `${(err as any)?.constructor?.name ?? typeof err}: ${String(err)}`;
        process.stderr.write(`[llm-proxy] stream error (chunks=${chunksRead} streamDone=${streamDone}): ${msg}\n`);
      }
    } finally {
      await writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    status: upstream.status,
    headers: responseHeaders(upstream.headers),
  });
}

export async function processSSELine(
  line: string,
  detok: StreamDetokenizer,
  toolUseBuf: ToolUseBuffer,
  state: StreamState,
): Promise<string[]> {
  // SSE event-header lines (e.g. "event: content_block_delta") come before the
  // matching data line. We suppress "event: content_block_stop" headers
  // unconditionally (not just for tool_use) and re-emit them from the
  // data-line handler below, so we can inject a synthetic tail delta or a
  // buffered tool_use flush ahead of them in the correct order — a stop can
  // close either kind of block, and only the data line tells us which.
  if (!line.startsWith("data: ")) {
    // Suppress "event: content_block_delta" headers while buffering tool input
    if (line === "event: content_block_delta" && toolUseBuf.active) return [];
    if (line === "event: content_block_stop") return [];
    return [line];
  }

  const raw = line.slice(6);
  if (raw === "[DONE]") return [line];

  let event: Record<string, unknown>;
  try { event = JSON.parse(raw); } catch { return [line]; }

  if (
    event.type === "content_block_delta" &&
    typeof event.delta === "object" && event.delta !== null
  ) {
    const delta = event.delta as Record<string, unknown>;

    // Text delta — existing behaviour unchanged
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      delta.text = await detok.push(delta.text);
      if (typeof event.index === "number") {
        state.lastContentIndex = event.index;
        state.sawTextDelta = true;
      }
      return ["data: " + JSON.stringify(event)];
    }

    // Tool input delta — buffer and suppress; emitted as one detokenized chunk on block_stop
    if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      toolUseBuf.accumulate(delta.partial_json);
      return [];
    }
  }

  // Tool_use block start — initialise buffer for this block
  if (
    event.type === "content_block_start" &&
    typeof event.content_block === "object" && event.content_block !== null
  ) {
    const cb = event.content_block as Record<string, unknown>;
    if (cb.type === "tool_use" && typeof event.index === "number") {
      toolUseBuf.startBlock(event.index);
    }
    return [line];
  }

  // Content block stop — its "event: content_block_stop" header was suppressed
  // above so we own ordering. Either flush a pending tool_use buffer, or — if
  // this stop closes the text block that's been receiving text_delta pushes —
  // inject the detokenizer's held-back tail, then re-emit header + data line.
  if (event.type === "content_block_stop") {
    const preLines: string[] = [];
    if (toolUseBuf.hasData()) {
      preLines.push(...(await toolUseBuf.flush()));
    } else if (
      typeof event.index === "number" &&
      event.index === state.lastContentIndex &&
      state.sawTextDelta &&
      !state.tailInjected
    ) {
      state.tailInjected = true;
      const tail = await detok.finalize();
      if (tail) {
        preLines.push("event: content_block_delta");
        preLines.push("data: " + JSON.stringify({
          type: "content_block_delta",
          index: state.lastContentIndex,
          delta: { type: "text_delta", text: tail },
        }));
        preLines.push(""); // blank line terminates the SSE event per spec
      }
    }
    return [...preLines, "event: content_block_stop", line];
  }

  return [line];
}

/**
 * Returns true when `line` marks the start of the terminal SSE event group —
 * i.e., message_delta or message_stop. `content_block_stop` is deliberately
 * NOT terminal: a response can have multiple content blocks (e.g. text
 * followed by tool_use), so a block closing doesn't mean the stream is done.
 * `content_block_stop` is instead handled per-block in `processSSELine()`,
 * which injects the detokenizer's tail or flushes a tool_use buffer at the
 * right block boundary. Primary detection via `event: X` header lines;
 * data-line JSON type as fallback.
 */
export function isTerminalLine(line: string): boolean {
  if (
    line === "event: message_delta" ||
    line === "event: message_stop"
  ) return true;

  if (line.startsWith("data: ")) {
    try {
      const ev = JSON.parse(line.slice(6)) as Record<string, unknown>;
      return (
        ev.type === "message_delta" ||
        ev.type === "message_stop"
      );
    } catch {}
  }
  return false;
}

async function passthrough(req: Request, url: URL): Promise<Response> {
  const upstream = await fetch(`${TARGET}${url.pathname}${url.search}`, {
    method: req.method,
    headers: forwardHeaders(req.headers),
    body: req.body,
  });
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders(upstream.headers) });
}

function forwardHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const strip = ["host", "connection", "transfer-encoding", "accept-encoding"];
  h.forEach((v, k) => {
    if (!strip.includes(k.toLowerCase())) out[k] = v;
  });
  return out;
}

function responseHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const strip = ["transfer-encoding", "connection", "content-encoding", "content-length"];
  h.forEach((v, k) => {
    if (!strip.includes(k.toLowerCase())) out[k] = v;
  });
  return out;
}
