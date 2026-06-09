import type { IVault } from "../types.js";
import { StreamDetokenizer } from "../proxy/transform.js";

const OLLAMA_HOST = (process.env.LLM_PROXY_TARGET ?? "http://192.168.30.51:11434").replace(/\/$/, "");

export const MODEL_MAP: Record<string, string> = {
  default: "nemotron-3-ultra:cloud",
};

function mapModel(model: string): string {
  if (/opus|sonnet/i.test(model)) return "nemotron-3-ultra:cloud";
  if (/haiku/i.test(model)) return "nemotron-3-super:cloud";
  return model;
}

// Anthropic tool_use content block → OpenAI-style function tool
function translateTools(tools: unknown[]): unknown[] {
  return tools.map((t) => {
    const tool = t as Record<string, unknown>;
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.input_schema ?? { type: "object", properties: {} },
      },
    };
  });
}

// Anthropic messages array → Ollama messages array
function translateMessages(messages: unknown[], systemText?: string): unknown[] {
  const out: unknown[] = [];

  if (systemText) {
    out.push({ role: "system", content: systemText });
  }

  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const role = m.role as string;
    const content = m.content;

    // Handle tool_result messages: Anthropic uses role "user" with content array
    // containing {type:"tool_result", tool_use_id, content} blocks.
    // Ollama expects role "tool" with content string.
    if (role === "user" && Array.isArray(content)) {
      const toolResults = (content as Array<Record<string, unknown>>).filter(
        (c) => c.type === "tool_result"
      );
      const textBlocks = (content as Array<Record<string, unknown>>).filter(
        (c) => c.type === "text"
      );

      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          const resultContent = tr.content;
          let resultStr: string;
          if (typeof resultContent === "string") {
            resultStr = resultContent;
          } else if (Array.isArray(resultContent)) {
            resultStr = (resultContent as Array<Record<string, unknown>>)
              .map((b) => (b.type === "text" ? (b.text as string) : JSON.stringify(b)))
              .join("\n");
          } else {
            resultStr = JSON.stringify(resultContent);
          }
          out.push({ role: "tool", content: resultStr });
        }
        // If there were also text blocks, add them as a regular user message
        if (textBlocks.length > 0) {
          const text = textBlocks.map((b) => b.text as string).join("\n");
          out.push({ role: "user", content: text });
        }
        continue;
      }

      // Regular user message with content array (text blocks)
      const text = (content as Array<Record<string, unknown>>)
        .map((b) => (b.type === "text" ? (b.text as string) : ""))
        .join("\n");
      out.push({ role: "user", content: text });
      continue;
    }

    // Assistant messages — may include tool_use blocks
    if (role === "assistant" && Array.isArray(content)) {
      // Flatten to text for assistant history (tool_use was already executed)
      const text = (content as Array<Record<string, unknown>>)
        .filter((b) => b.type === "text")
        .map((b) => b.text as string)
        .join("\n");
      out.push({ role: "assistant", content: text || "" });
      continue;
    }

    // Plain string content
    out.push({ role, content: typeof content === "string" ? content : JSON.stringify(content) });
  }

  return out;
}

export function translateToOllama(body: Record<string, unknown>): Record<string, unknown> {
  const model = mapModel((body.model as string) ?? "");
  const systemText = typeof body.system === "string" ? body.system : undefined;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? translateTools(body.tools) : undefined;

  const options: Record<string, unknown> = {};
  if (typeof body.max_tokens === "number") options.num_predict = body.max_tokens;
  if (typeof body.temperature === "number") options.temperature = body.temperature;

  const req: Record<string, unknown> = {
    model,
    messages: translateMessages(messages, systemText),
    stream: true,
  };
  if (tools) req.tools = tools;
  if (Object.keys(options).length > 0) req.options = options;

  return req;
}

export async function forwardToOllama(body: Record<string, unknown>): Promise<Response> {
  const ollamaBody = translateToOllama(body);
  return fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ollamaBody),
  });
}

// Ollama NDJSON streaming → Anthropic SSE format
// The Anthropic SDK state machine requires this exact event sequence:
//   1. message_start
//   2. content_block_start (index 0, type "text")
//   3. content_block_delta* (text deltas)
//   4. [content_block_stop for text block if there are tool calls]
//   5. [content_block_start + content_block_delta + content_block_stop per tool_use]
//   6. content_block_stop (for last block)
//   7. message_delta (with stop_reason)
//   8. message_stop
export async function translateOllamaStreamToAnthropic(
  ollamaResp: Response,
  vault: IVault
): Promise<Response> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const msgId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

  function sse(eventName: string, data: unknown): string {
    return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  (async () => {
    const detok = new StreamDetokenizer(vault);
    let textBlockOpen = false;
    let stopReason = "end_turn";
    let lastBlockIndex = 0;

    try {
      // Emit message_start
      await writer.write(enc.encode(sse("message_start", {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          content: [],
          model: "ollama",
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })));

      // Emit content_block_start for the text block
      await writer.write(enc.encode(sse("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })));
      textBlockOpen = true;

      const body = ollamaResp.body;
      if (!body) throw new Error("Ollama response has no body");

      const reader = body.getReader();
      let leftover = "";
      let toolBlockIndex = 1;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        leftover += dec.decode(value, { stream: true });
        const lines = leftover.split("\n");
        leftover = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let chunk: Record<string, unknown>;
          try { chunk = JSON.parse(trimmed); } catch { continue; }

          const isDone = chunk.done === true;
          const msg = chunk.message as Record<string, unknown> | undefined;

          if (msg) {
            const content = msg.content as string | undefined;
            const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;

            // Text content delta
            if (typeof content === "string" && content.length > 0) {
              const detokenized = await detok.push(content);
              if (detokenized.length > 0) {
                await writer.write(enc.encode(sse("content_block_delta", {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: detokenized },
                })));
              }
            }

            // Tool calls
            if (toolCalls && toolCalls.length > 0) {
              // Close text block first
              if (textBlockOpen) {
                const tail = await detok.finalize();
                if (tail) {
                  await writer.write(enc.encode(sse("content_block_delta", {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: tail },
                  })));
                }
                await writer.write(enc.encode(sse("content_block_stop", {
                  type: "content_block_stop", index: 0,
                })));
                textBlockOpen = false;
              }

              for (const tc of toolCalls) {
                const fn = tc.function as Record<string, unknown>;
                const toolId = `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
                const toolName = fn.name as string;
                const toolArgs = typeof fn.arguments === "string"
                  ? fn.arguments
                  : JSON.stringify(fn.arguments ?? {});

                await writer.write(enc.encode(sse("content_block_start", {
                  type: "content_block_start",
                  index: toolBlockIndex,
                  content_block: { type: "tool_use", id: toolId, name: toolName, input: {} },
                })));
                await writer.write(enc.encode(sse("content_block_delta", {
                  type: "content_block_delta",
                  index: toolBlockIndex,
                  delta: { type: "input_json_delta", partial_json: toolArgs },
                })));
                await writer.write(enc.encode(sse("content_block_stop", {
                  type: "content_block_stop", index: toolBlockIndex,
                })));
                lastBlockIndex = toolBlockIndex;
                toolBlockIndex++;
              }
              stopReason = "tool_use";
            }
          }

          if (isDone) {
            const doneReason = chunk.done_reason as string | undefined;
            if (doneReason === "length") stopReason = "max_tokens";
            else if (doneReason === "tool_calls") stopReason = "tool_use";
            else if (doneReason === "stop") stopReason = "end_turn";
          }
        }
      }

      // Close the text block if still open
      if (textBlockOpen) {
        const tail = await detok.finalize();
        if (tail) {
          await writer.write(enc.encode(sse("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: tail },
          })));
        }
        await writer.write(enc.encode(sse("content_block_stop", {
          type: "content_block_stop", index: 0,
        })));
        lastBlockIndex = 0;
      }

      // message_delta with stop reason
      await writer.write(enc.encode(sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 0 },
      })));

      // message_stop
      await writer.write(enc.encode(sse("message_stop", { type: "message_stop" })));

    } catch (err) {
      process.stderr.write(`[llm-proxy] ollama stream error: ${err}\n`);
    } finally {
      await writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "transfer-encoding": "chunked",
    },
  });
}
