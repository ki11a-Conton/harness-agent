#!/usr/bin/env node
/**
 * E4-R101-A (T6) — the ANTI-CHEAT mutations (plan §T6 怎么做 7).
 *
 *   "mutation/反例直接改变行为：让两臂都用一个构建、跳过 verifier、固定 request=r97、
 *    绕过预算、resume 丢历史失败，对应测试必须失败."
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The plan's five mutations are the plan's own list of the ways this campaign could
 * be faked. A suite that passes while every one of them goes undetected proves
 * nothing about the suite — it proves only that the suite ran. So each mutation is
 * APPLIED to the real production source, the named test is run, and the test MUST
 * FAIL. The source is then restored, and the restoration is verified by hash.
 *
 * This is deliberately not a test file. It mutates production code on disk, so it
 * must never run as part of an ordinary suite where a crash could leave the tree
 * modified. It is a separate, explicitly invoked gate, and it restores the file in
 * a `finally` block.
 *
 * HOW EACH MUTATION IS APPLIED
 * ---------------------------
 * A mutation is a literal `find`/`replace` on one production file. A literal swap is
 * used rather than a regex so the mutation is exactly as wide as it looks, and the
 * script REFUSES to proceed if the `find` text is not present exactly once — a
 * mutation that silently did nothing would report a false "the test caught it".
 *
 * USAGE
 * -----
 *   node scripts/e4/r97-mutation-check.mjs
 *   node scripts/e4/r97-mutation-check.mjs --only arms-not-distinct
 *   node scripts/e4/r97-mutation-check.mjs --out .ci/r97-r98/mutation-report.json
 *
 * Exit codes: 0 = every mutation was caught · 1 = a mutation was NOT caught (or a
 * mutation could not be applied) · 2 = usage error.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");

export const MUTATION_VERSION = "e4-r101-mutation-check-v1";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_CONFIG = 2;

/**
 * The five mutations of plan §T6 怎么做 7, each bound to the test that must catch it.
 *
 * `find`/`replace` are literal strings. `test` is a `-t` filter for vitest, chosen
 * to be the test that exists to catch EXACTLY this mutation — not the whole file,
 * so a mutation that happens to break something unrelated is not mistaken for a
 * caught mutation.
 */
export const MUTATIONS = [
  {
    id: "same-build-for-both-arms",
    // 让两臂都用一个构建
    planWording: "让两臂都用一个构建",
    file: "packages/evaluation/src/r97-plan.ts",
    // `if (false)` would be a TYPE error (`baseline` is then possibly null), which
    // would make the mutation test the type system instead of the behaviour. This
    // variant keeps the narrowing and simply never fires — a same-build pair is
    // then accepted as two historical checkouts.
    find: `    if (baseline.sourceSha === candidate.sourceSha) {`,
    replace: `    if (baseline.sourceSha === candidate.sourceSha && baseline.arm === candidate.arm) {`,
    suite: "packages/evaluation/src/r97-plan.test.ts",
    test: "refuses two arms that observed the SAME build",
    catchExpectation: "ARMS_NOT_DISTINCT is no longer raised, so the readiness check reports none",
  },
  {
    id: "skip-verifier",
    // 跳过 verifier — a pass must be substantiated by the report's own verifier.
    planWording: "跳过 verifier",
    file: "scripts/e4/r97-arm-worker.mjs",
    find: `      category: "infrastructure",
      detail: \`E4-R98: case \${caseId} reports success=true but carries no verification evidence`,
    replace: `      category: null,
      detail: \`E4-R98: case \${caseId} reports success=true but carries no verification evidence`,
    suite: "packages/evaluation/src/r97-arm-worker-contract.test.ts",
    test: "success=true WITHOUT the report's own verification evidence",
    catchExpectation: "an unsubstantiated success is classified as a PASS instead of infrastructure",
  },
  {
    id: "fixed-request-placeholder",
    // 固定 request=r97 — every case would send the SAME request.
    planWording: "固定 request=r97",
    file: "scripts/e4/r97-arm-exec.mjs",
    find: `    prefix = [["text", \`done: \${caseDef.caseId}\`]];`,
    replace: `    prefix = [["text", "r97"]];`,
    suite: "packages/evaluation/src/r97-offline-seam.test.ts",
    test: "gives DIFFERENT cases DIFFERENT claim text",
    catchExpectation: "the request text is the same fixed placeholder for every case",
  },
  {
    id: "bypass-budget",
    // 绕过预算
    planWording: "绕过预算",
    file: "packages/evaluation/src/r97-budget-ledger.ts",
    find: `              reason: \`\${R97_BUDGET_EXHAUSTED}: \${count} logical call(s) requested but only \${currentView.remaining} of \${currentView.granted} remain`,
    replace: `              reason: \`\${count} logical call(s) requested but only \${currentView.remaining} of \${currentView.granted} remain`,
    suite: "packages/evaluation/src/r97-budget-ledger.test.ts",
    // The fixture test is the one that asserts the refusal NAMES the cause
    // (`expect(c.reason).toContain("BUDGET_EXHAUSTED")`), so dropping the name from
    // the reason is what it must catch.
    test: "the §R97 acceptance fixture: grant 3, arm A uses 2, arm B gets at most 1",
    catchExpectation: "an exhausted budget no longer names BUDGET_EXHAUSTED as the cause",
  },
  {
    id: "resume-loses-history",
    // resume 丢历史失败
    planWording: "resume 丢历史失败",
    file: "scripts/e4/r97-campaign-driver.mjs",
    find: `  const historicalFailures = settled
    .filter((r) => r.status === "failed")`,
    replace: `  const historicalFailures = settled
    .filter(() => false)`,
    suite: "packages/evaluation/src/r97-driver-closed-loop.test.ts",
    test: "a resumed run does NOT report COMPLETE when history holds failures",
    catchExpectation: "a resume forgets the failures its own history recorded",
  },
];

/** sha256 of a file, so a restoration can be PROVED rather than assumed. */
function hashOf(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Apply a mutation, run its test, and restore the file.
 *
 * The restoration is in a `finally`, so an exception thrown by the test run cannot
 * leave the tree mutated. The post-restore hash is compared with the pre-mutation
 * hash and a mismatch is reported as a CONFIG failure — a mutation gate that
 * damaged the source would be worse than no gate.
 */
function runOne(mutation) {
  const target = join(REPO_ROOT, mutation.file);
  const original = readFileSync(target, "utf8");
  const originalHash = hashOf(target);
  const occurrences = original.split(mutation.find).length - 1;
  if (occurrences !== 1) {
    return {
      id: mutation.id,
      planWording: mutation.planWording,
      ok: false,
      applied: false,
      reason: `the mutation anchor appears ${occurrences} time(s) in ${mutation.file}; exactly 1 is required, so the mutation would be ambiguous or a no-op`,
    };
  }

  let result;
  try {
    writeFileSync(target, original.replace(mutation.find, mutation.replace), "utf8");
    // The mutated code must be TYPED, not just textual: the tests import the BUILT
    // evaluation package, so a mutation applied to `src` is invisible until the
    // package is rebuilt. A build failure is reported as a broken mutation rather
    // than being counted as the test catching it.
    const buildResult = build();
    const testRun = buildResult.code === 0 ? runVitest(mutation.suite, mutation.test) : null;
    result = { buildCode: buildResult.code, buildOut: tail(buildResult.out), testRun };
  } finally {
    writeFileSync(target, original, "utf8");
    // Rebuilding from the RESTORED source is what makes the restoration complete:
    // leaving a mutated `dist` behind would poison every later run.
    build();
  }

  const restoredHash = hashOf(target);
  if (restoredHash !== originalHash) {
    return {
      id: mutation.id,
      planWording: mutation.planWording,
      ok: false,
      applied: true,
      reason: `RESTORATION FAILED: ${mutation.file} hashes ${restoredHash} but was ${originalHash} before the mutation`,
    };
  }

  if (result.buildCode !== 0) {
    return {
      id: mutation.id,
      planWording: mutation.planWording,
      ok: false,
      applied: true,
      reason: `the mutation does not COMPILE, so it tests the type system rather than the behaviour: ${result.buildOut}`,
    };
  }

  const caught = result.testRun.code !== 0;
  return {
    id: mutation.id,
    planWording: mutation.planWording,
    file: mutation.file,
    suite: mutation.suite,
    test: mutation.test,
    catchExpectation: mutation.catchExpectation,
    ok: caught,
    applied: true,
    restored: true,
    restoredHash,
    testExitCode: result.testRun.code,
    ...(caught ? {} : { reason: "the test PASSED with the mutation applied — it does not catch this defect" }),
    ...(caught ? { evidence: tail(result.testRun.out, 12) } : { output: tail(result.testRun.out, 20) }),
  };
}

/**
 * Rebuild the workspace with `tsc -b`, through TypeScript's own JS entry.
 *
 * MEASURED: `pnpm` cannot be spawned with `shell: false` at all — `pnpm.cmd` gives
 * `EINVAL` on Node 24 and a bare `pnpm` gives `ENOENT` on Windows. `shell: true`
 * would work but reintroduces the platform dependency the closed-loop runner was
 * written to remove, and this gate must be runnable on both platforms. TypeScript's
 * `bin/tsc` is a plain JS file, so `process.execPath` runs it directly.
 *
 * The rebuild matters for CORRECTNESS, not just for compilation: the tests import
 * `packages/evaluation/dist`, so a mutation applied to `src` is invisible until the
 * package is rebuilt — and the restoration is incomplete until it is rebuilt again.
 */
function build() {
  return run(process.execPath, [join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "-b"], 900_000);
}

/** Run a command, returning `{ code, out }`. A non-zero exit is data. */
function run(cmd, args, timeout) {
  try {
    const out = execFileSync(cmd, args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      maxBuffer: 128 * 1024 * 1024,
      shell: false,
    });
    return { code: 0, out: String(out) };
  } catch (err) {
    return {
      code: typeof err?.status === "number" ? err.status : 1,
      out: `${String(err?.stdout ?? "")}\n${String(err?.stderr ?? err?.message ?? "")}`,
    };
  }
}

/** Run vitest's real `.mjs` entry directly (no `.cmd` shim, which needs a shell). */
function runVitest(suite, testFilter) {
  return run(
    process.execPath,
    [join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs"), "run", suite, "-t", testFilter, "--reporter=verbose"],
    900_000,
  );
}

function tail(text, lines = 25) {
  return String(text)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(-lines)
    .join("\n");
}

export function parseArgs(argv) {
  const value = (name) => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} requires a value`);
    return v;
  };
  return { only: value("--only"), out: value("--out") };
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`r101-mutation: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_CONFIG;
  }
  const selected = parsed.only === undefined ? MUTATIONS : MUTATIONS.filter((m) => m.id === parsed.only);
  if (selected.length === 0) {
    process.stderr.write(`r101-mutation: --only ${String(parsed.only)} matches no mutation\n`);
    return EXIT_CONFIG;
  }

  const results = [];
  for (const mutation of selected) {
    process.stdout.write(`[..] applying ${mutation.id} (${mutation.planWording})\n`);
    const result = runOne(mutation);
    results.push(result);
    process.stdout.write(
      `[${result.ok ? "CAUGHT" : "MISSED"}] ${mutation.id}` +
        (result.ok ? `  -> ${mutation.suite} fails as required\n` : `  ${result.reason ?? ""}\n`),
    );
  }

  const report = {
    schema: "e4-r101-mutation-report-v1",
    mutationVersion: MUTATION_VERSION,
    platform: process.platform,
    totalMutations: results.length,
    caught: results.filter((r) => r.ok).length,
    mutations: results,
    ok: results.every((r) => r.ok),
    scopeNote:
      "Each mutation was applied to the real production source, the named test was run, and the source was restored and re-hashed. A CAUGHT mutation means the test FAILED with the mutation applied, which is what makes the test a real check rather than a description.",
  };
  if (parsed.out !== undefined) {
    const out = resolve(parsed.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  process.stdout.write(
    `\nr101-mutation: ${report.caught}/${report.totalMutations} mutation(s) CAUGHT by their tests\n`,
  );
  return report.ok ? EXIT_OK : EXIT_FAILED;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
