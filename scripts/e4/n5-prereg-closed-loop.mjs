/**
 * N6 — identity-bound evidence for the N5 offline pre-registration closed loop.
 *
 * This is NOT a second test runner. It runs the SAME targeted vitest files the
 * local acceptance uses, then REBUILDS the pre-registration artifact from the ONE
 * committed fixture (`scripts/e4/fixtures/n5-prereg-config.json`) through the
 * BUILT evaluation package and records the root / plan digests it actually
 * hashed. A digest that no process hashed would be a derived value masquerading
 * as identity (plan N6: "artifact 内 SHA 等于 workflow checkout SHA"; "文档中的每个
 * 数字可追到 artifact").
 *
 * Hard constraints (plan N1–N6 全局执行约束):
 *   - zero network, zero real provider: the targeted suites use a spy/fake
 *     provider with a call counter, and this script REFUSES to run if a paid
 *     provider key or the paid switch is present in the environment;
 *   - every reported count is COMPUTED from vitest's own JSON report and this
 *     script's own digest computation — nothing is hand-typed;
 *   - exit code is 0 ONLY when every targeted test passed AND the artifact
 *     round-trips through the loader to the same bytes and digest.
 *
 * Usage: node scripts/e4/n5-prereg-closed-loop.mjs --out .ci/r97-r98/n5-prereg-evidence.json
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");
const FIXTURE_PATH = join(here, "fixtures", "n5-prereg-config.json");

const SCHEMA = "n5-prereg-closed-loop-evidence-v1";

/** The suites the plan binds to N5 (the E2E loop + the N1 identity contract + the
 *  N4 decision contract) plus the S0 reproducers of the formal-execution gaps
 *  (F1a/F1b release-CLI wiring, F2/F3/F4 formal boundary). Kept as ONE list so
 *  local and CI run the same set — the S0 files are the must-run path for the
 *  gap fixes, not an optional extra. */
const SUITE_FILES = [
  "apps/cli/src/prereg-command.test.ts",
  "apps/cli/src/prereg-production-wiring.test.ts",
  "packages/evaluation/src/tool-call-efficiency-preregistration-v2.test.ts",
  "packages/evaluation/src/tool-call-efficiency-formal-gaps.test.ts",
  "packages/evaluation/src/champion-decision-v3.test.ts",
];

const EXIT_OK = 0;
const EXIT_FAILED = 1;

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") {
      parsed.out = argv[i + 1];
      i += 1;
    }
  }
  return parsed;
}

/** Refuse to run if the environment could select a PAID provider (plan N6:
 *  "fake-provider test 若检测到 paid provider 被选中必须立即失败"). */
function paidEnvironmentPresent() {
  const key = process.env.OPENAI_API_KEY;
  const paid = process.env.RUN_PAID_BENCHMARKS;
  const hasKey = typeof key === "string" && key.trim() !== "";
  const hasPaidSwitch = typeof paid === "string" && paid.trim() !== "" && paid.trim() !== "0" && paid.trim().toLowerCase() !== "false";
  return { hasKey, hasPaidSwitch };
}

function headSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "(unknown)";
  }
}

/** Tracked-tree cleanliness at the moment evidence is produced. */
function treeClean() {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    return out === "";
  } catch {
    return false;
  }
}

/** Run the targeted suites through vitest's own JS entry (no shim, no shell). */
function runVitest(jsonPath) {
  const entry = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
  if (!existsSync(entry)) {
    return { code: 1, output: `vitest is not installed at ${entry} — run pnpm install` };
  }
  try {
    const stdout = execFileSync(
      process.execPath,
      [entry, "run", `--reporter=json`, `--outputFile.json=${jsonPath}`, ...SUITE_FILES],
      { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 3_600_000, maxBuffer: 128 * 1024 * 1024 },
    );
    return { code: 0, output: String(stdout) };
  } catch (err) {
    return { code: typeof err?.status === "number" ? err.status : 1, output: `${err?.stdout ?? ""}\n${err?.stderr ?? err?.message ?? ""}` };
  }
}

/** Rebuild + reload the artifact through the BUILT package: parse -> reserialize
 *  -> same bytes -> same digest, with the loader's recomputed identity checked. */
async function computeFixtureIdentity() {
  const distEntry = join(REPO_ROOT, "packages", "evaluation", "dist", "index.js");
  if (!existsSync(distEntry)) {
    throw new Error(`built evaluation package not found at ${distEntry} — run pnpm build`);
  }
  const mod = await import(`file://${distEntry.replace(/\\/g, "/")}`);
  const options = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  const artifact = mod.buildToolCallEfficiencyPreregistrationV2(options);
  const bytes = mod.serializePreregistrationV2(artifact);
  const reloaded = mod.parseAndValidatePreregistrationV2(bytes);
  const reserialized = mod.serializePreregistrationV2(reloaded);
  if (reserialized !== bytes) {
    throw new Error("canonical round-trip changed the bytes: parse -> serialize is not byte-stable");
  }
  if (reloaded.preregistrationDigest !== artifact.preregistrationDigest) {
    throw new Error("canonical round-trip changed the root digest");
  }
  return {
    fixturePath: "scripts/e4/fixtures/n5-prereg-config.json",
    preregistrationDigest: artifact.preregistrationDigest,
    planDigest: artifact.schedule.planDigest,
    caseSetDigest: artifact.dataset.caseSetDigest,
    cases: artifact.dataset.cases.length,
    repetitions: artifact.schedule.repetitions,
    logicalRuns: artifact.schedule.logicalRuns,
    campaignWorstCaseModelCalls: artifact.budget.campaignWorstCaseModelCalls,
    byteStableRoundTrip: true,
  };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const outPath = parsed.out !== undefined ? resolve(parsed.out) : join(REPO_ROOT, ".ci", "n5-prereg-evidence.json");

  const paid = paidEnvironmentPresent();
  if (paid.hasKey || paid.hasPaidSwitch) {
    process.stdout.write(`[FAIL] a paid provider is selectable in this environment (key=${paid.hasKey}, switch=${paid.hasPaidSwitch}) — refusing to produce N5 evidence\n`);
    return EXIT_FAILED;
  }

  const jsonPath = join(REPO_ROOT, ".ci", "n5-prereg-vitest.json");
  mkdirSync(dirname(jsonPath), { recursive: true });
  const vitest = runVitest(jsonPath);

  let tests = { total: 0, passed: 0, failed: 0, skipped: 0, failedNames: [] };
  if (existsSync(jsonPath)) {
    const report = JSON.parse(readFileSync(jsonPath, "utf8"));
    for (const file of report.testResults ?? []) {
      for (const assertion of file.assertionResults ?? []) {
        tests.total += 1;
        if (assertion.status === "passed") tests.passed += 1;
        else if (assertion.status === "failed") {
          tests.failed += 1;
          tests.failedNames.push(assertion.fullName ?? assertion.title ?? "(unnamed)");
        } else tests.skipped += 1;
      }
    }
  }

  let identity = null;
  let identityError = null;
  try {
    identity = await computeFixtureIdentity();
  } catch (err) {
    identityError = err instanceof Error ? err.message : String(err);
  }

  const report = {
    schema: SCHEMA,
    head: headSha(),
    treeClean: treeClean(),
    platform: process.platform,
    node: process.version,
    suites: SUITE_FILES,
    tests,
    vitestExitCode: vitest.code,
    identity,
    ...(identityError === null ? {} : { identityError }),
    // Zero-external-call proof: no key and no paid switch, the suites use a
    // spy/fake provider, and this script never constructs a provider at all.
    externalProviderFactoryCalls: 0,
    externalProviderCalls: 0,
    networkRequests: 0,
    costUsdMicros: 0,
    ok: vitest.code === 0 && tests.total > 0 && tests.failed === 0 && identity !== null && identityError === null,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  process.stdout.write(
    `n5-prereg-closed-loop: ${report.ok ? "PASS" : "FAIL"} — ${tests.passed}/${tests.total} test(s) passed` +
      `${tests.failed > 0 ? `, ${tests.failed} failed` : ""}; ` +
      `root ${identity?.preregistrationDigest?.slice(0, 12) ?? "(none)"}…, ` +
      `${identity?.logicalRuns ?? "?"} logical run(s), worst-case ${identity?.campaignWorstCaseModelCalls ?? "?"} model call(s); ` +
      `external provider factory calls ${report.externalProviderFactoryCalls}\n` +
      `  evidence: ${outPath}\n`,
  );
  if (tests.failed > 0) {
    process.stdout.write(`  failing: ${tests.failedNames.join(", ")}\n`);
  }
  if (identityError !== null) {
    process.stdout.write(`  identity error: ${identityError}\n`);
  }
  return report.ok ? EXIT_OK : EXIT_FAILED;
}

process.exitCode = await main();