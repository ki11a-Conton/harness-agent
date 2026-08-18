import { describe, expect, it } from "vitest";
import { errorInfo, newMessageId, newSessionId } from "@ar/contracts";
import type { Message } from "@ar/contracts";
import { EchoModelProvider, ScriptedModelProvider } from "./index.js";
import { ModelRegistry } from "./registry.js";

function userMessage(text: string): Message {
  return {
    id: newMessageId(),
    sessionId: newSessionId(),
    role: "user",
    content: text,
    createdAt: 0,
  };
}

describe("ScriptedModelProvider", () => {
  it("streams text and completes", async () => {
    const p = new ScriptedModelProvider([ScriptedModelProvider.text("hello world")]);
    const client = p.createClient({ providerId: "scripted", modelId: "scripted-model" }, {});
    const events: string[] = [];
    let finalText = "";
    for await (const ev of client.generate({ messages: [userMessage("hi")] }, new AbortController().signal)) {
      if (ev.type === "text_delta") {
        events.push(ev.text);
        finalText += ev.text;
      }
      if (ev.type === "completed") {
        expect(ev.result.finishReason).toBe("stop");
        expect(finalText).toBe("hello world");
      }
    }
    expect(events.length).toBe(1);
  });

  it("streams a tool call", async () => {
    const p = new ScriptedModelProvider([ScriptedModelProvider.toolCall("read", { path: "a.txt" })]);
    const client = p.createClient({ providerId: "scripted", modelId: "scripted-model" }, {});
    const calls: string[] = [];
    for await (const ev of client.generate({ messages: [] }, new AbortController().signal)) {
      if (ev.type === "tool_call_delta") calls.push(ev.toolCall.name);
      if (ev.type === "completed") expect(ev.result.toolCalls?.[0]?.args.path).toBe("a.txt");
    }
    expect(calls).toEqual(["read"]);
  });

  it("reports usage", async () => {
    const usage = { inputTokens: 10, outputTokens: 5 };
    const p = new ScriptedModelProvider([
      [
        { type: "started", timestamp: 0 },
        { type: "usage", usage, timestamp: 0 },
        { type: "completed", result: { finishReason: "stop", text: "" }, timestamp: 0 },
      ],
    ]);
    const client = p.createClient({ providerId: "scripted", modelId: "scripted-model" }, {});
    let seen: number | undefined;
    for await (const ev of client.generate({ messages: [] }, new AbortController().signal)) {
      if (ev.type === "usage") seen = ev.usage.inputTokens;
    }
    expect(seen).toBe(10);
  });

  it("yields error events", async () => {
    const p = new ScriptedModelProvider([[{ type: "error", error: errorInfo("MODEL_ERROR", "boom"), timestamp: 0 }]]);
    const client = p.createClient({ providerId: "scripted", modelId: "scripted-model" }, {});
    let sawError = false;
    for await (const ev of client.generate({ messages: [] }, new AbortController().signal)) {
      if (ev.type === "error") sawError = true;
    }
    expect(sawError).toBe(true);
  });
});

describe("EchoModelProvider", () => {
  it("echoes the last user message", async () => {
    const p = new EchoModelProvider();
    const client = p.createClient({ providerId: "echo", modelId: "echo-model" }, {});
    let text = "";
    for await (const ev of client.generate({ messages: [userMessage("hello world")] }, new AbortController().signal)) {
      if (ev.type === "text_delta") text += ev.text;
    }
    expect(text).toBe("hello world ");
  });

  it("can be cancelled mid-stream", async () => {
    const p = new EchoModelProvider({ deltaDelayMs: 20 });
    const client = p.createClient({ providerId: "echo", modelId: "echo-model" }, {});
    const ac = new AbortController();
    let cancelled = false;
    (async () => {
      await new Promise((r) => setTimeout(r, 30));
      ac.abort();
    })();
    try {
      for await (const _ev of client.generate({ messages: [userMessage("one two three four five")] }, ac.signal)) {
        // consume
      }
    } catch (err) {
      cancelled = err instanceof Error && err.message.includes("cancelled");
    }
    expect(cancelled).toBe(true);
  });

  it("can fail on purpose", async () => {
    const p = new EchoModelProvider({ failAfterEvents: 1 });
    const client = p.createClient({ providerId: "echo", modelId: "echo-model" }, {});
    let failed = false;
    try {
      for await (const _ev of client.generate({ messages: [userMessage("one two three")] }, new AbortController().signal)) {
        // consume
      }
    } catch (err) {
      failed = err instanceof Error && err.message.includes("on purpose");
    }
    expect(failed).toBe(true);
  });
});

describe("ModelRegistry", () => {
  it("registers, lists and resolves providers", async () => {
    const reg = new ModelRegistry();
    reg.register(new ScriptedModelProvider([]));
    reg.register(new EchoModelProvider());
    expect(reg.list().map((p) => p.id)).toEqual(["scripted", "echo"]);
    expect(reg.get("echo").id).toBe("echo");
    expect(() => reg.get("nope")).toThrow(/unknown model provider/);
    expect(() => reg.register(new ScriptedModelProvider([]))).toThrow(/already registered/);
  });

  it("creates clients by ModelRef", () => {
    const reg = new ModelRegistry();
    reg.register(new EchoModelProvider());
    const client = reg.createClient({ providerId: "echo", modelId: "echo-model" });
    expect(typeof client.generate).toBe("function");
  });
});