import type { AgentEvent } from "@ar/contracts";

/** A prior pass cannot certify a later failure or a different turn. */
export function terminalVerificationStatus(events: readonly AgentEvent[]): "PASS" | "FAIL" | "TIMEOUT" | "NOT_RUN" | null {
  if (events.length === 0) return null;
  const turn = events.findLast(event => event.type === "turn.started" || event.type === "turn.completed"
    || event.type === "turn.failed" || event.type === "turn.cancelled")?.turnId;
  const current = turn === undefined ? events : events.filter(event => event.turnId === turn);
  const last = current.findLast(event => event.type === "verification.completed" || event.type === "verification.failed");
  if (last !== undefined) return last.type === "verification.completed" && last.payload.passed === true ? "PASS" : "FAIL";
  return current.some(event => event.type === "turn.cancelled") ? "TIMEOUT" : "NOT_RUN";
}
