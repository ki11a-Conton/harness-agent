/**
 * Canonical tool-name accessor. Prefers the canonical `tool` field, then the
 * legacy `name` alias (pre-Q-4 producers / older stored logs). Every evaluator
 * should use this instead of guessing which field a producer emitted.
 */
export function toolNameOf(payload) {
    const record = payload;
    const t = record.tool;
    if (typeof t === "string" && t !== "")
        return t;
    const n = record.name;
    return typeof n === "string" && n !== "" ? n : undefined;
}
/**
 * Static guarantee that every event type in EVENT_TYPES has a declared payload
 * shape. Kept as a value so dropping/renaming a type above surfaces here.
 */
export const EVENT_PAYLOAD_TYPES = {
    "tool.requested": true,
    "tool.permission_requested": true,
    "tool.permission_resolved": true,
    "tool.started": true,
    "tool.output": true,
    "tool.completed": true,
    "tool.failed": true,
    "model.completed": true,
    "model.retry": true,
    "verification.completed": true,
    "verification.failed": true,
    "context.compacted": true,
    "run.limit_reached": true,
    "turn.completed": true,
    "approval.resolved": true,
    "security.network_denied": true,
    "security.injection_denied": true,
    "security.permission_denied": true,
    "security.filesystem_denied": true,
    "security.process_denied": true,
    "security.secret_redacted": true,
    "security.memory_denied": true,
    "security.skill_denied": true,
    "security.mcp_denied": true,
    "security.approval_denied": true,
};
//# sourceMappingURL=event-payloads.js.map