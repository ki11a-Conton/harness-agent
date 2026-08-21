import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TOOL_SEMANTICS, buildCheckpoint, newAgentId, newCheckpointId, newTurnId, newWorkingState, } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime, RuntimeKilledError } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";
import { ContextPipeline } from "@ar/context";
const AGENT = {
    id: newAgentId(),
    name: "test-agent",
    description: "test",
    mode: "primary",
    model: { providerId: "scripted", modelId: "scripted-model" },
    systemPrompt: "you are a test",
    tools: {},
    permissions: { rules: [] },
    skills: {},
    limits: {},
};
/** In-memory CheckpointStore; loadLatest returns the newest saved or the seed
 *  (the "last durable checkpoint" a fresh process would see). */
class FakeCheckpointStore {
    saved = [];
    seed;
    async save(checkpoint) {
        this.saved.push(checkpoint);
    }
    async loadLatest() {
        if (this.saved.length > 0)
            return this.saved[this.saved.length - 1];
        return this.seed;
    }
    async list() {
        return [...this.saved].reverse();
    }
}
class FilteringSessionStore extends MemorySessionStore {
    async listSessions(opts) {
        let list = await super.listSessions();
        if (opts?.parentId !== undefined)
            list = list.filter((s) => s.parentId === opts.parentId);
        if (opts?.status !== undefined)
            list = list.filter((s) => s.status === opts.status);
        return list;
    }
}
class WriteCountingOrchestrator extends FakeOrchestrator {
    writeCount = 0;
    async execute(request, context) {
        if (request.call.name === "write_file")
            this.writeCount += 1;
        return super.execute(request, context);
    }
}
function killAt(points) {
    return (point) => {
        if (points.has(point))
            throw new RuntimeKilledError(point);
    };
}
function seededCheckpoint(sessionId, over = {}) {
    return buildCheckpoint({
        checkpointId: newCheckpointId(),
        schemaVersion: 1,
        sessionId,
        agentId: AGENT.id,
        createdAt: 10,
        reason: "tool:completed:write_file",
        phase: "thinking",
        iteration: 1,
        state: newWorkingState("fix the build"),
        toolLedger: [],
        childSessions: [],
        lastEventSequence: 0,
        effectiveAgentConfigRef: "effectiveAgent",
        contextRefs: [],
        ...over,
    });
}
function toolScript(toolName, args) {
    return [ScriptedModelProvider.toolCall(toolName, args), ScriptedModelProvider.text("done")];
}
let cwd;
let tempDirs = [];
afterEach(async () => {
    for (const dir of tempDirs)
        await rm(dir, { recursive: true, force: true });
    tempDirs = [];
});
async function makeRuntime(opts = {}) {
    cwd = await mkdtemp(join(tmpdir(), "fi2-"));
    tempDirs.push(cwd);
    const orch = opts.orch ?? new WriteCountingOrchestrator({ status: "success", output: "ok" });
    const store = new FilteringSessionStore();
    const events = new MemoryEventStore();
    const ckpt = opts.checkpoint ?? new FakeCheckpointStore();
    const runtime = new AgentRuntime({
        store,
        events,
        modelProvider: new ScriptedModelProvider(opts.scripts ?? [ScriptedModelProvider.text("done")]),
        orchestrator: orch,
        agents: [AGENT],
        checkpointStore: ckpt,
        checkpointPolicy: {
            afterSideEffectTools: true,
            afterCompaction: true,
            afterVerification: true,
            everyNIterations: 0,
        },
        ...(opts.kill !== undefined ? { failpoint: killAt(opts.kill) } : {}),
        ...(opts.failpointFn !== undefined ? { failpoint: opts.failpointFn } : {}),
        ...(opts.context !== undefined
            ? {
                context: {
                    pipeline: new ContextPipeline(),
                    budget: { maxTokens: opts.context.maxTokens, reserved: { system: 0, task: 0, output: 0 }, dynamic: 0 },
                },
            }
            : {}),
        ...(opts.toolSemantics !== undefined ? { toolSemanticsOf: opts.toolSemantics } : {}),
    });
    return { runtime, store, events, ckpt, orch };
}
/** Simulate the process dying: run a turn with the injector armed, expect the
 *  RuntimeKilledError to escape runTurn (no turn.completed was emitted).
 *  Returns the interrupted turn. */
async function runUntilKilled(runtime, session, point) {
    const turn = await runtime.startTurn(session.id, "fix the build");
    await expect(runtime.runTurn(session.id, turn.id, new AbortController().signal)).rejects.toMatchObject({
        name: "RuntimeKilledError",
        point,
    });
    return { turn };
}
/** A fresh "process" over the same durable stores. */
function restartedRuntime(opts) {
    return new AgentRuntime({
        store: opts.store,
        events: opts.events,
        modelProvider: new ScriptedModelProvider(opts.scripts ?? [ScriptedModelProvider.text("done")]),
        orchestrator: opts.orch ?? new FakeOrchestrator({ status: "success", output: "ok" }),
        agents: [AGENT],
        checkpointStore: opts.ckpt,
        checkpointPolicy: {
            afterSideEffectTools: false,
            afterCompaction: false,
            afterVerification: false,
            everyNIterations: 0,
        },
        ...(opts.toolSemantics !== undefined ? { toolSemanticsOf: opts.toolSemantics } : {}),
    });
}
describe("fault injection v2: kill points + crash resume (P1-5)", () => {
    it("kill after file write (checkpoint persisted): side effect committed, never re-executed, session intact", async () => {
        const { runtime, store, events, ckpt, orch } = await makeRuntime({
            scripts: toolScript("write_file", { path: "src/a.ts", content: "x" }),
            kill: new Set(["tool.checkpointed"]),
        });
        const session = await runtime.createSession({ agent: AGENT, cwd });
        await runUntilKilled(runtime, session, "tool.checkpointed");
        // No turn.completed was emitted (process died); session is decipherable.
        const stored = await events.list(session.id);
        expect(stored.map((e) => e.type)).not.toContain("turn.completed");
        // A fresh process resumes from the persisted checkpoint.
        const r2 = restartedRuntime({ store, events, ckpt, orch });
        const result = await r2.resumeTurn(session.id, new AbortController().signal);
        // recoverable state is recovered (the checkpoint already carries the write)
        expect(result.state.filesChanged).toContain("src/a.ts");
        // The kill happened AFTER the checkpoint, so the checkpoint covers the work:
        // no post-checkpoint activity to reconcile.
        expect(result.committedSideEffects).toHaveLength(0);
        expect(result.outcome.status).toBe("completed");
        // no duplicate unsafe side effect: the write ran once in r1, zero times in r2
        expect(orch.writeCount).toBe(1);
        // no corrupted session: turns/messages readable and consistent
        const turns = await store.listTurns(session.id);
        expect(turns.length).toBeGreaterThanOrEqual(1);
    });
    it("kill after file write but BEFORE its checkpoint: the store result proves it committed", async () => {
        const { runtime, store, events, ckpt, orch } = await makeRuntime({
            scripts: toolScript("write_file", { path: "CHANGELOG.md", content: "x" }),
            kill: new Set(["tool.completed"]),
        });
        const session = await runtime.createSession({ agent: AGENT, cwd });
        const lastEventSequence = (await events.nextSequence(session.id)) - 1;
        const { turn } = await runUntilKilled(runtime, session, "tool.completed");
        // The seed checkpoint must reference the interrupted turn so resume can
        // prove which store tool results belong to it (committed) vs uncertain.
        ckpt.seed = seededCheckpoint(session.id, { lastEventSequence, turnId: turn.id });
        // The tool's own checkpoint was NOT written (killed before save) 鈥?only the seed remains.
        expect(ckpt.saved).toHaveLength(0);
        const r2 = restartedRuntime({ store, events, ckpt, orch });
        const result = await r2.resumeTurn(session.id, new AbortController().signal);
        // committed from the durable tool message, folded back into the state
        expect(result.committedSideEffects).toHaveLength(1);
        expect(result.committedSideEffects[0].tool).toBe("write_file");
        expect(result.state.filesChanged).toContain("CHANGELOG.md");
        expect(orch.writeCount).toBe(1);
        expect(result.outcome.status).toBe("completed");
    });
    it("kill during file write: outcome unknown surfaces as unresolved reconciliation, never re-executed", async () => {
        const { runtime, store, events, ckpt, orch } = await makeRuntime({
            scripts: toolScript("write_file", { path: "MESSAGES.md", content: "x" }),
            kill: new Set(["tool.executing"]),
        });
        const session = await runtime.createSession({ agent: AGENT, cwd });
        const lastEventSequence = (await events.nextSequence(session.id)) - 1;
        ckpt.seed = seededCheckpoint(session.id, { lastEventSequence });
        await runUntilKilled(runtime, session, "tool.executing");
        // The tool never completed: no result message, no committed side effect.
        expect(orch.writeCount).toBe(0);
        const r2 = restartedRuntime({ store, events, ckpt, orch });
        const result = await r2.resumeTurn(session.id, new AbortController().signal);
        expect(result.unresolvedTools).toHaveLength(1);
        expect(result.unresolvedTools[0].tool).toBe("write_file");
        expect(result.unresolvedTools[0].sideEffect).toBe(true);
        expect(result.committedSideEffects).toEqual([]);
        expect(result.state.filesChanged).toEqual([]);
        // It is surfaced to the model for reconciliation, NOT auto-replayed.
        expect(orch.writeCount).toBe(0);
        expect(result.outcome.status).toBe("completed");
    });
    it("kill before the next model call after a checkpoint: resume continues without losing committed work", async () => {
        let nextCalls = 0;
        const { runtime, store, events, ckpt, orch } = await makeRuntime({
            scripts: [
                ScriptedModelProvider.toolCall("write_file", { path: "src/b.ts", content: "x" }),
                ScriptedModelProvider.text("done"),
            ],
            // Round 1 generates + writes + checkpoints; round 2 dies right before
            // the model call (the "after checkpoint, before next model call" window).
            failpointFn: (point) => {
                if (point === "model.next_call") {
                    nextCalls += 1;
                    if (nextCalls === 2)
                        throw new RuntimeKilledError(point);
                }
            },
        });
        const session = await runtime.createSession({ agent: AGENT, cwd });
        const turn = await runtime.startTurn(session.id, "g");
        await expect(runtime.runTurn(session.id, turn.id, new AbortController().signal)).rejects.toMatchObject({
            name: "RuntimeKilledError",
            point: "model.next_call",
        });
        // At least the side-effect checkpoint survived.
        expect(ckpt.saved.length).toBeGreaterThanOrEqual(1);
        const r2 = restartedRuntime({ store, events, ckpt, orch });
        const result = await r2.resumeTurn(session.id, new AbortController().signal);
        expect(result.state.filesChanged).toContain("src/b.ts");
        expect(result.outcome.status).toBe("completed");
        expect(orch.writeCount).toBe(1);
    });
    it("kill during model stream: no side effects ran, turn dies with no completion, resume completes", async () => {
        const { runtime, store, events, ckpt } = await makeRuntime({
            scripts: [ScriptedModelProvider.text("done")],
            kill: new Set(["model.stream"]),
        });
        const session = await runtime.createSession({ agent: AGENT, cwd });
        const lastEventSequence = (await events.nextSequence(session.id)) - 1;
        ckpt.seed = seededCheckpoint(session.id, { lastEventSequence });
        const turn = await runtime.startTurn(session.id, "g");
        await expect(runtime.runTurn(session.id, turn.id, new AbortController().signal)).rejects.toMatchObject({
            name: "RuntimeKilledError",
            point: "model.stream",
        });
        const stored = await events.list(session.id);
        expect(stored.map((e) => e.type)).not.toContain("turn.completed");
        const r2 = restartedRuntime({ store, events, ckpt });
        const result = await r2.resumeTurn(session.id, new AbortController().signal);
        expect(result.outcome.status).toBe("completed");
    });
    it("kill during verification: the turn dies, resume re-runs and completes", async () => {
        const { runtime, store, events, ckpt } = await makeRuntime({
            scripts: [ScriptedModelProvider.text("done")],
            kill: new Set(["verification.started"]),
        });
        const session = await runtime.createSession({ agent: AGENT, cwd });
        const lastEventSequence = (await events.nextSequence(session.id)) - 1;
        ckpt.seed = seededCheckpoint(session.id, { lastEventSequence });
        await runUntilKilled(runtime, session, "verification.started");
        const r2 = restartedRuntime({ store, events, ckpt });
        const result = await r2.resumeTurn(session.id, new AbortController().signal);
        expect(result.outcome.status).toBe("completed");
    });
    it("kill during compaction: summary block is already durable in the transcript; resume recovers", async () => {
        let failed = false;
        const { runtime, store, events, ckpt } = await makeRuntime({
            scripts: [ScriptedModelProvider.text("done")],
            // maxTokens=2 forces the system block (鈮? tokens) over budget, so every
            // build compacts; kill right after the compaction signal is emitted.
            context: { maxTokens: 2 },
            failpointFn: (point) => {
                if (point === "context.compacted" && !failed) {
                    failed = true;
                    throw new RuntimeKilledError(point);
                }
            },
        });
        const session = await runtime.createSession({ agent: AGENT, cwd });
        await expect((async () => {
            const turn = await runtime.startTurn(session.id, "g");
            await runtime.runTurn(session.id, turn.id, new AbortController().signal);
        })()).rejects.toMatchObject({
            point: "context.compacted",
        });
        // Resumption needs a durable checkpoint: seed one (the compacted context
        // was a safe boundary, so one would normally exist).
        const lastEventSequence = (await events.nextSequence(session.id)) - 1;
        ckpt.seed = seededCheckpoint(session.id, { lastEventSequence });
        const r2 = restartedRuntime({ store, events, ckpt });
        const result = await r2.resumeTurn(session.id, new AbortController().signal);
        expect(result.outcome.status).toBe("completed");
    });
    it("honest un-recoverability: no checkpoint to resume from surfaces RESUME_FAILED instead of fabricating work", async () => {
        const { runtime, store, events, ckpt, orch } = await makeRuntime({
            scripts: toolScript("write_file", { path: "a.md", content: "x" }),
            kill: new Set(["tool.executing"]),
        });
        const session = await runtime.createSession({ agent: AGENT, cwd });
        // No checkpoint store, no seed: the tool died mid-execution with zero
        // durable state behind it 鈥?recovering would be a guess.
        ckpt.saved.length = 0;
        ckpt.seed = undefined;
        const turn = await runtime.startTurn(session.id, "g");
        await expect(runtime.runTurn(session.id, turn.id, new AbortController().signal)).rejects.toMatchObject({
            point: "tool.executing",
        });
        const r2 = restartedRuntime({ store, events, ckpt, orch });
        await expect(r2.resumeTurn(session.id, new AbortController().signal)).rejects.toMatchObject({
            info: expect.objectContaining({ code: "RESUME_FAILED" }),
        });
    });
    it("kill while child agent running: child session survives intact, parent dies, resume never re-delegates", async () => {
        // A delegation tool whose orchestrator blocks while the child is mid-run.
        let delegateCalls = 0;
        class DelegationOrchestrator extends WriteCountingOrchestrator {
            async execute(request, context) {
                if (request.call.name === "delegate") {
                    delegateCalls += 1;
                    // The child agent is running when the process dies. A simulated kill
                    // inside the orchestrator is not a tool failure to recover from 鈥?          // the runtime rethrows it and the turn dies without a completion.
                    throw new RuntimeKilledError("tool.executing");
                }
                return super.execute(request, context);
            }
        }
        const { runtime, store, events, ckpt, orch } = await makeRuntime({
            scripts: toolScript("delegate", { child: "worker-1" }),
            orch: new DelegationOrchestrator(),
        });
        const session = await runtime.createSession({ agent: AGENT, cwd });
        // The delegation had already created the child session before the kill.
        const child = await runtime.createSession({ agent: AGENT, cwd, parentId: session.id });
        const lastEventSequence = (await events.nextSequence(session.id)) - 1;
        ckpt.seed = seededCheckpoint(session.id, { lastEventSequence });
        await runUntilKilled(runtime, session, "tool.executing");
        // No corrupted session: the child is intact, still running, linked to the parent.
        const storedChild = await store.getSession(child.id);
        expect(storedChild).toBeDefined();
        expect(storedChild.parentId).toBe(session.id);
        // A fresh process resumes: the in-flight delegation surfaces as unresolved
        // (honest ambiguity) and is never blindly re-executed. P0-8: unknown tools
        // default to sideEffect=true (fail-closed — the effect may have happened),
        // so the resolved call is presented for reconciliation, never replayed.
        const r2 = restartedRuntime({ store, events, ckpt, orch });
        const result = await r2.resumeTurn(session.id, new AbortController().signal);
        expect(result.unresolvedTools).toHaveLength(1);
        expect(result.unresolvedTools[0].tool).toBe("delegate");
        expect(result.unresolvedTools[0].sideEffect).toBe(true);
        expect(delegateCalls).toBe(1);
        expect(result.outcome.status).toBe("completed");
    });
    it("kill while MCP call active: in-flight MCP tool surfaces as unresolved, session intact, no auto-retry", async () => {
        // MCP-backed tools are long external calls: the server may or may not have
        // executed when the process dies, so the outcome is genuinely unknown.
        let mcpCalls = 0;
        class McpOrchestrator extends WriteCountingOrchestrator {
            async execute(request, context) {
                if (request.call.name === "mcp_tool_call") {
                    mcpCalls += 1;
                    throw new RuntimeKilledError("tool.executing");
                }
                return super.execute(request, context);
            }
        }
        const { runtime, store, events, ckpt, orch } = await makeRuntime({
            scripts: toolScript("mcp_tool_call", { name: "github.list_repos" }),
            orch: new McpOrchestrator(),
        });
        const session = await runtime.createSession({ agent: AGENT, cwd });
        const lastEventSequence = (await events.nextSequence(session.id)) - 1;
        ckpt.seed = seededCheckpoint(session.id, { lastEventSequence });
        await runUntilKilled(runtime, session, "tool.executing");
        // Session stays decipherable; no turn.completed was emitted.
        const stored = await events.list(session.id);
        expect(stored.map((e) => e.type)).not.toContain("turn.completed");
        expect(await store.getSession(session.id)).toBeDefined();
        const r2 = restartedRuntime({ store, events, ckpt, orch });
        const result = await r2.resumeTurn(session.id, new AbortController().signal);
        // P0-8: the unknown outcome is surfaced as a potential side effect
        // (fail-closed — mcp_tool_call has no declared semantics, so the runtime
        // cannot prove no effect happened). It is presented for reconciliation,
        // never replayed.
        expect(result.unresolvedTools).toHaveLength(1);
        expect(result.unresolvedTools[0].tool).toBe("mcp_tool_call");
        expect(result.unresolvedTools[0].sideEffect).toBe(true);
        expect(mcpCalls).toBe(1);
        expect(result.outcome.status).toBe("completed");
    });
    it("P0-8: unknown tool killed mid-flight is reconciled fail-closed, never auto-replayed", async () => {
        // A tool with NO registered semantics (not in the registry, not in the
        // runtime's known map) defaults to DEFAULT_TOOL_SEMANTICS. P0-8: its
        // sideEffectScope is "unknown" — treated as may-have-side-effect. The
        // kill leaves the outcome ambiguous; on resume the call must surface for
        // reconciliation, never be blindly re-run.
        let unknownCalls = 0;
        class UnknownOrchestrator extends WriteCountingOrchestrator {
            async execute(request, context) {
                if (request.call.name === "mystery_plugin_tool") {
                    unknownCalls += 1;
                    throw new RuntimeKilledError("tool.executing");
                }
                return super.execute(request, context);
            }
        }
        const { runtime, store, events, ckpt, orch } = await makeRuntime({
            scripts: toolScript("mystery_plugin_tool", { action: "sync" }),
            orch: new UnknownOrchestrator(),
            // No toolSemanticsOf: the runtime falls back to DEFAULT_TOOL_SEMANTICS.
        });
        const session = await runtime.createSession({ agent: AGENT, cwd });
        const lastEventSequence = (await events.nextSequence(session.id)) - 1;
        ckpt.seed = seededCheckpoint(session.id, { lastEventSequence });
        await runUntilKilled(runtime, session, "tool.executing");
        // Process died: no turn.completed, no tool result.
        const stored = await events.list(session.id);
        expect(stored.map((e) => e.type)).not.toContain("turn.completed");
        expect(unknownCalls).toBe(1);
        const r2 = restartedRuntime({ store, events, ckpt, orch, scripts: [] });
        const result = await r2.resumeTurn(session.id, new AbortController().signal);
        // The unknown outcome is surfaced with sideEffect=true (fail-closed) and
        // never re-executed — the model reconciles it instead.
        expect(result.unresolvedTools).toHaveLength(1);
        expect(result.unresolvedTools[0].tool).toBe("mystery_plugin_tool");
        expect(result.unresolvedTools[0].sideEffect).toBe(true);
        expect(unknownCalls).toBe(1);
        // No committed-side-effect claim: nothing was proven applied.
        expect(result.committedSideEffects).toHaveLength(0);
    });
    it("kill while several children running: every in-flight child session survives intact, none duplicated", async () => {
        let delegateCalls = 0;
        class FanOutOrchestrator extends WriteCountingOrchestrator {
            async execute(request, context) {
                if (request.call.name === "delegate") {
                    delegateCalls += 1;
                    throw new RuntimeKilledError("tool.executing");
                }
                return super.execute(request, context);
            }
        }
        const { runtime, store, events, ckpt, orch } = await makeRuntime({
            scripts: [
                ScriptedModelProvider.toolCall("delegate", { child: "worker-a" }),
                ScriptedModelProvider.toolCall("delegate", { child: "worker-b" }),
                ScriptedModelProvider.text("done"),
            ],
            orch: new FanOutOrchestrator(),
        });
        const session = await runtime.createSession({ agent: AGENT, cwd });
        // Both children were already spawned and running when the process died.
        const a = await runtime.createSession({ agent: AGENT, cwd, parentId: session.id });
        const b = await runtime.createSession({ agent: AGENT, cwd, parentId: session.id });
        const lastEventSequence = (await events.nextSequence(session.id)) - 1;
        ckpt.seed = seededCheckpoint(session.id, { lastEventSequence });
        await runUntilKilled(runtime, session, "tool.executing");
        // Every in-flight child session survives, still linked to the parent.
        const children = await store.listSessions({ parentId: session.id });
        expect(children.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
        const r2 = restartedRuntime({ store, events, ckpt, orch });
        const result = await r2.resumeTurn(session.id, new AbortController().signal);
        expect(result.unresolvedTools).toHaveLength(1);
        expect(result.unresolvedTools[0].tool).toBe("delegate");
        // Neither child is duplicated: the delegation is never re-executed.
        expect(delegateCalls).toBe(1);
        expect(result.outcome.status).toBe("completed");
    });
    it("P1-11: side-effect decisions follow injected semantics, not tool names (deploy 鈫?filesystem)", async () => {
        // "deploy" is not a builtin name 鈥?semantics make it a filesystem writer.
        const semantics = (name) => name === "deploy" ? { ...DEFAULT_TOOL_SEMANTICS, sideEffectScope: "filesystem", retrySafety: "none" } : DEFAULT_TOOL_SEMANTICS;
        const { runtime, ckpt, orch } = await makeRuntime({
            scripts: toolScript("deploy", { path: "src/x.ts" }),
            toolSemantics: semantics,
        });
        const session = await runtime.createSession({ agent: AGENT, cwd });
        const turn = await runtime.startTurn(session.id, "deploy the change");
        const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);
        expect(outcome.status).toBe("completed");
        // filesChanged recorded via semantics 鈥?no name hardcode.
        expect(outcome.state.filesChanged).toContain("src/x.ts");
        expect(orch.calls).toHaveLength(1);
        // checkpoint boundary triggered by the filesystem scope.
        expect(ckpt.saved.length).toBeGreaterThan(0);
    });
    it("P1-11: a builtin-name tool declared side-effect-free neither checkpoints nor records files", async () => {
        const semantics = (name) => name === "write_file" ? { ...DEFAULT_TOOL_SEMANTICS, sideEffectScope: "none" } : DEFAULT_TOOL_SEMANTICS;
        const { runtime, ckpt, orch } = await makeRuntime({
            scripts: toolScript("write_file", { path: "src/y.ts", content: "x" }),
            toolSemantics: semantics,
        });
        const session = await runtime.createSession({ agent: AGENT, cwd });
        const turn = await runtime.startTurn(session.id, "write y");
        const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);
        expect(outcome.status).toBe("completed");
        // The declared semantics win over the name: no filesystem effect.
        expect(outcome.state.filesChanged).toEqual([]);
        expect(outcome.state.completed.filter((c) => c.includes("modified"))).toEqual([]);
        // No side-effect checkpoint boundary either.
        expect(ckpt.saved).toHaveLength(0);
        expect(orch.calls).toHaveLength(1);
    });
    it("P1-11: crash-resume reconciliation uses the same semantics as the original run", async () => {
        const semantics = (name) => name === "deploy" ? { ...DEFAULT_TOOL_SEMANTICS, sideEffectScope: "filesystem" } : DEFAULT_TOOL_SEMANTICS;
        const { runtime, store, events, ckpt, orch } = await makeRuntime({
            scripts: toolScript("deploy", { path: "src/z.ts" }),
            kill: new Set(["tool.completed"]),
            toolSemantics: semantics,
        });
        const session = await runtime.createSession({ agent: AGENT, cwd });
        const lastEventSequence = (await events.nextSequence(session.id)) - 1;
        const { turn } = await runUntilKilled(runtime, session, "tool.completed");
        // The tool's checkpoint was NOT written (killed before save) 鈥?seed points
        // resume at the interrupted turn so the store result is provably committed.
        expect(ckpt.saved).toHaveLength(0);
        ckpt.seed = seededCheckpoint(session.id, { lastEventSequence, turnId: turn.id });
        const r2 = restartedRuntime({ store, events, ckpt, orch, toolSemantics: semantics });
        const result = await r2.resumeTurn(session.id, new AbortController().signal);
        // The interrupted "deploy" is reconciled by its semantics: it is a
        // committed side effect and never re-executed, exactly once overall.
        expect(result.unresolvedTools).toHaveLength(0);
        expect(result.outcome.status).toBe("completed");
        expect(result.state.filesChanged).toContain("src/z.ts");
        expect(orch.calls).toHaveLength(1);
    });
});
//# sourceMappingURL=fault-injection-v2.test.js.map