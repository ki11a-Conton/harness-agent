/**
 * E4-R16 (N12) — shared, VERSIONED candidate mechanism definitions.
 *
 * Both sides of the promotion contract must consume the SAME strategy text:
 *
 *   - the BENCHMARK runner (what is EVALUATED) appends this guidance to the
 *     system prompt when budget_aware_completion_v1 is active;
 *   - the CHAMPION APPLICATION (what is INSTALLED at startup) installs this
 *     same text as `completionGuidance`.
 *
 * Before E4-R16 these were two DIFFERENT constants (a startup-side rewrite with
 * "similar meaning" but not the evaluated text), and the candidate registry's
 * prompt-additions digest was a static string that did not bind the real
 * implementation. Core never imports CLI constants, so the definition lives
 * HERE (the strategy layer) and the CLI imports it. Changing the text changes
 * `budgetAwareCompletionGuidanceDigest()` — which flows into the arm digest,
 * the R13 execution identity and the R15 promotion target — so an old
 * evaluation can never authorize a rewritten strategy under the same
 * candidateId.
 */

import { createHash } from "node:crypto";

/** Version identity of the budget-aware completion strategy implementation. */
export const BUDGET_AWARE_COMPLETION_GUIDANCE_VERSION = "budget-aware-completion:v1";

/** The SINGLE authoritative strategy text (what the benchmark evaluated). */
export const BUDGET_AWARE_COMPLETION_GUIDANCE_V1 = [
  "",
  "Budget-aware completion guidance:",
  "- You have a limited number of iterations per turn (typically 30 tool calls).",
  "- When you are close to this limit and have made meaningful progress, prioritize",
  "  running the verification command and confirming the task is complete.",
  "- Avoid spending remaining budget on speculative work when verification would pass.",
  "- If verification fails, you may still have budget to iterate; use it.",
  "- If you are not close to the budget, proceed normally.",
].join("\n");

/** sha256 over the ACTUAL strategy text — the mechanism implementation digest.
 *  A text edit changes this digest, and with it the arm digest, the execution
 *  identity and the promotion target (E4-R16 N12). */
export function budgetAwareCompletionGuidanceDigest(): string {
  return createHash("sha256").update(BUDGET_AWARE_COMPLETION_GUIDANCE_V1, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// N5 (agent_limit cluster) — tool-call efficiency strategy.
//
// Evidence (docs/E4-R99-R101-report.md §10.4): the largest real failure cluster is
// `agent_limit` (27/59), where every failing case hits the 30-model-call cap with
// a high number of FAILED tool calls (reg-08 tool_failures=14, reg-06/reg-02=12,
// ho-02=11, ho-10=9, stress-huge-logs=9). The iterations are consumed retrying
// tools that fail rather than making progress, so the task never converges.
//
// This is a DIFFERENT mechanism from budget_aware_completion_v1 (which was tried
// and REJECTED — netDelta 0): that one changed HOW the agent spends its last
// iterations (converge + verify); this one attacks WHY the iterations are wasted
// in the first place (redundant / repeating failing tool calls).
// ---------------------------------------------------------------------------

/** Version identity of the tool-call efficiency strategy implementation. */
export const TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION = "tool-call-efficiency:v1";

/** The SINGLE authoritative strategy text for tool_call_efficiency_v1. */
export const TOOL_CALL_EFFICIENCY_GUIDANCE_V1 = [
  "",
  "Tool-call efficiency guidance:",
  "- You have a limited number of iterations per turn (typically 30 model calls),",
  "  and every tool call you issue spends one.",
  "- Never repeat a tool call that just failed with the same arguments. Change the",
  "  arguments, or change the approach.",
  "- If the same tool fails twice, stop retrying it. Switch to a different tool or",
  "  a different plan instead of issuing a third attempt.",
  "- Read every file you need in as few calls as possible, and do not re-read a",
  "  file you have already read unless it changed.",
  "- Make each edit complete before moving on, so the verification command you run",
  "  near the end reflects finished work rather than a half-applied change.",
].join("\n");

/** sha256 over the ACTUAL tool-call efficiency strategy text — binds the arm
 *  digest, the execution identity and the promotion target to the real text. */
export function toolCallEfficiencyGuidanceDigest(): string {
  return createHash("sha256").update(TOOL_CALL_EFFICIENCY_GUIDANCE_V1, "utf8").digest("hex");
}
