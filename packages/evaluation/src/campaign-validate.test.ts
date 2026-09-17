/**
 * E4-R84 (F84-1) — table-driven tests for the campaign-level validator.
 *
 * Every negative case must fail closed with a STABLE reason code, and the
 * positive case must re-derive the committed numbers from the raw per-case
 * reports. The suite is deterministic and offline: no provider, no network.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CAMPAIGN_EXPECTED_SUITE_COUNTS,
  buildCampaignEvidenceManifest,
  campaignReportFileName,
  expectedCampaignCases,
  parseCampaignManifest,
  parseCaseReport,
  scanCampaignForSecrets,
  validateCampaign,
  type CampaignReasonCode,
} from "./campaign-validate.js";

/**
 * Recorded digest of the committed fixture. MUST be identical on Windows and
 * Linux: the digest is computed after CRLF→LF normalization and over
 * POSIX-normalized relative paths. Because it covers EVERY byte of every
 * committed fixture file, pinning it here is also the check that the fixture
 * still matches `scripts/benchmark/fixtures/r84-campaign/generate.mjs` — the
 * generator's own `--check` mode (run by `selfcheck-campaign-runner.ps1` and by
 * CI) reports drift by file name.
 */
const FIXTURE_ROOT_DIGEST = "26167402acbde04eddad4535bfb8fbbf16c9be20f6e2b5866f26b602740525c8";

// ---------------------------------------------------------------------------
// Synthetic campaign builder (deterministic; no timestamps, no absolute paths)
// ---------------------------------------------------------------------------

/** The synthetic shape used by these tests: 2 suites, 3 cases total. */
const SYNTHETIC_COUNTS: Record<string, number> = { alpha: 2, beta: 1 };
const SYNTHETIC_TOTAL = 3;

interface SyntheticCase {
  suite: string;
  caseId: string;
  success: boolean;
  termination: string;
  modelCalls: number;
  tokensInput: number;
  tokensOutput: number;
  sourceSha: string;
}

const SYNTHETIC_CASES: SyntheticCase[] = [
  { suite: "alpha", caseId: "a-1", success: true, termination: "verified_complete", modelCalls: 4, tokensInput: 100, tokensOutput: 20, sourceSha: "aaaa1111" },
  { suite: "alpha", caseId: "a-2", success: false, termination: "tool_limit", modelCalls: 7, tokensInput: 250, tokensOutput: 40, sourceSha: "aaaa1111" },
  { suite: "beta", caseId: "b-1", success: false, termination: "agent_limit", modelCalls: 9, tokensInput: 300, tokensOutput: 60, sourceSha: "bbbb2222" },
];

/** A committed-shape report: meta + one result + summary + manifest. */
function reportJson(c: SyntheticCase): string {
  return `${JSON.stringify({
    meta: { generatedAt: "1970-01-01T00:00:00.000Z", benchmarkVersion: "2.0.0", model: { providerId: "test", modelId: "synthetic-1" }, casesTotal: 1, suite: c.suite },
    results: [{
      task_id: c.caseId,
      suite: c.suite,
      judge_version: "1.0.0",
      success: c.success,
      actual_status: c.success ? "completed" : "failed",
      duration_ms: 1234,
      model_calls: c.modelCalls,
      input_tokens: c.tokensInput,
      output_tokens: c.tokensOutput,
      tool_calls: c.modelCalls,
      termination_reason: c.termination,
    }],
    summary: { total: 1, passed: c.success ? 1 : 0, failed: c.success ? 0 : 1, errors: 0 },
    manifest: {
      gitSha: c.sourceSha,
      dirty: false,
      model: "synthetic-1",
      provider: "test",
      judgeVersion: "1.0.0",
      platform: "test",
      nodeVersion: "v0",
    },
  }, null, 2)}\n`;
}

function summaryJson(cases: readonly SyntheticCase[]): string {
  const term: Record<string, number> = {};
  const suite: Record<string, number> = {};
  const shas: Record<string, number> = {};
  for (const c of cases) {
    term[c.termination] = (term[c.termination] ?? 0) + 1;
    suite[c.suite] = (suite[c.suite] ?? 0) + 1;
    shas[c.sourceSha] = (shas[c.sourceSha] ?? 0) + 1;
  }
  return `${JSON.stringify({
    generatedAt: "1970-01-01T00:00:00.000Z",
    root: "synthetic",
    gitShas: Object.keys(shas).sort(),
    expected: suite,
    expectedTotal: cases.length,
    storedCases: cases.length,
    storedPassing: cases.filter((c) => c.success).length,
    terminationDistribution: Object.entries(term).sort().map(([reason, count]) => ({ reason, count })),
    tokensTotal: {
      input: cases.reduce((a, c) => a + c.tokensInput, 0),
      output: cases.reduce((a, c) => a + c.tokensOutput, 0),
    },
    modelCallsTotal: cases.reduce((a, c) => a + c.modelCalls, 0),
  }, null, 2)}\n`;
}

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Build a synthetic campaign root + case source. Returns both paths. */
async function buildCampaign(options?: {
  cases?: SyntheticCase[];
  /** Skip writing this case's report (simulates a missing case). */
  omitReportFor?: string;
  /** Extra report file inside a case dir (simulates a duplicate final result). */
  duplicateReportFor?: string;
  /** Overwrite a case report's raw bytes with this text. */
  corruptReportFor?: { caseId: string; text: string };
  /** Omit the whole suite directory from the case source. */
  omitSuiteFromSource?: string;
  /** Omit the manifest entirely. */
  omitManifest?: boolean;
  /** Append this raw text to the manifest (no trailing newline added). */
  appendManifestRaw?: string;
  /** Overwrite the summary with this text. */
  summaryOverride?: string;
  /** Omit the summary. */
  omitSummary?: boolean;
  /** Add an extra, unexpected case directory under results/. */
  extraResultCase?: string;
  /** Extra file written under results/<suite>/<caseId>/ (hash tamper target). */
  extraEvidenceFile?: { suite: string; caseId: string; name: string; text: string };
}): Promise<{ root: string; casesRoot: string }> {
  const base = await mkdtemp(join(tmpdir(), "e4-r84-campaign-"));
  tempDirs.push(base);
  const casesRoot = join(base, "cases");
  const root = join(base, "campaign");
  const cases = options?.cases ?? SYNTHETIC_CASES;

  // Versioned case source: <casesRoot>/<suite>/<caseId>/request.md
  for (const c of cases) {
    if (options?.omitSuiteFromSource === c.suite) continue;
    const dir = join(casesRoot, c.suite, c.caseId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "request.md"), `do ${c.caseId}\n`, "utf8");
    await writeFile(join(dir, "expected.md"), "done\n", "utf8");
  }

  // Campaign results
  await mkdir(join(root, "results"), { recursive: true });
  for (const c of cases) {
    if (options?.omitReportFor === c.caseId) continue;
    const caseDir = join(root, "results", c.suite, c.caseId);
    await mkdir(caseDir, { recursive: true });
    const reportName = campaignReportFileName(c.suite);
    const text = options?.corruptReportFor?.caseId === c.caseId
      ? options.corruptReportFor.text
      : reportJson(c);
    await writeFile(join(caseDir, reportName), text, "utf8");
    if (options?.duplicateReportFor === c.caseId) {
      // A second recognised final report in the SAME case dir.
      const alt = c.suite === "regression" ? "regression.json" : "baseline.json";
      await writeFile(join(caseDir, alt), reportJson(c), "utf8");
    }
    if (options?.extraEvidenceFile !== undefined &&
        options.extraEvidenceFile.suite === c.suite && options.extraEvidenceFile.caseId === c.caseId) {
      await writeFile(join(caseDir, options.extraEvidenceFile.name), options.extraEvidenceFile.text, "utf8");
    }
  }
  if (options?.extraResultCase !== undefined) {
    const dir = join(root, "results", "alpha", options.extraResultCase);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "alpha.json"), reportJson({ ...SYNTHETIC_CASES[0]!, caseId: options.extraResultCase }), "utf8");
  }

  // Resume manifest: one ok=true line per stored case.
  if (options?.omitManifest !== true) {
    const stored = cases.filter((c) => options?.omitReportFor !== c.caseId);
    const lines = stored.map((c) => JSON.stringify({ ts: "1970-01-01T00:00:00.000Z", suite: c.suite, caseId: c.caseId, ok: true, error: null, elapsedSec: 1 }));
    let text = lines.join("\n");
    if (options?.appendManifestRaw !== undefined) text += `\n${options.appendManifestRaw}`;
    await writeFile(join(root, "manifest.jsonl"), `${text}\n`, "utf8");
  }

  if (options?.omitSummary !== true) {
    await writeFile(join(root, "campaign-summary.json"), options?.summaryOverride ?? summaryJson(cases), "utf8");
  }

  return { root, casesRoot };
}

async function validate(
  built: { root: string; casesRoot: string },
  overrides?: Partial<Parameters<typeof validateCampaign>[0]>,
) {
  return validateCampaign({
    root: built.root,
    casesRoot: built.casesRoot,
    expectedSuiteCounts: SYNTHETIC_COUNTS,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Positive case
// ---------------------------------------------------------------------------

describe("E4-R84 campaign validator — valid campaign", () => {
  it("re-derives every aggregate from the raw case reports and reports process vs case success separately", async () => {
    const built = await buildCampaign();
    const result = await validate(built);

    expect(result.ok).toBe(true);
    expect(result.reasonCodes).toEqual([]);
    expect(result.summary.storedCases).toBe(SYNTHETIC_TOTAL);
    expect(result.summary.expectedCases).toBe(SYNTHETIC_TOTAL);
    expect(result.summary.passed).toBe(1);
    expect(result.summary.failed).toBe(2);
    // Process execution success (runner stored a report) is 3/3 — DIFFERENT from
    // case success (1/3). The two must never be conflated.
    expect(result.summary.processRunSuccesses).toBe(3);
    expect(result.summary.processRunFailures).toBe(0);
    expect(result.summary.modelCalls).toBe(20);
    expect(result.summary.tokensInput).toBe(650);
    expect(result.summary.tokensOutput).toBe(120);
    expect(result.summary.terminationReasons).toEqual({ agent_limit: 1, tool_limit: 1, verified_complete: 1 });
    expect(result.summary.suiteDistribution).toEqual({ alpha: 2, beta: 1 });
    expect(result.summary.sourceShaDistribution).toEqual({ aaaa1111: 2, bbbb2222: 1 });
    expect(result.rootDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.artifactHashes.length).toBeGreaterThan(0);
    // Sorted, POSIX-normalized relative paths (no backslashes on Windows).
    const paths = result.artifactHashes.map((a) => a.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths.every((p) => !p.includes("\\"))).toBe(true);
    expect(paths.some((p) => p === "manifest.jsonl")).toBe(true);
  });

  it("is deterministic: validating twice yields the identical root digest", async () => {
    const built = await buildCampaign();
    const first = await validate(built);
    const second = await validate(built);
    expect(first.rootDigest).toBe(second.rootDigest);
    expect(JSON.stringify(first.summary)).toBe(JSON.stringify(second.summary));
  });
});

// ---------------------------------------------------------------------------
// Table-driven negative cases — each MUST fail closed with a stable code
// ---------------------------------------------------------------------------

describe("E4-R84 campaign validator — fail-closed negative cases", () => {
  const table: Array<{
    name: string;
    code: CampaignReasonCode;
    build: () => Promise<{ root: string; casesRoot: string }>;
    options?: Partial<Parameters<typeof validateCampaign>[0]>;
  }> = [
    {
      name: "missing case (no stored report)",
      code: "CAMPAIGN_MISSING_CASE",
      build: () => buildCampaign({ omitReportFor: "a-2" }),
    },
    {
      name: "unknown case (results dir carries a case absent from the versioned source)",
      code: "CAMPAIGN_UNKNOWN_CASE",
      build: () => buildCampaign({ extraResultCase: "a-zz" }),
    },
    {
      name: "duplicate case (two recognised final reports in one case dir)",
      code: "CAMPAIGN_MULTIPLE_FINAL_RESULTS",
      build: () => buildCampaign({ duplicateReportFor: "a-1" }),
    },
    {
      name: "artifact hash mismatch (an unrecorded evidence file appears)",
      code: "CAMPAIGN_ARTIFACT_HASH_MISMATCH",
      build: () => buildCampaign({ extraEvidenceFile: { suite: "alpha", caseId: "a-1", name: "run.log", text: "line\n" } }),
      // Tamper DETECTION requires the recorded hashes: the campaign is always
      // tamper-EVIDENT (root digest), and becomes tamper-DETECTING when the
      // previously emitted evidence manifest is supplied.
      options: { expectedRootDigest: "0".repeat(64) },
    },
    {
      name: "summary tampering (declared passing count inflated)",
      code: "CAMPAIGN_SUMMARY_MISMATCH",
      build: async () => {
        const cases = SYNTHETIC_CASES;
        const tampered = JSON.parse(summaryJson(cases)) as Record<string, unknown>;
        tampered.storedPassing = 3;
        return buildCampaign({ summaryOverride: `${JSON.stringify(tampered, null, 2)}\n` });
      },
    },
    {
      name: "summary tampering (declared token total changed)",
      code: "CAMPAIGN_SUMMARY_MISMATCH",
      build: async () => {
        const tampered = JSON.parse(summaryJson(SYNTHETIC_CASES)) as Record<string, unknown>;
        tampered.tokensTotal = { input: 1, output: 1 };
        return buildCampaign({ summaryOverride: `${JSON.stringify(tampered, null, 2)}\n` });
      },
    },
    {
      name: "source SHA drift (stored case reports an undeclared SHA)",
      code: "CAMPAIGN_SOURCE_SHA_DRIFT",
      build: () => buildCampaign({
        cases: [SYNTHETIC_CASES[0]!, SYNTHETIC_CASES[1]!, { ...SYNTHETIC_CASES[2]!, sourceSha: "cccc3333" }],
      }),
      options: { allowedSourceShas: ["aaaa1111", "bbbb2222"] },
    },
    {
      name: "manifest truncated (last line is a partial JSON record)",
      code: "CAMPAIGN_MANIFEST_TRUNCATED",
      build: () => buildCampaign({ appendManifestRaw: '{"ts":"1970-01-01T00:00:00.000Z","suite":"alpha","caseId":"a-2","ok":' }),
    },
    {
      name: "manifest missing",
      code: "CAMPAIGN_MANIFEST_MISSING",
      build: () => buildCampaign({ omitManifest: true }),
    },
    {
      name: "empty directory",
      code: "CAMPAIGN_EMPTY",
      build: async () => {
        const base = await mkdtemp(join(tmpdir(), "e4-r84-empty-"));
        tempDirs.push(base);
        const root = join(base, "campaign");
        await mkdir(join(root, "results"), { recursive: true });
        return { root, casesRoot: join(base, "cases") };
      },
    },
    {
      name: "summary-only tree (no raw case reports)",
      code: "CAMPAIGN_NO_CASE_ARTIFACTS",
      build: async () => {
        const base = await mkdtemp(join(tmpdir(), "e4-r84-summaryonly-"));
        tempDirs.push(base);
        const root = join(base, "campaign");
        await mkdir(root, { recursive: true });
        await writeFile(join(root, "campaign-summary.json"), summaryJson(SYNTHETIC_CASES), "utf8");
        await writeFile(join(root, "manifest.jsonl"), "", "utf8");
        return { root, casesRoot: join(base, "cases") };
      },
    },
    {
      name: "secret hit in a stored artifact",
      code: "CAMPAIGN_SECRET_FOUND",
      build: () => buildCampaign({
        extraEvidenceFile: { suite: "beta", caseId: "b-1", name: "run.log", text: "authorization: Bearer abcdefghijklmnopqrstuvwxyz012345\n" },
      }),
    },
    {
      name: "campaign root does not exist",
      code: "CAMPAIGN_ROOT_MISSING",
      build: async () => {
        const base = await mkdtemp(join(tmpdir(), "e4-r84-noroot-"));
        tempDirs.push(base);
        return { root: join(base, "does-not-exist"), casesRoot: join(base, "cases") };
      },
    },
  ];

  for (const row of table) {
    it(`${row.name} → ${row.code}`, async () => {
      const built = await row.build();
      const result = await validate(built, row.options);
      expect(result.ok).toBe(false);
      expect(result.reasonCodes).toContain(row.code);
      // Every failure carries a non-empty, human-readable detail.
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.every((e) => e.detail.length > 0)).toBe(true);
    });
  }

  it("a missing suite in the versioned source is a declared-shape mismatch", async () => {
    const built = await buildCampaign({ omitSuiteFromSource: "beta" });
    const result = await validate(built);
    expect(result.ok).toBe(false);
    expect(result.reasonCodes).toContain("CAMPAIGN_SUITE_COUNT_MISMATCH");
    expect(result.reasonCodes).toContain("CAMPAIGN_SUITE_MISSING");
  });

  it("a report with a malformed schema fails closed instead of back-filling", async () => {
    const built = await buildCampaign({ corruptReportFor: { caseId: "a-1", text: "{ not json" } });
    const result = await validate(built);
    expect(result.ok).toBe(false);
    expect(result.reasonCodes).toContain("CAMPAIGN_ARTIFACT_SCHEMA_INVALID");
  });

  it("a report missing recorded fields fails closed as not_recorded", async () => {
    const partial = `${JSON.stringify({
      meta: { suite: "alpha" },
      results: [{ task_id: "a-1", suite: "alpha", success: true, termination_reason: "verified_complete" }],
      manifest: { provider: "test", model: "synthetic-1" },
    })}\n`;
    const built = await buildCampaign({ corruptReportFor: { caseId: "a-1", text: partial } });
    const result = await validate(built);
    expect(result.ok).toBe(false);
    expect(result.reasonCodes).toContain("CAMPAIGN_FIELD_NOT_RECORDED");
  });

  it("a tampered artifact byte changes the root digest (hash is tamper-evident)", async () => {
    const built = await buildCampaign();
    const before = await validate(built);
    expect(before.ok).toBe(true);

    // Append ONE byte to a stored report's sibling evidence file. The digest
    // covers every file under results/, so the root digest must change.
    const target = join(built.root, "results", "alpha", "a-1", "run.log");
    await writeFile(target, "x\n", "utf8");
    const after = await validate(built);
    expect(after.rootDigest).not.toBe(before.rootDigest);
  });

  it("CRLF and LF encodings of the same campaign produce the same root digest", async () => {
    const built = await buildCampaign({ extraEvidenceFile: { suite: "alpha", caseId: "a-1", name: "run.log", text: "a\nb\n" } });
    const lf = await validate(built);
    await writeFile(join(built.root, "results", "alpha", "a-1", "run.log"), "a\r\nb\r\n", "utf8");
    const crlf = await validate(built);
    expect(crlf.rootDigest).toBe(lf.rootDigest);
  });

  it("R90: the NORMALIZED digest is CRLF/LF-equivalent but rawSha256 is NOT (byte audit)", async () => {
    // The plan's correction: `rootDigest` proves normalized CONTENT integrity,
    // not byte-level immutability. A byte auditor needs a separate raw hash, so
    // the two facts must be declared separately and must actually differ.
    const built = await buildCampaign({ extraEvidenceFile: { suite: "alpha", caseId: "a-1", name: "run.log", text: "a\nb\n" } });
    const lf = await validate(built);
    expect(lf.ok).toBe(true);
    const lfRaw = lf.artifactHashes.find((a) => a.path === "results/alpha/a-1/run.log")?.rawSha256;
    expect(lfRaw).toMatch(/^[0-9a-f]{64}$/);

    await writeFile(join(built.root, "results", "alpha", "a-1", "run.log"), "a\r\nb\r\n", "utf8");
    const crlf = await validate(built);
    // Normalized: identical (that is the cross-platform guarantee)...
    expect(crlf.rootDigest).toBe(lf.rootDigest);
    // ...but the raw bytes genuinely changed, and the raw hash says so.
    const crlfRaw = crlf.artifactHashes.find((a) => a.path === "results/alpha/a-1/run.log")?.rawSha256;
    expect(crlfRaw).not.toBe(lfRaw);
    expect(crlf.rawRootDigest).not.toBe(lf.rawRootDigest);
  });

  it("accepts both Windows and POSIX separators for the campaign root", async () => {
    const built = await buildCampaign();
    const posixRoot = built.root.split("\\").join("/");
    const result = await validate({ root: posixRoot, casesRoot: built.casesRoot });
    expect(result.ok).toBe(true);
    expect(result.artifactHashes.every((a) => !a.path.includes("\\"))).toBe(true);
  });

  it("an evidence file byte change is detected by the per-artifact hash listing", async () => {
    const built = await buildCampaign();
    const before = await validate(built);
    const target = join(built.root, "results", "beta", "b-1", campaignReportFileName("beta"));
    const original = await readFile(target, "utf8");
    await writeFile(target, original.replace('"model_calls": 9', '"model_calls": 10'), "utf8");
    const after = await validate(built);
    expect(after.ok).toBe(false);
    // The report no longer matches the submitted summary AND its hash changed.
    expect(after.reasonCodes).toContain("CAMPAIGN_SUMMARY_MISMATCH");
    const beforeHash = before.artifactHashes.find((a) => a.path === "results/beta/b-1/beta.json")?.sha256;
    const afterHash = after.artifactHashes.find((a) => a.path === "results/beta/b-1/beta.json")?.sha256;
    expect(afterHash).not.toBe(beforeHash);
  });
});

// ---------------------------------------------------------------------------
// Manifest semantics
// ---------------------------------------------------------------------------

describe("E4-R84 campaign validator — resume manifest semantics", () => {
  it("accepts a resumed case: failed attempts followed by a successful last attempt", async () => {
    const built = await buildCampaign();
    // Prepend two failed attempts for a-1 (that IS the resume record).
    const lines = [
      JSON.stringify({ ts: "1970-01-01T00:00:00.000Z", suite: "alpha", caseId: "a-1", ok: false, error: "RUN EXIT 1", elapsedSec: 3 }),
      JSON.stringify({ ts: "1970-01-01T00:00:01.000Z", suite: "alpha", caseId: "a-1", ok: false, error: "DRY-RUN FAILED", elapsedSec: 1 }),
    ];
    const existing = await readFile(join(built.root, "manifest.jsonl"), "utf8");
    await writeFile(join(built.root, "manifest.jsonl"), `${lines.join("\n")}\n${existing}`, "utf8");
    const result = await validate(built);
    expect(result.ok).toBe(true);
    expect(result.summary.processRunSuccesses).toBe(3);
    expect(result.summary.processRunFailures).toBe(2);
  });

  it("rejects a case whose final result is stored but whose last manifest record failed", async () => {
    const built = await buildCampaign();
    const lines = [
      JSON.stringify({ ts: "1970-01-01T00:00:00.000Z", suite: "alpha", caseId: "a-1", ok: true, error: null, elapsedSec: 1 }),
      JSON.stringify({ ts: "1970-01-01T00:00:01.000Z", suite: "alpha", caseId: "a-1", ok: false, error: "RUN EXIT 1", elapsedSec: 1 }),
    ];
    await writeFile(join(built.root, "manifest.jsonl"), `${lines.join("\n")}\n`, "utf8");
    const result = await validate(built);
    expect(result.ok).toBe(false);
    expect(result.reasonCodes).toContain("CAMPAIGN_MANIFEST_RESUME_MISMATCH");
  });

  it("rejects a manifest record naming a case that is not in the versioned source", async () => {
    const built = await buildCampaign();
    const extra = JSON.stringify({ ts: "1970-01-01T00:00:00.000Z", suite: "alpha", caseId: "not-a-real-case", ok: true, error: null, elapsedSec: 1 });
    const existing = await readFile(join(built.root, "manifest.jsonl"), "utf8");
    await writeFile(join(built.root, "manifest.jsonl"), `${existing}${extra}\n`, "utf8");
    const result = await validate(built);
    expect(result.ok).toBe(false);
    expect(result.reasonCodes).toContain("CAMPAIGN_MANIFEST_RECORD_INVALID");
  });

  it("parseCampaignManifest reports a partial trailing record without dropping it", () => {
    const { records, errors } = parseCampaignManifest('{"suite":"a","caseId":"1","ok":true}\n{"suite":"a","caseId":');
    expect(records).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("truncated or corrupt");
  });

  it("parseCaseReport refuses an empty results[] instead of inventing a case", () => {
    const parsed = parseCaseReport(JSON.stringify({ results: [], manifest: {} }), "alpha/a-1");
    expect(parsed).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Evidence manifest: sanitized, and refused for an invalid campaign
// ---------------------------------------------------------------------------

describe("E4-R84 campaign evidence manifest", () => {
  it("emits only reviewer-facing fields — no prompt, no output, no absolute path, no key", async () => {
    const built = await buildCampaign();
    const built_ = await buildCampaignEvidenceManifest({
      root: built.root,
      casesRoot: built.casesRoot,
      expectedSuiteCounts: SYNTHETIC_COUNTS,
    });
    expect("manifest" in built_).toBe(true);
    if (!("manifest" in built_)) return;
    const text = JSON.stringify(built_.manifest);
    // Absolute paths (the temp root) must never appear.
    expect(text).not.toContain(built.root.split("\\").join("\\"));
    expect(text).not.toContain(tmpdir().split("\\").join("\\"));
    expect(text).not.toMatch(/[A-Za-z]:[\\/]/);
    for (const row of built_.manifest.cases) {
      expect(Object.keys(row).sort()).toEqual([
        "artifactSha256", "caseId", "durationMs", "identity", "identityDigest",
        "modelCalls", "passed", "sourceSha", "suite", "termination",
        "tokensInput", "tokensOutput", "toolCalls",
      ]);
      expect(row.identityDigest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("refuses to emit evidence for a campaign that does not validate", async () => {
    const built = await buildCampaign({ omitReportFor: "a-2" });
    const result = await buildCampaignEvidenceManifest({
      root: built.root,
      casesRoot: built.casesRoot,
      expectedSuiteCounts: SYNTHETIC_COUNTS,
    });
    expect("error" in result).toBe(true);
  });

  it("the emitted manifest round-trips: re-validating with its hashes detects any later change", async () => {
    const built = await buildCampaign();
    const emitted = await buildCampaignEvidenceManifest({
      root: built.root,
      casesRoot: built.casesRoot,
      expectedSuiteCounts: SYNTHETIC_COUNTS,
    });
    expect("manifest" in emitted).toBe(true);
    if (!("manifest" in emitted)) return;
    const { manifest } = emitted;

    // Unchanged: the recorded hashes still match.
    const unchanged = await validateCampaign({
      root: built.root,
      casesRoot: built.casesRoot,
      expectedSuiteCounts: SYNTHETIC_COUNTS,
      expectedRootDigest: manifest.rootDigest,
      expectedArtifactHashes: manifest.artifactHashes,
    });
    expect(unchanged.ok).toBe(true);
    expect(unchanged.rootDigest).toBe(manifest.rootDigest);

    // One changed byte in ANY evidence file must now FAIL, not merely change
    // the digest. This is the tamper-DETECTING property.
    await writeFile(join(built.root, "results", "alpha", "a-1", "run.log"), "x\n", "utf8");
    const changed = await validateCampaign({
      root: built.root,
      casesRoot: built.casesRoot,
      expectedSuiteCounts: SYNTHETIC_COUNTS,
      expectedRootDigest: manifest.rootDigest,
      expectedArtifactHashes: manifest.artifactHashes,
    });
    expect(changed.ok).toBe(false);
    expect(changed.reasonCodes).toContain("CAMPAIGN_ARTIFACT_HASH_MISMATCH");
    // The finding names the offending file and never echoes file contents.
    const finding = changed.errors.find((e) => e.code === "CAMPAIGN_ARTIFACT_HASH_MISMATCH");
    expect(finding?.detail).toContain("results/alpha/a-1/run.log");
    expect(finding?.detail).not.toContain("x\n");
  });

  it("an ADDED or REMOVED evidence file is detected when hashes are supplied", async () => {
    const built = await buildCampaign();
    const emitted = await buildCampaignEvidenceManifest({
      root: built.root,
      casesRoot: built.casesRoot,
      expectedSuiteCounts: SYNTHETIC_COUNTS,
    });
    if (!("manifest" in emitted)) throw new Error("expected a manifest");
    const recorded = emitted.manifest.artifactHashes;

    // ADDED: a new file under results/ is not in the recorded set.
    await writeFile(join(built.root, "results", "alpha", "a-1", "sneaky.log"), "hi\n", "utf8");
    const added = await validateCampaign({
      root: built.root,
      casesRoot: built.casesRoot,
      expectedSuiteCounts: SYNTHETIC_COUNTS,
      expectedArtifactHashes: recorded,
    });
    expect(added.ok).toBe(false);
    expect(added.errors.some((e) => e.code === "CAMPAIGN_ARTIFACT_HASH_MISMATCH" && e.detail.includes("sneaky.log"))).toBe(true);

    // REMOVED: a recorded file is gone.
    await rm(join(built.root, "results", "alpha", "a-1", "sneaky.log"));
    await rm(join(built.root, "results", "beta", "b-1", "beta.json"));
    const removed = await validateCampaign({
      root: built.root,
      casesRoot: built.casesRoot,
      expectedSuiteCounts: SYNTHETIC_COUNTS,
      expectedArtifactHashes: recorded,
    });
    expect(removed.ok).toBe(false);
    expect(removed.errors.some((e) => e.code === "CAMPAIGN_ARTIFACT_HASH_MISMATCH" && e.detail.includes("missing on disk"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real committed campaign shape (R83) — declared constants
// ---------------------------------------------------------------------------

describe("E4-R84 declared campaign shape", () => {
  it("declares adversarial 13 / stress 11 / regression 30 / holdout 32 = 86", () => {
    expect(CAMPAIGN_EXPECTED_SUITE_COUNTS).toEqual({ adversarial: 13, stress: 11, regression: 30, holdout: 32 });
    const total = Object.values(CAMPAIGN_EXPECTED_SUITE_COUNTS).reduce((a, b) => a + b, 0);
    expect(total).toBe(86);
  });

  it("the versioned benchmark source matches the declared shape", async () => {
    const expected = await expectedCampaignCases("benchmarks");
    expect(expected).toHaveLength(86);
    const bySuite: Record<string, number> = {};
    for (const c of expected) bySuite[c.suite] = (bySuite[c.suite] ?? 0) + 1;
    expect(bySuite).toEqual(CAMPAIGN_EXPECTED_SUITE_COUNTS);
  });

  it("regression reports keep the historical baseline.json name", () => {
    expect(campaignReportFileName("regression")).toBe("baseline.json");
    expect(campaignReportFileName("holdout")).toBe("holdout.json");
  });
});

// ---------------------------------------------------------------------------
// Secret scanning never echoes the secret
// ---------------------------------------------------------------------------

describe("E4-R84 secret scan", () => {
  it("matches common secret shapes and returns only the pattern source", () => {
    const hits = scanCampaignForSecrets("sk-abcdefghijklmnopqrstuvwxyz\nAuthorization: Bearer abcdefghijklmnop");
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit).not.toContain("abcdefghij");
    }
  });

  it("passes clean text", () => {
    expect(scanCampaignForSecrets("termination_reason: tool_limit\nmodel_calls: 9")).toEqual([]);
  });

  it("detects URL userinfo and query tokens", () => {
    expect(scanCampaignForSecrets("https://user:pass@example.test/v1").length).toBeGreaterThan(0);
    expect(scanCampaignForSecrets("https://example.test/v1?api_key=abcdefghijklmn").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Committed synthetic fixture (used by CI on windows-latest AND ubuntu-latest)
// ---------------------------------------------------------------------------

describe("E4-R84 committed CI fixture", () => {
  const FIXTURE = join("scripts", "benchmark", "fixtures", "r84-campaign");
  const FIXTURE_SUITES = { adversarial: 2, stress: 1 };

  it("validates and produces the same root digest on every platform", async () => {
    const result = await validateCampaign({
      root: join(FIXTURE, "campaign"),
      casesRoot: join(FIXTURE, "cases"),
      expectedSuiteCounts: FIXTURE_SUITES,
    });
    expect(result.ok).toBe(true);
    expect(result.reasonCodes).toEqual([]);
    expect(result.summary.storedCases).toBe(3);
    expect(result.summary.passed).toBe(1);
    expect(result.summary.processRunSuccesses).toBe(3);
    expect(result.summary.modelCalls).toBe(20);
    expect(result.summary.tokensInput).toBe(650);
    expect(result.summary.tokensOutput).toBe(120);
    // A cross-platform digest: computed after CRLF→LF normalization, so this
    // exact value must hold on windows-latest and ubuntu-latest alike.
    expect(result.rootDigest).toBe(FIXTURE_ROOT_DIGEST);
  });

  it("contains no real R83 case id, endpoint, key or absolute path", async () => {
    // The fixture is what CI runs; it must be wholly synthetic. The digest pin
    // above already covers every byte, so this asserts the *content policy*.
    const { readdir } = await import("node:fs/promises");
    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(abs)));
        else out.push(abs);
      }
      return out;
    };
    const files = await walk(FIXTURE);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      if (file.endsWith("generate.mjs")) continue;
      const text = await readFile(file, "utf8");
      expect(text, file).not.toMatch(/[A-Za-z]:[\\/]/);
      expect(text, file).not.toMatch(/https?:\/\//);
      expect(text, file).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
      expect(text, file).not.toMatch(/api[_-]?key/i);
      // Real R83 case ids BEGIN with the suite prefix (adv-…, str-…, reg-…,
      // ho-…); the fixture's ids are "syn-…". The lookbehind keeps "syn-adv-1"
      // from being mistaken for a real "adv-…" id.
      expect(text, file).not.toMatch(/(?<![-\w])(adv|str|reg|ho)-\d/);
      // Real campaign SHAs are 40 hex chars; the fixture uses 8-char fakes.
      expect(text, file).not.toMatch(/\b[0-9a-f]{40}\b/);
    }
  });

  it("a byte change in the fixture is detected", async () => {
    const base = await mkdtemp(join(tmpdir(), "e4-r84-fixture-tamper-"));
    tempDirs.push(base);
    const copy = join(base, "campaign");
    await cp(join(FIXTURE, "campaign"), copy, { recursive: true });
    const before = await validateCampaign({ root: copy, casesRoot: join(FIXTURE, "cases"), expectedSuiteCounts: FIXTURE_SUITES });
    expect(before.ok).toBe(true);
    const reportPath = join(copy, "results", "stress", "syn-str-1", "stress.json");
    const text = await readFile(reportPath, "utf8");
    await writeFile(reportPath, text.replace('"model_calls": 9', '"model_calls": 10'), "utf8");
    const after = await validateCampaign({ root: copy, casesRoot: join(FIXTURE, "cases"), expectedSuiteCounts: FIXTURE_SUITES });
    expect(after.ok).toBe(false);
    expect(after.rootDigest).not.toBe(before.rootDigest);
  });

  it("the recorded digest detects the same byte change when supplied", async () => {
    const base = await mkdtemp(join(tmpdir(), "e4-r84-fixture-detect-"));
    tempDirs.push(base);
    const copy = join(base, "campaign");
    await cp(join(FIXTURE, "campaign"), copy, { recursive: true });
    await writeFile(join(copy, "results", "adversarial", "syn-adv-1", "extra.log"), "leak\n", "utf8");
    const result = await validateCampaign({
      root: copy,
      casesRoot: join(FIXTURE, "cases"),
      expectedSuiteCounts: FIXTURE_SUITES,
      expectedRootDigest: FIXTURE_ROOT_DIGEST,
    });
    expect(result.ok).toBe(false);
    expect(result.reasonCodes).toContain("CAMPAIGN_ARTIFACT_HASH_MISMATCH");
  });
});
