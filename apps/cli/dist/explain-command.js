export async function explainCmd(opts, events) {
    const lines = [];
    const all = await events.list(opts.sessionId);
    if (all.length === 0) {
        return { exitCode: 1, lines: [`explain: no events for session ${opts.sessionId}`] };
    }
    lines.push(`session: ${opts.sessionId}`);
    lines.push(`events: ${all.length}`);
    const turnStart = all.find((e) => e.type === "turn.started");
    const turnComplete = all.filter((e) => e.type === "turn.completed").at(-1);
    const goalEvent = all.find((e) => e.type === "turn.started");
    if (goalEvent !== undefined) {
        lines.push(`goal: ${String(goalEvent.payload.goal ?? "(turn input)")}`);
    }
    if (turnStart !== undefined) {
        lines.push(`turns started: ${all.filter((e) => e.type === "turn.started").length}`);
    }
    if (turnComplete !== undefined) {
        const reason = turnComplete.payload.terminationReason;
        lines.push(`terminal status: ${String(turnComplete.payload.status ?? "?")}${reason !== undefined ? ` (${reason})` : ""}`);
    }
    // Active plan: the last update_plan tool result.
    const planOutputs = all.filter((e) => e.type === "tool.output" && e.payload.tool === "update_plan");
    const lastPlan = planOutputs.at(-1);
    if (lastPlan !== undefined) {
        lines.push(`active plan: ${String(lastPlan.payload.output ?? "(see tool output)")}`);
    }
    else {
        lines.push("active plan: none recorded");
    }
    // Relevant context sources.
    const discovered = all.filter((e) => e.type === "instruction.discovered");
    if (discovered.length > 0) {
        lines.push(`context sources: ${discovered.map((e) => String(e.payload.path ?? "?")).join(", ")}`);
    }
    else {
        lines.push("context sources: system prompt only");
    }
    // Tool-call focus: either the requested call or the last executed one.
    const toolEvents = all.filter((e) => e.type === "tool.completed" || e.type === "tool.failed");
    const target = opts.toolCallId !== undefined
        ? toolEvents.find((e) => e.payload.toolCallId === opts.toolCallId)
        : toolEvents.at(-1);
    if (target !== undefined) {
        const payload = target.payload;
        lines.push(`--- tool ${payload.toolCallId} (${payload.tool ?? payload.name ?? "?"}) ---`);
        lines.push(`tool semantics: ${payload.tool ?? payload.name ?? "?"} (${target.type === "tool.completed" ? "succeeded" : "failed"})${payload.durationMs !== undefined ? ` in ${payload.durationMs}ms` : ""}`);
        if (target.type === "tool.failed") {
            lines.push(`recovery cause: ${String(payload.error?.info?.message ?? payload.error ?? "?")}`);
        }
    }
    else {
        lines.push("tool calls: none executed");
    }
    // Permission / security results.
    const denied = all.filter((e) => e.type === "security.permission_denied");
    for (const d of denied) {
        lines.push(`permission result: DENIED ${String(d.payload.tool ?? "?")} — ${String(d.payload.error ?? "")}`);
    }
    // Verification evidence (P8-2 step events carry stable refs).
    const steps = all.filter((e) => e.type === "verification.step_completed");
    for (const step of steps) {
        const payload = step.payload;
        lines.push(`verification: ${String(payload.passed === true ? "PASS" : "FAIL")} ${String(payload.ref ?? "?")}${payload.detail !== undefined ? ` — ${payload.detail}` : ""}`);
    }
    return { exitCode: 0, lines };
}
//# sourceMappingURL=explain-command.js.map