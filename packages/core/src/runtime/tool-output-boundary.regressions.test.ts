import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TOOL_SEMANTICS, newAgentId, newEventId, newSessionId, newToolCallId, newTurnId } from "@ar/contracts";
import type { AgentDefinition, ModelProvider, ModelRequest, ToolResult } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { ContextController, type ContextControllerDeps } from "./context-controller.js";
import { InMemoryArtifactStore } from "./artifact-store.js";
import { AgentRuntime } from "./runtime.js";
import type { TurnContext } from "./turn-helpers.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const secret = "SECRET_RESEARCH_SENTINEL";
const attack = "INJECTION_RESEARCH_SENTINEL";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

function fixture(overrides: Partial<ContextControllerDeps> = {}) {
  const ctx = { sessionId: newSessionId(), turnId: newTurnId() } as TurnContext;
  const call = { id: newToolCallId(), name: "exec", args: {} };
  const emit = vi.fn<ContextControllerDeps["emit"]>(async (sessionId, type, payload, turnId) => ({
    id: newEventId(), sessionId, turnId, type, payload, timestamp: 0, sequence: 1,
  }));
  const controller = new ContextController({
    store: new MemorySessionStore(), emit, now: () => 0, failAt: async () => {},
    compactCounter: { value: 0 }, checkpoint: async () => {},
    finishTurn: async () => { throw new Error("unexpected finishTurn"); },
    semanticsOf: () => DEFAULT_TOOL_SEMANTICS, ...overrides,
  });
  return { ctx, call, controller, emit };
}

describe("R3a model-facing tool output boundary", () => {
  it.each([true, false])("scans/redacts exec objects with budget enabled=%s and preserves the raw result", async (budget) => {
    const outputRedactor = vi.fn((content: string) => ({ content: content.replaceAll(secret, "[redacted]"), redacted: 1 }));
    const injectionDetector = vi.fn((content: string) => ({ hasInjection: content.includes(attack), reasons: ["research-marker"] }));
    const { controller, ctx, call, emit } = fixture({
      ...(budget ? { toolOutputBudget: { maxInlineBytes: 32000 } } : {}), outputRedactor, injectionDetector,
    });
    const result: ToolResult = { status: "success", output: { exitCode: 0, stdout: `${secret} ${attack}`, stderr: "", truncated: false }, metadata: { retained: true } };
    const before = structuredClone(result);
    const rendered = await controller.renderToolResultForContext(ctx, call, result);
    expect(rendered).toContain("tool output blocked");
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain(attack);
    expect(result).toEqual(before);
    expect(outputRedactor).toHaveBeenCalledWith(JSON.stringify(before.output));
    expect(injectionDetector).toHaveBeenCalledWith(JSON.stringify(before.output).replaceAll(secret, "[redacted]"));
    expect(emit.mock.calls.map(([, type]) => type)).toEqual(["security.secret_redacted", "security.injection_denied"]);
    expect(emit.mock.calls[1]?.[2]).toMatchObject({ toolCallId: call.id, target: "exec", code: "SECURITY_DENIED" });
  });

  it("applies security hooks to string output and error messages without a budget", async () => {
    const { controller, ctx, call } = fixture({
      outputRedactor: (content) => ({ content: content.replaceAll(secret, "[redacted]"), redacted: 1 }),
      injectionDetector: (content) => ({ hasInjection: content.includes(attack), reasons: ["research-marker"] }),
    });
    for (const result of [
      { status: "success", output: `${secret} ${attack}` },
      { status: "failed", error: { code: "PROCESS_ERROR", message: `${secret} ${attack}`, retryable: false, safeToRetry: false } },
    ] as ToolResult[]) {
      const rendered = await controller.renderToolResultForContext(ctx, call, result);
      expect(rendered).toContain("tool output blocked");
      expect(rendered).not.toContain(secret);
      expect(rendered).not.toContain(attack);
    }
  });

  it("archives the complete redacted object text with matching bytes/hash and keeps the source object intact", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "r3a-artifact-"));
    dirs.push(artifactDir);
    const artifactStore = new InMemoryArtifactStore();
    const result: ToolResult = { status: "success", output: { stdout: `${secret}${"中".repeat(4000)}`, stderr: "FINAL_DIAGNOSTIC", exitCode: 0 } };
    const original = structuredClone(result);
    const expected = JSON.stringify(result.output).replaceAll(secret, "[redacted]");
    const { controller, ctx, call } = fixture({
      toolOutputBudget: { maxInlineBytes: 128, artifactDir }, artifactStore,
      outputRedactor: (content) => ({ content: content.replaceAll(secret, "[redacted]"), redacted: 1 }),
    });
    const rendered = await controller.renderToolResultForContext(ctx, call, result);
    const [artifact] = await artifactStore.list();
    expect(artifact).toBeDefined();
    expect(await readFile(artifact!.ref, "utf8")).toBe(expected);
    expect(artifact).toMatchObject({ bytes: Buffer.byteLength(expected), sha256: createHash("sha256").update(expected).digest("hex"), sensitivity: "high" });
    expect(rendered).toContain(artifact!.sha256);
    expect(rendered).toContain("FINAL_DIAGNOSTIC");
    expect(rendered).not.toContain(secret);
    expect(result).toEqual(original);
  });

  it("retains redacted audit artifacts while blocking injection in an object preview", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "r3a-audit-"));
    dirs.push(artifactDir);
    const artifactStore = new InMemoryArtifactStore();
    const { controller, ctx, call, emit } = fixture({
      toolOutputBudget: { maxInlineBytes: 32, artifactDir }, artifactStore,
      outputRedactor: (content) => ({ content: content.replaceAll(secret, "[redacted]"), redacted: 1 }),
      injectionDetector: (content) => ({ hasInjection: content.includes(attack), reasons: ["research-marker"] }),
    });
    const result: ToolResult = { status: "success", output: { stdout: `${secret} ${attack} ${"x".repeat(9000)}` } };
    const rendered = await controller.renderToolResultForContext(ctx, call, result);
    expect(rendered).toContain("tool output blocked");
    expect(rendered).not.toContain(attack);
    const [artifact] = await artifactStore.list();
    expect(await readFile(artifact!.ref, "utf8")).toBe(JSON.stringify(result.output).replaceAll(secret, "[redacted]"));
    expect(emit.mock.calls.some(([, type]) => type === "security.injection_denied")).toBe(true);
  });

  it.each(["中".repeat(3000), "😀".repeat(3000)])("bounds UTF-8 preview bodies without splitting a character", async (out) => {
    const { controller, ctx, call } = fixture({ toolOutputBudget: { maxInlineBytes: 100 } });
    const rendered = await controller.renderToolResultForContext(ctx, call, { status: "success", output: out });
    const [, headAndTail] = rendered.split("--- output head ---\n");
    const [head, tail] = headAndTail!.split("\n--- output tail ---\n");
    expect(Buffer.byteLength(head!)).toBeLessThanOrEqual(2000);
    expect(Buffer.byteLength(tail!)).toBeLessThanOrEqual(2000);
    expect(Buffer.from(head!).toString("utf8")).toBe(head);
    expect(Buffer.from(tail!).toString("utf8")).toBe(tail);
  });

  it("keeps small structured/null output and ASCII previews compatible", async () => {
    const { controller, ctx, call } = fixture({ toolOutputBudget: { maxInlineBytes: 100 } });
    expect(await controller.renderToolResultForContext(ctx, call, { status: "success", output: { ok: 1 } })).toBe('{"ok":1}');
    expect(await controller.renderToolResultForContext(ctx, call, { status: "success", output: null })).toBe("");
    const rendered = await controller.renderToolResultForContext(ctx, call, { status: "success", output: `${"a".repeat(3000)}${"z".repeat(3000)}` });
    expect(rendered).toContain(`--- output head ---\n${"a".repeat(2000)}\n--- output tail ---\n${"z".repeat(2000)}`);
  });

  it("preserves failed diagnostics and serialization fallbacks without changing caller data", async () => {
    const outputRedactor = vi.fn((content: string) => ({ content, redacted: 0 }));
    const injectionDetector = vi.fn(() => ({ hasInjection: false, reasons: [] }));
    const { controller, ctx, call } = fixture({ outputRedactor, injectionDetector });
    const circular: { self?: unknown } = {}; circular.self = circular;
    const cases: Array<[ToolResult, string]> = [
      [{ status: "success", output: undefined }, ""],
      [{ status: "success", output: null }, ""],
      [{ status: "success", output: { ok: 1 } }, '{"ok":1}'],
      [{ status: "success", output: circular }, "[object Object]"],
      [{ status: "success", output: 12n }, "12"],
      [{ status: "success", output: () => "ignored" }, ""],
      [{ status: "failed", output: { stdout: "compiler location src/math.ts:7" }, error: { code: "PROCESS_ERROR", message: "exit code 3", retryable: false, safeToRetry: false } }, '[failed] {"error":"exit code 3","output":{"stdout":"compiler location src/math.ts:7"}}'],
      [{ status: "denied" }, "[denied] no error detail"],
    ];
    for (const [result, expected] of cases) {
      const originalOutput = result.output;
      expect(await controller.renderToolResultForContext(ctx, call, result)).toBe(expected);
      expect(result.output).toBe(originalOutput);
      expect(outputRedactor).toHaveBeenCalledWith(expected);
      expect(injectionDetector).toHaveBeenCalledWith(expected);
    }
    expect(outputRedactor.mock.calls.length).toBeGreaterThanOrEqual(cases.length);
    expect(injectionDetector.mock.calls.length).toBeGreaterThanOrEqual(cases.length);
  });

  it("scans injection in the omitted middle and rechecks a retained audit artifact on readback", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "r3a-middle-"));
    dirs.push(artifactDir);
    const artifactStore = new InMemoryArtifactStore();
    const injectionDetector = vi.fn((content: string) => ({ hasInjection: content.includes(attack), reasons: ["research-marker"] }));
    const { controller, ctx, call, emit } = fixture({
      toolOutputBudget: { maxInlineBytes: 1, artifactDir }, artifactStore, injectionDetector,
      outputRedactor: (content) => ({ content: content.replaceAll(secret, "[redacted]"), redacted: content.includes(secret) ? 1 : 0 }),
    });
    const original = `${"a".repeat(2100)}${secret} ${attack}${"z".repeat(2100)}`;
    expect(await controller.renderToolResultForContext(ctx, call, { status: "success", output: original })).toContain("tool output blocked");
    const [artifact] = await artifactStore.list();
    const persisted = await readFile(artifact!.ref, "utf8");
    expect(persisted).toBe(original.replaceAll(secret, "[redacted]"));
    const readCall = { ...call, id: newToolCallId(), name: "read_file" };
    expect(await controller.renderToolResultForContext(ctx, readCall, { status: "success", output: persisted })).toContain("tool output blocked");
    expect(emit.mock.calls.filter(([, type]) => type === "security.injection_denied").map(([, , payload]) => payload.toolCallId)).toEqual([call.id, readCall.id]);
    expect(injectionDetector.mock.calls.map(([content]) => content)).toEqual([persisted, persisted]);
  });

  it.each([0, 1, 2, 3, 4, 7, 8, 9])("cap=%s remains an artifact threshold with separate UTF-8 preview/marker overhead", async (cap) => {
    const { controller, ctx, call } = fixture({ toolOutputBudget: { maxInlineBytes: cap } });
    const output = "A中😀\r\n";
    const rendered = await controller.renderToolResultForContext(ctx, call, { status: "success", output });
    expect(rendered).toContain(`exceeds inline budget (${cap})`);
    const [, bodies] = rendered.split("--- output head ---\n");
    const [head, tail] = bodies!.split("\n--- output tail ---\n");
    expect(head).toBe(output);
    expect(tail).toBe(output);
    expect(Buffer.byteLength(head!)).toBeLessThanOrEqual(2000);
    expect(Buffer.byteLength(tail!)).toBeLessThanOrEqual(2000);
  });

  it.each(["A".repeat(1999) + "😀" + "中\r\n".repeat(700), "中\r\n".repeat(700) + "😀" + "Z".repeat(1999)])("keeps valid mixed UTF-8 at preview slice boundaries", async (output) => {
    const { controller, ctx, call } = fixture({ toolOutputBudget: { maxInlineBytes: 1 } });
    const rendered = await controller.renderToolResultForContext(ctx, call, { status: "success", output });
    const [, bodies] = rendered.split("--- output head ---\n");
    const [head, tail] = bodies!.split("\n--- output tail ---\n");
    expect(Buffer.byteLength(head!)).toBeLessThanOrEqual(2000);
    expect(Buffer.byteLength(tail!)).toBeLessThanOrEqual(2000);
    expect(output.startsWith(head!)).toBe(true);
    expect(output.endsWith(tail!)).toBe(true);
    expect(rendered).not.toContain("�");
    expect(rendered).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("a real AgentRuntime stores bounded object tool text before the next model call", async () => {
    const agent: AgentDefinition = { id: newAgentId(), name: "r3a", description: "test", mode: "primary", model: { providerId: "scripted", modelId: "scripted-model" }, systemPrompt: "test", tools: {}, permissions: { rules: [] }, skills: {}, limits: {} };
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const modelProvider: ModelProvider = new ScriptedModelProvider([ScriptedModelProvider.toolCall("exec", {}), ScriptedModelProvider.text("done")]);
    const requests: ModelRequest[] = [];
    const createClient = modelProvider.createClient.bind(modelProvider);
    vi.spyOn(modelProvider, "createClient").mockImplementation((model, config) => {
      const client = createClient(model, config);
      return { generate(request: ModelRequest, signal: AbortSignal) {
        requests.push(structuredClone(request));
        return client.generate(request, signal);
      } };
    });
    const runtime = new AgentRuntime({
      store, events, agents: [agent], modelProvider,
      orchestrator: new FakeOrchestrator({ status: "success", output: { stdout: `${secret}${"x".repeat(20000)}`, stderr: "END_DIAGNOSTIC", exitCode: 0 } }),
      toolRegistry: defaultTestToolCatalog(), permissiveToolResolution: true,
      toolOutputBudget: { maxInlineBytes: 128 }, outputRedactor: (content) => ({ content: content.replaceAll(secret, "[redacted]"), redacted: 1 }),
    });
    const session = await runtime.createSession({ agent, cwd: process.cwd() });
    const turn = await runtime.startTurn(session.id, "test output");
    expect((await runtime.runTurn(session.id, turn.id, new AbortController().signal)).status).toBe("completed");
    const tool = (await store.listMessages(session.id)).find((message) => message.role === "tool")!;
    expect(tool.content).toContain("exceeds inline budget");
    expect(tool.content).not.toContain(secret);
    expect(tool.content).toContain("END_DIAGNOSTIC");
    expect(Buffer.byteLength(tool.content)).toBeLessThan(5000);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.find((message) => message.role === "tool")!.content).toBe(tool.content);
  });
});
