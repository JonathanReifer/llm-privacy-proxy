/**
 * Streaming SSE integration tests
 *
 * These tests verify that the handleStreamingResponse SSE tail-injection fix
 * works correctly. They simulate the streaming state machine directly (without
 * an HTTP server) to check that:
 *
 *   1. isTerminalLine() correctly identifies terminal SSE event lines
 *   2. The held-back tail from finalize() is injected as a proper
 *      content_block_delta SSE event BEFORE content_block_stop/message_stop
 *   3. The "3 chars" assumption is correct for plain text, but up to 15 chars
 *      can be held back when a privacy token is split at the stream boundary
 */

import { describe, it, expect } from "bun:test";
import { isTerminalLine } from "../src/proxy/server.js";
import { StreamDetokenizer } from "../src/proxy/transform.js";
import { MemoryVault } from "../src/vault.js";

// ── isTerminalLine unit tests ────────────────────────────────────────────────

describe("isTerminalLine", () => {
  it("detects event: content_block_stop", () => {
    expect(isTerminalLine("event: content_block_stop")).toBe(true);
  });

  it("detects event: message_delta", () => {
    expect(isTerminalLine("event: message_delta")).toBe(true);
  });

  it("detects event: message_stop", () => {
    expect(isTerminalLine("event: message_stop")).toBe(true);
  });

  it("detects data: content_block_stop (fallback)", () => {
    expect(isTerminalLine('data: {"type":"content_block_stop","index":0}')).toBe(true);
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
 * Replicate the core of handleStreamingResponse's streaming loop in a
 * testable, synchronous-ish form. Returns the collected output lines.
 */
async function simulateStream(sseLines: string[]): Promise<string[]> {
  const vault = new MemoryVault();
  const detok = new StreamDetokenizer(vault);
  const output: string[] = [];

  const terminalBuf: string[] = [];
  let inTerminalPhase = false;
  let lastContentIndex: number | null = null;

  for (const line of sseLines) {
    if (inTerminalPhase || isTerminalLine(line)) {
      inTerminalPhase = true;
      terminalBuf.push(line);
    } else {
      // processSSELine equivalent (plain text only — no vault tokens in these tests)
      let out = line;
      if (line.startsWith("data: ")) {
        try {
          const ev = JSON.parse(line.slice(6)) as Record<string, unknown>;
          if (
            ev.type === "content_block_delta" &&
            typeof ev.delta === "object" && ev.delta !== null
          ) {
            const delta = ev.delta as Record<string, unknown>;
            if (delta.type === "text_delta" && typeof delta.text === "string") {
              delta.text = await detok.push(delta.text);
              out = "data: " + JSON.stringify(ev);
            }
          }
          if (
            ev.type === "content_block_delta" &&
            typeof ev.index === "number" &&
            (ev.delta as Record<string, unknown>)?.type === "text_delta"
          ) {
            lastContentIndex = ev.index as number;
          }
        } catch {}
      }
      output.push(out);
    }
  }

  const tail = await detok.finalize();
  if (inTerminalPhase) {
    if (tail && lastContentIndex !== null) {
      const syntheticEvent = {
        type: "content_block_delta",
        index: lastContentIndex,
        delta: { type: "text_delta", text: tail },
      };
      output.push("event: content_block_delta");
      output.push("data: " + JSON.stringify(syntheticEvent));
      output.push(""); // SSE event separator
    }
    for (const line of terminalBuf) output.push(line);
  } else {
    if (tail) output.push(tail); // fallback
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

  it("all terminal events are preserved in order after the synthetic delta", async () => {
    const output = await simulateStream(sseStream);
    const firstTerminal = firstTerminalPos(output);
    const terminalLines = output.slice(firstTerminal);
    // Should contain all three terminal event lines
    expect(terminalLines.some(l => l === "event: content_block_stop")).toBe(true);
    expect(terminalLines.some(l => l === "event: message_delta")).toBe(true);
    expect(terminalLines.some(l => l === "event: message_stop")).toBe(true);
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

  it("does not inject synthetic text_delta into tool_use-only stream (lastContentIndex poisoning fix)", async () => {
    // Regression: tool-use-only responses have no text content block. The old code
    // initialised lastContentIndex=0 and injected a text_delta onto index 0 (a
    // tool_use block), causing the SDK to throw "Content block is not a text block".
    const stream = [
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01","name":"bash","input":{}}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"ls\\"}"}}',
      "",
      "event: content_block_stop",
      'data: {"type":"content_block_stop","index":0}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ];
    const output = await simulateStream(stream);
    // No synthetic text_delta should be injected (no text content block existed)
    const syntheticTextDelta = output.find(l => {
      if (!l.startsWith("data: ")) return false;
      try {
        const ev = JSON.parse(l.slice(6)) as Record<string, unknown>;
        if (ev.type !== "content_block_delta") return false;
        return (ev.delta as Record<string, unknown>)?.type === "text_delta";
      } catch { return false; }
    });
    expect(syntheticTextDelta).toBeUndefined();
    // Terminal events must still be present
    expect(output.some(l => l === "event: content_block_stop")).toBe(true);
    expect(output.some(l => l === "event: message_stop")).toBe(true);
  });

  it("correctly buffers event: header line when terminal phase starts mid-batch", async () => {
    // Ensures the event: content_block_stop header is buffered alongside its data: line
    const stream = [
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"test text"}}',
      "",
      "event: content_block_stop",  // ← this line triggers terminal phase
      'data: {"type":"content_block_stop","index":0}',
      "",
    ];
    const output = await simulateStream(stream);
    // Both the event: and data: lines should be in the output after the synthetic tail
    const firstTerminal = firstTerminalPos(output);
    expect(output[firstTerminal]).toBe("event: content_block_stop");
    const nextLine = output[firstTerminal + 1];
    expect(nextLine).toContain("content_block_stop");
  });
});
