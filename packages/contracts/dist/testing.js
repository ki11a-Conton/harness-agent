const DEFAULT_MODEL = { providerId: "test-provider", modelId: "test-model" };
const DEFAULT_AGENT = "agent_test-fixture";
/** A fresh monotone seed with a fixed clock. Give each fixture its own. */
export function makeSeed() {
    let count = 0;
    return {
        ids: () => {
            count += 1;
            return count;
        },
        now: () => 1000,
    };
}
/**
 * Module-level default counter. Each test file gets its own isolated instance
 * (vitest isolates per file), so consecutive `makeEvent()` calls in one suite
 * yield distinct ids while the run stays deterministic and reproducible.
 */
let defaultCounter = 0;
function fixed(seed, n) {
    if (seed)
        return seed.ids();
    if (n !== undefined)
        return n;
    defaultCounter += 1;
    return defaultCounter;
}
/** Deterministic id of a given kind: `<prefix>` + zero-padded sequence. */
function seededId(prefix, n) {
    return `${prefix}${String(n).padStart(4, "0")}`;
}
export function makeSessionId(n) {
    return seededId("session_", n);
}
export function makeTurnId(n) {
    return seededId("turn_", n);
}
export function makeEventId(n) {
    return seededId("event_", n);
}
export function makeAgentId(n) {
    return seededId("agent_", n);
}
/** An agent-fixture id; give a small `n` to pin the value. */
export function fixtureAgentId(n = 1) {
    return makeAgentId(n);
}
/** Deterministic minimal Session with sensible defaults. */
export function makeSession(over = {}) {
    const n = over.n ?? 1;
    return {
        id: over.id ?? makeSessionId(n),
        parentId: over.parentId,
        agentId: over.agentId ?? DEFAULT_AGENT,
        model: over.model ?? DEFAULT_MODEL,
        cwd: over.cwd ?? "/workspace",
        status: over.status ?? "active",
        createdAt: over.createdAt ?? 0,
        updatedAt: over.updatedAt ?? 0,
    };
}
/** Deterministic minimal Turn. input is a nominal message by default. */
export function makeTurn(over = {}) {
    const n = over.n ?? 1;
    const sid = over.sessionId ?? makeSessionId(n);
    return {
        id: over.id ?? makeTurnId(n),
        sessionId: sid,
        input: over.input ?? { sessionId: sid, text: `prompt ${n}` },
        status: over.status ?? "running",
        startedAt: over.startedAt ?? 0,
        completedAt: over.completedAt,
    };
}
/**
 * Deterministic AgentEvent. Default sequence is 0 (the store under test owns
 * sequencing); pass `sequence` as needed. Id + timestamp come from `n` or the
 * injected seed clock so snapshots are stable across runs.
 */
export function makeEvent(over = {}) {
    const n = over.n;
    const seed = over.seed;
    const seqId = fixed(seed, n);
    const at = over.timestamp ?? (seed ? seed.now() : seqId);
    return {
        id: over.id ?? makeEventId(seqId),
        // A stable default session (session_0001): a loop of makeEvent() in one
        // suite lands in the same session unless the caller overrides it.
        sessionId: over.sessionId ?? makeSessionId(1),
        turnId: over.turnId ?? makeTurnId(n ?? (seqId === 1 ? 1 : seqId)),
        sequence: over.sequence ?? 0,
        timestamp: at,
        schemaVersion: over.schemaVersion,
        type: over.type ?? "turn.started",
        payload: over.payload ?? {},
    };
}
//# sourceMappingURL=testing.js.map