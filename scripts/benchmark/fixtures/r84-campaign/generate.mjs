#!/usr/bin/env node
/**
 * E4-R84 — deterministic generator for the committed synthetic campaign fixture.
 *
 * The fixture is what CI runs on BOTH `windows-latest` and `ubuntu-latest`:
 * a small, fully synthetic campaign (2 suites / 3 cases) whose numbers are
 * known by construction. It contains NO real prompt, NO model output, NO
 * endpoint, NO key and NO absolute path — the user's private R83 campaign is
 * never uploaded as a CI artifact.
 *
 * Committing the generator (not just its output) is deliberate: a reviewer can
 * re-run it and see that the fixture was not hand-tuned to make the validator
 * pass. Every value below is fixed; the generator is pure and idempotent.
 *
 * Usage:
 *   node scripts/benchmark/fixtures/r84-campaign/generate.mjs          # write
 *   node scripts/benchmark/fixtures/r84-campaign/generate.mjs --check  # verify
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Synthetic campaign shape: adversarial 2 + stress 1 = 3 cases.
 *
 * The suite NAMES are real (`adversarial` / `stress`) because `agent benchmark
 * --suite` only accepts the four versioned suite names; the CASE IDS are
 * obviously fake. Using real suite names means the runner exercises its real
 * staging + dry-run + digest path, while the campaign is still tiny, fully
 * synthetic and free (0 provider calls in --dry-run).
 */
export const FIXTURE_SUITE_COUNTS = { adversarial: 2, stress: 1 };

/** Fixed cases. `aaaa1111` / `bbbb2222` are obviously-fake SHAs, not real ones. */
export const FIXTURE_CASES = [
  { suite: "adversarial", caseId: "syn-adv-1", success: true, termination: "verified_complete", modelCalls: 4, tokensInput: 100, tokensOutput: 20, sourceSha: "aaaa1111" },
  { suite: "adversarial", caseId: "syn-adv-2", success: false, termination: "tool_limit", modelCalls: 7, tokensInput: 250, tokensOutput: 40, sourceSha: "aaaa1111" },
  { suite: "stress", caseId: "syn-str-1", success: false, termination: "agent_limit", modelCalls: 9, tokensInput: 300, tokensOutput: 60, sourceSha: "bbbb2222" },
];

const FIXED_TS = "1970-01-01T00:00:00.000Z";

export function reportJson(c) {
  return `${JSON.stringify({
    meta: {
      generatedAt: FIXED_TS,
      benchmarkVersion: "2.0.0",
      model: { providerId: "test", modelId: "synthetic-1" },
      casesTotal: 1,
      suite: c.suite,
    },
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
      platform: "synthetic",
      nodeVersion: "v0",
    },
  }, null, 2)}\n`;
}

export function summaryJson(cases) {
  const term = {};
  const suite = {};
  const shas = {};
  for (const c of cases) {
    term[c.termination] = (term[c.termination] ?? 0) + 1;
    suite[c.suite] = (suite[c.suite] ?? 0) + 1;
    shas[c.sourceSha] = (shas[c.sourceSha] ?? 0) + 1;
  }
  return `${JSON.stringify({
    generatedAt: FIXED_TS,
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

/** Every file the fixture consists of, as `<posix path>` → exact bytes. */
export function fixtureFiles() {
  const files = new Map();
  for (const c of FIXTURE_CASES) {
    files.set(`cases/${c.suite}/${c.caseId}/request.md`, `do ${c.caseId}\n`);
    files.set(`cases/${c.suite}/${c.caseId}/expected.md`, "done\n");
    const reportName = c.suite === "regression" ? "baseline.json" : `${c.suite}.json`;
    files.set(`campaign/results/${c.suite}/${c.caseId}/${reportName}`, reportJson(c));
  }
  const manifestLines = FIXTURE_CASES.map((c) => JSON.stringify({
    ts: FIXED_TS, suite: c.suite, caseId: c.caseId, ok: true, error: null, elapsedSec: 1,
  }));
  files.set("campaign/manifest.jsonl", `${manifestLines.join("\n")}\n`);
  files.set("campaign/campaign-summary.json", summaryJson(FIXTURE_CASES));
  return files;
}

async function main() {
  const check = process.argv.includes("--check");
  const files = fixtureFiles();
  let mismatches = 0;
  for (const [rel, content] of files) {
    const abs = join(HERE, rel);
    if (check) {
      let actual;
      try {
        actual = await readFile(abs, "utf8");
      } catch {
        actual = undefined;
      }
      if (actual !== content) {
        mismatches += 1;
        console.error(`FIXTURE DRIFT: ${rel}`);
      }
    } else {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    }
  }
  if (check) {
    if (mismatches > 0) {
      console.error(`r84 fixture check: ${mismatches} file(s) drifted — re-run the generator`);
      process.exit(1);
    }
    console.log(`r84 fixture check: ${files.size} file(s) match the generator`);
    return;
  }
  console.log(`r84 fixture: wrote ${files.size} file(s)`);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  await main();
}
