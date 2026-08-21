import type { AgentEvent, EventType, ReflectionOutput } from "@ar/contracts";
/** §164 failure attribution categories. */
export type FailureRootCause = "model" | "context" | "tool" | "permission" | "sandbox" | "environment" | "verification";
/** Failure event types the reflector scans (§68). turn.cancelled is not a failure. */
export declare const FAILURE_EVENT_TYPES: ReadonlySet<EventType>;
export interface ReflectDeps {
    events: AgentEvent[];
    taskGoal?: string;
}
/**
 * REFLECTION-001: deterministic (§68) rule-based reflection over an event
 * stream — no LLM. Every failure event is attributed to a §164 root cause,
 * backed by evidence (related event ids + timestamps) and a template lesson,
 * and yields one procedural memory candidate. Aggregation: no failures -> [];
 * failures sharing a root cause (and, for tool failures, the same tool) are
 * deduped into a single output; persistence is left to the §67 write gate
 * (reflection never writes, §181).
 */
export declare class Reflector {
    reflect({ events, taskGoal }: ReflectDeps): ReflectionOutput[];
}
//# sourceMappingURL=reflection.d.ts.map