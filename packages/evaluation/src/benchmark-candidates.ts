import type { EvalCase, ForbiddenActions } from "./eval-case.js";

/**
 * P3-8 — Auto-generated Benchmark Candidates.
 *
 * A mechanism-CANDIDATE experiment (no main-runtime refactor). An agent may
 * propose new benchmark cases, but plan.md P3-8 forbids a proposal from
 * entering the formal regression suite unchecked:
 *
 *   judge freeze       the candidate is judged by the FROZEN judge version; a
 *                      candidate cannot ship its own judge/expected
 *                      interpretation, and its pinned judgeVersion must match.
 *   fixture sanitize   proposed fixture files are scanned; injection markers,
 *                      secret-like strings, path traversal, and dangerous exec
 *                      commands reject the candidate (fail-closed).
 *   human or deterministic review
 *                      acceptance requires either a deterministic structural
 *                      review OR (when opted in) explicit human approval; a
 *                      pending review never enters regression.
 *
 * Only after all three pass does a proposal become a regression-ready EvalCase.
 * This mirrors the production stance that additions to the benchmark must be
 * frozen-judged and clean, never self-certified by the proposing agent.
 */

export type BenchCandidateSuite = "regression" | "holdout" | "adversarial" | "stress";

/** An agent-proposed benchmark case. Must carry NO judge logic of its own —
 *  only a pinned judgeVersion that must match the frozen judge. */
export interface BenchmarkCandidate {
  /** Id and (separate) proposal id to surface the proposing agent. */
  id: string;
  proposalId: string;
  task: string;
  suite: BenchCandidateSuite;
  /** Proposed fixture files (path → content). Sanitized before acceptance. */
  fixture?: Record<string, string>;
  expected: EvalCase["expected"];
  forbidden?: ForbiddenActions;
  /** Must equal the frozen judge version; a mismatch means the judge isn't
   *  frozen for this candidate (its own interpretation would leak in). */
  judgeVersionPinned: string;
  tags?: string[];
  /** Optional human review ticket id, surfaced for an explicit approval path. */
  reviewTicketId?: string;
}

export type CandidateVerdict = "accepted" | "pending" | "rejected";

export interface CandidateReviewReport {
  verdict: CandidateVerdict;
  /** Why. Empty when accepted. */
  reasons: string[];
  /** The regression-ready case when accepted (judge frozen to `judgeVersion`). */
  case?: EvalCase;
}

// ---------------------- Fixture sanitize (fail-closed) ----------------------

/** Prompt-injection and secret markers that must never appear in a fixture. */
const FIXTURE_BAD_MARKERS = [
  "ignore previous instructions",
  "ignore all prior instructions",
  "you are now",
  "system prompt says",
] as const;

const FIXTURE_SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{12,}/,
  /AKIA[0-9A-Z]{16}/,
  /password\s*[:=]\s*\S+/i,
  /Bearer\s+[A-Za-z0-9._-]{20,}/,
] as const;

/** Path-traversal signals in a fixture path. */
const PATH_TRAVERSAL = ["..", "\\", "@", "\0"] as const;

/** Dangerous exec commands that must never be baked into a fixture. */
const DANGEROUS_EXEC = [
  "rm -rf /",
  "sudo ",
  "> /etc/passwd",
  "chmod 777 /",
  "curl ",
  "wget ",
] as const;

export interface SanitizeResult {
  ok: boolean;
  reason?: string;
}

/** Scan a proposed fixture set. Any unsafe path or content rejects it. */
export function sanitizeFixture(fixture: Record<string, string> | undefined): SanitizeResult {
  if (fixture === undefined || Object.keys(fixture).length === 0) return { ok: true };
  for (const [path, content] of Object.entries(fixture)) {
    for (const token of PATH_TRAVERSAL) {
      if (path.startsWith("/") || path.includes("..") || path.includes(token)) {
        return { ok: false, reason: `unsafe fixture path: ${path}` };
      }
    }
    const lower = content.toLowerCase();
    for (const marker of FIXTURE_BAD_MARKERS) {
      if (lower.includes(marker)) {
        return { ok: false, reason: `injection marker in fixture ${path}` };
      }
    }
    for (const pat of FIXTURE_SECRET_PATTERNS) {
      if (pat.test(content)) {
        return { ok: false, reason: `secret-like content in fixture ${path}` };
      }
    }
    for (const cmd of DANGEROUS_EXEC) {
      if (lower.includes(cmd)) {
        return { ok: false, reason: `dangerous exec in fixture ${path}: ${cmd}` };
      }
    }
  }
  return { ok: true };
}

// ---------------------- Judge freeze ----------------------------------------

/** The candidate is acceptable only if its pinned judge version equals the
 *  frozen judge. A candidate must never carry/interpret its own judge. */
export function assertJudgeFrozen(
  candidate: BenchmarkCandidate,
  frozenJudgeVersion: string,
): { ok: boolean; reason?: string } {
  if (candidate.judgeVersionPinned !== frozenJudgeVersion) {
    return {
      ok: false,
      reason: `judge not frozen: candidate pins ${candidate.judgeVersionPinned}, frozen judge is ${frozenJudgeVersion}`,
    };
  }
  return { ok: true };
}

// ---------------------- Deterministic / human review ------------------------

export interface DeterministicReviewOptions {
  frozenJudgeVersion: string;
  allowedSuites?: readonly BenchCandidateSuite[];
  /** When true, acceptance requires explicit human approval (else pending). */
  requireHuman?: boolean;
}

/** Pure structural review of a candidate. Deterministic — no human needed. */
export function deterministicReview(
  candidate: BenchmarkCandidate,
  options: DeterministicReviewOptions,
): CandidateReviewReport {
  const reasons: string[] = [];
  const allowedSuites = options.allowedSuites ?? ["regression", "holdout", "adversarial", "stress"];

  if (candidate.id.trim() === "") reasons.push("id must be non-empty");
  if (candidate.proposalId.trim() === "") reasons.push("proposalId must be non-empty");
  if (candidate.task.trim() === "") reasons.push("task must be non-empty");
  if (!(allowedSuites as readonly string[]).includes(candidate.suite)) {
    reasons.push(`suite must be one of: ${allowedSuites.join(", ")}`);
  }
  if (candidate.expected.status !== "completed" && candidate.expected.status !== "failed" && candidate.expected.status !== "denied") {
    reasons.push("expected.status must be completed | failed | denied");
  }
  const frozen = assertJudgeFrozen(candidate, options.frozenJudgeVersion);
  if (!frozen.ok) reasons.push(frozen.reason!);
  const sanitized = sanitizeFixture(candidate.fixture);
  if (!sanitized.ok) reasons.push(sanitized.reason!);

  if (reasons.length > 0) return { verdict: "rejected", reasons };

  if (options.requireHuman && !candidate.reviewTicketId) {
    return {
      verdict: "pending",
      reasons: ["human review required but no approval ticket yet"],
    };
  }

  return {
    verdict: "accepted",
    reasons: [],
    case: toCase(candidate, options.frozenJudgeVersion),
  };
}

/** Build the regression-ready EvalCase from an accepted candidate. The judge is
 *  frozen to `judgeVersion`; the candidate carries no judge of its own. */
export function toCase(candidate: BenchmarkCandidate, judgeVersion: string): EvalCase {
  return {
    id: candidate.id,
    task: candidate.task,
    workspace: candidate.fixture ? { fixture: syntheticFixtureLabel(candidate) } : undefined,
    expected: candidate.expected,
    forbidden: candidate.forbidden,
    suite: candidate.suite,
    tags: candidate.tags,
    judgeVersion,
  };
}

function syntheticFixtureLabel(candidate: BenchmarkCandidate): string {
  // Fixture data is carried on the candidate; stamp a stable label here so the
  // case, once accepted, always references the *same* sanitized fixture set.
  return `auto:${candidate.proposalId}`;
}

/**
 * The P3-8 acceptance gate. An agent's proposed case becomes a regression-ready
 * EvalCase ONLY after: judge is frozen, fixture is sanitized, and the review is
 * either deterministic-passing or explicitly human-approved. Safety (judge
 * freeze + fixture sanitize + structure) is ALWAYS enforced and can never be
 * waived by human approval — a human only decides whether a *structurally safe*
 * proposal needs an explicit authorization ticket before admission.
 */
export function reviewBenchmarkCandidate(
  candidate: BenchmarkCandidate,
  options: DeterministicReviewOptions & { humanApproved?: boolean } = {
    frozenJudgeVersion: "1.0.0",
  },
): CandidateReviewReport {
  // Safety + structure are non-negotiable: they run first and are never
  // overridden by a human flag. `requireHuman` is deliberately left out here.
  const base = deterministicReview(candidate, { ...options, requireHuman: false });
  if (base.verdict === "rejected") return base;

  if (options.requireHuman === true && options.humanApproved !== true) {
    return {
      verdict: "pending",
      reasons: ["awaiting explicit human approval"],
    };
  }
  return base;
}