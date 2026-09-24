/**
 * E4-R08 + E4-R18 + E4-R24 — runtime observation evidence.
 *
 * `observed` in the usage audit is never inferred from a symbol appearing in
 * an E2E-named file (a comment, string or import would count). Instead, a real
 * passing production-path test records an ObservationEvidence row, and the
 * audit marks a capability observed ONLY for rows that are strict-valid AND
 * whose testedSourceSha EXACTLY matches the audited HEAD.
 *
 * E4-R18 (N15/N16) integrity redesign:
 *   - STRICT reader: every field is required and typed; `testedSourceSha` must
 *     be a 40-hex git sha (null/unknown is NOT a valid strict row); the
 *     `evidenceDigest` is RECOMPUTED over the canonical row body and must
 *     match — a fabricated all-zero digest row is rejected;
 *   - PER-RUN isolation: every test run writes to its OWN runId-namespaced
 *     file. The audit consumes a SPECIFIC run file, so an old successful run
 *     can never mask a current failure.
 *
 * E4-R24 (F03/F04) — final-result binding:
 *   - F03: the loader requires the row's INLINE runId to equal the REQUESTED
 *     runId. Copying another run's committed rows verbatim into
 *     `<newRunId>.jsonl` no longer makes the new run observed — the copied
 *     rows carry their own runId and are dropped (diagnostic only).
 *   - F04: the test-body collector (`createObservationRun`) records ONLY
 *     candidates (`<runId>.candidates.jsonl`, append-only, worker-safe).
 *     Committed (`runStatus: "passed"`) rows are published by
 *     `commitObservationRun` from the test FRAMEWORK's final results — the
 *     Vitest reporter in apps/cli/test-infra calls it after the run ends —
 *     so a test that observes but then fails an assertion, an afterEach or an
 *     afterAll leaves NO passed proof behind. The in-test `commit()` authority
 *     is gone: a hand-called method at the end of a test body is not proof
 *     the framework agreed the test passed.
 *   - runId is a SAFE IDENTIFIER (no separators, no traversal); `--run` on the
 *     CLI and every path derived from a runId is validated against it.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

export const OBSERVATION_EVIDENCE_SCHEMA_VERSION = "e4-r24-v1";
/** Candidate rows are NOT evidence — they lack the final-result binding. */
export const OBSERVATION_CANDIDATE_SCHEMA_VERSION = "e4-r24-c1";

/** Runners that may publish committed observation rows. */
export const OBSERVATION_RUNNERS = ["vitest"] as const;
export type ObservationRunner = (typeof OBSERVATION_RUNNERS)[number];

export interface ObservationEvidence {
  schemaVersion: typeof OBSERVATION_EVIDENCE_SCHEMA_VERSION;
  /** Per-run identity — one file per runId; the audit reads a SPECIFIC run. */
  runId: string;
  /** KEY_CAPABILITIES.capability id this row proves. */
  capabilityId: string;
  symbol: string;
  /** Which production entrypoint exercised it. */
  entrypoint: "cli" | "web" | "benchmark" | "release";
  testFile: string;
  testName: string;
  /** git HEAD at the time the test ran — REQUIRED (40-hex); unknown SHA rows
   *  are diagnostic only and never enter strict `observed`. */
  testedSourceSha: string;
  runStatus: "passed";
  /** E4-R24: which test framework produced the final result (run source). */
  runner: ObservationRunner;
  /** E4-R24: sha256 over the canonical final-result record — binds
   *  {testFile, testName, runStatus, runner} so the committed status and the
   *  row content cannot diverge silently (content integrity; see the report
   *  for what it does and does NOT prove). */
  resultDigest: string;
  /** What actually ran (chain of real stages / events, not a name). */
  invocation: string;
  /** sha256 over the canonical row body (self-excluding) — recomputed by the
   *  reader; a mismatched/fabricated digest rejects the row. */
  evidenceDigest: string;
}

/** Canonical digest input for a row — evidenceDigest is ALWAYS excluded, so the
 *  reader recomputes the same value over the parsed row that the writer signed
 *  over the unsigned body. */
export function computeObservationEvidenceDigest(body: Record<string, unknown>): string {
  const { evidenceDigest: _d, ...rest } = body;
  return createHash("sha256").update(JSON.stringify(rest), "utf8").digest("hex");
}

/** E4-R24: digest over the framework's final-result record for one test. */
export function computeObservationResultDigest(input: {
  testFile: string;
  testName: string;
  status: string;
  runner: string;
}): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ENTRYPOINTS = new Set(["cli", "web", "benchmark", "release"]);
const RUNNER_SET = new Set<string>(OBSERVATION_RUNNERS);
/**
 * E4-R24: a runId is a file-name component, never a path — separators,
 * traversal segments and hidden/system names are rejected before any path is
 * derived from it.
 */
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeObservationRunId(runId: string): boolean {
  return SAFE_RUN_ID.test(runId) && runId !== "." && runId !== "..";
}

function requireSafeRunId(runId: string): string {
  if (!isSafeObservationRunId(runId)) {
    throw new Error(
      `unsafe observation runId ${JSON.stringify(runId)} (must match ${SAFE_RUN_ID.source} — path separators and traversal segments are forbidden)`,
    );
  }
  return runId;
}

/** E4-R18 (N15): strict row validation — issues are non-empty when the row is
 *  NOT valid observation evidence. */
export function observationEvidenceIssues(value: unknown): string[] {
  const issues: string[] = [];
  if (typeof value !== "object" || value === null) return ["observation row is not an object"];
  const r = value as Record<string, unknown>;
  const str = (field: string): boolean => typeof r[field] === "string" && (r[field] as string).length > 0;
  if (r.schemaVersion !== OBSERVATION_EVIDENCE_SCHEMA_VERSION) {
    issues.push(`schemaVersion ${JSON.stringify(r.schemaVersion)} != ${OBSERVATION_EVIDENCE_SCHEMA_VERSION}`);
  }
  if (!str("runId")) issues.push("runId missing");
  if (!str("capabilityId")) issues.push("capabilityId missing");
  if (!str("symbol")) issues.push("symbol missing");
  if (typeof r.entrypoint !== "string" || !ENTRYPOINTS.has(r.entrypoint)) issues.push("entrypoint must be cli|web|benchmark|release");
  if (!str("testFile")) issues.push("testFile missing");
  if (!str("testName")) issues.push("testName missing");
  if (typeof r.testedSourceSha !== "string" || !HEX40.test(r.testedSourceSha)) {
    issues.push(`testedSourceSha must be a 40-hex git sha (got ${JSON.stringify(r.testedSourceSha)})`);
  }
  if (r.runStatus !== "passed") issues.push("runStatus must be 'passed' (final committed result)");
  if (typeof r.runner !== "string" || !RUNNER_SET.has(r.runner)) {
    issues.push(`runner must be one of ${OBSERVATION_RUNNERS.join("|")} (got ${JSON.stringify(r.runner)})`);
  }
  if (!str("invocation")) issues.push("invocation missing");
  if (typeof r.resultDigest !== "string" || !HEX64.test(r.resultDigest)) {
    issues.push("resultDigest must be 64-hex");
  }
  if (typeof r.evidenceDigest !== "string" || !HEX64.test(r.evidenceDigest)) {
    issues.push("evidenceDigest must be 64-hex");
  }
  // Recompute the digests over the canonical body — a fabricated/edited row is
  // rejected even when all fields LOOK plausible.
  if (typeof r.evidenceDigest === "string" && HEX64.test(r.evidenceDigest)) {
    const recomputed = computeObservationEvidenceDigest(value as Record<string, unknown>);
    if (recomputed !== r.evidenceDigest) {
      issues.push("evidenceDigest does not recompute over the row body");
    }
  }
  if (
    typeof r.resultDigest === "string" && HEX64.test(r.resultDigest) &&
    typeof r.runner === "string" && typeof r.testFile === "string" &&
    typeof r.testName === "string" && typeof r.runStatus === "string"
  ) {
    const recomputedResult = computeObservationResultDigest({
      testFile: r.testFile, testName: r.testName, status: r.runStatus, runner: r.runner,
    });
    if (recomputedResult !== r.resultDigest) {
      issues.push("resultDigest does not recompute over the recorded final result");
    }
  }
  return issues;
}

/** Strict parse: throws when the row is not valid observation evidence. */
export function parseObservationEvidence(value: unknown): ObservationEvidence {
  const issues = observationEvidenceIssues(value);
  if (issues.length > 0) {
    throw new Error(`ObservationEvidence invalid: ${issues.join("; ")}`);
  }
  return value as ObservationEvidence;
}

/** Where per-run evidence lives. Tests/gates may override via the env var. */
export function observationEvidenceDir(): string {
  return process.env.E2E_OBSERVATION_EVIDENCE_DIR ?? join(tmpdir(), "harness-observation-evidence");
}

/** The runId-namespaced COMMITTED evidence file (one run = one file — a failed
 *  rerun leaves no rows behind, so it can never mask a current failure). */
export function observationEvidencePathForRun(runId: string): string {
  return join(observationEvidenceDir(), `${requireSafeRunId(runId)}.jsonl`);
}

/** The runId-namespaced CANDIDATE file (append-only, written during the test
 *  run; consumed only by commitObservationRun — never by the audit). */
export function observationCandidatesPathForRun(runId: string): string {
  return join(observationEvidenceDir(), `${requireSafeRunId(runId)}.candidates.jsonl`);
}

/**
 * Read the committed rows of ONE run strictly.
 *
 * E4-R24 (F03): a row whose INLINE runId differs from the requested run is
 * dropped with a distinct diagnostic — verbatim copies of another run's rows
 * are detectable and never count as this run's evidence.
 */
export function loadObservationEvidence(runId: string): ObservationEvidence[] {
  const p = observationEvidencePathForRun(runId);
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return []; // no committed run — nothing observed
  }
  const out: ObservationEvidence[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = parseObservationEvidence(JSON.parse(line) as unknown);
      if (row.runId !== runId) {
        process.stderr.write(
          `[degraded] observation-evidence: row runId ${JSON.stringify(row.runId)} != requested run ${JSON.stringify(runId)} (rows copied from another run are diagnostic only) — dropped\n`,
        );
        continue;
      }
      out.push(row);
    } catch (err) {
      process.stderr.write(`[degraded] observation-evidence unreadable row: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return out;
}

/** Read the committed rows of EVERY run (diagnostic mode — release-grade
 *  auditing passes a specific runId instead). Candidate files are skipped:
 *  they are not evidence. */
export function loadAllObservationEvidence(): ObservationEvidence[] {
  let entries: string[];
  try {
    entries = readdirSync(observationEvidenceDir());
  } catch {
    return [];
  }
  const out: ObservationEvidence[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl") || entry.endsWith(".candidates.jsonl")) continue;
    for (const row of loadObservationEvidence(entry.slice(0, -".jsonl".length))) {
      out.push(row);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// E4-R24 (F04): two-phase commit — the test body only records CANDIDATES; the
// final publication happens from the test framework's FINAL results.
// ---------------------------------------------------------------------------

export interface ObservationRunInput {
  runId: string;
  testFile: string;
  testName: string;
  /** git HEAD the test ran against (REQUIRED 40-hex). */
  testedSourceSha: string;
  entrypoint: "cli" | "web" | "benchmark" | "release";
}

export interface ObservationCollector {
  runId: string;
  /** Record a CANDIDATE observation ("this capability was exercised"). No
   *  durable proof exists until the framework's final results are committed —
   *  a later assertion/hook failure in the same test leaves nothing behind. */
  observe(ev: {
    capabilityId: string;
    symbol: string;
    entrypoint: ObservationEvidence["entrypoint"];
    invocation: string;
  }): void;
}

interface CandidateRow {
  schemaVersion: typeof OBSERVATION_CANDIDATE_SCHEMA_VERSION;
  runId: string;
  capabilityId: string;
  symbol: string;
  entrypoint: ObservationEvidence["entrypoint"];
  testFile: string;
  testName: string;
  testedSourceSha: string;
  invocation: string;
}

export function createObservationRun(input: ObservationRunInput): ObservationCollector {
  const runId = requireSafeRunId(input.runId);
  return {
    runId,
    observe(ev) {
      try {
        const candidate: CandidateRow = {
          schemaVersion: OBSERVATION_CANDIDATE_SCHEMA_VERSION,
          runId,
          capabilityId: ev.capabilityId,
          symbol: ev.symbol,
          entrypoint: ev.entrypoint,
          testFile: input.testFile,
          testName: input.testName,
          testedSourceSha: input.testedSourceSha,
          invocation: ev.invocation,
        };
        mkdirSync(observationEvidenceDir(), { recursive: true });
        // Append-only single-line writes: parallel workers of the SAME run
        // never overwrite each other's candidates (E4-R24 multi-worker rule).
        appendFileSync(observationCandidatesPathForRun(runId), `${JSON.stringify(candidate)}\n`, "utf8");
      } catch (err) {
        process.stderr.write(
          `[degraded] observation-evidence candidate append failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    },
  };
}

/** One final framework outcome for one test identity. `status` is the test
 *  framework's FINAL state for that test (assertions + hooks included). */
export interface ObservationFinalOutcome {
  testFile: string;
  testName: string;
  status: string;
}

export interface CommitObservationRunResult {
  committedRows: number;
  droppedCandidates: number;
  /** The committed file path (always exists after this call — possibly empty). */
  path: string;
}

/**
 * E4-R24 (F04): publish the committed evidence for ONE run from the test
 * framework's FINAL results.
 *
 * A candidate is committed as a `runStatus: "passed"` row ONLY when EVERY
 * final outcome matching its (testFile, testName) is "passed" — candidates
 * with no matching outcome are dropped (a testFile existing is not proof its
 * testName ran). Identical duplicate candidates (retry attempts re-observing)
 * are deduplicated. The write is temp-file + atomic rename, so a crash mid-way
 * never leaves a half-consumable success file.
 */
export function commitObservationRun(
  runId: string,
  finals: readonly ObservationFinalOutcome[],
): CommitObservationRunResult {
  const path = observationEvidencePathForRun(runId);
  let raw = "";
  try {
    raw = readFileSync(observationCandidatesPathForRun(runId), "utf8");
  } catch {
    raw = ""; // no candidates at all — commit an empty run file
  }
  const seen = new Set<string>();
  const candidates: CandidateRow[] = [];
  let dropped = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      dropped += 1;
      continue;
    }
    const key = line.trim();
    if (seen.has(key)) continue; // retry/duplicate candidate
    seen.add(key);
    const c = parsed as Record<string, unknown>;
    if (
      typeof c["runId"] !== "string" || c["runId"] !== runId ||
      typeof c["capabilityId"] !== "string" || c["capabilityId"].length === 0 ||
      typeof c["symbol"] !== "string" || c["symbol"].length === 0 ||
      typeof c["entrypoint"] !== "string" || !ENTRYPOINTS.has(c["entrypoint"]) ||
      typeof c["testFile"] !== "string" || c["testFile"].length === 0 ||
      typeof c["testName"] !== "string" || c["testName"].length === 0 ||
      typeof c["testedSourceSha"] !== "string" || !HEX40.test(c["testedSourceSha"]) ||
      typeof c["invocation"] !== "string" || c["invocation"].length === 0
    ) {
      dropped += 1;
      continue;
    }
    candidates.push(parsed as unknown as CandidateRow);
  }

  const rows: Array<Omit<ObservationEvidence, "evidenceDigest"> & { evidenceDigest: string }> = [];
  for (const c of candidates) {
    const matches = finals.filter((f) => f.testFile === c.testFile && f.testName === c.testName);
    if (matches.length === 0 || matches.some((f) => f.status !== "passed")) {
      dropped += 1;
      continue;
    }
    const body: Omit<ObservationEvidence, "evidenceDigest"> = {
      schemaVersion: OBSERVATION_EVIDENCE_SCHEMA_VERSION,
      runId,
      capabilityId: c.capabilityId,
      symbol: c.symbol,
      entrypoint: c.entrypoint,
      testFile: c.testFile,
      testName: c.testName,
      testedSourceSha: c.testedSourceSha,
      runStatus: "passed",
      runner: "vitest",
      resultDigest: computeObservationResultDigest({
        testFile: c.testFile, testName: c.testName, status: "passed", runner: "vitest",
      }),
      invocation: c.invocation,
    };
    rows.push({ ...body, evidenceDigest: computeObservationEvidenceDigest(body as unknown as Record<string, unknown>) });
  }

  mkdirSync(observationEvidenceDir(), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, rows.length > 0 ? `${rows.map((r) => JSON.stringify(r)).join("\n")}\n` : "", "utf8");
  renameSync(tmp, path);
  return { committedRows: rows.length, droppedCandidates: dropped, path };
}

/** git HEAD sha at audit/test time (null when the checkout is not a repo). */
export function gitHeadShaAt(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}
