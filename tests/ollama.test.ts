import { describe, it, expect, beforeAll } from "bun:test";

// Import the internal translation helper directly
// We test the translateMessages function by importing the module and calling it
// via the exported translateToOllama which wraps it

const OLLAMA_URL = process.env.LLM_PROXY_TARGET ?? "http://192.168.30.51:11434";

// Import translateToOllama; it's the public surface for the translation pipeline
let translateToOllama: (body: Record<string, unknown>) => Record<string, unknown>;

// Dynamic import so we can set env before module load
beforeAll(async () => {
  process.env.LLM_PROXY_TARGET = OLLAMA_URL;
  ({ translateToOllama } = await import("../src/backends/ollama.js"));
});

describe("translateToOllama — request shape", () => {
  it("maps system prompt to first message", () => {
    const out = translateToOllama({
      model: "claude-sonnet-4-6",
      system: "You are a helpful assistant.",
      messages: [{ role: "user", content: "Hello" }],
    });
    const msgs = out.messages as Array<{ role: string; content: string }>;
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe("You are a helpful assistant.");
  });

  it("maps sonnet model to nemotron-3-ultra", () => {
    const out = translateToOllama({ model: "claude-sonnet-4-6", messages: [] });
    expect(out.model).toBe("nemotron-3-ultra:cloud");
  });

  it("maps haiku model to nemotron-3-super", () => {
    const out = translateToOllama({ model: "claude-haiku-4-5", messages: [] });
    expect(out.model).toBe("nemotron-3-super:cloud");
  });

  it("maps opus model to nemotron-3-ultra", () => {
    const out = translateToOllama({ model: "claude-opus-4-8", messages: [] });
    expect(out.model).toBe("nemotron-3-ultra:cloud");
  });

  it("converts max_tokens to options.num_predict", () => {
    const out = translateToOllama({ model: "claude-sonnet-4-6", messages: [], max_tokens: 512 });
    expect((out.options as Record<string, unknown>).num_predict).toBe(512);
  });

  it("converts tool_result content blocks to role:tool messages", () => {
    const messages = [
      { role: "user", content: "call a tool" },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_abc123",
            content: [{ type: "text", text: "tool output here" }],
          },
        ],
      },
    ];
    const out = translateToOllama({ model: "claude-sonnet-4-6", messages });
    const outMsgs = out.messages as Array<{ role: string; content: string }>;
    const toolMsg = outMsgs.find((m) => m.role === "tool");
    expect(toolMsg).toBeTruthy();
    expect(toolMsg?.content).toContain("tool output here");
  });

  it("converts tool definitions to OpenAI-style function format", () => {
    const out = translateToOllama({
      model: "claude-sonnet-4-6",
      messages: [],
      tools: [
        {
          name: "get_weather",
          description: "Get current weather",
          input_schema: {
            type: "object",
            properties: { location: { type: "string" } },
            required: ["location"],
          },
        },
      ],
    });
    const tools = out.tools as Array<{ type: string; function: { name: string; parameters: unknown } }>;
    expect(tools[0].type).toBe("function");
    expect(tools[0].function.name).toBe("get_weather");
    expect(tools[0].function.parameters).toBeDefined();
  });

  it("passes through unrecognized model names as-is", () => {
    const out = translateToOllama({ model: "some-custom-model", messages: [] });
    expect(out.model).toBe("some-custom-model");
  });
});
