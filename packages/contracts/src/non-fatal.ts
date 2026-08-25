import type { EventSink } from "./event.js";
import type { SessionId, TurnId } from "./ids.js";

/** P14-6: typed node error-code check — lets a catch only be silent for a
 *  SPECIFIC expected code (e.g. ENOENT on first run) and rethrow anything
 *  else, so the catch is never a blanket swallow. */
export function isNodeErrorCode(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === code
  );
}

/** P14-6: report a non-fatal failure to stderr synchronously (the universal
 *  observable channel; never async, never lost). Equivalent to
 *  `stderrErrorSink().report(context, err)` — the shorthand for catch blocks
 *  that must keep running but must not be silent. */
export function reportDegraded(context: string, err: unknown): void {
  stderrErrorSink().report(context, err);
}

/**
 * P14-6 — typed channel for non-fatal / degraded failures.
 *
 * A best-effort subsystem (event emission, background persistence, cleanup,
 * telemetry) must never break the run — but its failures must NEVER be silent
 * either. `NonFatalErrorSink` is the one place a subsystem reports such a
 * failure: the report is observable by the host (event stream, stderr, test
 * assertions) and carries the failing context and reason.
 *
 * Security gates, state persistence, checkpoint, approval, memory write and
 * capability composition must NOT use this channel for their denials — those
 * remain typed, fail-closed errors/events. This channel is only for work whose
 * failure does not change the security conclusion.
 */
export interface NonFatalErrorSink {
  report(context: string, error: unknown, meta?: Record<string, unknown>): void;
}

/** A sink that drops reports — the explicit opt-out for hosts that do not
 *  want degradation noise. Choosing it is a conscious decision; the default
 *  in runtime paths is {@link stderrErrorSink} so reports stay observable. */
export const NOOP_ERROR_SINK: NonFatalErrorSink = { report: () => {} };

/** Report to stderr synchronously (never lost, never async). */
export function stderrErrorSink(label = "degraded"): NonFatalErrorSink {
  return {
    report(context, error, meta) {
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[${label}] ${context}: ${reason}${meta !== undefined && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : ""}\n`,
      );
    },
  };
}

/** Report as a typed `runtime.degraded` event with a synchronous stderr
 *  fallback — the report survives even when the event write fails. */
export function degradedEventSink(
  events: EventSink,
  sessionId: SessionId,
  opts?: { turnId?: TurnId; now?: () => number },
): NonFatalErrorSink {
  return {
    report(context, error, meta) {
      const reason = error instanceof Error ? error.message : String(error);
      // Synchronous stderr first: the event write below may itself fail, and
      // a second failure must never erase the first report.
      process.stderr.write(`[degraded] ${context}: ${reason}\n`);
      void events
        .emit(
          sessionId,
          "runtime.degraded",
          {
            context,
            reason,
            ...(meta !== undefined ? meta : {}),
          },
          opts?.turnId,
        )
        .catch((emitErr) => {
          process.stderr.write(
            `[degraded] event emit failed for ${context}: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}\n`,
          );
        });
    },
  };
}
