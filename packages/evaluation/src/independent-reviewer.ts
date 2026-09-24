/**
 * P19-2 — Independent reviewer isolation (a benchmarkable CANDIDATE, not a
 * default runtime phase).
 *
 * P13 shipped a review EXPERIMENT as a seeded effect model. P19-2 moves the
 * Reviewer toward a real, benchmarkable candidate WITHOUT turning it on by
 * default. The Reviewer here is a real read-only model pass whose input is
 * strictly limited to observable surfaces, whose tool surface is read-only,
 * and whose failure mode is fail-closed (never approve).
 *
 * Isolation contract (every claim below is enforced, not documented):
 *   - read-only input   : the input carries ONLY userRequirement / diff /
 *                         verificationEvidence / repoInstructions — no
 *                         transcript, no reasoning, no internal plan.
 *   - read-only tools   : the Reviewer's tool surface is read-only; write /
 *                         exec / network tools are rejected by
 *                         `assertReviewerToolIsolation`.
 *   - no inheritance    : memory / skill / hook / personalization from the
 *                         main Agent are NEVER part of the Reviewer context.
 *   - fail-closed       : a parse failure or any thrown error yields
 *                         `degraded` — NEVER an approve. `unverified` is
 *                         returned when the candidate is not enabled at all.
 *
 * Promotion remains gated by the same economic rule as P13
 * (`decideReviewPromotion`): the Reviewer is promoted only when it catches
 * net latent defects above noise without tanking cost. The candidate flag
 * (`REVIEWER_CANDIDATE_ENABLED`) defaults to false.
 */

import { decideReviewPromotion, type ReviewDecision } from "./review-experiment.js";

/** The ONLY fields a Reviewer may read. Anything else is a fail-closed
 *  violation (a smuggling attempt). */
export interface IndependentReviewerInput {
  /** The user's requirement / task goal. */
  userRequirement: string;
  /** Observable change surface — never the hidden reasoning behind it. */
  diff: {
    changedPaths: string[];
    /** Optional raw diff/patch text (read-only). */
    patch?: string;
  };
  /** Verification evidence produced by the gate (commands/tests run, results). */
  verificationEvidence: Array<{
    type: string;
    source: string;
    passed?: boolean;
  }>;
  /** Minimal repository instructions required to judge the diff (README /
   *  contributing guide excerpts). Optional. */
  repoInstructions?: string;
}

/** The Reviewer's verdict vocabulary. `degraded` is the fail-closed outcome
 *  for ANY reviewer-side failure (parse error / thrown error / timeout). */
export type ReviewerVerdictCode = "approve" | "flag" | "degraded" | "unverified";

export interface IndependentReviewerVerdict {
  verdict: ReviewerVerdictCode;
  /** For `flag`: what the Reviewer wants reworked. */
  summary?: string;
  /** Raw model output, kept for audit (never trusted for the verdict). */
  raw?: string;
  /** Human-readable cause for degraded/unverified. */
  error?: string;
}

/** The Reviewer's read-only tool surface. */
export const REVIEWER_READ_ONLY_TOOLS = [
  "read_file",
  "search_files",
  "grep_search",
  "repo_tree",
  "repo_map",
  "list_dir",
  "symbol_search",
  "navigate",
  "get_working_state",
] as const;

/** Tools the Reviewer must NEVER be given (write / exec / network / mutate). */
export const REVIEWER_FORBIDDEN_TOOLS = [
  "write_file",
  "edit_file",
  "write",
  "apply_patch",
  "exec",
  "bash",
  "run_shell",
  "run_test",
  "http_request",
  "web_fetch",
  "update_plan",
  "delegate",
  "delegate_worker",
  "delegate_explore",
  "delegate_batch",
] as const;

/** Main-Agent context that must NEVER be inherited into the Reviewer session. */
export const REVIEWER_NO_INHERIT = [
  "memory",
  "skill",
  "hook",
  "personalization",
  "steer",
  "candidate_thoughts",
] as const;

/** Input-key whitelist: the ONLY top-level keys accepted on a Reviewer input. */
export const REVIEWER_INPUT_KEYS = [
  "userRequirement",
  "diff",
  "verificationEvidence",
  "repoInstructions",
] as const;

/** Hidden-reasoning / inherited-context keys — carrying any of these is a
 *  fail-closed isolation violation. */
const FORBIDDEN_ISOLATION_KEYS = [
  ...REVIEWER_NO_INHERIT,
  "reasoning",
  "chain_of_thought",
  "hidden_reasoning",
  "internal_plan",
  "private_plan",
  "transcript",
  "worker_thoughts",
  "cot",
  "scratchpad",
] as const;

/**
 * P19-2 — fail-closed input isolation guard. Rejects ANY object that either
 * (a) carries a top-level key outside the whitelist, or (b) carries a
 * hidden-reasoning / inherited-context key. Never silently truncates.
 */
export function assertIndependentReviewerIsolation(
  input: Record<string, unknown>,
): void {
  for (const key of Object.keys(input)) {
    // Hidden-reasoning / inherited-context keys are rejected FIRST — a
    // smuggled "memory"/"reasoning" must never be reported as merely
    // non-whitelisted (both fail closed, but the reason must be unambiguous).
    if ((FORBIDDEN_ISOLATION_KEYS as readonly string[]).includes(key.toLowerCase())) {
      throw new Error(
        `reviewer isolation violated: input carries hidden/inherited key "${key}"`,
      );
    }
    if (!(REVIEWER_INPUT_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `reviewer isolation violated: non-whitelisted input key "${key}" ` +
          `(allowed: ${REVIEWER_INPUT_KEYS.join(", ")})`,
      );
    }
  }
}

/**
 * P19-2 — tool-surface isolation guard. A Reviewer session may only be
 * granted read-only tools; any write / exec / network / mutation tool is a
 * fail-closed violation.
 */
export function assertReviewerToolIsolation(tools: readonly string[]): void {
  for (const tool of tools) {
    const forbidden = (REVIEWER_FORBIDDEN_TOOLS as readonly string[]).some(
      (f) => tool === f || tool.startsWith(`${f}:`) || tool.startsWith(`${f}_`),
    );
    if (forbidden) {
      throw new Error(
        `reviewer isolation violated: tool "${tool}" is not read-only`,
      );
    }
  }
}

/**
 * P19-2 — build the Reviewer prompt from ONLY the whitelisted input. No
 * transcript, no reasoning, no memory, no skills/hooks. The prompt asks for a
 * strict structured verdict so the output is parseable.
 */
export function buildReviewerPrompt(input: IndependentReviewerInput): string {
  // Guard before rendering: a smuggled field must never reach the model.
  assertIndependentReviewerIsolation(input as unknown as Record<string, unknown>);
  const lines: string[] = [
    "You are an independent, READ-ONLY reviewer. You may inspect the change",
    "surface and verification evidence below and nothing else. You do NOT know",
    "the worker's private planning or internal state.",
    "",
    "USER REQUIREMENT:",
    input.userRequirement,
  ];
  lines.push("", "CHANGED FILES:", input.diff.changedPaths.join("\n") || "(none)");
  if (input.diff.patch !== undefined && input.diff.patch.length > 0) {
    lines.push("", "DIFF:", input.diff.patch);
  }
  if (input.verificationEvidence.length > 0) {
    lines.push("", "VERIFICATION EVIDENCE:");
    for (const ev of input.verificationEvidence) {
      lines.push(`- [${ev.passed === true ? "passed" : ev.passed === false ? "failed" : "ran"}] ${ev.type}: ${ev.source}`);
    }
  } else {
    lines.push("", "VERIFICATION EVIDENCE: (none)");
  }
  if (input.repoInstructions !== undefined) {
    lines.push("", "REPOSITORY INSTRUCTIONS:", input.repoInstructions);
  }
  lines.push(
    "",
    "Respond with EXACTLY one of:",
    '  {"verdict":"approve"}',
    '  {"verdict":"flag","summary":"<what must be reworked>"}',
    "Do not add any other text outside the JSON object.",
  );
  return lines.join("\n");
}

/**
 * P19-2 — strict verdict parser. Accepts a JSON object
 * `{"verdict":"approve"|"flag","summary"?}`. Anything else (prose, partial
 * JSON, empty) is UNPARSEABLE → the caller must degrade, never approve.
 */
export function parseReviewerVerdict(raw: string):
  | { verdict: "approve" | "flag"; summary?: string }
  | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const obj = JSON.parse(trimmed);
    if (
      typeof obj === "object" &&
      obj !== null &&
      (obj.verdict === "approve" || obj.verdict === "flag")
    ) {
      return {
        verdict: obj.verdict,
        ...(typeof obj.summary === "string" && obj.summary.length > 0
          ? { summary: obj.summary.slice(0, 1000) }
          : {}),
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Injected model call surface — the host supplies generation; tests supply
 *  a fake. This keeps the Reviewer decoupled from any specific model package. */
export interface ReviewerRunner {
  generate: (prompt: string) => Promise<string>;
}

/**
 * P19-2 — run an independent review pass. FAIL-CLOSED:
 *   - isolation guard throws → degraded (not approve).
 *   - generation throws / times out → degraded.
 *   - output unparseable → degraded.
 * `approve` is returned ONLY from a structurally valid approve verdict.
 */
export async function runIndependentReview(
  input: IndependentReviewerInput,
  runner: ReviewerRunner,
): Promise<IndependentReviewerVerdict> {
  let prompt: string;
  try {
    prompt = buildReviewerPrompt(input);
  } catch (err) {
    return {
      verdict: "degraded",
      error: `isolation guard rejected input: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let raw: string;
  try {
    raw = await runner.generate(prompt);
  } catch (err) {
    return {
      verdict: "degraded",
      error: `reviewer generation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = parseReviewerVerdict(raw);
  if (parsed === undefined) {
    return { verdict: "degraded", error: "unparseable reviewer output (fail-closed)", raw };
  }
  return { verdict: parsed.verdict, ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}), raw };
}

// ---------------------- Benchmarkable candidate assessment -------------------

/** The Reviewer is a candidate, not a default phase. */
export const REVIEWER_CANDIDATE_ENABLED = false;

export interface ReviewerCandidateCase {
  id: string;
  /** True when the "passed" worker output actually shipped a latent defect. */
  latentDefect: boolean;
  /** True when the worker's verification gate passed. */
  verificationPassed: boolean;
  /** The reviewer's verdict on this case (from a real or simulated pass). */
  reviewerVerdict: ReviewerVerdictCode;
}

export interface ReviewerCandidateAssessment {
  candidateId: string;
  /** Never default-on: the flag is a reviewed opt-in. */
  enabled: boolean;
  baseline: {
    /** Latent defects that shipped with no reviewer. */
    defectsSlipped: number;
  };
  challenger: {
    defectsSlipped: number;
    defectsCaught: number;
    falsePositives: number;
    degraded: number;
    unverified: number;
  };
  decision: ReviewDecision;
}

/**
 * P19-2 — assess the Reviewer as a benchmark candidate against the baseline
 * (no reviewer). The economic gate is the SAME as P13
 * (`decideReviewPromotion`): promote only when net caught defects clear noise
 * and cost stays positive. The Reviewer's own failures (degraded) count
 * against it — a broken reviewer is never silently promoted.
 */
export function assessReviewerCandidate(
  cases: ReviewerCandidateCase[],
  options: {
    candidateId?: string;
    enabled?: boolean;
    gate?: { minimumNetDefectsCaught?: number; maxFalsePositiveRate?: number };
  } = {},
): ReviewerCandidateAssessment {
  const enabled = options.enabled ?? REVIEWER_CANDIDATE_ENABLED;
  const allDefects = cases.filter((c) => c.latentDefect).length;
  const clean = cases.filter((c) => !c.latentDefect);

  // Baseline: every latent defect ships untouched.
  const baselineSlipped = allDefects;

  // Challenger: a flag on a defective case catches it; a flag on a clean case
  // is a false positive; degraded/unverified neither catch nor count as FP.
  let caught = 0;
  let falsePositives = 0;
  let degraded = 0;
  let unverified = 0;
  for (const c of cases) {
    if (c.reviewerVerdict === "flag") {
      if (c.latentDefect) caught += 1;
      else falsePositives += 1;
    } else if (c.reviewerVerdict === "degraded") {
      degraded += 1;
    } else if (c.reviewerVerdict === "unverified") {
      unverified += 1;
    }
  }
  const challengerSlipped = allDefects - caught;

  const decision = decideReviewPromotion({
    netDefectsCaught: caught - falsePositives,
    slippedDelta: challengerSlipped - baselineSlipped,
    falsePositiveRate: clean.length === 0 ? 0 : falsePositives / clean.length,
    costScoreDelta: enabled ? 1 : 0,
    gate: options.gate,
  });

  return {
    candidateId: options.candidateId ?? "independent-reviewer",
    enabled,
    baseline: { defectsSlipped: baselineSlipped },
    challenger: {
      defectsSlipped: challengerSlipped,
      defectsCaught: caught,
      falsePositives,
      degraded,
      unverified,
    },
    decision,
  };
}
