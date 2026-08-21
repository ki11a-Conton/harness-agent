/** Return a new skill with the feedback applied (immutable). */
export function recordSkillEffectiveness(skill, feedback, opts = {}) {
    const base = skill.effectiveness ?? emptyEffectiveness();
    const count = (kind) => feedback.kind === kind ? 1 : 0;
    return {
        ...skill,
        effectiveness: {
            ...base,
            selectedCount: base.selectedCount + count("selected"),
            loadedCount: base.loadedCount + count("loaded"),
            injectedCount: base.injectedCount + count("injected"),
            toolCallCount: base.toolCallCount + count("toolCalled"),
            tokenCount: base.tokenCount + (feedback.kind === "tokensUsed" ? feedback.count : 0),
            latencyMs: base.latencyMs + (feedback.kind === "latency" ? feedback.ms : 0),
            completedCount: base.completedCount + count("taskCompleted"),
            failedCount: base.failedCount + count("taskFailed"),
            verificationPassedCount: base.verificationPassedCount + count("verificationPassed"),
            verificationFailedCount: base.verificationFailedCount + count("verificationFailed"),
            lastUsedAt: opts.at ?? Date.now(),
        },
    };
}
/** Neutral starting profile (no feedback yet). */
function emptyEffectiveness() {
    return {
        selectedCount: 0,
        loadedCount: 0,
        injectedCount: 0,
        completedCount: 0,
        failedCount: 0,
        verificationPassedCount: 0,
        verificationFailedCount: 0,
        toolCallCount: 0,
        tokenCount: 0,
        latencyMs: 0,
    };
}
/** Success rate over concluded tasks; undefined when nothing concluded. */
export function successRateOf(skill) {
    const total = (skill.effectiveness?.completedCount ?? 0) + (skill.effectiveness?.failedCount ?? 0);
    if (total === 0)
        return undefined;
    const completed = skill.effectiveness?.completedCount ?? 0;
    return completed / total;
}
/** Average latency per tool call (ms); undefined without tool calls. */
export function averageToolLatencyOf(skill) {
    const calls = skill.effectiveness?.toolCallCount ?? 0;
    if (calls === 0)
        return undefined;
    return (skill.effectiveness?.latencyMs ?? 0) / calls;
}
//# sourceMappingURL=effectiveness.js.map