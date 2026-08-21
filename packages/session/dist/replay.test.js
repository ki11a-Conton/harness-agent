import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newEventId, newSessionId, newTurnId } from "@ar/contracts";
import { JSONLSessionStore } from "./session-store.js";
import { compare, SessionReplayer } from "./replay.js";
class FakeEventStore {
    events = new Map();
    seq = new Map();
    async append(event) {
        const list = this.events.get(event.sessionId) ?? [];
        list.push(event);
        this.events.set(event.sessionId, list);
        this.seq.set(event.sessionId, (this.seq.get(event.sessionId) ?? 0) + 1);
        return event;
    }
    async list(sessionId, opts) {
        const all = this.events.get(sessionId) ?? [];
        const after = opts?.afterSequence ?? -1;
        const filtered = all.filter((e) => e.sequence > after);
        return opts?.limit !== undefined ? filtered.slice(0, opts.limit) : filtered;
    }
    async *stream(sessionId, opts) {
        for (const e of await this.list(sessionId, opts))
            yield e;
    }
    async nextSequence(sessionId) {
        return this.seq.get(sessionId) ?? 0;
    }
}
const sessionId = newSessionId();
const turnA = newTurnId();
const turnB = newTurnId();
/** Build a full event list for one session, with ascending sequence numbers. */
function buildEvents(specs) {
    return specs.map((spec, i) => ({
        id: newEventId(),
        sessionId,
        ...(spec.turnId !== undefined ? { turnId: spec.turnId } : {}),
        sequence: i,
        timestamp: spec.timestamp ?? 1000 * (i + 1),
        type: spec.type,
        payload: spec.payload ?? {},
    }));
}
function feed(events) {
    const store = new FakeEventStore();
    for (const ev of events)
        void store.append(ev);
    return store;
}
describe("SessionReplayer (REPLAY-001)", () => {
    it("rebuilds a completed turn with tool call counts and tool outputs", async () => {
        const events = buildEvents([
            { type: "session.created" },
            { type: "turn.started", turnId: turnA, timestamp: 1000 },
            { type: "tool.requested", turnId: turnA, payload: { toolCallId: "tc1", name: "echo" }, timestamp: 1100 },
            { type: "tool.started", turnId: turnA, payload: { toolCallId: "tc1" }, timestamp: 1200 },
            { type: "tool.output", turnId: turnA, payload: { toolCallId: "tc1", name: "echo", output: "hello" }, timestamp: 1300 },
            { type: "tool.started", turnId: turnA, payload: { toolCallId: "tc2", name: "ls" }, timestamp: 1400 },
            { type: "tool.output", turnId: turnA, payload: { toolCallId: "tc2", name: "ls", output: ["a.txt"] }, timestamp: 1500 },
            { type: "turn.completed", turnId: turnA, timestamp: 1600 },
        ]);
        const result = await new SessionReplayer({ events: feed(events) }).replay(sessionId);
        expect(result.sessionId).toBe(sessionId);
        expect(result.events).toBe(8);
        expect(result.turns).toHaveLength(1);
        const turn = result.turns[0];
        expect(turn.turnId).toBe(turnA);
        expect(turn.status).toBe("completed");
        // tc1 was requested AND started but counts once; tc2 only started -> 2 total
        expect(turn.toolCalls).toBe(2);
        expect(turn.firstEventAt).toBe(1000);
        expect(turn.lastEventAt).toBe(1600);
        expect(result.messages).toHaveLength(2);
        expect(result.messages[0]).toMatchObject({
            turnId: turnA,
            kind: "output",
            toolCallId: "tc1",
            toolName: "echo",
            output: "hello",
            timestamp: 1300,
        });
        expect(result.messages[1]).toMatchObject({ kind: "output", output: ["a.txt"] });
    });
    it("derives failed and cancelled turn statuses, and ignores session-level events", async () => {
        const events = buildEvents([
            { type: "turn.started", turnId: turnA, timestamp: 1000 },
            { type: "tool.requested", turnId: turnA, payload: { toolCallId: "tc1" }, timestamp: 1100 },
            { type: "turn.failed", turnId: turnA, timestamp: 1200 },
            { type: "turn.started", turnId: turnB, timestamp: 2000 },
            { type: "turn.cancelled", turnId: turnB, timestamp: 2100 },
        ]);
        const result = await new SessionReplayer({ events: feed(events) }).replay(sessionId);
        expect(result.turns).toHaveLength(2);
        const [a, b] = result.turns;
        expect(a.turnId).toBe(turnA);
        expect(a.status).toBe("failed");
        expect(a.toolCalls).toBe(1);
        expect(b.turnId).toBe(turnB);
        expect(b.status).toBe("cancelled");
        expect(b.toolCalls).toBe(0);
        // sorted by firstEventAt
        expect(result.turns.map((t) => t.turnId)).toEqual([turnA, turnB]);
    });
    it("resolves status by sequence, not by list order (last lifecycle event wins)", async () => {
        // Events are stored in correct sequence order but deliberately fed to the
        // store shuffled, to prove the replayer sorts by sequence before applying
        // the "last lifecycle event wins" state machine.
        const events = buildEvents([
            { type: "tool.started", turnId: turnA, payload: { toolCallId: "tc1" }, timestamp: 1500 },
            { type: "tool.requested", turnId: turnA, payload: { toolCallId: "tc1" }, timestamp: 1400 },
            { type: "turn.started", turnId: turnA, timestamp: 1000 },
            { type: "turn.completed", turnId: turnA, timestamp: 1600 },
        ]);
        const shuffled = [events[1], events[3], events[0], events[2]];
        const result = await new SessionReplayer({ events: feed(shuffled) }).replay(sessionId);
        expect(result.turns[0].status).toBe("completed");
        expect(result.turns[0].toolCalls).toBe(1);
        expect(result.turns[0].firstEventAt).toBe(1000);
        expect(result.turns[0].lastEventAt).toBe(1600);
    });
    it("reports running for a turn that only started", async () => {
        const events = buildEvents([{ type: "turn.started", turnId: turnA, timestamp: 1000 }]);
        const result = await new SessionReplayer({ events: feed(events) }).replay(sessionId);
        expect(result.turns[0].status).toBe("running");
    });
    it("reports unknown for turns with only tool activity and no lifecycle events", async () => {
        const events = buildEvents([
            { type: "tool.requested", turnId: turnA, payload: { toolCallId: "tc1" }, timestamp: 1000 },
            { type: "tool.output", turnId: turnA, payload: { toolCallId: "tc1", output: "x" }, timestamp: 1100 },
        ]);
        const result = await new SessionReplayer({ events: feed(events) }).replay(sessionId);
        expect(result.turns[0].status).toBe("unknown");
        expect(result.turns[0].toolCalls).toBe(1);
    });
    it("includes tool.failed events as error messages", async () => {
        const events = buildEvents([
            { type: "turn.started", turnId: turnA },
            { type: "tool.failed", turnId: turnA, payload: { toolCallId: "tc1", name: "bash", error: { code: "E1" } } },
            { type: "turn.failed", turnId: turnA },
        ]);
        const result = await new SessionReplayer({ events: feed(events) }).replay(sessionId);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0]).toMatchObject({ kind: "error", toolName: "bash", error: { code: "E1" } });
    });
    it("decodes orchestrator-shaped tool.output payloads ({tool, stream, text})", async () => {
        // ToolOrchestrator.emit injects { toolCallId, tool } and passes the
        // ProcessExecutor onOutput chunk through as { stream, text }.
        const events = buildEvents([
            { type: "turn.started", turnId: turnA },
            { type: "tool.started", turnId: turnA, payload: { toolCallId: "tc1", tool: "exec" } },
            { type: "tool.output", turnId: turnA, payload: { toolCallId: "tc1", tool: "exec", stream: "stdout", text: "chunk1" } },
            { type: "tool.output", turnId: turnA, payload: { toolCallId: "tc1", tool: "exec", stream: "stderr", text: "boo" } },
            { type: "turn.completed", turnId: turnA },
        ]);
        const result = await new SessionReplayer({ events: feed(events) }).replay(sessionId);
        expect(result.turns[0].toolCalls).toBe(1);
        expect(result.messages).toHaveLength(2);
        expect(result.messages[0]).toMatchObject({ kind: "output", toolName: "exec", toolCallId: "tc1", output: "chunk1" });
        expect(result.messages[1]).toMatchObject({ kind: "output", toolName: "exec", output: "boo" });
    });
    it("returns empty turns and messages when there are no events", async () => {
        const result = await new SessionReplayer({ events: new FakeEventStore() }).replay(sessionId);
        expect(result).toEqual({ sessionId, turns: [], events: 0, messages: [], orphans: [] });
    });
    it("orders parallel turns deterministically by sequence, not wall-clock tie or list order (P2-33)", async () => {
        // Both turns share the exact same firstEventAt (parallel completions landing
        // in the same ms). turnB holds the lower sequence (0), turnA the higher (2).
        const events = buildEvents([
            { type: "turn.started", turnId: turnB, timestamp: 1000 }, // seq 0
            { type: "turn.completed", turnId: turnB, timestamp: 1100 }, // seq 1
            { type: "turn.started", turnId: turnA, timestamp: 1000 }, // seq 2
            { type: "turn.completed", turnId: turnA, timestamp: 1100 }, // seq 3
        ]);
        // Feed turnA's events first so map-insertion order (and any engine-stable
        // sort on equal timestamps) would yield [turnA, turnB]. The replayer must
        // NOT depend on that: it must break the tie by earliest sequence -> [turnB, turnA].
        const shuffled = [events[2], events[3], events[0], events[1]];
        const result = await new SessionReplayer({ events: feed(shuffled) }).replay(sessionId);
        expect(result.turns.map((t) => t.turnId)).toEqual([turnB, turnA]);
        expect(result.turns[0].firstEventAt).toBe(1000);
        expect(result.turns[1].firstEventAt).toBe(1000);
    });
    it("compare: consistent snapshot passes", async () => {
        const snapshot = {
            turns: [
                { id: "turn_1", status: "completed" },
                { id: "turn_2", status: "failed" },
            ],
        };
        const replay = {
            sessionId,
            events: 8,
            messages: [],
            orphans: [],
            turns: [
                { turnId: "turn_1", status: "completed", toolCalls: 2, firstEventAt: 1, lastEventAt: 2 },
                { turnId: "turn_2", status: "failed", toolCalls: 1, firstEventAt: 3, lastEventAt: 4 },
            ],
        };
        expect(compare(snapshot, replay)).toEqual({ ok: true, issues: [] });
    });
    it("compare: missing snapshot fails closed", async () => {
        const replay = { sessionId, events: 0, messages: [], orphans: [], turns: [] };
        const result = compare(undefined, replay);
        expect(result.ok).toBe(false);
        expect(result.issues.join(" ")).toContain("fail-closed");
    });
    it("compare: turn count mismatch is reported", async () => {
        const replay = {
            sessionId,
            events: 0,
            messages: [],
            orphans: [],
            turns: [
                { turnId: "turn_1", status: "completed", toolCalls: 0, firstEventAt: 1, lastEventAt: 2 },
            ],
        };
        const result = compare({ turns: [] }, replay);
        expect(result.ok).toBe(false);
        expect(result.issues.join(" ")).toContain("snapshot 0 vs replay 1");
    });
    it("compare: snapshot without turn data is reported", async () => {
        const replay = { sessionId, events: 0, messages: [], orphans: [], turns: [] };
        const result = compare({ other: 1 }, replay);
        expect(result.ok).toBe(false);
    });
    it("end-to-end: store snapshot and event replay agree for the same session (architecture §110)", async () => {
        const dataDir = await mkdtemp(join(tmpdir(), "session-replay-"));
        try {
            const store = new JSONLSessionStore({ dataDir });
            const session = {
                id: sessionId,
                agentId: "agent_demo",
                model: { providerId: "demo", modelId: "demo-1" },
                cwd: "C:\\work",
                status: "active",
                createdAt: 1,
                updatedAt: 1,
            };
            await store.createSession(session);
            const turn = {
                id: turnA,
                sessionId,
                input: { sessionId, text: "hi" },
                status: "completed",
                startedAt: 1000,
                completedAt: 1600,
            };
            await store.createTurn(turn);
            await store.saveStateSnapshot(sessionId, { turns: [{ id: turnA, status: "completed" }] });
            const events = buildEvents([
                { type: "turn.started", turnId: turnA, timestamp: 1000 },
                { type: "turn.completed", turnId: turnA, timestamp: 1600 },
            ]);
            const replay = await new SessionReplayer({ events: feed(events) }).replay(sessionId);
            const snapshot = await store.loadStateSnapshot(sessionId);
            expect(compare(snapshot, replay)).toEqual({ ok: true, issues: [] });
        }
        finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=replay.test.js.map