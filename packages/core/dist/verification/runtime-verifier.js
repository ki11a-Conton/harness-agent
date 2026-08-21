import { AgentError, errorInfo } from "@ar/contracts";
export class RuntimeVerifier {
    verifier;
    constructor(verifier) {
        this.verifier = verifier;
    }
    async verifyTurn(task, sessionId, turnId, store, opts) {
        const maxTranscriptChars = opts.maxTranscriptChars ?? 16_000;
        const messageTruncate = opts.messageTruncate ?? 1_000;
        const messages = await store.listMessages(sessionId);
        const transcript = renderTranscript(messages, { maxChars: maxTranscriptChars, messageTruncate });
        const context = {
            sessionId,
            ...(turnId !== undefined ? { turnId } : {}),
            cwd: opts.cwd,
            changedPaths: opts.changedPaths,
            ...(opts.baselineFiles !== undefined ? { baselineFiles: opts.baselineFiles } : {}),
            transcript,
            runStartedAt: opts.runStartedAt,
        };
        const nowFn = opts.now ?? Date.now;
        const startedAt = nowFn();
        let result;
        let blocked;
        try {
            result = await this.verifier.verify(task, context);
            // TaskVerifier fills startedAt/completedAt itself; fill defaults only
            // when the wrapped verifier omitted them (keeps VS-001 timestamps intact).
            if (!isFinite(result.startedAt))
                result.startedAt = startedAt;
            if (!isFinite(result.completedAt))
                result.completedAt = nowFn();
        }
        catch (err) {
            // Fail closed: the gate is "blocked", never a silent pass.
            const message = err instanceof AgentError ? err.info.message : err instanceof Error ? err.message : String(err);
            blocked = errorInfo("INTERNAL_ERROR", `verifier failed: ${message}`);
            result = {
                level: 0,
                passed: false,
                checks: [
                    {
                        id: "verifier:error",
                        kind: "review",
                        description: "verifier raised an internal error",
                        passed: false,
                        error: blocked,
                    },
                ],
                evidence: [],
                startedAt,
                completedAt: nowFn(),
            };
        }
        if (blocked !== undefined) {
            return { status: "blocked", result, reason: buildReason(result) };
        }
        return { status: result.passed ? "passed" : "failed", result, reason: buildReason(result) };
    }
}
/** One "[role] content" line per message; per-line cap then overall cap. */
function renderTranscript(messages, opts) {
    const parts = [];
    let used = 0;
    for (const m of messages) {
        const line = `[${m.role}] ${truncate(m.content, opts.messageTruncate)}`;
        const separator = used > 0 ? 1 : 0;
        if (used + separator + line.length > opts.maxChars) {
            const remaining = opts.maxChars - used - separator;
            if (remaining > 0)
                parts.push(truncate(line, remaining));
            break;
        }
        used += separator + line.length;
        parts.push(line);
    }
    return parts.join("\n");
}
function truncate(s, max) {
    if (max <= 0)
        return "";
    return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
/** "<description>: <error message>" per failed check; fallback to level. */
function buildReason(result) {
    const failed = result.checks.filter((c) => !c.passed);
    if (failed.length > 0) {
        return failed.map((c) => `${c.description}: ${c.error?.message ?? "check did not pass"}`).join("; ");
    }
    if (result.passed)
        return "all checks passed";
    return `verification failed at level ${result.level} (no failed check detail)`;
}
//# sourceMappingURL=runtime-verifier.js.map