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
export declare function explainCmd(opts: ExplainOptions, events: EventStore): Promise<{
    exitCode: number;
    lines: string[];
}>;
//# sourceMappingURL=explain-command.d.ts.map