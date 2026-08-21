import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newAgentId, newEventId, newSessionId, newTurnId } from "@ar/contracts";
import { JSONLEventStore } from "@ar/events";
import { JSONLSessionStore, SessionReplayer, SessionService } from "@ar/session";
let dataDir = "";
beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ar-p2-"));
});
afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
});
function event(type, sessionId, turnId) {
    return {
        id: newEventId(),
        sessionId: sessionId,
        ...(turnId !== undefined ? { turnId: turnId } : {}),
        sequence: 0,
        timestamp: Date.now(),
        type,
        payload: {},
    };
}
describe("P2 integration: session + events + replay (SESSION-001 / EVENT-001 / REPLAY-001)", () => {
    it("session survives process restart (destruct + reconstruct stores, same dataDir)", async () => {
        const service = new SessionService({ store: new JSONLSessionStore({ dataDir }) });
        const created = await service.create({
            agentId: newAgentId(),
            model: { providerId: "demo", modelId: "demo-1" },
            cwd: process.cwd(),
        });
        // "Process crashes": drop every reference, rebuild from the same dataDir.
        const store2 = new JSONLSessionStore({ dataDir });
        const resumed = await new SessionService({ store: store2 }).resume(created.id);
        expect(resumed.id).toBe(created.id);
        expect(resumed.status).toBe("active");
        // Turn + snapshot also survive.
        const turn = {
            id: newTurnId(),
            sessionId: created.id,
            input: { sessionId: created.id, text: "hi" },
            status: "running",
            startedAt: Date.now(),
        };
        await store2.createTurn(turn);
        await store2.saveStateSnapshot(created.id, { turns: [{ id: turn.id, status: "running" }] });
        const store3 = new JSONLSessionStore({ dataDir });
        expect((await store3.getTurn(turn.id))?.id).toBe(turn.id);
        const snap = await store3.loadStateSnapshot(created.id);
        expect(Array.isArray(snap?.turns)).toBe(true);
    });
    it("event log survives restart with monotonic sequences (EVENT-001 §109)", async () => {
        const sid = newSessionId();
        const store = new JSONLEventStore({ dataDir });
        const e1 = await store.append(event("session.created", sid));
        const e2 = await store.append(event("turn.started", sid, newTurnId()));
        expect(e2.sequence).toBe(e1.sequence + 1);
        // Restart: new instance, same dataDir.
        const store2 = new JSONLEventStore({ dataDir });
        const all = await store2.list(sid);
        expect(all).toHaveLength(2);
        expect(all.map((e) => e.sequence)).toEqual([0, 1]);
        expect(await store2.nextSequence(sid)).toBe(2);
        const e3 = await store2.append(event("turn.started", sid, newTurnId()));
        expect(e3.sequence).toBe(2);
        expect(await store2.nextSequence(sid)).toBe(3);
    });
    it("replay reconstructs turns from persisted events, consistent with snapshot (§110)", async () => {
        const sid = newSessionId();
        const events = new JSONLEventStore({ dataDir });
        const turns = new JSONLSessionStore({ dataDir });
        const sid2 = sid;
        const turnId = newTurnId();
        const session = {
            id: sid,
            agentId: newAgentId(),
            model: { providerId: "demo", modelId: "demo-1" },
            cwd: process.cwd(),
            status: "active",
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        await turns.createSession(session);
        await turns.saveStateSnapshot(sid, { turns: [{ id: turnId, status: "completed" }] });
        await events.append({ ...event("session.created", sid), sessionId: sid });
        await events.append({ ...event("turn.started", sid, turnId), sessionId: sid, turnId });
        await events.append({ ...event("turn.completed", sid, turnId), sessionId: sid, turnId });
        const replay = await new SessionReplayer({ events }).replay(sid);
        expect(replay.turns).toHaveLength(1);
        expect(replay.turns[0].turnId).toBe(turnId);
        expect(replay.turns[0].status).toBe("completed");
        const snapshot = await turns.loadStateSnapshot(sid);
        // Replay is a pure read-only reconstruction; compare against snapshot.
        expect(replay.turns).toHaveLength((snapshot?.turns).length);
        expect(sid2).toBeDefined(); // keep type usage explicit
    });
});
//# sourceMappingURL=p2-integration.test.js.map