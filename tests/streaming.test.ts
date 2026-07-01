/**
 * Streaming SSE integration tests
 *
 * These tests verify that the handleStreamingResponse SSE tail-injection fix
 * works correctly. They drive the real isTerminalLine()/processSSELine()
 * exports from server.ts through the same loop shape handleStreamingResponse
 * uses (without an HTTP server) to check that:
 *
 *   1. isTerminalLine() correctly identifies terminal SSE event lines —
 *      message_delta/message_stop only. content_block_stop is NOT terminal:
 *      a response can have multiple content blocks (text, tool_use, ...), so
 *      a block closing doesn't mean the stream is done.
 *   2. The held-back tail from finalize() is injected as a proper
 *      content_block_delta SSE event BEFORE the text block's own
 *      content_block_stop (not deferred to end-of-stream, which is too late —
 *      by then the SDK has already closed that content block).
 *   3. The "3 chars" assumption is correct for plain text, but up to 15 chars
 *      can be held back when a privacy token is split at the stream boundary.
 *   4. tool_use content blocks interleaved with a text block still get their
 *      input_json_delta detokenized and flushed in order.
 */

import { describe, it, expect } from "bun:test";
import { isTerminalLine, processSSELine, newStreamState } from "../src/proxy/server.js";
import { StreamDetokenizer, ToolUseBuffer } from "../src/proxy/transform.js";
import { MemoryVault } from "../src/vault.js";

// ── isTerminalLine unit tests ────────────────────────────────────────────────

describe("isTerminalLine", () => {
  it("does NOT treat event: content_block_stop as terminal (a block can close mid-stream, e.g. before a tool_use block)", () => {
    expect(isTerminalLine("event: content_block_stop")).toBe(false);
  });

  it("detects event: message_delta", () => {
    expect(isTerminalLine("event: message_delta")).toBe(true);
  });

  it("detects event: message_stop", () => {
    expect(isTerminalLine("event: message_stop")).toBe(true);
  });

  it("does NOT treat data: content_block_stop as terminal (fallback)", () => {
    expect(isTerminalLine('data: {"type":"content_block_stop","index":0}')).toBe(false);
  });

  it("detects data: message_delta (fallback)", () => {
    expect(isTerminalLine('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}')).toBe(true);
  });

  it("detects data: message_stop (fallback)", () => {
    expect(isTerminalLine('data: {"type":"message_stop"}')).toBe(true);
  });

  it("returns false for event: content_block_delta (content, not terminal)", () => {
    expect(isTerminalLine("event: content_block_delta")).toBe(false);
  });

  it("returns false for data: content_block_delta", () => {
    expect(isTerminalLine('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}')).toBe(false);
  });

  it("returns false for empty line", () => {
    expect(isTerminalLine("")).toBe(false);
  });

  it("returns false for event: ping", () => {
    expect(isTerminalLine("event: ping")).toBe(false);
  });

  it("returns false for malformed data line", () => {
    expect(isTerminalLine("data: not-json")).toBe(false);
  });
});

// ── Streaming state machine simulation ───────────────────────────────────────

/**
 * Replicate the core of handleStreamingResponse's streaming loop, calling the
 * real isTerminalLine()/processSSELine() exports so these tests exercise the
 * actual implementation rather than a parallel reimplementation. Returns the
 * collected output lines.
 */
async function simulateStream(sseLines: string[]): Promise<string[]> {
  const vault = new MemoryVault();
  const detok = new StreamDetokenizer(vault);
  const toolUseBuf = new ToolUseBuffer(vault);
  const state = newStreamState();
  const output: string[] = [];

  const terminalBuf: string[] = [];
  let inTerminalPhase = false;

  for (const line of sseLines) {
    if (inTerminalPhase || isTerminalLine(line)) {
      inTerminalPhase = true;
      terminalBuf.push(line);
    } else {
      const outLines = await processSSELine(line, detok, toolUseBuf, state);
      output.push(...outLines);
    }
  }

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
        output.push("event: content_block_delta");
        output.push("data: " + JSON.stringify(syntheticEvent));
        output.push(""); // SSE event separator
      }
    } else {
      if (tail) output.push(tail); // fallback
    }
  }
  if (inTerminalPhase) {
    for (const line of terminalBuf) output.push(line);
  }

  return output;
}

/** Extract all text_delta strings from the output lines in order */
function collectText(lines: string[]): string {
  return lines
    .filter(l => l.startsWith("data: "))
    .map(l => {
      try {
        const ev = JSON.parse(l.slice(6)) as Record<string, unknown>;
        if (ev.type === "content_block_delta") {
          const delta = ev.delta as Record<string, unknown>;
          if (delta?.type === "text_delta") return delta.text as string;
        }
      } catch {}
      return "";
    })
    .join("");
}

/** Find the position (index into lines[]) of the first terminal event line */
function firstTerminalPos(lines: string[]): number {
  return lines.findIndex(l => isTerminalLine(l));
}

/** Find the last content_block_delta data line position */
function lastDeltaPos(lines: string[]): number {
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("data: ")) continue;
    try {
      const ev = JSON.parse(lines[i].slice(6)) as Record<string, unknown>;
      if (ev.type === "content_block_delta") last = i;
    } catch {}
  }
  return last;
}

// ── Streaming integration tests ───────────────────────────────────────────────

describe("SSE streaming tail injection", () => {
  // Simulate a real Anthropic stream for the text "Hello, world! End."
  // The last 3 chars "nd." are held back by drain() and must appear in a
  // synthetic content_block_delta BEFORE content_block_stop.
  const fullText = "Hello, world! End.";

  // Build a stream where the last chunk ends such that "nd." lands in the tail
  const sseStream = [
    "event: message_start",
    'data: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","content":[]}}',
    "",
    "event: content_block_start",
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello, wor"}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ld! End."}}',
    "",
    "event: content_block_stop",
    'data: {"type":"content_block_stop","index":0}',
    "",
    "event: message_delta",
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":4}}',
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
  ];

  it("reconstructs full text without truncation", async () => {
    const output = await simulateStream(sseStream);
    const text = collectText(output);
    expect(text).toBe(fullText);
  });

  it("synthetic tail delta appears BEFORE content_block_stop", async () => {
    const output = await simulateStream(sseStream);
    const lastDelta = lastDeltaPos(output);
    const firstTerminal = firstTerminalPos(output);
    expect(lastDelta).toBeGreaterThan(-1);
    expect(firstTerminal).toBeGreaterThan(-1);
    expect(lastDelta).toBeLessThan(firstTerminal);
  });

  it("synthetic event has correct SSE structure", async () => {
    const output = await simulateStream(sseStream);
    // Find the synthetic content_block_delta injected for the tail
    const tailEventLine = output.find(l => {
      if (!l.startsWith("data: ")) return false;
      try {
        const ev = JSON.parse(l.slice(6)) as Record<string, unknown>;
        if (ev.type !== "content_block_delta") return false;
        const delta = ev.delta as Record<string, unknown>;
        return typeof delta?.text === "string" && (delta.text as string).length > 0;
      } catch { return false; }
    });
    expect(tailEventLine).toBeDefined();
    // The line before it should be "event: content_block_delta"
    const idx = output.indexOf(tailEventLine!);
    expect(output[idx - 1]).toBe("event: content_block_delta");
  });

  it("content_block_stop, message_delta, and message_stop all appear in order after the synthetic delta", async () => {
    const output = await simulateStream(sseStream);
    const lastDelta = lastDeltaPos(output);
    const stopIdx = output.indexOf("event: content_block_stop");
    const msgDeltaIdx = output.indexOf("event: message_delta");
    const msgStopIdx = output.indexOf("event: message_stop");
    // The synthetic tail delta (the last content_block_delta) must come before
    // content_block_stop closes the block — that's the whole fix. content_block_stop
    // itself is not buffered as "terminal"; only message_delta/message_stop are,
    // and they must still come after it.
    expect(lastDelta).toBeGreaterThan(-1);
    expect(stopIdx).toBeGreaterThan(lastDelta);
    expect(msgDeltaIdx).toBeGreaterThan(stopIdx);
    expect(msgStopIdx).toBeGreaterThan(msgDeltaIdx);
  });

  it("exactly 3 chars held back for plain text ending mid-buffer", async () => {
    // The last chunk "ld! End." (8 chars) → drain holds back last 3 = "nd."
    // So the synthetic event's text should be exactly "nd."
    const output = await simulateStream(sseStream);
    const lastDeltaLine = output
      .filter(l => {
        if (!l.startsWith("data: ")) return false;
        try {
          const ev = JSON.parse(l.slice(6)) as Record<string, unknown>;
          return ev.type === "content_block_delta";
        } catch { return false; }
      })
      .at(-1);
    const ev = JSON.parse(lastDeltaLine!.slice(6)) as Record<string, unknown>;
    const text = (ev.delta as Record<string, unknown>).text as string;
    expect(text).toBe("nd.");
    expect(text.length).toBe(3);
  });

  it("no content is lost even when stream has no privacy tokens", async () => {
    const output = await simulateStream(sseStream);
    expect(output.some(l => l.includes("content_block_stop"))).toBe(true);
    expect(output.some(l => l.includes("message_stop"))).toBe(true);
    const text = collectText(output);
    expect(text.length).toBe(fullText.length);
    expect(text).toBe(fullText);
  });
});

describe("SSE streaming tail — edge cases", () => {
  it("handles stream with no terminal events (fallback path preserved)", async () => {
    // A non-Anthropic or truncated stream with no terminal events.
    // Old behavior is preserved: drain() emits 8 chars via the event data line,
    // and the 3-char tail is written as a raw fallback line.
    const output = await simulateStream([
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello world"}}',
    ]);
    // 8 chars emitted via the data line ("hello wo"), 3-char tail as raw fallback ("rld")
    expect(output.some(l => l.includes('"hello wo"'))).toBe(true); // in JSON event
    expect(output.some(l => l === "rld")).toBe(true);              // raw fallback tail
  });

  it("handles stream where tail is empty (text ends on a chunk boundary)", async () => {
    // If the last delta text is exactly a multiple of buffer size,
    // there may be nothing held back — tail should be empty, no synthetic event
    const stream = [
      "event: content_block_delta",
      // Text of exactly 3 chars — drain() holds back all 3, emits nothing
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"abc"}}',
      "",
      "event: content_block_stop",
      'data: {"type":"content_block_stop","index":0}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
    ];
    const output = await simulateStream(stream);
    const text = collectText(output);
    expect(text).toBe("abc");
    // content_block_stop must still be present
    expect(output.some(l => l === "event: content_block_stop")).toBe(true);
  });

  it("keeps the content_block_stop header adjacent to its data line (not split across the synthetic tail)", async () => {
    // processSSELine() suppresses the raw "event: content_block_stop" header and
    // re-emits it itself, immediately followed by its data line, with any
    // synthetic tail / tool_use flush lines placed BEFORE both — never between them.
    const stream = [
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"test text"}}',
      "",
      "event: content_block_stop",
      'data: {"type":"content_block_stop","index":0}',
      "",
    ];
    const output = await simulateStream(stream);
    const headerIdx = output.indexOf("event: content_block_stop");
    expect(headerIdx).toBeGreaterThan(-1);
    expect(output[headerIdx + 1]).toContain('"content_block_stop"');
  });
});

describe("SSE streaming with tool_use blocks", () => {
  const EMAIL = "person@example.com";
  const TOKEN = "tok_reftest00001";

  it("injects the text block's tail before its content_block_stop, then still detokenizes a later tool_use block's input", async () => {
    const vault = new MemoryVault();
    await vault.put({ token: TOKEN, original: EMAIL, type: "pii_email", createdAt: new Date().toISOString() });
    const detok = new StreamDetokenizer(vault);
    const toolUseBuf = new ToolUseBuffer(vault);
    const state = newStreamState();

    const stream = [
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi there"}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"!!"}}',
      "",
      "event: content_block_stop",
      'data: {"type":"content_block_stop","index":0}',
      "",
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"lookup","input":{}}}',
      "",
      "event: content_block_delta",
      `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"email\\":\\"tok_ref"}}`,
      "",
      "event: content_block_delta",
      `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"test00001\\"}"}}`,
      "",
      "event: content_block_stop",
      'data: {"type":"content_block_stop","index":1}',
      "",
    ];

    const output: string[] = [];
    const terminalBuf: string[] = [];
    let inTerminalPhase = false;
    for (const line of stream) {
      if (inTerminalPhase || isTerminalLine(line)) {
        inTerminalPhase = true;
        terminalBuf.push(line);
      } else {
        output.push(...(await processSSELine(line, detok, toolUseBuf, state)));
      }
    }
    output.push(...terminalBuf);

    // Text is reassembled whole, tail included, before the tool_use block ever starts.
    expect(collectText(output)).toBe("Hi there!!");

    const firstStopIdx = output.indexOf("event: content_block_stop");
    const lastDelta = lastDeltaPos(output.slice(0, firstStopIdx));
    expect(lastDelta).toBeGreaterThan(-1); // synthetic tail delta present before the first stop

    // The tool_use input was flushed as one detokenized input_json_delta, not the raw token.
    const flushedLine = output.find(l => l.includes("input_json_delta"));
    expect(flushedLine).toBeDefined();
    expect(flushedLine).toContain(EMAIL);
    expect(flushedLine).not.toContain(TOKEN);

    // Two distinct content_block_stop events present, second one after the tool_use flush.
    const stopIndices = output.reduce<number[]>((acc, l, i) => (l === "event: content_block_stop" ? [...acc, i] : acc), []);
    expect(stopIndices.length).toBe(2);
    const flushIdx = output.indexOf(flushedLine!);
    expect(flushIdx).toBeGreaterThan(stopIndices[0]);
    expect(flushIdx).toBeLessThan(stopIndices[1]);
  });

  it("emits no bogus synthetic text tail for a tool_use-only stream with no text block", async () => {
    const vault = new MemoryVault();
    const detok = new StreamDetokenizer(vault);
    const toolUseBuf = new ToolUseBuffer(vault);
    const state = newStreamState();

    const stream = [
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"lookup","input":{}}}',
      "",
      "event: content_block_delta",
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"hi\\"}"}}`,
      "",
      "event: content_block_stop",
      'data: {"type":"content_block_stop","index":0}',
      "",
    ];

    const output = await simulateStream(stream);

    expect(collectText(output)).toBe(""); // no text_delta ever occurred, so no tail to inject
    expect(output.some(l => l.includes('"text_delta"'))).toBe(false);
    const flushedLine = output.find(l => l.includes("input_json_delta"));
    expect(flushedLine).toBeDefined();
    const flushedEvent = JSON.parse(flushedLine!.slice(6)) as Record<string, unknown>;
    const flushedDelta = flushedEvent.delta as Record<string, unknown>;
    expect(flushedDelta.partial_json).toBe('{"q":"hi"}');
  });
});
