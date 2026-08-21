export { HOOK_NAMES, type HookName, type HookContext, type HookFn, type BeforeToolHook, type AfterToolHook, } from "@ar/contracts";
import type { HookContext, HookFn, HookName, ToolCall, ToolResult } from "@ar/contracts";
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
export declare class HookRegistry {
    private handlers;
    private readonly policy;
    private readonly failures;
    private readonly timer;
    private readonly nowFn;
    constructor(policy?: HookPolicy);
    register(hook: HookName, fn: HookFn, opts?: HookOptions): () => void;
    size(): number;
    /** Observability: all failures (throw/timeout) ever recorded, gated first. */
    failureStats(): {
        count: number;
        denied: number;
        swallowed: number;
    };
    private record;
    /** Dispatch observe-style hooks (session_*, after_*, tool_error ...) in order.
     *  A throwing/timing-out handler is swallowed + reported (observe hooks can
     *  never widen security). Handlers run in registration order. */
    dispatch(hook: HookName, ctx: HookContext): Promise<void>;
    /** before_tool — SECURITY GATE. A handler that throws or times out FAILS
     *  CLOSED: the call is denied (null). An explicit null also denies. A
     *  returned ToolCall is the transformed/enriched context threaded onward. */
    beforeTool(ctx: HookContext, call: ToolCall): Promise<ToolCall | null>;
    /** before_permission — SECURITY GATE (may narrow permission, never widen).
     *  Returns true to allow, false to deny. Throwing/timing-out → false. */
    beforePermission(ctx: HookContext): Promise<boolean>;
    /** Observe-style wrappers (after_tool, tool_error) — same fail-open policy
     *  as dispatch: a throwing observer is swallowed + reported. */
    private runObserver;
    afterTool(ctx: HookContext, call: ToolCall, result: ToolResult): Promise<void>;
    toolError(ctx: HookContext, call: ToolCall, result: ToolResult): Promise<void>;
}
/** Stable fingerprint for a hook handler + source (used to record which policy
 *  version deployed a hook). */
export declare function fingerprintHook(fn: HookFn, source?: string): string;
//# sourceMappingURL=hooks.d.ts.map