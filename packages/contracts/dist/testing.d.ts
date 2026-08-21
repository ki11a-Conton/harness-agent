/**
 * Q-9 — Shared Test Fixture Builders.
 *
 * One home for the fixtures every package's tests reach for, so the same event
 * / session / turn shapes stop being hand-rolled (and subtly diverging) in each
 * `*.test.ts`. Everything here is DETERMINISTIC: ids are derived from a small
 * integer `n` (or an injected `makeSeed()` counter) and timestamps from an
 * injected clock, so:
 *
 *   - event snapshots are stable and re-runnable (no `Date.now()` flake);
 *   - a test can assert exact payload cross-sections without random drift;
 *   - a parent can call `makeSeed()` once and hand each child a fresh monotone
 *     id sequence that never collides.
 *
 * These builders live in `@ar/contracts` (the package every other package can
 * import) and construct only the pure data-layer shapes. Higher-level builders
 * (makeRuntime / makeTool / makeAgent) belong to the packages that own those
 * types, since `contracts` must not depend on tools/core/agents — a per-package
 * surface is documented in each owning package's `@ar/*` testing entry.
 */
import type { AgentEvent } from "./event.js";
import type { EventId, SessionId, TurnId } from "./ids.js";
import type { Session, SessionStatus, Turn, TurnStatus } from "./session.js";
import type { UserMessage } from "./message.js";
import type { AgentId } from "./ids.js";
/** Injected, deterministic sources of ids + the clock. */
export interface FixtureSeed {
    ids: () => number;
    now: () => number;
}
/** A fresh monotone seed with a fixed clock. Give each fixture its own. */
export declare function makeSeed(): FixtureSeed;
export declare function makeSessionId(n: number): SessionId;
export declare function makeTurnId(n: number): TurnId;
export declare function makeEventId(n: number): EventId;
export declare function makeAgentId(n: number): AgentId;
/** An agent-fixture id; give a small `n` to pin the value. */
export declare function fixtureAgentId(n?: number): AgentId;
export interface MakeSessionOverrides extends Partial<Omit<Session, "id">> {
    id?: SessionId;
    n?: number;
    status?: SessionStatus;
}
/** Deterministic minimal Session with sensible defaults. */
export declare function makeSession(over?: MakeSessionOverrides): Session;
export interface MakeTurnOverrides extends Partial<Omit<Turn, "sessionId" | "input">> {
    sessionId?: SessionId;
    input?: UserMessage;
    n?: number;
    status?: TurnStatus;
}
/** Deterministic minimal Turn. input is a nominal message by default. */
export declare function makeTurn(over?: MakeTurnOverrides): Turn;
export interface MakeEventOverrides extends Partial<Omit<AgentEvent, "type">> {
    payload?: Record<string, unknown>;
    type?: AgentEvent["type"];
    n?: number;
    seed?: FixtureSeed;
}
/**
 * Deterministic AgentEvent. Default sequence is 0 (the store under test owns
 * sequencing); pass `sequence` as needed. Id + timestamp come from `n` or the
 * injected seed clock so snapshots are stable across runs.
 */
export declare function makeEvent(over?: MakeEventOverrides): AgentEvent;
//# sourceMappingURL=testing.d.ts.map