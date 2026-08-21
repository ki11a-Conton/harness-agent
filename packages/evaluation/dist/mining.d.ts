import type { VerificationSpec } from "@ar/contracts";
import type { ForbiddenActions, EvalSuite } from "./eval-case.js";
import type { EvalStatus, FailureCategory } from "./runner.js";
/**
 * P2-11 Case Mining from Real Failures.
 *
 * A human-confirmed production-like failure may become a benchmark regression
 * case through a fixed pipeline:
 *
 *   production-like failure → sanitize → minimize fixture → create regression
 *   case → freeze judge
 *
 * Sanitization removes secrets, minimization shrinks the fixture to what the
 * task actually references, case-creation turns the result into an EvalCase
 * shape, and judge-fixing pins the judge version on the frozen case.
 *
 * Hard invariants (the plan forbids auto-saving a secret-bearing real
 * workspace as a benchmark as-is):
 *  - mineCandidate() throws when the failure is not `humanConfirmed`.
 *  - mineCandidate() throws when any secret survives redaction (including
 *    caller-supplied project-specific secret patterns) — a candidate must
 *    never embed a live credential.
 *  - freezeCase() throws when the fixture is still over the byte budget — a
 *    case whose fixture cannot be deterministically made small would fail
 *    inconsistent/guessing judges, so it is refused rather than truncated.
 *
 * Minimization only ever drops whole files (empty, duplicate, over-budget
 * trims); it never edits file contents beyond secret redaction, so it never
 * fabricates a reproduction.
 */
/** A real production-like failure waiting to be mined into a candidate case. */
export interface CapturedFailure {
    /** Unique source identifier (run id, incident ticket, …). */
    id: string;
    /** Raw request text that led to the failure (may contain secrets). */
    task: string;
    /** Real workspace snapshot: relative path → UTF-8 content (may contain secrets). */
    fixture: Record<string, string>;
    outcome?: {
        status: EvalStatus;
        terminationReason?: string;
        violations?: string[];
        failureCategory?: FailureCategory;
    };
    /** Hard gate: only human-confirmed failures may become benchmark cases. */
    humanConfirmed: boolean;
    /** Free-form classification tags (used for the default expected status). */
    tags?: string[];
}
export interface SanitizeReport {
    /** Every location that held a secret before redaction ("task" or a file path). */
    locations: string[];
    /** Secret family names detected across the failure (e.g. "openai-key"). */
    secretTypes: string[];
    /** Total secret spans replaced by redaction. */
    redactedSpans: number;
    /** Files removed entirely because they were pure secret material (a key
     *  file, a .env full of credentials) — the whole file, never a truncation. */
    fullyRemovedFiles: string[];
    /** Whether any secret matched before redaction. */
    sawSecret: boolean;
    /** Secret families that survive redaction (standard + custom patterns).
     *  Non-empty ⇒ mineCandidate() must refuse to build a candidate. */
    remainingSecret: string[];
}
export interface DropReason {
    path: string;
    reason: "empty-file" | "duplicate" | "over-budget-trim";
    /** For over-budget-trim: the size of the dropped file. */
    size?: number;
}
export interface MinimizeReport {
    inputFiles: number;
    outputFiles: number;
    inputBytes: number;
    outputBytes: number;
    maxBytes: number;
    dropped: DropReason[];
    /** True when the fixture is still over budget after deterministic trims —
     *  freezeCase() refuses so the case cannot be judged on a truncated fixture. */
    overBudget: boolean;
}
export interface CaseProvenance {
    sourceFailureId: string;
    minedAt: string;
    humanConfirmed: boolean;
    sourceStatus: EvalStatus | undefined;
    sanitization: SanitizeReport;
    minimization: MinimizeReport;
}
/** A mined, sanitized, minimized — but not yet frozen — regression candidate. */
export interface CandidateBenchmarkCase {
    id: string;
    suite: EvalSuite;
    task: string;
    fixture: Record<string, string>;
    expected: {
        status: "completed" | "failed" | "denied";
    };
    expectedTerminationReason?: string;
    forbidden?: ForbiddenActions;
    verification?: VerificationSpec[];
    tags?: string[];
    provenance: CaseProvenance;
}
/** A candidate whose judge version has been pinned; only a frozen case may be
 *  written to the benchmark layout. */
export interface FrozenBenchmarkCase extends CandidateBenchmarkCase {
    judgeVersion: string;
    provenance: CaseProvenance & {
        judgeVersion: string;
        frozen: true;
    };
}
/** Raised for a pipeline gate violation (not human-confirmed, secret survives,
 *  fixture over budget). Human-readable rule in `rule`. */
export declare class CaseMiningError extends Error {
    readonly rule: "need-human-confirmation" | "secret-survives" | "fixture-over-budget";
    constructor(rule: CaseMiningError["rule"], message: string);
}
export interface MinemineOptions {
    suite?: EvalSuite;
    /** Explicit expected status; when omitted, derived from tags (denial tags →
     *  "denied", otherwise "failed"). Never guessed to "completed". */
    expectedStatus?: "completed" | "failed" | "denied";
    expectedTerminationReason?: string;
    forbidden?: ForbiddenActions;
    verification?: VerificationSpec[];
    tags?: string[];
    /** Project-specific secret patterns to check AFTER standard redaction.
     *  A match here counts as a surviving secret ⇒ refusal. */
    customSecretPatterns?: RegExp[];
    /** Fixture byte budget for minimization (default MIN_FIXTURE_MAX_BYTES). */
    maxBytes?: number;
    /** Injectable timestamp for deterministic tests. */
    now?: () => number;
}
export declare const MIN_FIXTURE_MAX_BYTES: number;
/**
 * Step 1 — sanitize. Redacts secrets in the task and every fixture file using
 * the runtime's own secret gate (single source of truth with the runtime),
 * then removes whole files that were pure secret material. Returns whether any
 * secret survived (project-specific patterns included).
 */
export declare function sanitizeFailure(task: string, fixture: Record<string, string>, customSecretPatterns?: RegExp[]): {
    task: string;
    fixture: Record<string, string>;
    report: SanitizeReport;
};
/**
 * Step 2 — minimize fixture. Deterministic whole-file dropping only:
 *  - empty files are dropped,
 *  - files whose content is an exact duplicate of an earlier kept file are dropped,
 *  - if still over budget, the largest not-yet-kept files are trimmed until the
 *    budget is met; if the budget cannot be met by dropping whole files, the
 *    fixture is flagged `overBudget` and freezeCase() refuses.
 * No file content is ever edited in place (other than the earlier secret
 * redaction), so the reproduction is never fabricated.
 */
export declare function minimizeFixture(fixture: Record<string, string>, maxBytes?: number): {
    fixture: Record<string, string>;
    report: MinimizeReport;
};
/** Default expected status for a mined failure: denial tags → "denied",
 *  otherwise "failed". Never auto-selects "completed". */
export declare function defaultExpectedStatus(tags?: string[]): "denied" | "failed";
/**
 * Steps 1–3 — produce a candidate regression case from a real failure.
 *
 * Gates:
 *  - failure.humanConfirmed must be true (CaseMiningError "need-human-confirmation").
 *  - no secret may survive redaction, standard or custom (CaseMiningError
 *    "secret-survives") — this is the plan's prohibition on auto-saving a
 *    secret-bearing real workspace.
 * An over-budget fixture is allowed to reach the candidate (it is flagged in
 * provenance) but freezeCase() will refuse to pin a judge on it.
 */
export declare function mineCandidate(failure: CapturedFailure, opts?: MinemineOptions): CandidateBenchmarkCase;
/**
 * Step 4 — freeze the judge on a candidate. Refuses when a secret still
 * survives, or when the fixture is over budget (a candidate that automation
 * could not make judgeable cannot have a judge pinned without fabrication).
 */
export declare function freezeCase(candidate: CandidateBenchmarkCase, judgeVersion: string): FrozenBenchmarkCase;
/**
 * Write a frozen case into the benchmark layout consumed by benchmarks/README.md:
 *
 *   <outDir>/<suite>/<case-id>/request.md     (sanitized task)
 *   <outDir>/<suite>/<case-id>/expected.md    (human-readable acceptance)
 *   <outDir>/<suite>/<case-id>/case.json      (machine-readable EvalCase + provenance)
 *   <outDir>/<suite>/<case-id>/fixture/<rel>  (sanitized + minimized files)
 *
 * Path safety: fixture keys must stay inside the case dir (no absolute, no
 * escaping via ".."). A path that would escape is refused, not silently mapped.
 * Returns the case directory that was written.
 */
export declare function writeFrozenCase(outDir: string, frozen: FrozenBenchmarkCase): Promise<string>;
//# sourceMappingURL=mining.d.ts.map