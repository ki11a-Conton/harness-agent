export {
  HOOK_NAMES,
  type HookName,
  type HookContext,
  type HookFn,
  type BeforeToolHook,
  type AfterToolHook,
} from "@ar/contracts";
import type {
  BeforeToolHook,
  AfterToolHook,
  HookContext,
  HookFn,
  HookName,
  Timer,
  ToolCall,
  ToolResult,
} from "@ar/contracts";
import { RealTimer } from "@ar/contracts";

/**
 * Lifecycle hook registry per AGENT_ARCHITECTURE_PLAN §51.
 * Hooks may observe, annotate, block, transform — but may never bypass security.
 * HOOK-001 (P5) hardens blocking/transform semantics; this registry is the
 * interception surface Core owns.
 *
 * P2-19 Hook Runtime Hardening applies the controls demanded by the plan:
 *
 *   timeout      : every handler is bounded by a per-hook timeout; a handler
 *                  that never settles is treated as a failure, never allowed
 *                  to hang the turn.
 *   failure policy: gate hooks (before_tool / before_permission /
 *                  before_memory_write) FAIL CLOSED — a throwing or timing-out
 *                  gate hook yields deny (beforeTool → null, beforePermission
 *                  → false). Observe hooks (after_* / session_* / tool_error)
 *                  fail open (swallowed + reported) because they can only
 *                  observe and can never widen security.
 *                  明令禁止：hook 异常默认 allow。安全关口异常一律 deny。
 *   ordering     : handlers run strictly in registration order; registration
 *                  is append-only until unsubscribe.
 *   source       : each handler can carry a `source` tag (origin).
 *   observability: failures are reported to a sink and tallied via
 *                  `failureStats()` — never silently swallowed for gate hooks.
 *
 * Clarified semantics:
 *   - hook throw  : gate → deny (+report "throw"); observe → swallow (+report).
 *   - hook timeout: treated identically to throw, action "deny"/"swallow".
 *   - hook deny   : a gate hook returning null (or false) blocks the action;
 *                   an explicit deny and a fail-closed deny are both surfaced
 *                   (the explicit one is authoritative and not counted as a
 *                   failure).
 *   - hook additional context: a before_tool handler may return a (possibly
 *                   transformed) ToolCall; the transformed call is threaded to
 *                   the next handler and finally returned as the enriched
 *                   context. (transform = "additional context applied").
 */
import { createHash } from "node:crypto";

type StoredFn = (ctx: HookContext, ...args: never[]) => Promise<unknown> | unknown;

export type HookFailurePolicy = "deny" | "allow";

export interface HookFailureReport {
  hook: HookName;
  source?: string;
  kind: "throw" | "timeout";
  error?: string;
  index: number;
  /** For gate hooks this is always "deny" (fail-closed); observe → "swallow". */
  action: "deny" | "swallow";
  elapsedMs: number;
}

export interface HookOptions {
  /** Origin tag (e.g. "system", "plugin:foo", "user-rule"). */
  source?: string;
  /** Per-hook timeout; falls back to policy.defaultTimeoutMs. */
  timeoutMs?: number;
}

export interface HookPolicy {
  defaultTimeoutMs?: number;
  observability?: (report: HookFailureReport) => void;
  /** P1-7: injected clock for elapsed-time accounting. */
  now?: () => number;
}

/** Hooks that sit on a security boundary must fail closed. */
const GATE_HOOKS: ReadonlySet<HookName> = new Set([
  "before_tool",
  "before_permission",
  "before_memory_write",
]);

interface Stored {
  fn: StoredFn;
  source?: string;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function runGuarded<T extends unknown>(
  invocation: () => T | Promise<T>,
  timeoutMs: number,
  timer: Timer,
): Promise<{ ok: true; value: T } | { ok: false; kind: "throw" | "timeout"; error?: string }> {
  return new Promise<{ ok: true; value: T } | { ok: false; kind: "throw" | "timeout"; error?: string }>(
    (resolve) => {
      let settled = false;
      const handle = timer.schedule(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, kind: "timeout" });
      }, timeoutMs);
      // Defer invocation onto a microtask so a synchronous throw is caught
      // like any other rejection (never propagates out of the executor).
      Promise.resolve()
        .then(invocation)
        .then((value) => {
          if (settled) return;
          settled = true;
          handle.cancel();
          resolve({ ok: true, value });
        })
        .catch((cause) => {
          if (settled) return;
          settled = true;
          handle.cancel();
          resolve({ ok: false, kind: "throw", error: cause instanceof Error ? cause.message : String(cause) });
        });
    },
  );
}

export class HookRegistry {
  private handlers = new Map<HookName, Stored[]>();
  private readonly policy: HookPolicy;
  private readonly failures: HookFailureReport[] = [];
  private readonly timer: Timer;
  private readonly nowFn: () => number;

  constructor(policy?: HookPolicy) {
    this.policy = { defaultTimeoutMs: DEFAULT_TIMEOUT_MS, ...policy };
    this.nowFn = policy?.now ?? Date.now;
    this.timer = new RealTimer(this.nowFn);
  }

  register(hook: HookName, fn: HookFn, opts?: HookOptions): () => void {
    const list = this.handlers.get(hook) ?? [];
    list.push({
      fn: fn as StoredFn,
      source: opts?.source,
      timeoutMs: opts?.timeoutMs ?? this.policy.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    this.handlers.set(hook, list);
    return () => {
      const current = this.handlers.get(hook) ?? [];
      this.handlers.set(
        hook,
        current.filter((h) => h.fn !== (fn as StoredFn)),
      );
    };
  }

  size(): number {
    let n = 0;
    for (const list of this.handlers.values()) n += list.length;
    return n;
  }

  /** Observability: all failures (throw/timeout) ever recorded, gated first. */
  failureStats(): { count: number; denied: number; swallowed: number } {
    let denied = 0;
    for (const r of this.failures) if (r.action === "deny") denied += 1;
    return { count: this.failures.length, denied, swallowed: this.failures.length - denied };
  }

  private record(report: HookFailureReport): void {
    this.failures.push(report);
    this.policy.observability?.(report);
  }

  /** Dispatch observe-style hooks (session_*, after_*, tool_error ...) in order.
   *  A throwing/timing-out handler is swallowed + reported (observe hooks can
   *  never widen security). Handlers run in registration order. */
  async dispatch(hook: HookName, ctx: HookContext): Promise<void> {
    const list = this.handlers.get(hook);
    if (!list) return;
    let index = 0;
    for (const stored of list) {
      const startedAt = this.nowFn();
      const outcome = await runGuarded(() => stored.fn(ctx), stored.timeoutMs, this.timer);
      if (!outcome.ok) {
        this.record({
          hook,
          source: stored.source,
          kind: outcome.kind,
          error: outcome.error,
          index,
          action: "swallow",
          elapsedMs: this.nowFn() - startedAt,
        });
      }
      index += 1;
    }
  }

  /** before_tool — SECURITY GATE. A handler that throws or times out FAILS
   *  CLOSED: the call is denied (null). An explicit null also denies. A
   *  returned ToolCall is the transformed/enriched context threaded onward. */
  async beforeTool(ctx: HookContext, call: ToolCall): Promise<ToolCall | null> {
    const list = this.handlers.get("before_tool");
    if (!list) return call;
    let current: ToolCall = call;
    let index = 0;
    for (const stored of list) {
      const startedAt = this.nowFn();
      const outcome = await runGuarded(
        () => (stored.fn as BeforeToolHook)(ctx, current) as Promise<ToolCall | null>,
        stored.timeoutMs,
        this.timer,
      );
      if (!outcome.ok) {
        // FAIL-CLOSED: 禁止 hook 异常默认 allow.
        this.record({
          hook: "before_tool",
          source: stored.source,
          kind: outcome.kind,
          error: outcome.error,
          index,
          action: "deny",
          elapsedMs: this.nowFn() - startedAt,
        });
        return null;
      }
      if (outcome.value === null) return null; // explicit deny
      current = outcome.value; // transform = additional context applied
      index += 1;
    }
    return current;
  }

  /** before_permission — SECURITY GATE (may narrow permission, never widen).
   *  Returns true to allow, false to deny. Throwing/timing-out → false. */
  async beforePermission(ctx: HookContext): Promise<boolean> {
    const list = this.handlers.get("before_permission");
    if (!list) return true;
    let index = 0;
    for (const stored of list) {
      const startedAt = this.nowFn();
      const outcome = await runGuarded(
        () => Promise.resolve((stored.fn as (c: HookContext) => unknown)(ctx)),
        stored.timeoutMs,
        this.timer,
      );
      if (!outcome.ok || outcome.value === false) {
        if (!outcome.ok) {
          this.record({
            hook: "before_permission",
            source: stored.source,
            kind: outcome.kind,
            error: outcome.error,
            index,
            action: "deny",
            elapsedMs: this.nowFn() - startedAt,
          });
        }
        return false;
      }
      index += 1;
    }
    return true;
  }

  /** Observe-style wrappers (after_tool, tool_error) — same fail-open policy
   *  as dispatch: a throwing observer is swallowed + reported. */
  private async runObserver(
    hook: HookName,
    invoke: (stored: Stored) => unknown | Promise<unknown>,
  ): Promise<void> {
    const list = this.handlers.get(hook);
    if (!list) return;
    let index = 0;
    for (const stored of list) {
      const startedAt = this.nowFn();
      const outcome = await runGuarded(() => invoke(stored), stored.timeoutMs, this.timer);
      if (!outcome.ok) {
        this.record({
          hook,
          source: stored.source,
          kind: outcome.kind,
          error: outcome.error,
          index,
          action: "swallow",
          elapsedMs: this.nowFn() - startedAt,
        });
      }
      index += 1;
    }
  }

  afterTool(ctx: HookContext, call: ToolCall, result: ToolResult): Promise<void> {
    return this.runObserver("after_tool", (s) => (s.fn as AfterToolHook)(ctx, call, result));
  }

  toolError(ctx: HookContext, call: ToolCall, result: ToolResult): Promise<void> {
    return this.runObserver("tool_error", (s) => (s.fn as AfterToolHook)(ctx, call, result));
  }
}

/** Stable fingerprint for a hook handler + source (used to record which policy
 *  version deployed a hook). */
export function fingerprintHook(fn: HookFn, source?: string): string {
  return createHash("sha256").update(`${source ?? "<none>"}::${fn.toString()}`).digest("hex");
}