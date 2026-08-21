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
/** Production adapter over `setTimeout`/`clearTimeout`. */
export class RealTimer {
    nowFn;
    constructor(now = Date.now) {
        this.nowFn = now;
    }
    now() {
        return this.nowFn();
    }
    schedule(fn, delayMs) {
        const id = setTimeout(fn, Math.max(0, delayMs));
        let cancelled = false;
        return {
            cancel: () => {
                if (!cancelled) {
                    cancelled = true;
                    clearTimeout(id);
                }
            },
        };
    }
}
/**
 * Deterministic virtual-clock timer for tests. Nothing fires until you call
 * {@link advance} / {@link tick}; this replaces `await new Promise((r) =>
 * setTimeout(r, X))` with instant, reproducible progress regardless of machine
 * load.
 */
export class ManualTimer {
    clock = 0;
    nextId = 1;
    pending = [];
    now() {
        return this.clock;
    }
    schedule(fn, delayMs) {
        const entry = {
            id: this.nextId++,
            at: this.clock + Math.max(0, delayMs),
            fn,
            cancelled: false,
        };
        this.pending.push(entry);
        return {
            cancel: () => {
                entry.cancelled = true;
            },
        };
    }
    /**
     * Advance the clock by `ms` and fire every callback whose deadline lands
     * within `[oldNow, oldNow + ms]`, in deterministic scheduling order
     * (deadline, then schedule id). Callbacks scheduled by a firing callback are
     * also processed when they fall inside the same window.
     */
    advance(ms) {
        const target = this.clock + Math.max(0, ms);
        for (;;) {
            const due = this.pending
                .filter((e) => !e.cancelled && e.at <= target)
                .sort((a, b) => a.at - b.at || a.id - b.id);
            if (due.length === 0)
                break;
            // Jump the clock only as far as the soonest due deadline.
            this.clock = Math.max(this.clock, due[0].at);
            for (const e of due) {
                if (e.cancelled)
                    continue;
                e.cancelled = true;
                this.pending = this.pending.filter((p) => p !== e);
                e.fn();
            }
        }
        this.clock = target;
    }
    /** Fire callbacks due at the current instant (a zero-duration advance). */
    tick() {
        this.advance(0);
    }
    /** Number of still-pending, non-cancelled callbacks (for leak assertions). */
    pendingCount() {
        return this.pending.filter((e) => !e.cancelled).length;
    }
}
/**
 * The single sleep primitive. Resolves after `delayMs` on the injected timer,
 * or immediately when the signal is already cached, or as soon as it aborts.
 * Never keeps the process alive on its own and always detaches the abort
 * listener when the timer wins the race.
 */
export async function sleep(timer, delayMs, signal) {
    if (delayMs <= 0 || signal?.aborted)
        return;
    let timerHandle;
    let removeAbort;
    try {
        await new Promise((resolve) => {
            timerHandle = timer.schedule(resolve, delayMs);
            if (signal !== undefined) {
                const onAbort = () => {
                    timerHandle?.cancel();
                    resolve();
                };
                signal.addEventListener("abort", onAbort, { once: true });
                removeAbort = () => signal.removeEventListener("abort", onAbort);
            }
        });
    }
    finally {
        removeAbort?.();
    }
}
//# sourceMappingURL=timer.js.map