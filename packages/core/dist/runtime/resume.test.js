import { describe, expect, it } from "vitest";
import { buildCheckpoint, newAgentId, newCheckpointId, newEventId, newSessionId, newTurnId, newWorkingState, } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime, buildResumePrompt } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";
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
class FakeCheckpointStore {
    saved = [];
    seed;
    async save(checkpoint) {
        this.saved.push(checkpoint);
    }
    async loadLatest() {
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
        state: newWorkingState("goal"),
        toolLedger: [],
        childSessions: [],
        lastEventSequence: 0,
        effectiveAgentConfigRef: "effectiveAgent",
        contextRefs: [],
        ...over,
    });
}
async function makeRuntime(scripts = [ScriptedModelProvider.text("done")]) {
    const provider = new ScriptedModelProvider(scripts);
    const store = new FilteringSessionStore();
    const events = new MemoryEventStore();
    const ckpt = new FakeCheckpointStore();
    const runtime = new AgentRuntime({
        store,
        events,
        modelProvider: provider,
        orchestrator: new FakeOrchestrator({ status: "success", output: "ok" }),
        agents: [AGENT],
        checkpointStore: ckpt,
        checkpointPolicy: {
            afterSideEffectTools: false,
            afterCompaction: false,
            afterVerification: false,
            everyNIterations: 0,
        },
    });
    return { runtime, store, events, ckpt };
}
function requestedEvent(sessionId, toolCallId, name, args, timestamp = 7) {
    return {
        id: newEventId(),
        sessionId,
        turnId: newTurnId(),
        sequence: 0,
        timestamp,
        type: "tool.requested",
        payload: { toolCallId, name, args },
    };
}
describe("AgentRuntime resume (P1-4)", () => {
    it("resumes from a durable checkpoint into a fresh turn seeded with the restored working state", async () => {
        const { runtime, events, ckpt } = await makeRuntime();
        const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\work" });
        const lastEventSequence = (await events.nextSequence(session.id)) - 1;
        const state = newWorkingState("fix the build");
        state.completed.push("added config");
        state.filesChanged.push("config.yaml");
        ckpt.seed = seededCheckpoint(session.id, {
            lastEventSequence,
            state,
        });
        const result = await runtime.resumeTurn(session.id, new AbortController().signal);
        expect(result.checkpointId).toBe(ckpt.seed.checkpointId);
        expect(result.state.goal).toBe("fix the build");
        expect(result.state.filesChanged).toEqual(["config.yaml"]);
        expect(result.state.completed).toContain("added config");
        expect(result.outcome.status).toBe("completed");
        expect(result.replayedEventCount).toBe(0);
        expect(result.committedSideEffects).toEqual([]);
        expect(result.unresolvedTools).toEqual([]);
        const stored = await events.list(session.id);
        expect(stored.map((e) => e.type)).toContain("session.resumed");
        const resumed = stored.find((e) => e.type === "session.resumed");
        expect(resumed.payload.resumedTurnId).toBe(result.outcome.turn.id);
    });
    it("marks post-checkpoint completed side effects as committed (never redo) and folds them into the restored state", async () => {
        const { runtime, store, events, ckpt } = await makeRuntime();
        const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\work" });
        const lastEventSequence = (await events.nextSequence(session.id)) - 1;
        const interruptedTurn = newTurnId();
        await events.append(requestedEvent(session.id, "toolcall_w", "write_file", { path: "CHANGELOG.md", content: "x" }));
        await store.appendMessage({
            id: "message_m",
            sessionId: session.id,
            turnId: interruptedTurn,
            role: "tool",
            toolCallId: "toolcall_w",
            content: "wrote CHANGELOG.md",
            createdAt: 7,
        });
        ckpt.seed = seededCheckpoint(session.id, {
            lastEventSequence,
            turnId: interruptedTurn,
        });
        const result = await runtime.resumeTurn(session.id, new AbortController().signal);
        expect(result.replayedEventCount).toBe(1);
        expect(result.committedSideEffects).toHaveLength(1);
        expect(result.committedSideEffects[0].tool).toBe("write_file");
        expect(result.committedSideEffects[0].sideEffect).toBe(true);
        expect(result.unresolvedTools).toEqual([]);
        expect(result.state.filesChanged).toContain("CHANGELOG.md");
        expect(result.state.completed).toContain("modified CHANGELOG.md");
        const prompt = buildResumePrompt(result.state, result.committedSideEffects, result.unresolvedTools);
        expect(prompt).toContain("do NOT redo");
        expect(prompt).toContain("CHANGELOG.md");
    });
    it("surfaces started-but-unconfirmed tools as unresolved reconciliation (never auto-redo)", async () => {
        const { runtime, events, ckpt } = await makeRuntime();
        const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\work" });
        const lastEventSequence = (await events.nextSequence(session.id)) - 1;
        await events.append(requestedEvent(session.id, "toolcall_ex", "exec", { command: "npm publish" }));
        ckpt.seed = seededCheckpoint(session.id, { lastEventSequence });
        const result = await runtime.resumeTurn(session.id, new AbortController().signal);
        expect(result.unresolvedTools).toHaveLength(1);
        expect(result.unresolvedTools[0].tool).toBe("exec");
        expect(result.unresolvedTools[0].sideEffect).toBe(true);
        expect(result.committedSideEffects).toEqual([]);
        // The exec was never re-executed: the resumed turn ran only the text script.
        expect(result.state.commandsRun).toEqual([]);
        // P2-40: the unresolved tool surfaces as a reconciliation retry-kind event.
        const trail = await events.list(session.id);
        const reconciliations = trail.filter((e) => e.type === "retry.reconciliation");
        expect(reconciliations).toHaveLength(1);
        expect(reconciliations[0].payload).toMatchObject({
            toolCallId: "toolcall_ex",
            tool: "exec",
            sideEffect: true,
        });
        const prompt = buildResumePrompt(result.state, result.committedSideEffects, result.unresolvedTools);
        expect(prompt).toContain("Unresolved tool executions");
        expect(prompt).toContain("reconcile");
        expect(prompt).toContain("may have side effect");
    });
    it("refuses to resume without a durable checkpoint (RESUME_FAILED)", async () => {
        const { runtime } = await makeRuntime();
        const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\work" });
        await expect(runtime.resumeTurn(session.id, new AbortController().signal)).rejects.toMatchObject({
            info: expect.objectContaining({ code: "RESUME_FAILED" }),
        });
    });
    it("refuses to resume when the runtime has no checkpoint store at all", async () => {
        const store = new FilteringSessionStore();
        const events = new MemoryEventStore();
        const runtime = new AgentRuntime({
            store,
            events,
            modelProvider: new ScriptedModelProvider([ScriptedModelProvider.text("done")]),
            orchestrator: new FakeOrchestrator({ status: "success", output: "ok" }),
            agents: [AGENT],
        });
        const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\work" });
        await expect(runtime.resumeTurn(session.id, new AbortController().signal)).rejects.toMatchObject({
            info: expect.objectContaining({ code: "RESUME_FAILED" }),
        });
    });
    it("resume prompt carries working state, committed side effects and unresolved tools and omits the transcript", () => {
        const state = newWorkingState("goal here");
        state.pending.push("verify");
        state.importantFacts.push("fact");
        const committed = [
            { toolCallId: "toolcall_1", tool: "write_file", argsHash: "a", started: 1, completed: 2, status: "success", sideEffect: true },
        ];
        const unresolved = [
            { toolCallId: "toolcall_2", tool: "exec", argsHash: "b", started: 3, sideEffect: true },
        ];
        const prompt = buildResumePrompt(state, committed, unresolved);
        expect(prompt).toContain("goal here");
        expect(prompt).toContain("verify");
        expect(prompt).toContain("fact");
        expect(prompt).toContain("write_file");
        expect(prompt).toContain("exec");
        expect(prompt).toContain("do NOT redo");
        expect(prompt).toContain("reconcile");
        expect(prompt).not.toContain("[user]");
    });
});
//# sourceMappingURL=resume.test.js.map