import { SqliteVault, createVault } from "../vault.js";
import { tokenizeMessages, detokenizeBody, StreamDetokenizer } from "./transform.js";
import { PromptLogger } from "./logger.js";
import pkg from "../../package.json";

const PORT = parseInt(process.env.LLM_PROXY_PORT ?? "4444", 10);
const TARGET = (process.env.LLM_PROXY_TARGET ?? "https://api.anthropic.com").replace(/\/$/, "");

const vault = createVault();
const logger = new PromptLogger();
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
  console.log(`[llm-proxy] listening on http://localhost:${PORT} → ${TARGET}`);
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/health") {
    return new Response(JSON.stringify({
      status: "ok",
      version: pkg.version,
      target: TARGET,
      vaultMode: vault.mode,
      vaultPath: vault.path,
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
        });
      }
    } catch (err) {
      process.stderr.write(`[llm-proxy] tokenize error: ${err}\n`);
    }
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
    const reader = upstreamBody.getReader();
    let leftover = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        leftover += decoder.decode(value, { stream: true });
        const lines = leftover.split("\n");
        leftover = lines.pop() ?? "";

        for (const line of lines) {
          const out = await processSSELine(line, detok);
          await writer.write(encoder.encode(out + "\n"));
        }
      }

      if (leftover) {
        const out = await processSSELine(leftover, detok);
        await writer.write(encoder.encode(out + "\n"));
      }
      const tail = await detok.finalize();
      if (tail) await writer.write(encoder.encode(tail));
    } catch (err) {
      // Bun throws undefined when the client disconnects mid-stream (normal, not an error)
      if (err != null) {
        const msg = err instanceof Error ? err.message : `${(err as any)?.constructor?.name ?? typeof err}: ${String(err)}`;
        process.stderr.write(`[llm-proxy] stream error: ${msg}\n`);
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

async function processSSELine(line: string, detok: StreamDetokenizer): Promise<string> {
  if (!line.startsWith("data: ")) return line;

  const raw = line.slice(6);
  if (raw === "[DONE]") return line;

  let event: Record<string, unknown>;
  try { event = JSON.parse(raw); } catch { return line; }

  if (
    event.type === "content_block_delta" &&
    typeof event.delta === "object" && event.delta !== null
  ) {
    const delta = event.delta as Record<string, unknown>;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      delta.text = await detok.push(delta.text);
      return "data: " + JSON.stringify(event);
    }
  }

  return line;
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
