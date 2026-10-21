import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { newToolCallId, type ModelEvent, type ModelProvider, type ModelRequest } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { createHarness, type Harness } from "./create-harness.js";
import { parseMaxIterationsPerTurn, resolveMaxIterationsPerTurn, type HarnessConfig } from "./config.js";
import { evaluateConfigDrift } from "./config-drift.js";
import { fieldDocOf, lifecycleOf } from "./config-layers.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function workspace() { const cwd = await mkdtemp(join(tmpdir(), "ar-longrun-budget-")); roots.push(cwd); return cwd; }
const signal = () => new AbortController().signal;
async function run(harness: Harness, abort = signal()) {
  const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd: harness.config.cwd });
  const turn = await harness.runtime.startTurn(session.id, "Follow the file chain, fix value.cjs, run the check, and report evidence.");
  const outcome = await harness.runtime.runTurn(session.id, turn.id, abort);
  return { session, turn, outcome, events: await harness.events.list(session.id) };
}
function config(cwd: string, provider: ModelProvider, extra: Partial<HarnessConfig> = {}): HarnessConfig {
  return { cwd, profile: "test", modelProvider: provider, model: { providerId: provider.id, modelId: "scripted-model" },
    featureFlags: { skills: false },
    contextBudget: { maxTokens: 64000, reserved: { system: 512, task: 512, output: 1024 }, dynamic: 0 }, ...extra };
}

/** Each next path/value is obtained from the preceding real file result. */
function chainProvider(requests: ModelRequest[], repairVerification = false): ModelProvider {
  let stage: "read" | "edit" | "repair" | "test" | "done" = "read", first = true, repaired = false;
  return { id: "longrun-chain", listModels: async () => [], createClient: () => ({
    async *generate(request): AsyncGenerator<ModelEvent> {
      requests.push(structuredClone(request));
      let name: string, args: Record<string, unknown>;
      const previous = request.messages.findLast(message => message.role === "tool");
      if (stage === "read") {
        const next = first ? "step-0.txt" : /^NEXT: (step-\d+\.txt)$/mu.exec(previous?.content ?? "")?.[1];
        first = false;
        if (next !== undefined) { name = "read_file"; args = { path: next }; }
        else {
          const value = /^VALUE: (\d+)$/mu.exec(previous?.content ?? "")?.[1];
          expect(value).toBe("42"); stage = "edit";
          name = "edit_file"; args = { path: "value.cjs", oldText: "value: 0", newText: `value: ${repairVerification ? "41" : value}` };
        }
      } else if (stage === "edit") {
        expect(previous?.content).not.toContain("[failed]");
        if (repairVerification && !repaired) {
          stage = "repair";
          yield { type: "completed", result: { finishReason: "stop", text: "The provisional edit is ready for the configured check." }, timestamp: 0 }; return;
        }
        stage = "test";
        name = "exec"; args = { command: "node check.cjs" };
      } else if (stage === "repair") {
        expect(request.messages.some(message => message.role === "system" && message.content.includes("[verification failed"))).toBe(true);
        expect(request.messages.some(message => message.role === "tool" && message.content.includes("expected 42, got 41"))).toBe(true);
        repaired = true; stage = "edit";
        name = "edit_file"; args = { path: "value.cjs", oldText: "value: 41", newText: "value: 42" };
      } else {
        expect(previous?.content).toContain("verified 42"); stage = "done";
        yield { type: "completed", result: { finishReason: "stop", text: "Changed value.cjs to 42; node check.cjs passed." }, timestamp: 0 }; return;
      }
      yield { type: "completed", result: { finishReason: "tool_calls", toolCalls: [{ id: newToolCallId(), name, args }] }, timestamp: 0 };
    },
  }) };
}
async function chainFixture(extra: Partial<HarnessConfig> = {}, repairVerification = false) {
  const cwd = await workspace(), requests: ModelRequest[] = [];
  for (let i = 0; i < 40; i++) await writeFile(join(cwd, `step-${i}.txt`), i === 39 ? "VALUE: 42\n" : `NEXT: step-${i + 1}.txt\n`);
  await writeFile(join(cwd, "value.cjs"), "module.exports = { value: 0 };\n");
  await writeFile(join(cwd, "check.cjs"), 'const {value} = require("./value.cjs"); if (value !== 42) { console.error(`expected 42, got ${value}`); process.exit(1); } console.log("verified 42");\n');
  const harness = await createHarness(config(cwd, chainProvider(requests, repairVerification), { limits: { maxToolCalls: 60, maxDurationMs: 60000 },
    task: { id: "longrun-chain", goal: "Follow the chain and pass the real project check", verification: [{ kind: "command", command: process.execPath, args: ["check.cjs"] }] }, ...extra }));
  return { harness, requests, cwd };
}

it("preserves the default 20-iteration stop and never silently starts another turn", async () => {
  vi.stubEnv("HARNESS_MAX_ITERATIONS_PER_TURN", "45");
  const f = await chainFixture();
  try { const result = await run(f.harness);
    expect(result.outcome.status).toBe("failed"); expect(result.outcome.error?.message).toContain("maxIterationsPerTurn (20)");
    expect(f.requests).toHaveLength(20); expect(await f.harness.store.listTurns(result.session.id)).toHaveLength(1);
    expect(await readFile(join(f.cwd, "value.cjs"), "utf8")).toContain("value: 0");
    expect(f.harness.resolvedConfig.value.maxIterationsPerTurn).toBeUndefined();
  } finally { await f.harness.close(); }
});

it("an explicit finite host budget completes forty dependent reads, a real edit, execution and verification", async () => {
  const f = await chainFixture({ maxIterationsPerTurn: 45 });
  try { const result = await run(f.harness);
    expect(result.outcome.status, JSON.stringify(result.outcome)).toBe("completed"); expect(result.outcome.terminationReason).toBe("verified_complete");
    expect(f.requests).toHaveLength(43); expect(result.outcome.toolCalls).toBe(42);
    expect(await readFile(join(f.cwd, "value.cjs"), "utf8")).toContain("value: 42");
    expect((await f.harness.store.listMessages(result.session.id)).filter(message => message.role === "tool" && /^(?:NEXT|VALUE): /u.test(message.content))).toHaveLength(40);
    expect(result.events.some(event => event.type === "verification.completed" && event.payload.passed === true)).toBe(true);
  } finally { await f.harness.close(); }
});

it("repairs an actual failed project verification after forty dependent steps before reporting completion", async () => {
  const f = await chainFixture({ maxIterationsPerTurn: 48 }, true);
  try { const result = await run(f.harness);
    expect(result.outcome.status, JSON.stringify(result.outcome)).toBe("completed");
    expect(result.outcome.terminationReason).toBe("verified_complete"); expect(f.requests).toHaveLength(45);
    expect(await readFile(join(f.cwd, "value.cjs"), "utf8")).toContain("value: 42");
    expect(result.events.filter(event => event.type === "verification.failed")).toHaveLength(1);
    expect(result.events.filter(event => event.type === "verification.completed")).toHaveLength(1);
    expect(result.events.filter(event => event.type === "turn.completed")).toHaveLength(1);
    const checks = result.events.filter(event => event.type === "verification.step_completed");
    expect(checks.map(event => event.payload.passed)).toEqual([false, true]);
  } finally { await f.harness.close(); }
});

it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "45", null])("refuses invalid host iteration budget %s before composition", async value => {
  const cwd = await workspace(), provider = new ScriptedModelProvider([]);
  const listModels = vi.spyOn(provider, "listModels");
  await expect(createHarness(config(cwd, provider, { maxIterationsPerTurn: value as number }))).rejects.toThrow(/positive safe integer/);
  expect(listModels).not.toHaveBeenCalled();
});

it("captures the validated budget before asynchronous host composition", async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, "safe.txt"), "safe");
  const provider = new ScriptedModelProvider([ScriptedModelProvider.toolCall("read_file", { path: "safe.txt" }), ScriptedModelProvider.text("Must not receive a second iteration.")]);
  const input = config(cwd, provider, { dataDir: join(cwd, "state"), maxIterationsPerTurn: 1 });
  const creating = createHarness(input);
  input.maxIterationsPerTurn = Infinity;
  const harness = await creating;
  try {
    expect(harness.config.maxIterationsPerTurn).toBe(1);
    expect(harness.resolvedConfig.value.maxIterationsPerTurn).toBe(1);
    const result = await run(harness);
    expect(result.outcome.status).toBe("failed");
    expect(result.outcome.error?.message).toContain("maxIterationsPerTurn (1)");
    expect(result.events.filter(event => event.type === "model.started")).toHaveLength(1);
  } finally { await harness.close(); }
});

it("parses the shared real CLI/Web environment entry without coercing invalid strings", () => {
  expect(parseMaxIterationsPerTurn(undefined)).toBeUndefined(); expect(parseMaxIterationsPerTurn(" 45 ")).toBe(45);
  for (const value of [1, Number.MAX_SAFE_INTEGER]) {
    expect(resolveMaxIterationsPerTurn(value)).toBe(value);
    expect(parseMaxIterationsPerTurn(String(value))).toBe(value);
  }
  for (const value of ["", " ", "0", "-2", "+2", "02", "2.5", "Infinity", "NaN", "0x20", "1e2", "9007199254740992", "9007199254740993"]) expect(() => parseMaxIterationsPerTurn(value)).toThrow(/positive safe integer/);
});

it.each([undefined, 20])("freezes budget %s and rejects widening existing sessions or their forks", async ceiling => {
  const cwd = await workspace(), provider = new ScriptedModelProvider([]);
  const dataDir = join(cwd, "state");
  const a = await createHarness(config(cwd, provider, { dataDir, ...(ceiling === undefined ? {} : { maxIterationsPerTurn: ceiling }) }));
  const session = await a.sessionService.create({ agentId: a.agents[0]!.id, model: a.agents[0]!.model, cwd });
  const branch = await a.sessionService.threadFork(session.id);
  const parentSnapshot = await a.store.loadStateSnapshot(session.id);
  const branchSnapshot = await a.store.loadStateSnapshot(branch.id);
  expect(parentSnapshot?.["p27.configFingerprint"]).toBe(a.resolvedConfig.fingerprint);
  expect(branchSnapshot?.["p27.configFingerprint"]).toBe(parentSnapshot?.["p27.configFingerprint"]);
  expect(branchSnapshot?.["p27.configValue"]).toBe(parentSnapshot?.["p27.configValue"]);
  await a.close();
  const b = await createHarness(config(cwd, provider, { dataDir, maxIterationsPerTurn: 45 }));
  try { expect(lifecycleOf("maxIterationsPerTurn")).toBe("session_frozen"); expect(fieldDocOf("maxIterationsPerTurn")?.doc).toContain("default 20");
    expect(a.resolvedConfig.fingerprint).not.toBe(b.resolvedConfig.fingerprint);
    expect(evaluateConfigDrift(a.resolvedConfig, b.resolvedConfig)).toMatchObject({ severity: "reject", frozenChanged: true });
    for (const id of [session.id, branch.id]) {
      expect((await b.checkSessionConfigDrift(id)).severity).toBe("reject");
      await expect(b.sessions.load(id)).rejects.toMatchObject({ info: { code: "CONFIG_DRIFT_REJECTED" } });
    }
    await expect(b.sessionService.threadFork(session.id)).rejects.toMatchObject({ info: { code: "CONFIG_DRIFT_REJECTED" } });
    expect(await b.store.listSessions()).toHaveLength(2);
  } finally { await a.close(); await b.close(); }
});

it.each(["tool", "cost", "cancel", "duration"] as const)("the larger iteration budget preserves the existing %s stop before a write", async kind => {
  const cwd = await workspace(), controller = new AbortController(); let time = 0, calls = 0;
  const provider: ModelProvider = { id: "bounded", listModels: async () => [], createClient: () => ({ async *generate(): AsyncGenerator<ModelEvent> {
    calls++;
    if (kind === "cancel") controller.abort();
    if (kind === "duration" && calls === 1) { time = 100; yield* ScriptedModelProvider.toolCall("read_file", { path: "safe.txt" }); return; }
    yield { type: "completed", result: { finishReason: "tool_calls", toolCalls: [{ id: newToolCallId(), name: "write_file", args: { path: "forbidden.txt", content: "must not land" } }],
      ...(kind === "cost" ? { usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 1 } } : {}) }, timestamp: time };
  } }) };
  await writeFile(join(cwd, "safe.txt"), "safe");
  const harness = await createHarness(config(cwd, provider, { maxIterationsPerTurn: 45, now: () => time,
    limits: { ...(kind === "tool" ? { maxToolCalls: 0 } : {}), ...(kind === "cost" ? { maxEstimatedCostUsd: 0 } : {}), ...(kind === "duration" ? { maxDurationMs: 50 } : {}) } }));
  try { const result = await run(harness, controller.signal);
    expect(result.outcome.status).toBe(kind === "cancel" ? "cancelled" : "failed");
    await expect(readFile(join(cwd, "forbidden.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.events.some(event => event.type === "tool.completed" && event.payload.tool === "write_file")).toBe(false);
    if (kind !== "cancel") expect(result.events.some(event => event.type === "run.limit_reached" && event.payload.limit === ({ tool: "maxToolCalls", cost: "maxEstimatedCostUsd", duration: "maxDurationMs" } as const)[kind])).toBe(true);
  } finally { await harness.close(); }
});
