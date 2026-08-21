export async function recoverListCmd(deps) {
    const lines = [];
    const scan = {
        unfinishedSessions: [],
        pendingApprovals: [],
        pendingAsks: [],
        orphanChildren: [],
        unfinishedCheckpoints: 0,
    };
    const sessions = await deps.store.listSessions();
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const active = sessions.filter((s) => s.status === "active");
    // "Unfinished": active sessions with no completed/failed terminal turn.
    for (const session of active) {
        const turns = await deps.store.listTurns(session.id);
        const terminal = turns.some((t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled");
        if (!terminal) {
            scan.unfinishedSessions.push({
                sessionId: session.id,
                status: session.status,
                updatedAt: session.updatedAt,
                ...(session.parentId !== undefined ? { parentId: session.parentId } : {}),
            });
        }
    }
    // Orphan children: parent gone or parent never terminal-completed.
    for (const session of sessions) {
        if (session.parentId === undefined)
            continue;
        const parent = byId.get(session.parentId);
        if (parent === undefined) {
            scan.orphanChildren.push({ sessionId: session.id, parentId: session.parentId });
        }
    }
    if (deps.approvalStore !== undefined) {
        scan.pendingApprovals = deps.approvalStore.listPending().map((request) => ({
            approvalId: request.id,
            ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
            action: request.action ?? "approval",
            ...(request.createdAt !== undefined ? { createdAt: request.createdAt } : {}),
        }));
    }
    if (deps.askUserStore !== undefined) {
        for (const session of sessions) {
            const pending = await deps.askUserStore.listPending(session.id);
            scan.pendingAsks.push(...pending.map((ask) => ({
                askId: ask.id,
                sessionId: ask.sessionId,
                question: ask.question,
                createdAt: ask.createdAt,
            })));
        }
    }
    lines.push("recovery scan (no side effects — review and act manually):");
    lines.push(`  unfinished sessions: ${scan.unfinishedSessions.length}`);
    for (const s of scan.unfinishedSessions) {
        lines.push(`    - ${s.sessionId}${s.parentId !== undefined ? ` (child of ${s.parentId})` : ""} (updated ${new Date(s.updatedAt).toISOString()})`);
    }
    lines.push(`  pending approvals: ${scan.pendingApprovals.length}`);
    lines.push(`  pending asks: ${scan.pendingAsks.length}`);
    for (const ask of scan.pendingAsks.slice(0, 5)) {
        lines.push(`    - ${ask.askId}: ${ask.question.slice(0, 60)}`);
    }
    lines.push(`  orphan child sessions: ${scan.orphanChildren.length}`);
    for (const orphan of scan.orphanChildren.slice(0, 5)) {
        lines.push(`    - ${orphan.sessionId} (parent ${orphan.parentId} missing)`);
    }
    return { exitCode: scan.unfinishedSessions.length > 0 ? 1 : 0, lines, scan };
}
//# sourceMappingURL=recover-command.js.map