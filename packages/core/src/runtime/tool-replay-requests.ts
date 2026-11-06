import { computeArgsHash, type AgentEvent } from "@ar/contracts";

/** Separate executions from duplicate admission records. Call ids are unique
 * within one frozen step, but a model may reuse them in a later step. Legacy
 * journals without stepId can only deduplicate an identical still-open call. */
export function replayedToolRequests(events: readonly AgentEvent[]): AgentEvent[] {
  type Admission = { stepId: unknown; name: unknown; argsHash: string; settled: boolean };
  const active = new Map<string, Admission>();
  const requests: AgentEvent[] = [];
  for (const event of events) {
    const id = typeof event.payload.toolCallId === "string" ? event.payload.toolCallId : event.id;
    if (event.type === "tool.requested") {
      const { stepId, name } = event.payload;
      const argsHash = computeArgsHash((event.payload.args as Record<string, unknown> | undefined) ?? {});
      const previous = active.get(id);
      const sameStep = typeof stepId === "string" && stepId === previous?.stepId;
      const sameOpenLegacy = stepId === undefined && previous?.stepId === undefined && previous?.settled === false;
      if (previous && previous.name === name && previous.argsHash === argsHash && (sameStep || sameOpenLegacy)) continue;
      requests.push(event);
      active.set(id, { stepId, name, argsHash, settled: false });
    } else if (event.type === "tool.completed" || event.type === "tool.failed") {
      const admission = active.get(id);
      if (admission) admission.settled = true;
    }
  }
  return requests;
}
