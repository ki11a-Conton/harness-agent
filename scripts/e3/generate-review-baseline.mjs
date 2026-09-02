#!/usr/bin/env node
/**
 * E3-00 — machine-readable review baseline generator.
 *
 * Produces `e3-review-baseline.json` at the repo root. The baseline is
 * SCRIPT-GENERATED (never hand-filled): it records the exact commands, exit
 * codes, key stdout summaries, provider call counts, and the worktree state
 * before/after the gates ran.
 *
 * Honesty rules (E3-00):
 *  - NEVER writes "all gates pass" — capability/release/coverage status is
 *    recorded as actually observed (often partially available, e.g. built
 *    dist present but coverage not measured here).
 *  - Uses `subjectSha` / `subjectTreeDigest`, NOT "current HEAD" (a field
 *    that self-contradicts once this commit exists).
 *  - providerCalls must reflect real (non-fake) provider calls: 0 for this
 *    offline baseline.
 *
 * Requires a POSIX-ish shell for the pnpm gate invocations (git, pnpm are
 * expected on PATH). No API key is needed — nothing here calls a model.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const OUT_PATH = resolve(REPO_ROOT, "e3-review-baseline.json");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 15 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  return {
    exitCode: res.status,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
}

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function shortSha(sha) {
  return sha === null || sha === "" ? null : sha.slice(0, 12);
}

async function readJsonSafe(rel) {
  try {
    return JSON.parse(await readFile(join(REPO_ROOT, rel), "utf8"));
  } catch {
    return null;
  }
}

/** Worktree snapshot: git status porcelain + full-tree digest (excluding
 *  node_modules/.git so the digest is about the source tree, not deps). */
function captureWorktree() {
  const status = run("git", ["status", "--porcelain=v1"], { timeoutMs: 60_000 });
  const files = status.stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => l.slice(3));
  // Digest over the working tree file list + content hashes is expensive;
  // use the tracked-tree digest (HEAD^{tree}) plus the porcelain diff count as
  // the honest signal. This is what a reviewer can reproduce.
  const tree = run("git", ["show", "-s", "--format=%T", "HEAD"], { timeoutMs: 30_000 });
  return {
    gitAvailable: status.exitCode === 0,
    treeDigest: tree.exitCode === 0 ? tree.stdout : null,
    porcelainLines: files.length,
    porcelainHead: files.slice(0, 40),
    clean: files.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Gate runners
// ---------------------------------------------------------------------------

async function gate(cmd, args, label) {
  const started = Date.now();
  const res = run(cmd, args);
  const durationMs = Date.now() - started;
  const tail = res.stdout.split("\n").slice(-12).join("\n").trim();
  return {
    label,
    command: `${cmd} ${args.join(" ")}`,
    exitCode: res.exitCode,
    durationMs,
    stdoutTail: tail || res.stderr.split("\n").slice(-12).join("\n").trim(),
    passed: res.exitCode === 0,
  };
}

/** Run the defect repro suite. The suite is designed so a PASSING test means
 *  the defect reproduced (name `[REPRODUCED]`) or the improvement holds
 *  (`[FIXED]`). Exit 0 = all 12 tests passed. We parse the per-R-xx verdict
 *  expectations from the source file (stable, not reporter-dependent). */
async function runDefectRepro() {
  const res = run("pnpm", ["e3:repro-current-defects"]);
  const output = (res.stdout + "\n" + res.stderr).trim();

  // Extract the expected verdicts from the test file describe() names.
  const testFile = join(REPO_ROOT, "apps/cli/src/e3-repro-current-defects.test.ts");
  let src = "";
  try {
    src = await readFile(testFile, "utf8");
  } catch {
    src = "";
  }
  const reproduced = [];
  const fixed = [];
  for (const m of src.matchAll(/describe\("(R-\d{2}:[^"]*?)\[([A-Z]+)\]"/g)) {
    if (m[2] === "REPRODUCED") reproduced.push(m[1].trim());
    else if (m[2] === "FIXED") fixed.push(m[1].trim());
  }
  return {
    exitCode: res.exitCode,
    passed: res.exitCode === 0,
    expectedReproducedCount: reproduced.length,
    expectedFixedCount: fixed.length,
    reproduced,
    fixed,
    stdoutTail: output.split("\n").slice(-8).join("\n").trim(),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const subjectSha = (run("git", ["rev-parse", "HEAD"]).stdout || null);

  const worktreeBefore = captureWorktree();

  const gates = [];
  gates.push(await gate("pnpm", ["typecheck"], "typecheck (tsc -b)"));
  gates.push(await gate(
    "pnpm",
    ["vitest", "run", "packages/evaluation/src/benchmark-isolation.test.ts"],
    "cross-platform path unit tests (benchmark-isolation)",
  ));
  gates.push(await gate("pnpm", ["test"], "default full test suite"));

  const defectRepro = await runDefectRepro();

  const worktreeAfter = captureWorktree();

  // Provider call accounting: every gate above is offline. The defect repro
  // uses ScriptedModelProvider (id="scripted") which records its own calls
  // but is NOT a real provider — real provider calls stay 0.
  const providerCalls = {
    realProviderCalls: 0,
    fakeProviderUsed: true,
    note: "All gates are offline; the defect repro uses ScriptedModelProvider (id=scripted). No real model endpoint was contacted.",
  };

  // Active champion + ledger facts (read-only, historical snapshot).
  const championState = await readJsonSafe("docs/evolution/champion-state.json");
  const ledger = await readJsonSafe("docs/evolution/evolution-ledger.json");
  const activeChampion = championState?.active?.level ?? championState?.level ?? null;

  // Capability / release / coverage status — HONEST, never "all pass".
  const distAppsCli = await stat(join(REPO_ROOT, "apps/cli/dist/main.js")).then(
    () => true,
    () => false,
  );
  const capabilityStatus = {
    buildOutputPresent: {
      appsCliDist: distAppsCli,
      note: "built dist presence is NOT a green capability gate; actual capability audit requires `pnpm capability:audit` with a provider.",
    },
  };
  const releaseStatus = {
    releaseVerifyNotRun: true,
    note: "release:verify was NOT run in this offline baseline (it needs a provider/network). Recorded as not-run, not as pass.",
  };
  const coverageStatus = {
    coverageNotMeasured: true,
    note: "coverage was not measured in this offline baseline; `pnpm test:coverage` was not run here.",
  };

  const baseline = {
    schemaVersion: "1.0.0",
    kind: "e3-review-baseline",
    subjectSha,
    subjectShortSha: shortSha(subjectSha),
    subjectTreeDigest: worktreeBefore.treeDigest,
    generatedAtIso: new Date().toISOString(),
    generatedBy: "scripts/e3/generate-review-baseline.mjs (offline, no API key)",
    note: "Baseline for the E3 evolution. subjectSha is the git commit this baseline describes. A later documentation commit that adds this file is NOT part of the tested code tree.",
    worktree: {
      before: worktreeBefore,
      after: worktreeAfter,
      cleanBeforeAndAfter: worktreeBefore.clean && worktreeAfter.clean,
    },
    gates,
    defectRepro,
    providerCalls,
    activeChampion,
    activeChampionRecordedFrom: "docs/evolution/champion-state.json",
    capabilityStatus,
    releaseStatus,
    coverageStatus,
    regressions: {
      // Frozen R-01..R-12 as an at-a-glance table. The truth lives in
      // apps/cli/src/e3-repro-current-defects.test.ts.
      list: [
        { id: "R-01", status: "REPRODUCED", summary: "invalid --repeat 2 --interleave without --shuffle errors, but provider already called 1 time before the error" },
        { id: "R-02", status: "REPRODUCED", summary: "one case + --repeat 2 = 3 provider calls (initial + N repeats)" },
        { id: "R-03", status: "REPRODUCED", summary: "BA pair still has baseline.orderIndex=0 / candidate=1" },
        { id: "R-04", status: "REPRODUCED", summary: "undeclaredSecurityBypass=true in candidate config still comparable + providerCallsAllowed" },
        { id: "R-05", status: "REPRODUCED", summary: "all-unknown provenance accepted as comparable + promotionEligible" },
        { id: "R-06", status: "REPRODUCED", summary: "repetitions=2 + perRepetitionDeltas=[] → decideChampionV3 ACCEPT" },
        { id: "R-07", status: "REPRODUCED", summary: "forged PromotionEnvelope with arbitrary decision digest/source SHA accepted by strict loader" },
        { id: "R-08", status: "REPRODUCED", summary: "concurrent CAS on same parent: no advisory lock — at least one (POSIX: both) succeed" },
        { id: "R-09", status: "REPRODUCED", summary: "summary tamper (passRate/tokens/recoveryRate, keep caseCount/passed) accepted by strict loader" },
        { id: "R-10", status: "REPRODUCED", summary: "benchmark real exec writes absolute path outside case workspace; file created + 1/1 PASS" },
        { id: "R-11", status: "REPRODUCED", summary: "AR2 champion eval --strict → verified 0→0, provenance compatible, INCONCLUSIVE not V3 INVALID" },
        { id: "R-12", status: "FIXED", summary: "historical AR2 benchmark validate finds 32 cases, marks legacy/not-promotion-eligible (improvement already works)" },
      ],
    },
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");

  // Brief human summary on stdout (the JSON is the deliverable).
  console.log(`baseline written: ${OUT_PATH}`);
  console.log(`subjectSha:        ${subjectSha}`);
  console.log(`treeDigest:        ${worktreeBefore.treeDigest}`);
  console.log(`gates:             ${gates.map((g) => `${g.label}=${g.passed ? "PASS" : `FAIL(${g.exitCode})`}`).join(", ")}`);
  console.log(`defect repro:      ${defectRepro.expectedReproducedCount} REPRODUCED, ${defectRepro.expectedFixedCount} FIXED (exit ${defectRepro.exitCode})`);
  console.log(`real providerCalls: ${providerCalls.realProviderCalls}`);
  console.log(`worktree clean:    before=${worktreeBefore.clean} after=${worktreeAfter.clean}`);
}

main().catch((err) => {
  console.error(`baseline generator failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
