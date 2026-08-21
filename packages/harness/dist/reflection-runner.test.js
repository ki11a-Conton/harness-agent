// P2-5/P2-6: post-turn reflection — deterministic reflection over a turn's
// event stream, journaling outputs and queueing write-gate-passing candidates.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newEventId, newSessionId, newTurnId, } from "@ar/contracts";
import { JsonlCandidateStore } from "./candidate-store.js";
import { PostTurnReflector, REFLECTION_FILE_NAME } from "./reflection-runner.js";
let tempDirs = [];
async function tempDataDir() {
    const dir = await mkdtemp(join(tmpdir(), "ar-reflect-"));
    tempDirs.push(dir);
    return dir;
}
afterEach(async () => {
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
    tempDirs = [];
});
function eventStoreOf(events) {
    return {
        append: async (e) => e,
        list: async () => events,
        stream: async function* () { },
        nextSequence: async () => 0,
    };
}
function failureTurnEvents(sessionId, turnId) {
    return [
        { id: newEventId(), sessionId, turnId, sequence: 0, timestamp: 1, type: "turn.started", payload: { turnId } },
        { id: newEventId(), sessionId, turnId, sequence: 1, timestamp: 2, type: "tool.requested", payload: { toolCallId: "tc-1", tool: "read_file", args: { path: "/w/missing.txt" } } },
        { id: newEventId(), sessionId, turnId, sequence: 2, timestamp: 3, type: "tool.failed", payload: { toolCallId: "tc-1", tool: "read_file", error: { code: "PROCESS_ERROR", message: "ENOENT: no such file" } } },
        { id: newEventId(), sessionId, turnId, sequence: 3, timestamp: 4, type: "turn.failed", payload: { error: { code: "RESOURCE_LIMIT", message: "limits" } } },
    ];
}
describe("P2-5: PostTurnReflector", () => {
    it("reflects a failed turn into journaled outputs + queued candidates", async () => {
        const dataDir = await tempDataDir();
        const sessionId = newSessionId();
        const turnId = newTurnId();
        const candidateStore = new JsonlCandidateStore({ dataDir });
        // A raised importance bar lets the write gate filter the weaker tool
        // group (severity 0.6) while the turn.failed group (severity 0.9) passes.
        const reflector = new PostTurnReflector({
            events: eventStoreOf(failureTurnEvents(sessionId, turnId)),
            candidateStore,
            dataDir,
            now: () => 5000,
            writePolicy: { minImportance: 0.7, minNovelty: 0.4, episodicMinImportance: 0.8 },
        });
        const result = await reflector.reflect({
            sessionId,
            turnId,
            outcome: { status: "failed", state: { goal: "read the file" } },
        });
        // 2 reflection groups (tool:read_file + environment) are journaled; only
        // the turn.failed group passes the raised write gate.
        expect(result.outputs).toBe(2);
        expect(result.candidates).toBe(1);
        const candidates = await candidateStore.list();
        expect(candidates).toHaveLength(1);
        expect(candidates[0].content).toContain("environment failure");
        // The structured strategy lesson + full source candidate survive (P2-6).
        expect(candidates[0].structured).toBeDefined();
        expect(candidates[0].sourceCandidate).toBeDefined();
        expect(candidates[0].sourceCandidate.structured.rootCause).toBe("environment");
    });
    it("journals reflection outputs to disk", async () => {
        const dataDir = await tempDataDir();
        const sessionId = newSessionId();
        const turnId = newTurnId();
        const reflector = new PostTurnReflector({
            events: eventStoreOf(failureTurnEvents(sessionId, turnId)),
            candidateStore: new JsonlCandidateStore({ dataDir }),
            dataDir,
            now: () => 5000,
        });
        await reflector.reflect({ sessionId, turnId, outcome: { status: "failed" } });
        const journal = await reflector.listJournal();
        expect(journal).toHaveLength(2);
        expect(journal[0].turnId).toBe(turnId);
        expect(journal[0].outcome).toBe("failed");
    });
    it("a clean turn produces no reflections and no candidates", async () => {
        const dataDir = await tempDataDir();
        const sessionId = newSessionId();
        const turnId = newTurnId();
        const clean = [
            { id: newEventId(), sessionId, turnId, sequence: 0, timestamp: 1, type: "turn.started", payload: { turnId } },
            { id: newEventId(), sessionId, turnId, sequence: 1, timestamp: 2, type: "model.completed", payload: { finishReason: "stop" } },
            { id: newEventId(), sessionId, turnId, sequence: 2, timestamp: 3, type: "turn.completed", payload: {} },
        ];
        const reflector = new PostTurnReflector({
            events: eventStoreOf(clean),
            candidateStore: new JsonlCandidateStore({ dataDir }),
            dataDir,
        });
        const result = await reflector.reflect({ sessionId, turnId, outcome: { status: "completed" } });
        expect(result.outputs).toBe(0);
        expect(result.candidates).toBe(0);
    });
    it("an event-read failure degrades to an empty result (never throws)", async () => {
        const dataDir = await tempDataDir();
        const failingEvents = {
            append: async (e) => e,
            list: async () => {
                throw new Error("boom");
            },
            stream: async function* () { },
            nextSequence: async () => 0,
        };
        const reflector = new PostTurnReflector({
            events: failingEvents,
            candidateStore: new JsonlCandidateStore({ dataDir }),
            dataDir,
        });
        const result = await reflector.reflect({
            sessionId: newSessionId(),
            turnId: newTurnId(),
            outcome: { status: "failed" },
        });
        expect(result.outputs).toBe(0);
        expect(result.candidates).toBe(0);
    });
});
//# sourceMappingURL=reflection-runner.test.js.map