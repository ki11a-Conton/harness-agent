/**
 * E4-R08 + E4-R18 — runtime observation evidence.
 *
 * `observed` in the usage audit is never inferred from a symbol appearing in
 * an E2E-named file (a comment, string or import would count). Instead, a real
 * passing production-path test records an ObservationEvidence row AFTER its
 * assertions hold, and the audit marks a capability observed ONLY for rows that
 * are strict-valid AND whose testedSourceSha EXACTLY matches the audited HEAD.
 *
 * E4-R18 (N15/N16) integrity redesign:
 *   - STRICT reader: every field is required and typed; `testedSourceSha` must
 *     be a 40-hex git sha (null/unknown is NOT a valid strict row); the
 *     `evidenceDigest` is RECOMPUTED over the canonical row body and must
 *     match — a fabricated all-zero digest row is rejected;
 *   - PER-RUN isolation: every test run writes to its OWN runId-namespaced
 *     file (`<dir>/<runId>.jsonl`). The audit consumes a SPECIFIC run file, so
 *     an old successful run can never mask a current failure;
 *   - TWO-PHASE commit: `observeCapability`-style writers do NOT exist anymore.
 *     A run COLLECTS candidate observations during the test and commits them
 *     ONLY after every assertion passed (the test-end hook). A test that fails
 *     after observing leaves NO passed proof behind.
 *
 * The evidence lives in a TEST/evidence directory (never the audit's own
 * output), so the audit consuming it does not recursively prove itself.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

export const OBSERVATION_EVIDENCE_SCHEMA_VERSION = "e4-r18-v1";

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

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ENTRYPOINTS = new Set(["cli", "web", "benchmark", "release"]);

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
  if (!str("invocation")) issues.push("invocation missing");
  if (typeof r.evidenceDigest !== "string" || !HEX64.test(r.evidenceDigest)) {
    issues.push("evidenceDigest must be 64-hex");
  }
  // Recompute the digest over the canonical body — a fabricated/edited row is
  // rejected even when all fields LOOK plausible.
  if (typeof r.evidenceDigest === "string" && HEX64.test(r.evidenceDigest)) {
    const recomputed = computeObservationEvidenceDigest(value as Record<string, unknown>);
    if (recomputed !== r.evidenceDigest) {
      issues.push("evidenceDigest does not recompute over the row body");
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

/** The runId-namespaced evidence file (one run = one file — a failed rerun
 *  leaves no file behind, so it can never mask a current failure). */
export function observationEvidencePathForRun(runId: string): string {
  return join(observationEvidenceDir(), `${runId}.jsonl`);
}

/** Read the committed rows of ONE run strictly. */
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
      out.push(parseObservationEvidence(JSON.parse(line) as unknown));
    } catch (err) {
      process.stderr.write(`[degraded] observation-evidence unreadable row: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return out;
}

/** Read the committed rows of EVERY run (diagnostic mode — release-grade
 *  auditing passes a specific runId instead). */
export function loadAllObservationEvidence(): ObservationEvidence[] {
  let entries: string[];
  try {
    entries = readdirSync(observationEvidenceDir());
  } catch {
    return [];
  }
  const out: ObservationEvidence[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    for (const row of loadObservationEvidence(entry.slice(0, -".jsonl".length))) {
      out.push(row);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// E4-R18 (N16): two-phase commit — a test collects candidate observations and
// commits them ONLY after its final result is passed.
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
   *  durable proof is written until commit() — a later assertion failure in
   *  the same test leaves nothing behind. */
  observe(ev: {
    capabilityId: string;
    symbol: string;
    entrypoint: ObservationEvidence["entrypoint"];
    invocation: string;
  }): void;
  /** TEST-END HOOK: persist every collected row as a PASSED observation.
   *  Call ONLY after all assertions have passed. Idempotent. */
  commit(): void;
}

export function createObservationRun(input: ObservationRunInput): ObservationCollector {
  const pending: Array<{ capabilityId: string; symbol: string; entrypoint: ObservationEvidence["entrypoint"]; invocation: string }> = [];
  let committed = false;
  return {
    runId: input.runId,
    observe(ev) {
      pending.push(ev);
    },
    commit() {
      if (committed) return;
      committed = true;
      try {
        const rows = pending.map((ev) => {
          const body: Omit<ObservationEvidence, "evidenceDigest"> = {
            schemaVersion: OBSERVATION_EVIDENCE_SCHEMA_VERSION,
            runId: input.runId,
            capabilityId: ev.capabilityId,
            symbol: ev.symbol,
            entrypoint: ev.entrypoint,
            testFile: input.testFile,
            testName: input.testName,
            testedSourceSha: input.testedSourceSha,
            runStatus: "passed",
            invocation: ev.invocation,
          };
          return { ...body, evidenceDigest: computeObservationEvidenceDigest(body as unknown as Record<string, unknown>) };
        });
        mkdirSync(observationEvidenceDir(), { recursive: true });
        const path = observationEvidencePathForRun(input.runId);
        if (rows.length === 0) {
          appendFileSync(path, "", "utf8"); // an empty committed run still exists
          return;
        }
        writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
      } catch (err) {
        process.stderr.write(
          `[degraded] observation-evidence commit failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    },
  };
}

/** git HEAD sha at audit/test time (null when the checkout is not a repo). */
export function gitHeadShaAt(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}
