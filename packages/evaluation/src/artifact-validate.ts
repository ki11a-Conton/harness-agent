// P38.4-6 — Benchmark artifact validation and sanitization.
//
// A free deterministic command that answers:
// - Are these benchmark artifacts complete?
// - Are the claims mathematically consistent?
// - Are there duplicate/missing cases?
// - Do the summaries match the per-case runs?
// - Are obvious secrets present?

import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import type { BenchmarkCaseResult } from "./baseline.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  summary: { suites: number; cases: number; passed: number; failed: number };
}

export interface SanitizeCheckResult {
  ok: boolean;
  matches: string[];
}

// ---------------------------------------------------------------------------
// Secret scan
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /\b[Aa][Pp][Ii]_?[Kk][Ee][Yy]\b/,
  /\b[Aa][Pp][Ii][Kk][Ee][Yy]\b/,
  /\b[Aa][Cc][Cc][Ee][Ss][Ss]_[Tt][Oo][Kk][Ee][Nn]\b/,
  /\b[Rr][Ee][Ff][Rr][Ee][Ss][Hh]_[Tt][Oo][Kk][Ee][Nn]\b/,
  /\b[Ss][Ee][Cc][Rr][Ee][Tt]\b/,
  /\b[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]\b/,
  /\b[Cc][Oo][Oo][Kk][Ii][Ee]\b/,
  /\b[Ss][Ee][Tt]-[Cc][Oo][Oo][Kk][Ii][Ee]\b/,
  /[Xx]-[Aa][Pp][Ii]-[Kk][Ee][Yy]/,
  /[Bb][Ee][Aa][Rr][Ee][Rr]\s+\S{10,}/,
  /\bsk-[A-Za-z0-9]{10,}\b/,
];

/** Scan a string for secret-shaped patterns. Returns the list of matched
 *  pattern descriptions (empty = clean). */
export function scanForSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) {
      hits.push(re.source);
    }
  }
  return hits;
}

/** Check a JSON-deserialized object for secret-shaped values (recursive
 *  string scan). */
export function checkSecrets(obj: unknown): SanitizeCheckResult {
  const matches: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      const found = scanForSecrets(value);
      matches.push(...found);
    } else if (value !== null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) {
        walk(v);
      }
    }
  };
  walk(obj);
  return { ok: matches.length === 0, matches };
}

// ---------------------------------------------------------------------------
// Artifact validation
// ---------------------------------------------------------------------------

/** Validate a committed benchmark results directory.
 *
 *  Expected layout:
 *    manifest.json
 *    <suite>-summary.json          (per suite)
 *    <suite>-runs.sanitized.json   (optional per suite)
 *    overall-summary.json          (optional)
 *    overall-summary.md            (optional)
 */
export async function validateBenchmarkArtifacts(
  resultDir: string,
): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let totalCases = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  let suiteCount = 0;

  // 1. manifest.json must exist and be valid JSON
  let manifest: Record<string, unknown>;
  try {
    const raw = await readFile(join(resultDir, "manifest.json"), "utf8");
    manifest = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    errors.push(`manifest.json: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, errors, warnings, summary: { suites: 0, cases: 0, passed: 0, failed: 0 } };
  }

  // 2. Check manifest schema version
  if (typeof manifest.schemaVersion !== "number") {
    errors.push("manifest.json: missing or non-numeric schemaVersion");
  }

  // 3. Secret scan on manifest
  const manifestSecrets = checkSecrets(manifest);
  if (!manifestSecrets.ok) {
    errors.push(`manifest.json: secrets found (${manifestSecrets.matches.length} matches)`);
  }

  // 4. Discover per-suite summary files
  const entries = await readdir(resultDir);
  const suiteSummaries = entries.filter(
    (e) => e.endsWith("-summary.json") && e !== "overall-summary.json" && e !== "manifest.json",
  );

  for (const summaryFile of suiteSummaries) {
    suiteCount += 1;
    const suiteName = summaryFile.replace("-summary.json", "");
    let raw: unknown;

    try {
      const content = await readFile(join(resultDir, summaryFile), "utf8");
      raw = JSON.parse(content);
    } catch (err) {
      errors.push(`${summaryFile}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Secret scan on summary
    const summarySecrets = checkSecrets(raw);
    if (!summarySecrets.ok) {
      errors.push(`${summaryFile}: secrets found (${summarySecrets.matches.length} matches)`);
    }

    const asRecord = raw as Record<string, unknown>;

    // Support TWO summary shapes:
    //   A) BaselineReport  { meta: { suite }, summary: { total, passed, ... } }
    //   B) flat committed  { suite, cases, passed, passRate, ... }  (P38.3)
    const reportSuite = (asRecord.meta as Record<string, unknown> | undefined)?.suite ?? asRecord.suite;
    if (typeof reportSuite === "string" && reportSuite !== suiteName) {
      errors.push(`${summaryFile}: suite "${reportSuite}" does not match filename suite "${suiteName}"`);
    }

    const meta = asRecord.meta as Record<string, unknown> | undefined;
    const summaryBlock = asRecord.summary as Record<string, unknown> | undefined;
    const isFlat = summaryBlock === undefined && typeof asRecord.cases === "number";

    const cases = isFlat ? (asRecord.cases as number) : (summaryBlock?.total as number | undefined);
    const passed = isFlat ? (asRecord.passed as number) : (summaryBlock?.passed as number | undefined);
    const failed = isFlat ? (asRecord.failed as number) : (summaryBlock?.failed as number | undefined);
    const errorsCount = isFlat ? (asRecord.errors as number | undefined) : (summaryBlock?.errors as number | undefined);

    if (cases !== undefined) {
      if (typeof cases !== "number" || !Number.isFinite(cases) || cases < 0) {
        errors.push(`${summaryFile}: invalid case count ${cases}`);
      } else {
        if (passed !== undefined && failed !== undefined && errorsCount !== undefined) {
          const sum = passed + failed + errorsCount;
          if (sum !== cases) {
            errors.push(
              `${summaryFile}: cases (${cases}) != passed (${passed}) + failed (${failed}) + errors (${errorsCount}) = ${sum}`,
            );
          }
        }
        totalCases += cases;
        totalPassed += typeof passed === "number" ? passed : 0;
        totalFailed += (typeof failed === "number" ? failed : 0) + (typeof errorsCount === "number" ? errorsCount : 0);
      }
    }
    if (passed !== undefined && (typeof passed !== "number" || !Number.isFinite(passed) || passed < 0)) {
      errors.push(`${summaryFile}: invalid passed count ${passed}`);
    }
    if (failed !== undefined && (typeof failed !== "number" || !Number.isFinite(failed) || failed < 0)) {
      errors.push(`${summaryFile}: invalid failed count ${failed}`);
    }

    // Non-finite token/cost values (both shapes)
    const numericValues = isFlat
      ? [asRecord.tokensInput, asRecord.tokensOutput, asRecord.estimatedCostUsd]
      : [summaryBlock?.avg_tokens_input, summaryBlock?.avg_tokens_output, summaryBlock?.avg_cost_score];
    for (const val of numericValues) {
      if (typeof val === "number" && !Number.isFinite(val)) {
        errors.push(`${summaryFile}: non-finite value ${val}`);
      }
    }

    // Check for per-case runs file
    const runsFile = join(resultDir, `${suiteName}-runs.sanitized.json`);
    const runsFileAlt = join(resultDir, `runs.sanitized.json`);
    const runsFileSuite = join(resultDir, `${suiteName}-runs.json`);
    let runsFileToUse: string | undefined;
    try {
      await stat(runsFile);
      runsFileToUse = runsFile;
    } catch {
      try {
        await stat(runsFileAlt);
        runsFileToUse = runsFileAlt;
      } catch {
        try {
          await stat(runsFileSuite);
          runsFileToUse = runsFileSuite;
        } catch {
          // runs file is optional if summary is from a different source
        }
      }
    }

    if (runsFileToUse !== undefined) {
      try {
        const runsRaw = await readFile(runsFileToUse, "utf8");
        const runsData = JSON.parse(runsRaw) as { results?: BenchmarkCaseResult[] } | BenchmarkCaseResult[];

        const runs: BenchmarkCaseResult[] = Array.isArray(runsData) ? runsData : (runsData.results ?? []);

        if (runs.length > 0 && cases !== undefined) {
          // Check case count consistency
          if (runs.length !== cases) {
            errors.push(
              `${basename(runsFileToUse)}: ${runs.length} runs != summary cases ${cases}`,
            );
          }

          // Check for duplicate case IDs
          const ids = runs.map((r) => r.task_id);
          const seen = new Set<string>();
          for (const id of ids) {
            if (id === undefined) continue;
            if (seen.has(id)) {
              errors.push(`${basename(runsFileToUse)}: duplicate case_id "${id}"`);
            }
            seen.add(id);
          }

          // Check for missing case IDs (if expected manifest is available)
          const expectedManifest = manifest.perSuiteCaseIds as Record<string, string[]> | undefined;
          if (expectedManifest?.[suiteName]) {
            const expectedIds = new Set(expectedManifest[suiteName]);
            for (const id of expectedIds) {
              if (!seen.has(id)) {
                errors.push(`${basename(runsFileToUse)}: missing expected case "${id}"`);
              }
            }
            for (const id of seen) {
              if (!expectedIds.has(id)) {
                errors.push(`${basename(runsFileToUse)}: unexpected case "${id}"`);
              }
            }
          }

          // Check judgeVersion consistency
          const judgeVersions = new Set(runs.map((r) => r.judge_version).filter(Boolean));
          if (judgeVersions.size > 1) {
            warnings.push(
              `${basename(runsFileToUse)}: inconsistent judgeVersion across runs: ${[...judgeVersions].join(", ")}`,
            );
          }

          // Secret scan on runs
          const runsSecrets = checkSecrets(runsData);
          if (!runsSecrets.ok) {
            errors.push(`${basename(runsFileToUse)}: secrets found (${runsSecrets.matches.length} matches)`);
          }
        }
      } catch (err) {
        warnings.push(`${basename(runsFileToUse)}: could not read (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  }

  // 5. Check overall-summary if present
  const overallSummaryFile = join(resultDir, "overall-summary.json");
  try {
    const raw = await readFile(overallSummaryFile, "utf8");
    const overall = JSON.parse(raw) as Record<string, unknown>;
    const overallSecrets = checkSecrets(overall);
    if (!overallSecrets.ok) {
      errors.push(`overall-summary.json: secrets found (${overallSecrets.matches.length} matches)`);
    }
  } catch {
    // overall-summary is optional
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: { suites: suiteCount, cases: totalCases, passed: totalPassed, failed: totalFailed },
  };
}

// ---------------------------------------------------------------------------
// Deterministic summary derivation
// ---------------------------------------------------------------------------

export interface DeriveSummaryResult {
  suite: string;
  caseIds: string[];
  total: number;
  passed: number;
  failed: number;
  errors: number;
  successRate: number;
  failureCategories: Record<string, number>;
  terminationReasons: Record<string, number>;
  tokensInput: number;
  tokensOutput: number;
  toolCalls: number;
  securityViolations: number;
  verificationFailures: number;
  falseCompletes: number;
}

/** Derive a truthful summary from per-case benchmark runs. This is
 *  deterministic: given the same runs, the output is always the same.
 *  No external state, no randomness, no runtime access. */
export function deriveBenchmarkSummary(
  runs: BenchmarkCaseResult[],
  suiteName: string,
): DeriveSummaryResult {
  const total = runs.length;
  const passed = runs.filter((r) => r.success).length;
  const errors = runs.filter((r) => r.actual_status === "error").length;
  const failed = total - passed - errors;

  const failureCategories: Record<string, number> = {};
  const terminationReasons: Record<string, number> = {};
  let tokensInput = 0;
  let tokensOutput = 0;
  let toolCalls = 0;
  let securityViolations = 0;
  let verificationFailures = 0;
  let falseCompletes = 0;

  for (const r of runs) {
    if (r.failure_category !== undefined) {
      failureCategories[r.failure_category] = (failureCategories[r.failure_category] ?? 0) + 1;
    }
    terminationReasons[r.termination_reason] = (terminationReasons[r.termination_reason] ?? 0) + 1;
    tokensInput += r.input_tokens ?? 0;
    tokensOutput += r.output_tokens ?? 0;
    toolCalls += r.tool_calls ?? 0;
    securityViolations += r.violations?.length ?? 0;
    verificationFailures += r.verification_failures ?? 0;
    if (r.false_complete) falseCompletes += 1;
  }

  return {
    suite: suiteName,
    caseIds: runs.map((r) => r.task_id).filter((id): id is string => id !== undefined),
    total,
    passed,
    failed,
    errors,
    successRate: total === 0 ? 0 : passed / total,
    failureCategories,
    terminationReasons,
    tokensInput,
    tokensOutput,
    toolCalls,
    securityViolations,
    verificationFailures,
    falseCompletes,
  };
}