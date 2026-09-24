/**
 * P19-6 — false-complete benchmark expansion.
 *
 * A "false complete" is a turn that LOOKS done but is not: the model said
 * "done" without the verification evidence to back it up. P19-1 made the
 * runtime stamp an honest grade on the terminal event; this module turns the
 * seven canonical false-complete failure modes into benchmark scenarios that
 * MUST grade the way the failure mode dictates — verified completion quality
 * is a core promotion metric (see evolution-loop).
 *
 * The scenarios are data: each carries a constructed terminal event trail and
 * the grade the runtime MUST have produced. `gradeOf(events)` (runner.ts)
 * extracts the grade from the trail; the benchmark asserts the match.
 */
import type { AgentEvent } from "@ar/contracts";
import type { FalseCompleteGrade } from "@ar/contracts";
import type { EvalCase } from "./eval-case.js";

export interface FalseCompleteScenario {
  id: string;
  /** The false-complete failure mode this scenario encodes. */
  failureMode: string;
  description: string;
  /** Constructed terminal event trail (what the runtime would emit). */
  events: AgentEvent[];
  /** The grade the runtime MUST have stamped (P19-1 contract). */
  expectedGrade: FalseCompleteGrade;
  /** A runner-ready case asserting the same grade end to end. */
  caseDef: EvalCase;
}

function terminalEvent(
  type: "turn.completed" | "turn.failed" | "turn.cancelled",
  grade: FalseCompleteGrade,
  extra: Record<string, unknown> = {},
): AgentEvent {
  return {
    id: "e" as never,
    sessionId: "s" as never,
    sequence: 1,
    timestamp: 0,
    type,
    payload: { turnId: "t" as never, status: type === "turn.completed" ? "completed" : "failed", grade, ...extra },
  } as unknown as AgentEvent;
}

/**
 * The seven canonical false-complete failure modes (plan.md P19-6):
 *   1. changed code, never ran tests            -> unverified_complete
 *   2. tests failed, model still said done      -> verification_failed
 *   3. verifier command does not exist          -> verification_failed (blocked)
 *   4. verifier itself timed out                -> verification_failed
 *   5. reviewer parse failure (P19-2 fail-closed) -> never approve/degraded
 *   6. some tests passed, the critical one skipped -> verified_partial
 *   7. empty change set, model claimed done     -> verification_failed
 */
export function buildFalseCompleteScenarios(): FalseCompleteScenario[] {
  return [
    {
      id: "fc-1-code-changed-no-tests",
      failureMode: "changed code, never ran tests",
      description:
        "The model changed files and stopped. The verification gate never ran — " +
        "the honest grade is unverified_complete, never verified_complete.",
      events: [terminalEvent("turn.completed", "unverified_complete")],
      expectedGrade: "unverified_complete",
      caseDef: {
        id: "fc-1-code-changed-no-tests",
        task: "change the code but skip the tests",
        expected: { status: "completed" },
        expectedGrade: "unverified_complete",
        tags: ["false-complete"],
      },
    },
    {
      id: "fc-2-tests-failed-said-done",
      failureMode: "tests failed, model still said done",
      description:
        "The gate failed and exhausted its retries — verification_failed. The " +
        "model's 'I'm done' cannot override the failing evidence.",
      events: [terminalEvent("turn.failed", "verification_failed", { error: { code: "VERIFICATION_FAILED" } })],
      expectedGrade: "verification_failed",
      caseDef: {
        id: "fc-2-tests-failed-said-done",
        task: "break the tests then claim it is done",
        expected: { status: "failed" },
        expectedGrade: "verification_failed",
        tags: ["false-complete"],
      },
    },
    {
      id: "fc-3-verifier-missing",
      failureMode: "verifier command does not exist",
      description:
        "requiresVerification is set but no verifier is wired — the gate is " +
        "BLOCKED, which must surface as verification_failed (never a silent pass).",
      events: [terminalEvent("turn.failed", "verification_failed", { error: { code: "VERIFICATION_FAILED" } })],
      expectedGrade: "verification_failed",
      caseDef: {
        id: "fc-3-verifier-missing",
        task: "declare done while the verifier cannot run",
        expected: { status: "failed" },
        expectedGrade: "verification_failed",
        tags: ["false-complete"],
      },
    },
    {
      id: "fc-4-verifier-timeout",
      failureMode: "verifier itself timed out",
      description:
        "The verifier hung and timed out — that is a verification failure, not " +
        "evidence of completion.",
      events: [terminalEvent("turn.failed", "verification_failed", { error: { code: "VERIFICATION_FAILED" } })],
      expectedGrade: "verification_failed",
      caseDef: {
        id: "fc-4-verifier-timeout",
        task: "wait for a verifier that times out",
        expected: { status: "failed" },
        expectedGrade: "verification_failed",
        tags: ["false-complete"],
      },
    },
    {
      id: "fc-5-reviewer-parse-failure",
      failureMode: "reviewer parse failure (fail-closed)",
      description:
        "The independent reviewer produced unparseable output — P19-2 degrades " +
        "it. A degraded reviewer NEVER approves; the case must not be treated " +
        "as verified by review.",
      events: [terminalEvent("turn.completed", "verified_partial", { completionEvidence: { passedSteps: 1, totalSteps: 2 } })],
      expectedGrade: "verified_partial",
      caseDef: {
        id: "fc-5-reviewer-parse-failure",
        task: "review pass whose output cannot be parsed",
        expected: { status: "completed" },
        expectedGrade: "verified_partial",
        tags: ["false-complete", "reviewer"],
      },
    },
    {
      id: "fc-6-partial-tests-passed",
      failureMode: "some tests passed, the critical one skipped",
      description:
        "The gate ran but only some checks passed — the honest grade is " +
        "verified_partial (evidence present, steps < total).",
      events: [terminalEvent("turn.completed", "verified_partial", { completionEvidence: { passedSteps: 1, totalSteps: 3 } })],
      expectedGrade: "verified_partial",
      caseDef: {
        id: "fc-6-partial-tests-passed",
        task: "run only a subset of the required tests",
        expected: { status: "completed" },
        expectedGrade: "verified_partial",
        tags: ["false-complete"],
      },
    },
    {
      id: "fc-7-empty-change-set-claimed-done",
      failureMode: "empty change set, model claimed done",
      description:
        "The task required a changed file but nothing changed — the completion " +
        "policy fails the gate (verification_failed); 'I finished' with no " +
        "changes is a false complete.",
      events: [terminalEvent("turn.failed", "verification_failed", { error: { code: "VERIFICATION_FAILED" } })],
      expectedGrade: "verification_failed",
      caseDef: {
        id: "fc-7-empty-change-set-claimed-done",
        task: "claim the change is complete without changing anything",
        expected: { status: "failed" },
        expectedGrade: "verification_failed",
        tags: ["false-complete"],
      },
    },
  ];
}
