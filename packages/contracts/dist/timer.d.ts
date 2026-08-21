/**
 * Q-7 — testable timer / sleeper abstraction.
 *
 * Every timeout/backoff in the runtime goes through the `Timer` interface
 * instead of `setTimeout` / `Date` directly, so tests can inject a `ManualTimer`
 * that drives a *virtual* clock — no real wall-clock waiting, no flaky sleeps.
 *
 * Two implementations share the same interface:
 *   - `RealTimer`   : thin adapter over `setTimeout`/`clearTimeout`, with an
 *                     injectable `now()` so production backoff shares the same
 *                     injected clock the runtime already uses for `deps.now`.
 *   - `ManualTimer` : deterministic virtual clock for tests. `advance(ms)` moves
 *                     time and fires every due callback in scheduling order;
 *                     `tick()` fires callbacks due at the current instant; a
 *                     `sleep()` only resolves once the clock is advanced past it.
 *
 * The async `sleep(timer, ms, signal)` helper is the single sleep primitive:
 * it races the timer against cancellation and never leaks a listener.
 */
/** Opaque handle returned by {@link Timer.schedule}; cancels a pending callback. */
export interface TimerHandle {
    cancel(): void;
}
/** Abstraction over "run this later" — the unit every timeout/backoff uses. */
export interface Timer {
    /** Current time in ms since an arbitrary epoch (matches the injected clock). */
    now(): number;
    /** Run `fn` after `delayMs`. Returns a handle that cancels it before it fires. */
    schedule(fn: () => void, delayMs: number): TimerHandle;
}
/** Production adapter over `setTimeout`/`clearTimeout`. */
export declare class RealTimer implements Timer {
    private readonly nowFn;
    constructor(now?: () => number);
    now(): number;
    schedule(fn: () => void, delayMs: number): TimerHandle;
}
/**
 * Deterministic virtual-clock timer for tests. Nothing fires until you call
 * {@link advance} / {@link tick}; this replaces `await new Promise((r) =>
 * setTimeout(r, X))` with instant, reproducible progress regardless of machine
 * load.
 */
export declare class ManualTimer implements Timer {
    private clock;
    private nextId;
    private pending;
    now(): number;
    schedule(fn: () => void, delayMs: number): TimerHandle;
    /**
     * Advance the clock by `ms` and fire every callback whose deadline lands
     * within `[oldNow, oldNow + ms]`, in deterministic scheduling order
     * (deadline, then schedule id). Callbacks scheduled by a firing callback are
     * also processed when they fall inside the same window.
     */
    advance(ms: number): void;
    /** Fire callbacks due at the current instant (a zero-duration advance). */
    tick(): void;
    /** Number of still-pending, non-cancelled callbacks (for leak assertions). */
    pendingCount(): number;
}
/**
 * The single sleep primitive. Resolves after `delayMs` on the injected timer,
 * or immediately when the signal is already cached, or as soon as it aborts.
 * Never keeps the process alive on its own and always detaches the abort
 * listener when the timer wins the race.
 */
export declare function sleep(timer: Timer, delayMs: number, signal?: AbortSignal): Promise<void>;
//# sourceMappingURL=timer.d.ts.map