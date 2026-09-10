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
