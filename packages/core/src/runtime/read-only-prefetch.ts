import type { Timer, TimerHandle } from "@ar/contracts";

export type PrefetchResult<T> =
  | { status: "ready"; value: T }
  | { status: "cancelled" | "deadline" | "timeout" | "busy" | "rejected" };

/** Stop waiting for optional, read-only preparation. The real promise retains
 * its slot until settlement, even when its provider ignores cancellation.
 * Never use this boundary to settle writes or a durability fence early. */
export class ReadOnlyPrefetch {
  private pending = false;

  constructor(private readonly timer: Timer, private readonly now: () => number) {}

  run<T>(load: (signal: AbortSignal) => Promise<T>, options: {
    signal: AbortSignal;
    deadline?: number;
    timeoutMs?: number;
  }): Promise<PrefetchResult<T>> {
    const { signal, deadline } = options;
    if (signal.aborted) return Promise.resolve({ status: "cancelled" });
    if (deadline !== undefined && this.now() >= deadline) return Promise.resolve({ status: "deadline" });
    if (this.pending) return Promise.resolve({ status: "busy" });
    const timeoutAt = options.timeoutMs === undefined ? undefined : this.now() + Math.max(0, options.timeoutMs);
    if (timeoutAt !== undefined && this.now() >= timeoutAt) return Promise.resolve({ status: "timeout" });

    return new Promise<PrefetchResult<T>>((resolve) => {
      const controller = new AbortController();
      const handles: TimerHandle[] = [];
      let settled = false;
      const finish = (result: PrefetchResult<T>) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        for (const handle of handles) handle.cancel();
        if (result.status !== "ready") controller.abort();
        resolve(result);
      };
      const onAbort = () => finish({ status: "cancelled" });
      const expired = (): "cancelled" | "deadline" | "timeout" | undefined => {
        if (signal.aborted) return "cancelled";
        if (deadline !== undefined && this.now() >= deadline) return "deadline";
        if (timeoutAt !== undefined && this.now() >= timeoutAt) return "timeout";
        return undefined;
      };
      const schedule = (at: number) => {
        // Node timers have a 32-bit delay. Recheck the injected clock after a
        // bounded interval instead of overflowing a distant turn deadline.
        handles.push(this.timer.schedule(() => {
          if (settled) return;
          const status = expired();
          if (status !== undefined) finish({ status }); else schedule(at);
        }, Math.min(2_147_483_647, Math.max(0, at - this.now()))));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (deadline !== undefined) schedule(deadline);
      if (timeoutAt !== undefined) schedule(timeoutAt);
      this.pending = true;
      let source: Promise<T>;
      try { source = Promise.resolve(load(controller.signal)); }
      catch (cause) { source = Promise.reject(cause); }
      // Both handlers remain attached after the host stops waiting. A late
      // result cannot touch turn state; a late rejection is still observed.
      void source.then((value) => {
        this.pending = false;
        const status = expired();
        finish(status === undefined ? { status: "ready", value } : { status });
      }, () => {
        this.pending = false;
        finish({ status: expired() ?? "rejected" });
      });
    });
  }
}
