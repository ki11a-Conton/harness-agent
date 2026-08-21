/**
 * Lifecycle hook names per AGENT_ARCHITECTURE_PLAN §51 / HOOK-001.
 * Hooks may observe, annotate, block, transform — but may never bypass security:
 * permission evaluation always runs; hooks only narrow (before_tool null blocks)
 * or wrap, never widen.
 */
export const HOOK_NAMES = [
    "session_start",
    "session_end",
    "before_model",
    "after_model",
    "before_tool",
    "after_tool",
    "tool_error",
    "before_permission",
    "after_permission",
    "before_compaction",
    "after_compaction",
    "before_subagent",
    "after_subagent",
    "before_memory_write",
    "after_memory_write",
];
//# sourceMappingURL=hooks.js.map