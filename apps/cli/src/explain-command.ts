import type { EventStore, SessionId } from "@ar/contracts";

/**
 * P9-3: `agent explain <sessionId> [--tool-call <id>]` — why did the agent do
 * this? Reconstructs the answer ONLY from observable event/state evidence
 * (goal, active plan, context sources, tool semantics, permission result,
 * recovery cause, verification evidence). Never outputs hidden reasoning.
 */

export interface ExplainOptions {
  sessionId: SessionId;
  toolCallId?: string;
}

export async function explainCmd(
  opts: ExplainOptions,
  events: EventStore,
): Promise<{ exitCode: number; lines: string[] }> {
  const lines: string[] = [];
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
    lines.push(`goal: ${String((goalEvent.payload as { goal?: string }).goal ?? "(turn input)")}`);
  }
  if (turnStart !== undefined) {
    lines.push(`turns started: ${all.filter((e) => e.type === "turn.started").length}`);
  }
  if (turnComplete !== undefined) {
    const reason = (turnComplete.payload as { terminationReason?: string }).terminationReason;
    lines.push(`terminal status: ${String((turnComplete.payload as { status?: string }).status ?? "?")}${reason !== undefined ? ` (${reason})` : ""}`);
  }

  // Active plan: the last update_plan tool result.
  const planOutputs = all.filter(
    (e) => e.type === "tool.output" && (e.payload as { tool?: string }).tool === "update_plan",
  );
  const lastPlan = planOutputs.at(-1);
  if (lastPlan !== undefined) {
    lines.push(`active plan: ${String((lastPlan.payload as { output?: string }).output ?? "(see tool output)")}`);
  } else {
    lines.push("active plan: none recorded");
  }

  // Relevant context sources.
  const discovered = all.filter((e) => e.type === "instruction.discovered");
  if (discovered.length > 0) {
    lines.push(`context sources: ${discovered.map((e) => String((e.payload as { path?: string }).path ?? "?")).join(", ")}`);
  } else {
    lines.push("context sources: system prompt only");
  }

  // Tool-call focus: either the requested call or the last executed one.
  const toolEvents = all.filter((e) => e.type === "tool.completed" || e.type === "tool.failed");
  const target =
    opts.toolCallId !== undefined
      ? toolEvents.find((e) => (e.payload as { toolCallId?: string }).toolCallId === opts.toolCallId)
      : toolEvents.at(-1);

  if (target !== undefined) {
    const payload = target.payload as { toolCallId?: string; tool?: string; name?: string; durationMs?: number; error?: unknown };
    lines.push(`--- tool ${payload.toolCallId} (${payload.tool ?? payload.name ?? "?"}) ---`);
    lines.push(`tool semantics: ${payload.tool ?? payload.name ?? "?"} (${target.type === "tool.completed" ? "succeeded" : "failed"})${payload.durationMs !== undefined ? ` in ${payload.durationMs}ms` : ""}`);
    if (target.type === "tool.failed") {
      lines.push(`recovery cause: ${String((payload.error as { info?: { message?: string } })?.info?.message ?? payload.error ?? "?")}`);
    }
  } else {
    lines.push("tool calls: none executed");
  }

  // Permission / security results.
  const denied = all.filter((e) => e.type === "security.permission_denied");
  for (const d of denied) {
    lines.push(`permission result: DENIED ${String((d.payload as { tool?: string }).tool ?? "?")} — ${String((d.payload as { error?: unknown }).error ?? "")}`);
  }

  // Verification evidence (P8-2 step events carry stable refs).
  const steps = all.filter((e) => e.type === "verification.step_completed");
  for (const step of steps) {
    const payload = step.payload as { ref?: string; passed?: boolean; detail?: string };
    lines.push(`verification: ${String(payload.passed === true ? "PASS" : "FAIL")} ${String(payload.ref ?? "?")}${payload.detail !== undefined ? ` — ${payload.detail}` : ""}`);
  }

  return { exitCode: 0, lines };
}
