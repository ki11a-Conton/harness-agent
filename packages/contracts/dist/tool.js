export const DEFAULT_TOOL_CAPABILITY = {
    retry: "unknown",
    concurrencySafe: false,
};
/**
 * Fail-closed semantics for unknown tools (plan.md P0-8): the runtime cannot
 * prove a tool has no side effects, so it must assume effects — never
 * auto-retried, never run in parallel, checkpointed as a side effect, surfaced
 * for reconciliation on crash resume, and gated behind approval by default.
 * Compare: DEFAULT_TOOL_CAPABILITY is the narrower retry/concurrency view;
 * this is the full execution-semantics view.
 */
export const DEFAULT_TOOL_SEMANTICS = {
    readOnly: false,
    idempotent: false,
    retrySafety: "unknown",
    concurrencySafety: false,
    sideEffectScope: "unknown",
    cancellable: false,
    requiresApproval: true,
    networkBehavior: "unknown",
    outputSensitivity: "high",
};
/** P0-8: does this tool's semantics allow treating it as side-effect-free?
 *  "unknown" returns true (may have a side effect) — fail-closed. */
export function mayHaveSideEffect(semantics) {
    return semantics.sideEffectScope !== "none";
}
/** Derives full semantics from the legacy metadata/risk fields, so existing
 *  ToolDefinitions migrate without changes (P1-11 step 1 — no scatter, no
 *  name matching). */
export function toToolSemantics(metadata, risk) {
    let sideEffectScope = "none";
    if (metadata.sideEffect) {
        sideEffectScope = metadata.process
            ? "process"
            : metadata.filesystem
                ? "filesystem"
                : metadata.network
                    ? "network"
                    : "global";
    }
    return {
        readOnly: !metadata.sideEffect,
        idempotent: metadata.retry === "safe",
        retrySafety: metadata.retry ?? DEFAULT_TOOL_SEMANTICS.retrySafety,
        concurrencySafety: metadata.concurrencySafe ?? DEFAULT_TOOL_SEMANTICS.concurrencySafety,
        sideEffectScope,
        cancellable: true,
        requiresApproval: risk === "elevated" || risk === "critical",
        networkBehavior: metadata.network ? "outbound" : "none",
        outputSensitivity: "medium",
    };
}
export const TOOL_ERROR_CODES = [
    "TOOL_SCHEMA_ERROR",
    "PERMISSION_DENIED",
    "APPROVAL_DENIED",
    "SANDBOX_DENIED",
    "PROCESS_ERROR",
    "PROCESS_TIMEOUT",
    "NETWORK_ERROR",
    "RESOURCE_LIMIT",
    "USER_CANCELLED",
    "INTERNAL_ERROR",
];
//# sourceMappingURL=tool.js.map