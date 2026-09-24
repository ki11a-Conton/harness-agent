/**
 * E4-R84 (F84-1) — campaign-level, fail-closed validation of a benchmark
 * campaign directory.
 *
 * Why this exists
 * ---------------
 * R83 ran a real 86-case campaign (adversarial 13 / stress 11 / regression 30 /
 * holdout 32) and reported 86 stored, 21 passing, 1,327 model calls,
 * 4,051,523 input / 440,594 output tokens. That report could not be
 * independently re-checked: the raw runner, per-case reports, `manifest.jsonl`
 * and the campaign summary all lived under the git-ignored `.ci/`, and the
 * existing `validateArtifactDir` validator is per-DIRECTORY (it discovers
 * holdout-style artifacts in ONE directory and never looks at a campaign tree,
 * a resume manifest or a cross-case summary).
 *
 * This validator is the campaign-level counterpart. It is deliberately
 * different from `validateArtifactDir` in four ways:
 *
 *   1. The EXPECTED case set comes from the versioned benchmark case source
 *      (`benchmarks/<suite>/<caseId>/`), never from the manifest being
 *      validated. A manifest can therefore not certify itself.
 *   2. It validates the WHOLE tree — every suite, every case, the resume
 *      manifest and the submitted summary — and re-derives every aggregate
 *      from the per-case reports.
 *   3. It produces a stable, cross-platform root digest: files are hashed after
 *      CRLF→LF normalization and sorted by a POSIX-normalized relative path, so
 *      a Windows checkout and an Ubuntu checkout of the same campaign agree.
 *   4. It separates PROCESS EXECUTION SUCCESS (did the runner exit 0 and store
 *      a report?) from CASE SUCCESS (did the harness verify the task?). The R83
 *      campaign has 86/86 process successes and 21/86 case successes; collapsing
 *      those two numbers is exactly the dishonesty the plan forbids.
 *
 * Fail-closed: empty directory, 0 cases, summary-only (no raw case reports),
 * a missing suite, a truncated manifest, an unknown/duplicate case, a hash or
 * summary mismatch all produce a non-zero verdict with a stable reason code.
 *
 * Never runs a model, never reads a secret, never invents a value: a field that
 * was not recorded is reported as `not_recorded` and FAILS the check (the plan
 * forbids back-filling missing raw data).
 */

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// Stable reason codes (machine-readable, sortable, safe to assert on)
// ---------------------------------------------------------------------------

export type CampaignReasonCode =
  | "CAMPAIGN_ROOT_MISSING"
  | "CAMPAIGN_EMPTY"
  | "CAMPAIGN_RESULTS_DIR_MISSING"
  | "CAMPAIGN_NO_CASE_ARTIFACTS"
  | "CAMPAIGN_MANIFEST_MISSING"
  | "CAMPAIGN_MANIFEST_TRUNCATED"
  | "CAMPAIGN_MANIFEST_RECORD_INVALID"
  | "CAMPAIGN_MANIFEST_RESUME_MISMATCH"
  | "CAMPAIGN_CASE_SET_MISMATCH"
  | "CAMPAIGN_MISSING_CASE"
  | "CAMPAIGN_DUPLICATE_CASE"
  | "CAMPAIGN_UNKNOWN_CASE"
  | "CAMPAIGN_SUITE_COUNT_MISMATCH"
  | "CAMPAIGN_SUITE_MISSING"
  | "CAMPAIGN_MULTIPLE_FINAL_RESULTS"
  | "CAMPAIGN_ARTIFACT_UNREADABLE"
  | "CAMPAIGN_ARTIFACT_SCHEMA_INVALID"
  | "CAMPAIGN_ARTIFACT_HASH_MISMATCH"
  | "CAMPAIGN_SUMMARY_MISSING"
  | "CAMPAIGN_SUMMARY_INVALID"
  | "CAMPAIGN_SUMMARY_MISMATCH"
  | "CAMPAIGN_SOURCE_SHA_DRIFT"
  | "CAMPAIGN_IDENTITY_DRIFT"
  | "CAMPAIGN_FIELD_NOT_RECORDED"
  | "CAMPAIGN_SECRET_FOUND";

// ---------------------------------------------------------------------------
// Fixed campaign shape (plan §R84: adversarial 13 / stress 11 / regression 30 /
// holdout 32 = 86). This is the DECLARED shape; the authoritative expected case
// set is still derived from the versioned benchmark case source below.
// ---------------------------------------------------------------------------

export const CAMPAIGN_SUITE_ORDER = ["adversarial", "stress", "regression", "holdout"] as const;
export type CampaignSuite = (typeof CAMPAIGN_SUITE_ORDER)[number];

export const CAMPAIGN_EXPECTED_SUITE_COUNTS: Readonly<Record<CampaignSuite, number>> = {
  adversarial: 13,
  stress: 11,
  regression: 30,
  holdout: 32,
};

export const CAMPAIGN_EXPECTED_TOTAL_CASES = 86;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CampaignCheck {
  code: CampaignReasonCode;
  passed: boolean;
  detail: string;
  /** POSIX-normalized path relative to the campaign root, when applicable. */
  file?: string;
}

export interface CampaignCaseRecord {
  suite: string;
  caseId: string;
  /** Process-level: the runner stored a parseable report for this case. */
  stored: boolean;
  /** Case-level: the harness verified the task as complete. */
  success: boolean | null;
  terminationReason: string;
  modelCalls: number | null;
  toolCalls: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  durationMs: number | null;
  sourceSha: string | null;
  provider: string | null;
  model: string | null;
  judgeVersion: string | null;
  artifactPath: string;
  artifactSha256: string;
}

export interface CampaignSummary {
  suites: number;
  expectedCases: number;
  storedCases: number;
  passed: number;
  failed: number;
  /** Process execution success: the runner exited 0 and a report exists. */
  processRunSuccesses: number;
  /** Process execution failure: the resume manifest recorded a failed attempt. */
  processRunFailures: number;
  modelCalls: number;
  toolCalls: number;
  tokensInput: number;
  tokensOutput: number;
  terminationReasons: Record<string, number>;
  suiteDistribution: Record<string, number>;
  sourceShaDistribution: Record<string, number>;
  identityDistribution: Record<string, number>;
}

export interface CampaignValidationResult {
  ok: boolean;
  /** Sorted, unique reason codes for every FAILED check. */
  reasonCodes: CampaignReasonCode[];
  checks: CampaignCheck[];
  errors: CampaignCheck[];
  summary: CampaignSummary;
  /**
   * sha256 over the sorted `<path>\0<sha256>\n` evidence listing, computed on
   * CRLF→LF NORMALIZED content. This is a CONTENT-integrity digest: it is
   * deliberately line-ending agnostic so one campaign has one cross-platform
   * value, and it is NOT a byte-level immutability proof (see `rawRootDigest`).
   */
  rootDigest: string;
  /** R90 §4: the same listing computed over RAW bytes (no normalization). */
  rawRootDigest: string;
  artifactHashes: Array<{ path: string; sha256: string; rawSha256: string }>;
  cases: CampaignCaseRecord[];
}

export interface CampaignValidateOptions {
  /** Campaign root (holds `results/`, `manifest.jsonl`, the summary). */
  root: string;
  /** Versioned benchmark case source root. Default `benchmarks`. */
  casesRoot?: string;
  /** Submitted sanitized summary. Default `<root>/campaign-summary.json`. */
  summaryPath?: string;
  /** Declared per-suite case counts. Default `CAMPAIGN_EXPECTED_SUITE_COUNTS`. */
  expectedSuiteCounts?: Readonly<Record<string, number>>;
  /**
   * Suites the campaign is expected to cover, in report order. Defaults to the
   * keys of `expectedSuiteCounts` when given, else `CAMPAIGN_SUITE_ORDER`.
   * A synthetic/fixture campaign uses its own suite names; the real R83
   * campaign uses the four versioned suites.
   */
  suites?: readonly string[];
  /** Accepted source SHAs. When omitted the summary's `gitShas` are used. */
  allowedSourceShas?: readonly string[];
  /**
   * Expected campaign root digest (from a previously emitted evidence
   * manifest). When given, ANY byte change in ANY evidence file fails the
   * campaign with `CAMPAIGN_ARTIFACT_HASH_MISMATCH`.
   */
  expectedRootDigest?: string;
  /**
   * Expected per-artifact hashes. When given, every listed artifact must exist
   * with exactly that hash, and no unlisted evidence file may appear.
   */
  expectedArtifactHashes?: ReadonlyArray<{ path: string; sha256: string }>;
  /** Extra secret patterns (never echoed back in a finding). */
  secretPatterns?: readonly RegExp[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** True when the path exists. The catch carries real logic (`return false`). */
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function posix(p: string): string {
  return p.split(sep).join("/");
}

/**
 * CRLF→LF normalization BEFORE hashing. This is what makes the root digest
 * identical on Windows and Ubuntu for the same campaign, and it is the reason a
 * lone `\r` byte change is not by itself a tamper signal. Every other byte
 * change still fails the hash check.
 */
function normalizedBytes(buf: Buffer): Buffer {
  const text = buf.toString("utf8");
  return Buffer.from(text.includes("\r\n") ? text.replace(/\r\n/g, "\n") : text, "utf8");
}

function sha256Bytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function hashFile(abs: string): Promise<string> {
  return sha256Bytes(normalizedBytes(await readFile(abs)));
}

/**
 * R90 §4: the RAW byte hash of a file, with NO CRLF→LF normalization.
 *
 * `sha256` above proves normalized CONTENT integrity — it is deliberately
 * line-ending agnostic so one campaign yields one digest on Windows and Linux.
 * That is NOT byte-level immutability, and the two facts must never be
 * conflated. `rawSha256` is the byte-audit companion: it changes when a single
 * `\r` is added, which is exactly what a forensic byte comparison needs.
 */
async function rawHashFile(abs: string): Promise<string> {
  return sha256Bytes(await readFile(abs));
}

/** Recursively list every regular file under `dir`, POSIX-relative to `base`. */
async function listFilesRecursive(dir: string, base: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        out.push(posix(relative(base, abs)));
      }
    }
  };
  await walk(dir);
  return out;
}

function sortedKeys(record: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key] as number;
  return out;
}

function bump(record: Record<string, number>, key: string, by = 1): void {
  record[key] = (record[key] ?? 0) + by;
}

/** Report file name for a suite (regression keeps the historical `baseline.json`). */
export function campaignReportFileName(suite: string): string {
  return suite === "regression" ? "baseline.json" : `${suite}.json`;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /[Bb]earer\s+[A-Za-z0-9._-]{16,}/,
  /https?:\/\/[^/\s:@]+:[^/\s:@]+@/,
  /[?&](?:api[_-]?key|access[_-]?token|token)=[A-Za-z0-9._-]{12,}/i,
  /[Xx]-[Aa][Pp][Ii]-[Kk][Ee][Yy]\s*[:=]\s*\S{12,}/,
  /[Aa]uthorization\s*[:=]\s*\S{12,}/,
];

/** Scan text for secret-shaped material. Returns matched pattern sources only
 *  (never the matched value — a finding must not leak the secret). */
export function scanCampaignForSecrets(text: string, extra?: readonly RegExp[]): string[] {
  const hits: string[] = [];
  for (const re of [...SECRET_PATTERNS, ...(extra ?? [])]) {
    if (re.test(text)) hits.push(re.source);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Expected case set — from the VERSIONED benchmark case source
// ---------------------------------------------------------------------------

export interface ExpectedCampaignCase {
  suite: string;
  caseId: string;
}

/** Read the expected (suite, caseId) set from `benchmarks/<suite>/<caseId>/`.
 *  Dot-directories are skipped (they are not cases). */
export async function expectedCampaignCases(
  casesRoot: string,
  suites: readonly string[] = CAMPAIGN_SUITE_ORDER,
): Promise<ExpectedCampaignCase[]> {
  const out: ExpectedCampaignCase[] = [];
  for (const suite of suites) {
    let entries;
    try {
      entries = await readdir(join(casesRoot, suite), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      out.push({ suite, caseId: entry.name });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report parsing
// ---------------------------------------------------------------------------

interface ParsedCaseReport {
  success: boolean | null;
  terminationReason: string;
  modelCalls: number | null;
  toolCalls: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  durationMs: number | null;
  sourceSha: string | null;
  provider: string | null;
  model: string | null;
  judgeVersion: string | null;
  resultCount: number;
}

const NOT_RECORDED = "not_recorded";

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Parse one per-case report. Returns an Error describing the schema problem
 *  (never a fabricated value) when the report cannot be trusted. */
export function parseCaseReport(raw: string, caseLabel: string): ParsedCaseReport | Error {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return new Error(`${caseLabel}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return new Error(`${caseLabel}: report is not a JSON object`);
  }
  const doc = parsed as Record<string, unknown>;
  const results = doc.results;
  if (!Array.isArray(results)) {
    return new Error(`${caseLabel}: missing results[] array`);
  }
  if (results.length === 0) {
    return new Error(`${caseLabel}: results[] is empty`);
  }
  const first = results[0];
  if (first === null || typeof first !== "object" || Array.isArray(first)) {
    return new Error(`${caseLabel}: results[0] is not an object`);
  }
  const r = first as Record<string, unknown>;
  const manifest = (doc.manifest ?? {}) as Record<string, unknown>;
  const meta = (doc.meta ?? {}) as Record<string, unknown>;
  const metaModel = (meta.model ?? {}) as Record<string, unknown>;

  return {
    success: typeof r.success === "boolean" ? r.success : null,
    terminationReason: strOrNull(r.termination_reason) ?? NOT_RECORDED,
    modelCalls: numOrNull(r.model_calls),
    toolCalls: numOrNull(r.tool_calls),
    tokensInput: numOrNull(r.input_tokens),
    tokensOutput: numOrNull(r.output_tokens),
    durationMs: numOrNull(r.duration_ms),
    sourceSha: strOrNull(manifest.gitSha),
    provider: strOrNull(manifest.provider) ?? strOrNull(metaModel.providerId),
    model: strOrNull(manifest.model) ?? strOrNull(metaModel.modelId),
    judgeVersion: strOrNull(r.judge_version) ?? strOrNull(manifest.judgeVersion),
    resultCount: results.length,
  };
}

// ---------------------------------------------------------------------------
// Resume manifest
// ---------------------------------------------------------------------------

interface ManifestRecord {
  lineNumber: number;
  suite: string;
  caseId: string;
  ok: boolean;
}

/** Parse `manifest.jsonl`. A non-empty trailing line that is not valid JSON is
 *  a TRUNCATED manifest (an interrupted write), which is a hard failure — it is
 *  never silently dropped. */
export function parseCampaignManifest(raw: string): { records: ManifestRecord[]; errors: string[] } {
  const records: ManifestRecord[] = [];
  const errors: string[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      errors.push(`line ${i + 1}: not valid JSON (truncated or corrupt manifest record)`);
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      errors.push(`line ${i + 1}: record is not a JSON object`);
      continue;
    }
    const rec = parsed as Record<string, unknown>;
    const suite = strOrNull(rec.suite);
    const caseId = strOrNull(rec.caseId);
    if (suite === null || caseId === null) {
      errors.push(`line ${i + 1}: record is missing suite/caseId`);
      continue;
    }
    records.push({ lineNumber: i + 1, suite, caseId, ok: rec.ok === true });
  }
  return { records, errors };
}

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

function check(
  checks: CampaignCheck[],
  code: CampaignReasonCode,
  passed: boolean,
  detail: string,
  file?: string,
): void {
  checks.push(file === undefined ? { code, passed, detail } : { code, passed, detail, file });
}

/**
 * Validate a whole campaign directory. Never throws for a bad campaign — it
 * returns `ok: false` with stable reason codes. It DOES throw only for a
 * programming error (a bug in the caller), never for malformed input.
 */
export async function validateCampaign(
  options: CampaignValidateOptions,
): Promise<CampaignValidationResult> {
  const root = options.root;
  const casesRoot = options.casesRoot ?? "benchmarks";
  const summaryPath = options.summaryPath ?? join(root, "campaign-summary.json");
  const expectedCounts: Readonly<Record<string, number>> =
    options.expectedSuiteCounts ?? CAMPAIGN_EXPECTED_SUITE_COUNTS;
  // The suite list is derived from the declared counts (fixture campaigns use
  // their own suite names); the four versioned suites are the default.
  const suites: readonly string[] = options.suites ??
    (options.expectedSuiteCounts !== undefined
      ? Object.keys(options.expectedSuiteCounts)
      : CAMPAIGN_SUITE_ORDER);
  const checks: CampaignCheck[] = [];
  const cases: CampaignCaseRecord[] = [];

  const emptySummary: CampaignSummary = {
    suites: 0,
    expectedCases: 0,
    storedCases: 0,
    passed: 0,
    failed: 0,
    processRunSuccesses: 0,
    processRunFailures: 0,
    modelCalls: 0,
    toolCalls: 0,
    tokensInput: 0,
    tokensOutput: 0,
    terminationReasons: {},
    suiteDistribution: {},
    sourceShaDistribution: {},
    identityDistribution: {},
  };

  // ---- 0. The root itself ----
  if (!(await exists(root))) {
    check(checks, "CAMPAIGN_ROOT_MISSING", false, `campaign root does not exist: ${root}`);
    return finish(checks, emptySummary, [], cases);
  }

  // ---- 1. Expected case set from the VERSIONED source ----
  const expected = await expectedCampaignCases(casesRoot, suites);
  const expectedKeys = new Set(expected.map((c) => `${c.suite}/${c.caseId}`));
  const expectedBySuite: Record<string, number> = {};
  for (const c of expected) bump(expectedBySuite, c.suite);

  const declaredTotal = Object.values(expectedCounts).reduce((a, b) => a + b, 0);
  let expectedShapeOk = expected.length === declaredTotal;
  const shapeProblems: string[] = [];
  for (const suite of suites) {
    const declared = expectedCounts[suite];
    const actual = expectedBySuite[suite] ?? 0;
    if (declared === undefined) continue;
    if (actual !== declared) {
      expectedShapeOk = false;
      shapeProblems.push(`${suite}: declared ${declared}, on-disk ${actual}`);
    }
  }
  check(
    checks,
    "CAMPAIGN_SUITE_COUNT_MISMATCH",
    expectedShapeOk,
    expectedShapeOk
      ? `expected set matches the declared shape (${suites.map((s) => `${s} ${expectedCounts[s]}`).join(", ")})`
      : `expected case source does not match the declared campaign shape: ${shapeProblems.join("; ")}`,
    posix(casesRoot),
  );

  for (const suite of suites) {
    const count = expectedBySuite[suite] ?? 0;
    check(
      checks,
      "CAMPAIGN_SUITE_MISSING",
      count > 0,
      count > 0 ? `suite ${suite}: ${count} expected case(s)` : `suite ${suite}: no case directories found under ${posix(join(casesRoot, suite))}`,
    );
  }

  // ---- 2. Discover the stored per-case artifacts ----
  const resultsDir = join(root, "results");
  if (!(await exists(resultsDir))) {
    check(checks, "CAMPAIGN_RESULTS_DIR_MISSING", false, `results/ directory missing under ${root} — a summary without raw case reports is not evidence`);
  }

  const storedByKey = new Map<string, { suite: string; caseId: string; abs: string; rel: string }>();
  const duplicates: string[] = [];
  const unknown: string[] = [];
  const artifactHashes: Array<{ path: string; sha256: string; rawSha256: string }> = [];
  const reportFiles: string[] = [];

  if (await exists(resultsDir)) {
    const suiteDirs = (await readdir(resultsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const suite of suiteDirs) {
      const caseDirs = (await readdir(join(resultsDir, suite), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
      for (const caseId of caseDirs) {
        const caseDirAbs = join(resultsDir, suite, caseId);
        // A case directory may carry MORE THAN ONE final report. Every
        // recognised report file in it is a candidate final result, so two of
        // them is "one case, multiple final results" — a hard failure.
        const present: string[] = [];
        for (const suiteName of [suite, "regression", "baseline"]) {
          const candidate = suiteName === "baseline" ? "baseline.json" : `${suiteName}.json`;
          if (await exists(join(caseDirAbs, candidate)) && !present.includes(candidate)) {
            present.push(candidate);
          }
        }
        if (present.length === 0) continue;
        const rel = posix(join("results", suite, caseId, present[0] as string));
        if (present.length > 1) {
          duplicates.push(`${suite}/${caseId}: ${present.join(", ")}`);
          continue;
        }
        const key = `${suite}/${caseId}`;
        if (!expectedKeys.has(key)) unknown.push(key);
        if (storedByKey.has(key)) {
          duplicates.push(key);
          continue;
        }
        storedByKey.set(key, { suite, caseId, abs: join(caseDirAbs, present[0] as string), rel });
        reportFiles.push(join(caseDirAbs, present[0] as string));
      }
    }
  }

  // ---- 3. Hash every evidence file (deterministic, cross-platform) ----
  const evidenceFiles: string[] = [];
  if (await exists(resultsDir)) {
    evidenceFiles.push(...(await listFilesRecursive(resultsDir, root)));
  }
  const manifestRel = "manifest.jsonl";
  if (await exists(join(root, manifestRel))) evidenceFiles.push(manifestRel);
  const summaryRel = posix(relative(root, summaryPath));
  if (!summaryRel.startsWith("..") && (await exists(summaryPath))) evidenceFiles.push(summaryRel);
  const sortedEvidence = [...new Set(evidenceFiles)].sort();
  for (const rel of sortedEvidence) {
    artifactHashes.push({
      path: rel,
      sha256: await hashFile(join(root, rel)),
      // R90 §4: recorded ALONGSIDE (never instead of) the normalized digest, so
      // a byte auditor can detect a line-ending-only change while every existing
      // normalized digest stays compatible.
      rawSha256: await rawHashFile(join(root, rel)),
    });
  }
  const rootDigest = sha256Bytes(Buffer.from(
    artifactHashes.map((a) => `${a.path}\u0000${a.sha256}\n`).join(""),
    "utf8",
  ));
  // The byte-level companion digest. It is NOT the tamper gate (the normalized
  // root digest remains authoritative) — it exists so byte identity is auditable.
  const rawRootDigest = sha256Bytes(Buffer.from(
    artifactHashes.map((a) => `${a.path}\u0000${a.rawSha256}\n`).join(""),
    "utf8",
  ));

  // ---- 3b. Hash integrity against a previously recorded evidence manifest ----
  // A campaign is tamper-EVIDENT because the digest covers every evidence file.
  // It becomes tamper-DETECTING when the expected digest is supplied: then any
  // added, removed or modified byte fails the campaign outright.
  {
    const hashProblems: string[] = [];
    const actual = new Map(artifactHashes.map((a) => [a.path, a.sha256]));
    if (options.expectedArtifactHashes !== undefined) {
      const expectedPaths = new Set<string>();
      for (const want of options.expectedArtifactHashes) {
        expectedPaths.add(want.path);
        const have = actual.get(want.path);
        if (have === undefined) {
          hashProblems.push(`${want.path}: recorded in the evidence manifest but missing on disk`);
        } else if (have !== want.sha256) {
          hashProblems.push(`${want.path}: sha256 ${have} != recorded ${want.sha256}`);
        }
      }
      for (const path of actual.keys()) {
        if (!expectedPaths.has(path)) hashProblems.push(`${path}: present on disk but not recorded in the evidence manifest`);
      }
    }
    if (options.expectedRootDigest !== undefined && options.expectedRootDigest !== rootDigest) {
      hashProblems.push(`root digest ${rootDigest} != recorded ${options.expectedRootDigest}`);
    }
    if (hashProblems.length > 0) {
      check(checks, "CAMPAIGN_ARTIFACT_HASH_MISMATCH", false, hashProblems.slice(0, 12).join("; "));
    } else if (options.expectedRootDigest !== undefined || options.expectedArtifactHashes !== undefined) {
      check(checks, "CAMPAIGN_ARTIFACT_HASH_MISMATCH", true, `every evidence file matches the recorded hashes (root digest ${rootDigest})`);
    }
  }

  // ---- 3c. Secret scan over EVERY evidence file ----
  // Not just the parsed reports: a `run.log` or a stray file in the tree is
  // exactly where a leaked header or URL would sit.
  const secretFindings: string[] = [];
  for (const artifact of artifactHashes) {
    let text: string;
    try {
      text = (await readFile(join(root, artifact.path))).toString("utf8");
    } catch {
      continue;
    }
    for (const hit of scanCampaignForSecrets(text, options.secretPatterns)) {
      secretFindings.push(`${artifact.path}: matches ${hit}`);
    }
  }

  // ---- 4. Parse every stored report ----
  const missing = [...expectedKeys].filter((k) => !storedByKey.has(k)).sort();
  const notRecordedFields: string[] = [];
  const schemaErrors: string[] = [];
  const identitySet = new Set<string>();
  const sourceShaSet = new Set<string>();

  for (const key of [...storedByKey.keys()].sort()) {
    const entry = storedByKey.get(key)!;
    let raw: string;
    try {
      raw = await readFile(entry.abs, "utf8");
    } catch (err) {
      schemaErrors.push(`${key}: unreadable (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const parsed = parseCaseReport(raw, key);
    if (parsed instanceof Error) {
      schemaErrors.push(parsed.message);
      continue;
    }
    if (parsed.resultCount !== 1) {
      duplicates.push(`${key}: report carries ${parsed.resultCount} results (expected exactly 1)`);
    }
    if (parsed.success === null) notRecordedFields.push(`${key}: success`);
    if (parsed.terminationReason === NOT_RECORDED) notRecordedFields.push(`${key}: termination_reason`);
    for (const [field, value] of [
      ["model_calls", parsed.modelCalls],
      ["tool_calls", parsed.toolCalls],
      ["input_tokens", parsed.tokensInput],
      ["output_tokens", parsed.tokensOutput],
      ["duration_ms", parsed.durationMs],
    ] as const) {
      if (value === null) notRecordedFields.push(`${key}: ${field}`);
    }
    if (parsed.sourceSha === null) notRecordedFields.push(`${key}: sourceSha(gitSha)`);
    const identity = parsed.provider !== null && parsed.model !== null ? `${parsed.provider}/${parsed.model}` : null;
    if (identity === null) notRecordedFields.push(`${key}: identity(provider/model)`);
    else identitySet.add(identity);
    if (parsed.sourceSha !== null) sourceShaSet.add(parsed.sourceSha);

    cases.push({
      suite: entry.suite,
      caseId: entry.caseId,
      stored: true,
      success: parsed.success,
      terminationReason: parsed.terminationReason,
      modelCalls: parsed.modelCalls,
      toolCalls: parsed.toolCalls,
      tokensInput: parsed.tokensInput,
      tokensOutput: parsed.tokensOutput,
      durationMs: parsed.durationMs,
      sourceSha: parsed.sourceSha,
      provider: parsed.provider,
      model: parsed.model,
      judgeVersion: parsed.judgeVersion,
      artifactPath: entry.rel,
      artifactSha256: artifactHashes.find((a) => a.path === entry.rel)?.sha256 ?? "",
    });
  }

  check(
    checks,
    "CAMPAIGN_ARTIFACT_SCHEMA_INVALID",
    schemaErrors.length === 0,
    schemaErrors.length === 0 ? "every stored report parses and carries results[]" : schemaErrors.join("; "),
  );
  check(
    checks,
    "CAMPAIGN_FIELD_NOT_RECORDED",
    notRecordedFields.length === 0,
    notRecordedFields.length === 0
      ? "every stored report records success/termination/model_calls/tokens/duration/sourceSha/identity"
      : `fields missing from the raw data are reported as not_recorded (never back-filled): ${notRecordedFields.slice(0, 12).join("; ")}${notRecordedFields.length > 12 ? ` (+${notRecordedFields.length - 12} more)` : ""}`,
  );
  check(
    checks,
    "CAMPAIGN_SECRET_FOUND",
    secretFindings.length === 0,
    secretFindings.length === 0 ? "no secret-shaped material in the stored artifacts" : secretFindings.slice(0, 8).join("; "),
  );

  // ---- 5. Case-set checks ----
  check(
    checks,
    "CAMPAIGN_MISSING_CASE",
    missing.length === 0,
    missing.length === 0 ? `all ${expectedKeys.size} expected cases have a stored final result` : `${missing.length} expected case(s) have no stored result: ${missing.slice(0, 12).join(", ")}`,
  );
  check(
    checks,
    "CAMPAIGN_UNKNOWN_CASE",
    unknown.length === 0,
    unknown.length === 0 ? "no unexpected case directories" : `unexpected case(s) not in the versioned source: ${unknown.slice(0, 12).join(", ")}`,
  );
  check(
    checks,
    "CAMPAIGN_MULTIPLE_FINAL_RESULTS",
    duplicates.length === 0,
    duplicates.length === 0 ? "exactly one final result per case" : `duplicate/multiple final results: ${duplicates.slice(0, 12).join("; ")}`,
  );
  check(
    checks,
    "CAMPAIGN_NO_CASE_ARTIFACTS",
    storedByKey.size > 0,
    storedByKey.size > 0
      ? `${storedByKey.size} case artifact(s) discovered under results/`
      : "no case artifacts found — a campaign summary alone is not evidence (summary-only directories fail closed)",
  );
  const setMatches = missing.length === 0 && unknown.length === 0 && duplicates.length === 0 && storedByKey.size === expectedKeys.size;
  check(
    checks,
    "CAMPAIGN_CASE_SET_MISMATCH",
    setMatches,
    setMatches
      ? `stored (suite, caseId) set is exactly the versioned expected set (${expectedKeys.size} cases)`
      : `stored set does not equal the expected set: expected ${expectedKeys.size}, stored ${storedByKey.size}, missing ${missing.length}, unknown ${unknown.length}, duplicate ${duplicates.length}`,
  );

  // ---- 6. Resume manifest ↔ final results ----
  let manifestRecords: ManifestRecord[] = [];
  const manifestAbs = join(root, manifestRel);
  if (!(await exists(manifestAbs))) {
    check(checks, "CAMPAIGN_MANIFEST_MISSING", false, `resume manifest missing: ${manifestRel} — the resume/attempt record cannot be reconstructed`);
  } else {
    const { records, errors } = parseCampaignManifest(await readFile(manifestAbs, "utf8"));
    manifestRecords = records;
    check(
      checks,
      "CAMPAIGN_MANIFEST_TRUNCATED",
      errors.length === 0,
      errors.length === 0 ? `every line of ${manifestRel} is a complete JSON record (${records.length} record(s))` : `${manifestRel}: ${errors.join("; ")}`,
    );
    const malformed = records.filter((r) => !expectedKeys.has(`${r.suite}/${r.caseId}`));
    check(
      checks,
      "CAMPAIGN_MANIFEST_RECORD_INVALID",
      malformed.length === 0,
      malformed.length === 0 ? "every manifest record names an expected case" : `manifest names unknown case(s): ${malformed.slice(0, 12).map((r) => `line ${r.lineNumber} ${r.suite}/${r.caseId}`).join(", ")}`,
    );
    // Resume semantics: a case may appear more than once ONLY when every
    // earlier attempt failed (that IS the resume record). The LAST attempt for
    // a case must be ok=true exactly when a final result is stored.
    const byKey = new Map<string, ManifestRecord[]>();
    for (const rec of records) {
      const key = `${rec.suite}/${rec.caseId}`;
      const list = byKey.get(key) ?? [];
      list.push(rec);
      byKey.set(key, list);
    }
    const resumeProblems: string[] = [];
    for (const [key, list] of byKey) {
      const ordered = [...list].sort((a, b) => a.lineNumber - b.lineNumber);
      for (const earlier of ordered.slice(0, -1)) {
        if (earlier.ok) resumeProblems.push(`${key}: line ${earlier.lineNumber} succeeded but the case was attempted again`);
      }
      const last = ordered[ordered.length - 1]!;
      const stored = storedByKey.has(key);
      if (stored && !last.ok) resumeProblems.push(`${key}: a final result is stored but the last manifest record (line ${last.lineNumber}) reports failure`);
      if (!stored && last.ok) resumeProblems.push(`${key}: the last manifest record (line ${last.lineNumber}) reports success but no final result is stored`);
    }
    for (const key of storedByKey.keys()) {
      if (!byKey.has(key)) resumeProblems.push(`${key}: stored final result has no manifest record`);
    }
    const okRecords = records.filter((r) => r.ok).length;
    if (okRecords !== storedByKey.size) {
      resumeProblems.push(`manifest ok=true records (${okRecords}) != stored final results (${storedByKey.size})`);
    }
    check(
      checks,
      "CAMPAIGN_MANIFEST_RESUME_MISMATCH",
      resumeProblems.length === 0,
      resumeProblems.length === 0
        ? `resume manifest is 1:1 with the stored final results (${storedByKey.size} case(s), ${records.length} record(s))`
        : resumeProblems.slice(0, 12).join("; "),
    );
  }

  // ---- 7. Re-derive aggregates from the RAW case reports ----
  const terminationReasons: Record<string, number> = {};
  const suiteDistribution: Record<string, number> = {};
  const sourceShaDistribution: Record<string, number> = {};
  const identityDistribution: Record<string, number> = {};
  let passed = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  let tokensInput = 0;
  let tokensOutput = 0;
  for (const c of cases) {
    bump(terminationReasons, c.terminationReason);
    bump(suiteDistribution, c.suite);
    if (c.sourceSha !== null) bump(sourceShaDistribution, c.sourceSha);
    if (c.provider !== null && c.model !== null) bump(identityDistribution, `${c.provider}/${c.model}`);
    if (c.success === true) passed += 1;
    modelCalls += c.modelCalls ?? 0;
    toolCalls += c.toolCalls ?? 0;
    tokensInput += c.tokensInput ?? 0;
    tokensOutput += c.tokensOutput ?? 0;
  }
  const storedCases = cases.length;
  const processRunSuccesses = manifestRecords.filter((r) => r.ok).length;
  const processRunFailures = manifestRecords.filter((r) => !r.ok).length;
  const summary: CampaignSummary = {
    suites: Object.keys(suiteDistribution).length,
    expectedCases: expectedKeys.size,
    storedCases,
    passed,
    failed: storedCases - passed,
    processRunSuccesses,
    processRunFailures,
    modelCalls,
    toolCalls,
    tokensInput,
    tokensOutput,
    terminationReasons: sortedKeys(terminationReasons),
    suiteDistribution: sortedKeys(suiteDistribution),
    sourceShaDistribution: sortedKeys(sourceShaDistribution),
    identityDistribution: sortedKeys(identityDistribution),
  };

  // ---- 8. Submitted sanitized summary must equal the re-derived truth ----
  if (!(await exists(summaryPath))) {
    check(checks, "CAMPAIGN_SUMMARY_MISSING", false, `submitted summary missing: ${posix(relative(root, summaryPath))} — the committed numbers cannot be cross-checked`);
  } else {
    let declared: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(await readFile(summaryPath, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        declared = parsed as Record<string, unknown>;
      }
    } catch (err) {
      check(checks, "CAMPAIGN_SUMMARY_INVALID", false, `${posix(relative(root, summaryPath))}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    }
    if (declared === null) {
      check(checks, "CAMPAIGN_SUMMARY_INVALID", false, `${posix(relative(root, summaryPath))}: not a JSON object`);
    } else {
      check(checks, "CAMPAIGN_SUMMARY_INVALID", true, `${posix(relative(root, summaryPath))} parses as a JSON object`);
      const mismatches: string[] = [];
      const cmpNumber = (label: string, declaredValue: unknown, actual: number): void => {
        if (declaredValue === undefined) {
          mismatches.push(`${label}: not declared (recomputed ${actual})`);
          return;
        }
        if (typeof declaredValue !== "number" || !Number.isFinite(declaredValue)) {
          mismatches.push(`${label}: declared value is not a finite number`);
          return;
        }
        if (declaredValue !== actual) mismatches.push(`${label}: declared ${declaredValue} != recomputed ${actual}`);
      };
      cmpNumber("storedCases", declared.storedCases, storedCases);
      cmpNumber("storedPassing", declared.storedPassing, passed);
      cmpNumber("modelCallsTotal", declared.modelCallsTotal, modelCalls);

      const tokensTotal = (declared.tokensTotal ?? {}) as Record<string, unknown>;
      cmpNumber("tokensTotal.input", tokensTotal.input, tokensInput);
      cmpNumber("tokensTotal.output", tokensTotal.output, tokensOutput);

      const declaredSuite = (declared.expected ?? {}) as Record<string, unknown>;
      for (const suite of suites) {
        cmpNumber(`expected.${suite}`, declaredSuite[suite], suiteDistribution[suite] ?? 0);
      }

      const declaredTerm = declared.terminationDistribution;
      if (!Array.isArray(declaredTerm)) {
        mismatches.push("terminationDistribution: not declared as an array");
      } else {
        const asRecord: Record<string, number> = {};
        for (const row of declaredTerm) {
          if (row === null || typeof row !== "object") continue;
          const rec = row as Record<string, unknown>;
          if (typeof rec.reason === "string" && typeof rec.count === "number") asRecord[rec.reason] = rec.count;
        }
        const keys = [...new Set([...Object.keys(asRecord), ...Object.keys(terminationReasons)])].sort();
        for (const key of keys) {
          if ((asRecord[key] ?? 0) !== (terminationReasons[key] ?? 0)) {
            mismatches.push(`terminationDistribution.${key}: declared ${asRecord[key] ?? 0} != recomputed ${terminationReasons[key] ?? 0}`);
          }
        }
      }
      check(
        checks,
        "CAMPAIGN_SUMMARY_MISMATCH",
        mismatches.length === 0,
        mismatches.length === 0
          ? "the submitted summary equals the values recomputed from the raw case reports"
          : mismatches.slice(0, 12).join("; "),
      );

      // Source SHA distribution: only SHAs the summary itself declares.
      const declaredShas = options.allowedSourceShas ??
        (Array.isArray(declared.gitShas) ? declared.gitShas.filter((s): s is string => typeof s === "string") : []);
      if (declaredShas.length === 0) {
        check(checks, "CAMPAIGN_SOURCE_SHA_DRIFT", false, "the submitted summary declares no source SHA, so the per-case SHA distribution cannot be admitted");
      } else {
        const allowed = new Set(declaredShas);
        const drifted = [...sourceShaSet].filter((sha) => !allowed.has(sha)).sort();
        const undeclared = [...sourceShaSet].filter((sha) => !(sha in sourceShaDistribution)).sort();
        void undeclared;
        check(
          checks,
          "CAMPAIGN_SOURCE_SHA_DRIFT",
          drifted.length === 0,
          drifted.length === 0
            ? `every stored case reports a declared source SHA (${[...allowed].sort().join(", ")})`
            : `stored cases report source SHA(s) the summary does not declare: ${drifted.join(", ")}`,
        );
      }
    }
  }

  // ---- 9. Identity drift ----
  check(
    checks,
    "CAMPAIGN_IDENTITY_DRIFT",
    identitySet.size <= 1,
    identitySet.size <= 1
      ? identitySet.size === 1
        ? `all stored cases ran under one identity: ${[...identitySet][0]}`
        : "no identity recorded"
      : `stored cases ran under ${identitySet.size} identities: ${[...identitySet].sort().join(", ")}`,
  );

  // ---- 10. Empty-campaign guard ----
  check(
    checks,
    "CAMPAIGN_EMPTY",
    expectedKeys.size > 0 && storedByKey.size > 0,
    expectedKeys.size > 0 && storedByKey.size > 0
      ? `campaign is non-empty (${storedByKey.size} stored case(s))`
      : "campaign is empty (no expected cases and/or no stored artifacts) — an empty directory is never VALID",
  );

  return finish(checks, summary, artifactHashes, cases, rootDigest, rawRootDigest);
}

function finish(
  checks: CampaignCheck[],
  summary: CampaignSummary,
  artifactHashes: Array<{ path: string; sha256: string; rawSha256: string }>,
  cases: CampaignCaseRecord[],
  rootDigest = "",
  rawRootDigest = "",
): CampaignValidationResult {
  const errors = checks.filter((c) => !c.passed);
  const reasonCodes = [...new Set(errors.map((e) => e.code))].sort() as CampaignReasonCode[];
  return {
    ok: errors.length === 0,
    reasonCodes,
    checks,
    errors,
    summary,
    rootDigest,
    rawRootDigest,
    artifactHashes,
    cases,
  };
}

// ---------------------------------------------------------------------------
// Sanitized, machine-readable evidence manifest
// ---------------------------------------------------------------------------

export interface CampaignEvidenceManifest {
  schemaVersion: 1;
  kind: "campaign-evidence";
  /**
   * Where the evidence came from. NEVER an absolute path and never a private
   * directory: a path inside the repository is recorded as a POSIX-relative
   * path, anything else as a stable `external:<digest>` label. A committed
   * evidence manifest must not leak the operator's filesystem layout.
   */
  generatedFrom: { campaignRoot: string; casesRoot: string };
  rootDigest: string;
  declaredSummary: CampaignSummary;
  /** Per-artifact SHA-256 (POSIX path relative to the campaign root). */
  artifactHashes: Array<{ path: string; sha256: string }>;
  /** Reviewer-facing rows: ONLY the fields needed to re-check the numbers.
   *  No prompt, no model output, no absolute path, no key. */
  cases: Array<{
    suite: string;
    caseId: string;
    sourceSha: string;
    identity: string;
    identityDigest: string;
    termination: string;
    passed: boolean;
    modelCalls: number | null;
    toolCalls: number | null;
    tokensInput: number | null;
    tokensOutput: number | null;
    durationMs: number | null;
    artifactSha256: string;
  }>;
}

/**
 * A path safe to commit: POSIX-relative when it lives inside the current
 * working directory, otherwise a stable non-reversible label. Never absolute.
 */
export function safePathLabel(target: string): string {
  const rel = posix(relative(process.cwd(), resolve(target)));
  if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  return `external:${sha256Bytes(Buffer.from(resolve(target), "utf8")).slice(0, 16)}`;
}

/**
 * Build the sanitized evidence manifest from a validated campaign. Refuses to
 * emit evidence for a campaign that does not validate — evidence is never
 * produced for a campaign whose numbers cannot be recomputed.
 */
export async function buildCampaignEvidenceManifest(
  options: CampaignValidateOptions,
): Promise<{ manifest: CampaignEvidenceManifest } | { error: string; reasonCodes: CampaignReasonCode[] }> {
  const result = await validateCampaign(options);
  if (!result.ok) {
    return { error: `campaign does not validate (${result.reasonCodes.join(", ")})`, reasonCodes: result.reasonCodes };
  }
  const manifest: CampaignEvidenceManifest = {
    schemaVersion: 1,
    kind: "campaign-evidence",
    generatedFrom: {
      campaignRoot: safePathLabel(options.root),
      casesRoot: safePathLabel(options.casesRoot ?? "benchmarks"),
    },
    rootDigest: result.rootDigest,
    declaredSummary: result.summary,
    artifactHashes: result.artifactHashes,
    cases: result.cases.map((c) => {
      const identity = c.provider !== null && c.model !== null ? `${c.provider}/${c.model}` : NOT_RECORDED;
      return {
        suite: c.suite,
        caseId: c.caseId,
        sourceSha: c.sourceSha ?? NOT_RECORDED,
        identity,
        identityDigest: sha256Bytes(Buffer.from(identity, "utf8")),
        termination: c.terminationReason,
        passed: c.success === true,
        modelCalls: c.modelCalls,
        toolCalls: c.toolCalls,
        tokensInput: c.tokensInput,
        tokensOutput: c.tokensOutput,
        durationMs: c.durationMs,
        artifactSha256: c.artifactSha256,
      };
    }),
  };
  return { manifest };
}
