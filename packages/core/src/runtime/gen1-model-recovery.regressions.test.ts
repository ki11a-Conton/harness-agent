import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition, ModelEvent, ModelProvider } from "@ar/contracts";
import { errorInfo, ManualTimer, newAgentId } from "@ar/contracts";
import { OpenAICompatibleProvider } from "@ar/model";
import { AgentRuntime } from "./runtime.js";
import { decideModelRetry, isContextOverflowError } from "./turn-helpers.js";
import { RecoveryPolicy } from "../recovery/recovery.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const retry = { action: "retry", retryDelayMs: 0, maxAttempts: 3, reason: "test" };
const agent: AgentDefinition = {
  id: newAgentId(), name: "recovery-test", description: "offline", mode: "primary",
  model: { providerId: "openai", modelId: "offline" }, systemPrompt: "offline",
  tools: {}, permissions: { rules: [] }, skills: {}, limits: { maxToolCalls: 4 },
};

function runtime(provider: ModelProvider, timer?: ManualTimer) {
  const events = new MemoryEventStore();
  const orchestrator = new FakeOrchestrator();
  const engine = new AgentRuntime({
    store: new MemorySessionStore(), events, orchestrator, agents: [agent], modelProvider: provider,
    toolRegistry: defaultTestToolCatalog(), permissiveToolResolution: true, maxIterationsPerTurn: 3,
    recovery: new RecoveryPolicy({ maxAttempts: 3, retryDelayMs: timer ? 30_000 : 0 }),
    ...(timer ? { timer } : {}),
  });
  return { engine, events, orchestrator };
}

afterEach(() => vi.unstubAllGlobals());

describe("GEN1: context overflow classification", () => {
  it.each([
    "Invalid authentication token", "HTTP 429: tokens per minute rate limit exceeded",
    "Unsupported parameter: max_tokens", "HTTP 400: maximum output tokens must be positive",
    "HTTP 403: insufficient context access", "Maximum request retries reached",
  ])("does not compact for %s", message => {
    expect(isContextOverflowError(errorInfo("MODEL_ERROR", message))).toBe(false);
  });
  it.each([
    "This model's maximum context length is 8192 tokens", "context_length_exceeded",
    "prompt is too long: 213462 tokens > 200000 maximum", "Your input exceeds the context window of this model",
    "Input length (265330) exceeds model's maximum context length (262144).", "HTTP 413: request too large",
  ])("recognizes genuine overflow %s", message => {
    expect(isContextOverflowError(errorInfo("MODEL_ERROR", message))).toBe(true);
  });
  it("excludes rate limiting even if the response says too many tokens", () => {
    expect(isContextOverflowError(errorInfo("MODEL_ERROR", "Too many tokens; context limit exceeded, rate limit", { provider: { kind: "rate_limit", status: 429 } }))).toBe(false);
  });
  it.each(["context full", ""])("recognizes the structured CONTEXT_OVERFLOW code without a message pattern: %j", message => {
    expect(isContextOverflowError(errorInfo("CONTEXT_OVERFLOW", message))).toBe(true);
  });
  it("recognizes structured overflow from an ordinary HTTP 400 provider failure", () => {
    expect(isContextOverflowError(errorInfo("CONTEXT_OVERFLOW", "context full", { provider: { kind: "http", status: 400 } }))).toBe(true);
  });
  it.each([401, 403, 429])("does not compact contradictory structured overflow with HTTP %i", status => {
    expect(isContextOverflowError(errorInfo("CONTEXT_OVERFLOW", "context full", { provider: { kind: "http", status } }))).toBe(false);
  });
  it("keeps the rate-limit kind exclusion when a provider supplies a contradictory overflow code", () => {
    expect(isContextOverflowError(errorInfo("CONTEXT_OVERFLOW", "context full", { provider: { kind: "rate_limit" } }))).toBe(false);
  });
  it.each(["Invalid authentication token", "Unsupported parameter: max_tokens", "tokens per minute rate limit exceeded"])("keeps structured overflow exclusions for %s", message => {
    expect(isContextOverflowError(errorInfo("CONTEXT_OVERFLOW", message))).toBe(false);
  });
  it("does not guess overflow from an untyped context-full message", () => {
    expect(isContextOverflowError(errorInfo("MODEL_ERROR", "context full"))).toBe(false);
  });
});

describe("GEN1: retry contracts are respected by Runtime", () => {
  it.each([{ retryable: false }, { safeToRetry: false }])("refuses retry for %j", flags => {
    const action = decideModelRetry(errorInfo("MODEL_ERROR", "remote failure", flags), false, retry, 1);
    expect(action.action).toBe("fail");
  });
  it("allows one changed-context retry for a confirmed overflow", () => {
    expect(decideModelRetry(errorInfo("MODEL_ERROR", "context_length_exceeded", { retryable: false, safeToRetry: false }), false, retry, 1).action).toBe("compact-and-retry");
  });
  it("allows exactly one changed-context retry for a structured overflow, without ordinary unsafe replay", () => {
    const typedOverflow = errorInfo("CONTEXT_OVERFLOW", "context full", { retryable: false, safeToRetry: false });
    expect(decideModelRetry(typedOverflow, false, retry, 1).action).toBe("compact-and-retry");
    expect(decideModelRetry(typedOverflow, true, retry, 2).action).toBe("fail");
  });
  it("still retries a declared safe pre-stream network failure", () => {
    expect(decideModelRetry(errorInfo("MODEL_ERROR", "connection refused", { retryable: true, safeToRetry: true }), false, retry, 1).action).toBe("retry");
  });
  it.each([400, 401, 403])("performs only one physical HTTP request for %i", async status => {
    const send = vi.fn(async () => new Response('{"error":{"message":"Invalid authentication token"}}', { status }));
    vi.stubGlobal("fetch", send);
    const env = runtime(new OpenAICompatibleProvider({ apiKey: "offline-test", modelId: "offline" }));
    const session = await env.engine.createSession({ agent, cwd: "/offline" });
    const turn = await env.engine.startTurn(session.id, "task");
    expect((await env.engine.runTurn(session.id, turn.id, new AbortController().signal)).status).toBe("failed");
    expect(send).toHaveBeenCalledTimes(1);
    expect(env.orchestrator.calls).toHaveLength(0);
    const events = await env.events.list(session.id);
    expect(events.some(event => event.type === "context.compacted" || event.type === "model.retry")).toBe(false);
  });
  it("does not replay a partially streamed response after a declared unsafe error", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      id: "openai", async listModels() { return []; }, createClient() { return { async *generate(): AsyncGenerator<ModelEvent> {
        calls++;
        yield { type: "reasoning_delta", text: "private thinking", timestamp: 0 };
        yield { type: "text_delta", text: "partial", timestamp: 0 };
        yield { type: "error", error: errorInfo("MODEL_ERROR", "stream reset", { retryable: false, safeToRetry: false, provider: { kind: "network" } }), timestamp: 0 };
      } }; },
    };
    const env = runtime(provider);
    const session = await env.engine.createSession({ agent, cwd: "/offline" });
    const turn = await env.engine.startTurn(session.id, "task");
    expect((await env.engine.runTurn(session.id, turn.id, new AbortController().signal)).status).toBe("failed");
    expect(calls).toBe(1);
    expect(env.orchestrator.calls).toHaveLength(0);
    const events = await env.events.list(session.id);
    expect(events.filter(event => event.type === "model.delta").map(event => event.payload)).toEqual([{ kind: "text", text: "partial" }]);
    expect(events.some(event => event.type === "model.completed")).toBe(false);
  });
  it("cancels retry backoff without advancing the timer or invoking another request", async () => {
    const timer = new ManualTimer();
    let calls = 0;
    const provider: ModelProvider = {
      id: "openai", async listModels() { return []; }, createClient() { return { async *generate(): AsyncGenerator<ModelEvent> {
        calls++;
        yield { type: "error", error: errorInfo("MODEL_ERROR", "connection reset", { retryable: true, safeToRetry: true }), timestamp: 0 };
      } }; },
    };
    const env = runtime(provider, timer);
    const session = await env.engine.createSession({ agent, cwd: "/offline" });
    const turn = await env.engine.startTurn(session.id, "task");
    const abort = new AbortController();
    let settled = false;
    const running = env.engine.runTurn(session.id, turn.id, abort.signal).then(outcome => { settled = true; return outcome; });
    for (let i = 0; i < 200 && timer.pendingCount() === 0; i++) await Promise.resolve();
    expect(timer.pendingCount()).toBe(1);
    abort.abort();
    for (let i = 0; i < 200 && !settled; i++) await Promise.resolve();
    const cancelledWithoutClockAdvance = settled;
    // Cleanup also completes the broken baseline, so RED runs leave no work.
    timer.advance(30_000);
    expect((await running).status).toBe("cancelled");
    expect(cancelledWithoutClockAdvance).toBe(true);
    expect(calls).toBe(1);
    expect(timer.pendingCount()).toBe(0);
  });
});
