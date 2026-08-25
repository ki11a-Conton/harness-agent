/**
 * P19-5 — typed protocol self-heal without hiding corruption.
 *
 * Model/message protocol defects can be REPAIRED when the repair is safe and
 * the evidence is preserved — but an unsafe repair must fail safe, never be
 * papered over as a normal completion.
 *
 * Repair kinds (closed set):
 *   missing_tool_result        a referenced tool call id has no result.
 *   duplicate_tool_call_id     the same call id appears more than once in one
 *                              model turn (executing it twice = double effect).
 *   orphan_tool_result         a tool result exists with no matching call.
 *   malformed_structured_output a call's args are not a valid object / the
 *                              structured output does not parse.
 *   context_overflow           the model/context budget overflowed (recoverable
 *                              only via compaction; never by retry).
 *
 * Every repair emits typed evidence (kind / repaired / before / after /
 * detail) and ONE of two events:
 *   protocol.repaired    the defect was safely repaired (dedupe, drop orphan,
 *                        drop malformed call) and the turn continues.
 *   protocol.repair_failed the defect cannot be safely repaired -> fail-safe
 *                        termination; never a fabricated success.
 */
import type { ToolCall } from "./tool.js";

export type RepairKind =
  | "missing_tool_result"
  | "duplicate_tool_call_id"
  | "orphan_tool_result"
  | "malformed_structured_output"
  | "context_overflow";

/** Exhaustive list of repair kinds; `satisfies` keeps it in lock-step. */
export const REPAIR_KINDS = [
  "missing_tool_result",
  "duplicate_tool_call_id",
  "orphan_tool_result",
  "malformed_structured_output",
  "context_overflow",
] as const satisfies readonly RepairKind[];

export function isRepairKind(value: unknown): value is RepairKind {
  return typeof value === "string" && (REPAIR_KINDS as readonly string[]).includes(value);
}

/** The typed repair decision. `recover` applies a safe fix; `fail_safe`
 *  terminates without faking success. */
export type RepairAction = "recover" | "fail_safe";

export interface RepairEvidence {
  kind: RepairKind;
  /** True when the defect was actually repaired (action === "recover"). */
  repaired: boolean;
  action: RepairAction;
  /** What was observed before the repair (e.g. the duplicated call ids). */
  before?: unknown;
  /** What the state became after the repair. */
  after?: unknown;
  detail: string;
}

export interface ProtocolRepair {
  repairId: string;
  kind: RepairKind;
  action: RepairAction;
  evidence: RepairEvidence;
}

// ---------------------- Pure repair functions -------------------------------

/**
 * P19-5 — detect + repair duplicate tool call ids in one model turn.
 *
 * Executing the same call id twice is a double-effect risk, so the FIRST
 * occurrence wins and later duplicates are dropped. This is a SAFE repair:
 * the transcript retains the dropped ids in the evidence (never silently
 * vanishes). Returns an empty evidence list when there is nothing to repair.
 */
export function repairDuplicateToolCallIds(
  calls: ToolCall[],
  newRepairId: () => string,
): { calls: ToolCall[]; repairs: ProtocolRepair[] } {
  const seen = new Set<string>();
  const kept: ToolCall[] = [];
  const repairs: ProtocolRepair[] = [];
  for (const call of calls) {
    if (seen.has(call.id)) {
      repairs.push({
        repairId: newRepairId(),
        kind: "duplicate_tool_call_id",
        action: "recover",
        evidence: {
          kind: "duplicate_tool_call_id",
          repaired: true,
          action: "recover",
          before: call.id,
          after: undefined,
          detail: `dropped duplicate call id "${call.id}" (${call.name}); the first occurrence executes`,
        },
      });
      continue;
    }
    seen.add(call.id);
    kept.push(call);
  }
  return { calls: kept, repairs };
}

/**
 * P19-5 — detect malformed structured output (calls whose args are not a
 * plain object). A malformed call cannot execute safely: drop it with
 * evidence. If EVERY call is malformed the caller must fail safe (a
 * tool_calls turn with zero executable calls is not completion).
 */
export function repairMalformedToolCalls(
  calls: ToolCall[],
  newRepairId: () => string,
): { calls: ToolCall[]; repairs: ProtocolRepair[] } {
  const kept: ToolCall[] = [];
  const repairs: ProtocolRepair[] = [];
  for (const call of calls) {
    const argsOk =
      typeof call.args === "object" && call.args !== null && !Array.isArray(call.args);
    if (!argsOk) {
      repairs.push({
        repairId: newRepairId(),
        kind: "malformed_structured_output",
        action: "recover",
        evidence: {
          kind: "malformed_structured_output",
          repaired: true,
          action: "recover",
          before: { id: call.id, name: call.name, args: call.args },
          after: undefined,
          detail: `dropped malformed call "${call.name}" (id ${call.id}): args are not a plain object`,
        },
      });
      continue;
    }
    kept.push(call);
  }
  return { calls: kept, repairs };
}

/**
 * P19-5 — decide whether a defect can be safely repaired at all.
 *   duplicate_tool_call_id   -> recover (first wins; dropping a duplicate is
 *                               safe and observable).
 *   malformed_structured_output -> recover (the malformed call is dropped with
 *                               evidence) — but if it leaves ZERO executable
 *                               calls the caller must fail safe.
 *   missing_tool_result / orphan_tool_result -> recover ONLY when the caller
 *                               supplies an `after` (e.g. a synthetic
 *                               "tool unavailable" result or a dropped orphan);
 *                               the evidence is mandatory either way.
 *   context_overflow          -> recover only via compaction (caller handles);
 *                               a bare retry is NEVER a repair.
 */
export function canRepairSafely(
  kind: RepairKind,
  opts: { after?: unknown } = {},
): boolean {
  switch (kind) {
    case "duplicate_tool_call_id":
    case "malformed_structured_output":
      return true;
    case "missing_tool_result":
    case "orphan_tool_result":
      // Recoverable only when the caller can supply the repaired outcome; a
      // repair that cannot name what happened is not a repair.
      return "after" in opts;
    case "context_overflow":
      // Compaction is the only safe repair; a plain retry is not.
      return opts.after !== undefined && typeof opts.after === "object";
  }
}

/** Build a repair record with the given decision. */
export function buildRepair(
  repairId: string,
  kind: RepairKind,
  evidence: Omit<RepairEvidence, "kind">,
): ProtocolRepair {
  return { repairId, kind, action: evidence.action, evidence: { kind, ...evidence } };
}
