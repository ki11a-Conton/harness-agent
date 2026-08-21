import { describe, expect, it } from "vitest";
import { errorInfo, newAgentId, newMessageId } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime } from "@ar/core";
import { createLeafAgent, NESTED_MARKER, NestedDelegator, resolveRole, } from "./nested-delegation.js";
// ---- in-memory fakes (same pattern as delegator.test.ts) -------------------
class MemorySessionStore {
    sessions = new Map();
    turns = new Map();
    messages = [];
    async createSession(session) {
        this.sessions.set(session.id, session);
    }
    async getSession(id) {
        return this.sessions.get(id);
    }
    async updateSession(session) {
        this.sessions.set(session.id, session);
    }
    async listSessions(opts) {
        let all = [...this.sessions.values()];
        if (opts?.parentId !== undefined)
            all = all.filter((s) => s.parentId === opts.parentId);
        if (opts?.status !== undefined)
            all = all.filter((s) => s.status === opts.status);
        return all;
    }
    async createTurn(turn) {
        this.turns.set(turn.id, turn);
    }
    async getTurn(id) {
        return this.turns.get(id);
    }
    async updateTurn(turn) {
        this.turns.set(turn.id, turn);
    }
    async listTurns(sessionId) {
        return [...this.turns.values()].filter((t) => t.sessionId === sessionId);
    }
    async appendMessage(message) {
        this.messages.push(message);
    }
    async listMessages(sessionId) {
        return this.messages.filter((m) => m.sessionId === sessionId);
    }
    async listMessagesByTurn(sessionId, turnId) {
        return this.messages.filter((m) => m.sessionId === sessionId && m.turnId === turnId);
    }
    async saveStateSnapshot() { }
    async loadStateSnapshot() {
        return undefined;
    }
}
class MemoryEventStore {
    events = [];
    seq = 0;
    async nextSequence() {
        return this.seq + 1;
    }
    async append(event) {
        const stored = { ...event, sequence: ++this.seq };
        this.events.push(stored);
        return stored;
    }
    async list(sessionId, opts) {
        let list = this.events.filter((e) => e.sessionId === sessionId);
        if (opts?.afterSequence !== undefined)
            list = list.filter((e) => e.sequence > opts.afterSequence);
        if (opts?.limit !== undefined)
            list = list.slice(0, opts.limit);
        return list;
    }
    async *stream(sessionId, opts) {
        for (const e of this.events) {
            if (e.sessionId !== sessionId)
                continue;
            if (opts?.afterSequence !== undefined && e.sequence <= opts.afterSequence)
                continue;
            yield e;
        }
    }
}
class FakeOrchestrator {
    result;
    calls = [];
    constructor(result = { status: "success", output: "fake-ok" }) {
        this.result = result;
    }
    async execute(request, _context) {
        this.calls.push({ request });
        return this.result;
    }
}
// ---- harness ---------------------------------------------------------------
const PARENT = {
    id: newAgentId(),
    name: "parent",
    description: "parent test agent",
    mode: "primary",
    model: { providerId: "scripted", modelId: "scripted-model" },
    systemPrompt: "parent prompt",
    tools: {},
    permissions: { rules: [] },
    skills: {},
    limits: {},
};
const ORCHESTRATOR = {
    id: newAgentId(),
    name: "orch",
    description: "orchestrator test agent",
    mode: "subagent",
    model: { providerId: "scripted", modelId: "scripted-model" },
    systemPrompt: "orch prompt",
    tools: {},
    permissions: { rules: [] },
    skills: {},
    limits: {},
};
/** §56 leaf agent: same subagent shape, marked canDelegate=false. */
const LEAF = createLeafAgent({ ...ORCHESTRATOR, id: newAgentId(), name: "leaf" });
function makeHarness(opts) {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const now = opts?.now ?? Date.now;
    const provider = new ScriptedModelProvider(opts?.scripts ?? [ScriptedModelProvider.text("child done")]);
    const orchestrator = new FakeOrchestrator();
    const runtime = new AgentRuntime({
        store,
        events,
        modelProvider: provider,
        orchestrator,
        agents: [PARENT, ORCHESTRATOR, LEAF],
        now,
    });
    const nested = new NestedDelegator({
        runtime,
        store,
        events,
        agentId: ORCHESTRATOR.id,
        limits: opts?.limits,
        now,
        ...(opts?.resolveRole !== undefined ? { resolveRole: opts.resolveRole } : {}),
    });
    return { store, events, runtime, nested, provider, orchestrator };
}
async function createParent(harness) {
    const { runtime } = harness;
    return runtime.createSession({ agent: PARENT, cwd: "C:\\work" });
}
function subagentEvents(events, sessionId) {
    return events.events.filter((e) => e.sessionId === sessionId && e.type.startsWith("subagent."));
}
/** Waits until the scripted provider started `n` model calls (deterministic
 *  gate for cancel tests: the grandchild turn has begun). */
async function waitForModelCalls(provider, n) {
    const deadline = Date.now() + 2000;
    while (provider.calls.length < n && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
    }
    expect(provider.calls.length).toBeGreaterThanOrEqual(n);
}
// ---- tests -----------------------------------------------------------------
describe("NestedDelegator (SUBAGENT-003)", () => {
    it("createLeafAgent marks a leaf and resolveRole judges roles (§56)", () => {
        const leaf = createLeafAgent(ORCHESTRATOR);
        expect(leaf.mode).toBe("subagent");
        expect(leaf.canDelegate).toBe(false);
        expect(ORCHESTRATOR.canDelegate).toBeUndefined();
        expect(resolveRole(ORCHESTRATOR, 0, 2)).toBe("orchestrator");
        expect(resolveRole(leaf, 0, 2)).toBe("leaf");
        expect(resolveRole(ORCHESTRATOR, 1, 2)).toBe("orchestrator");
        expect(resolveRole(ORCHESTRATOR, 2, 2)).toBe("leaf");
    });
    it("rejects delegation to a leaf agent before any session is created (§56)", async () => {
        const h = makeHarness();
        const parent = await createParent(h);
        await expect(h.nested.delegateNested({ parentSessionId: parent.id, goal: "g", agentId: LEAF.id }, new AbortController().signal)).rejects.toMatchObject({ info: { code: "RESOURCE_LIMIT" } });
        expect(await h.store.listSessions({ parentId: parent.id })).toHaveLength(0);
    });
    it("delegates one level when the child does not request nesting", async () => {
        const h = makeHarness({ scripts: [ScriptedModelProvider.text("child done")] });
        const parent = await createParent(h);
        const result = await h.nested.delegateNested({ parentSessionId: parent.id, goal: "g" }, new AbortController().signal);
        expect(result.status).toBe("success");
        expect(result.summary).toBe("child done");
        expect(result.summary).not.toContain(NESTED_MARKER);
        expect(await h.store.listSessions({ parentId: parent.id })).toHaveLength(1);
    });
    it("nests one level: parent → child → grandchild, marked in the result chain", async () => {
        const h = makeHarness({
            scripts: [
                ScriptedModelProvider.text("DELEGATE: grandchild work"),
                ScriptedModelProvider.text("grandchild done"),
            ],
        });
        const parent = await createParent(h);
        const result = await h.nested.delegateNested({ parentSessionId: parent.id, goal: "parent goal" }, new AbortController().signal);
        expect(result.status).toBe("success");
        expect(result.summary).toContain(NESTED_MARKER);
        const child = await h.store.getSession(result.childSessionId);
        expect(child?.parentId).toBe(parent.id);
        const grandchildren = await h.store.listSessions({ parentId: result.childSessionId });
        expect(grandchildren).toHaveLength(1);
        expect(result.summary).toContain(`${result.childSessionId}:success`);
        expect(result.summary).toContain(`${grandchildren[0].id}:success`);
        expect(result.summary).toContain(" → ");
        const parentEvents = subagentEvents(h.events, parent.id);
        expect(parentEvents.map((e) => e.type)).toEqual(["subagent.started", "subagent.completed"]);
        const childEvents = subagentEvents(h.events, result.childSessionId);
        expect(childEvents.map((e) => e.type)).toEqual(["subagent.started", "subagent.completed"]);
    });
    it("rejects a third nesting level with the default maxDepth=2 (depth overrun)", async () => {
        const h = makeHarness({
            scripts: [
                ScriptedModelProvider.text("DELEGATE: level 2"),
                ScriptedModelProvider.text("DELEGATE: level 3"),
            ],
        });
        const parent = await createParent(h);
        await expect(h.nested.delegateNested({ parentSessionId: parent.id, goal: "g" }, new AbortController().signal)).rejects.toMatchObject({ info: { code: "RESOURCE_LIMIT" } });
        const children = await h.store.listSessions({ parentId: parent.id });
        expect(children).toHaveLength(1);
        const grandchildren = await h.store.listSessions({ parentId: children[0].id });
        expect(grandchildren).toHaveLength(1);
        expect(await h.store.listSessions({ parentId: grandchildren[0].id })).toHaveLength(0);
    });
    it("rejects nesting beyond maxDepth=1 while the first level still succeeds", async () => {
        const h = makeHarness({
            scripts: [ScriptedModelProvider.text("DELEGATE: level 2")],
            limits: { maxDepth: 1 },
        });
        const parent = await createParent(h);
        await expect(h.nested.delegateNested({ parentSessionId: parent.id, goal: "g" }, new AbortController().signal)).rejects.toMatchObject({ info: { code: "RESOURCE_LIMIT" } });
        const children = await h.store.listSessions({ parentId: parent.id });
        expect(children).toHaveLength(1);
        expect(await h.store.listSessions({ parentId: children[0].id })).toHaveLength(0);
    });
    it("applies per-request limits to nested levels", async () => {
        const h = makeHarness({ scripts: [ScriptedModelProvider.text("DELEGATE: level 2")] });
        const parent = await createParent(h);
        await expect(h.nested.delegateNested({ parentSessionId: parent.id, goal: "g", limits: { maxDepth: 1 } }, new AbortController().signal)).rejects.toMatchObject({ info: { code: "RESOURCE_LIMIT" } });
        const children = await h.store.listSessions({ parentId: parent.id });
        expect(children).toHaveLength(1);
        expect(await h.store.listSessions({ parentId: children[0].id })).toHaveLength(0);
    });
    it("uses a provided starting depth: beyond maxDepth rejects up front", async () => {
        const h = makeHarness();
        const parent = await createParent(h);
        await expect(h.nested.delegateNested({ parentSessionId: parent.id, goal: "g" }, new AbortController().signal, 2)).rejects.toMatchObject({ info: { code: "RESOURCE_LIMIT" } });
        expect(await h.store.listSessions({ parentId: parent.id })).toHaveLength(0);
        const ok = await h.nested.delegateNested({ parentSessionId: parent.id, goal: "g" }, new AbortController().signal, 1);
        expect(ok.status).toBe("success");
    });
    it("propagates caller cancellation across nesting levels", async () => {
        const hanging = (async function* hang() {
            yield { type: "started", timestamp: 0 };
            await new Promise((r) => setTimeout(r, 1000));
        })();
        const h = makeHarness({
            scripts: [ScriptedModelProvider.text("DELEGATE: hang level"), hanging],
        });
        const parent = await createParent(h);
        const ac = new AbortController();
        const pending = h.nested.delegateNested({ parentSessionId: parent.id, goal: "g" }, ac.signal);
        await waitForModelCalls(h.provider, 2);
        ac.abort();
        const result = await pending;
        expect(result.status).toBe("cancelled");
        expect(result.summary).toContain(NESTED_MARKER);
        expect(result.summary).toContain("cancelled");
        const child = await h.store.getSession(result.childSessionId);
        expect(child?.parentId).toBe(parent.id);
    });
    it("propagates the per-level timeout across nesting", async () => {
        const hanging = (async function* hang() {
            yield { type: "started", timestamp: 0 };
            await new Promise((r) => setTimeout(r, 2000));
        })();
        const h = makeHarness({
            scripts: [ScriptedModelProvider.text("DELEGATE: hang level"), hanging],
            limits: { timeoutMs: 100 },
        });
        const parent = await createParent(h);
        const result = await h.nested.delegateNested({ parentSessionId: parent.id, goal: "g" }, new AbortController().signal);
        expect(result.status).toBe("timeout");
        expect(result.error).toContain("100ms");
        expect(result.summary).toContain(NESTED_MARKER);
        expect(result.summary).toContain("timeout");
    });
    it("propagates a failed nested turn instead of masking it", async () => {
        const h = makeHarness({
            scripts: [
                ScriptedModelProvider.text("DELEGATE: fail level"),
                [{ type: "error", error: errorInfo("MODEL_ERROR", "grandchild boom"), timestamp: 0 }],
            ],
        });
        const parent = await createParent(h);
        const result = await h.nested.delegateNested({ parentSessionId: parent.id, goal: "g" }, new AbortController().signal);
        expect(result.status).toBe("failed");
        expect(result.error).toBe("grandchild boom");
        expect(result.summary).toContain(NESTED_MARKER);
        expect(result.summary).toContain("failed");
    });
    it("uses an injected role resolver when provided", async () => {
        const h = makeHarness({
            scripts: [ScriptedModelProvider.text("child done")],
            resolveRole: () => "leaf",
        });
        const parent = await createParent(h);
        await expect(h.nested.delegateNested({ parentSessionId: parent.id, goal: "g" }, new AbortController().signal)).rejects.toMatchObject({ info: { code: "RESOURCE_LIMIT" } });
        expect(await h.store.listSessions({ parentId: parent.id })).toHaveLength(0);
    });
});
//# sourceMappingURL=nested-delegation.test.js.map