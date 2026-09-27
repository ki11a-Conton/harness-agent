#!/usr/bin/env node
/**
 * N1 — NEGATIVE CONTROL, v2: which file does the mirrored arm actually EXECUTE?
 *
 * plan(20260926-175819).md §N1 怎么做 3 (line 43):
 *   "准备一条负向测试：替换其中一个 checkout/打乱 ABI 后，provider factory 和物理请求
 *    均为 0，明确拒绝。"
 *
 * WHY v2 EXISTS (measured, not guessed). v1 renamed the 7 `runOneCase` occurrences in the
 * candidate arm's `apps/cli/dist/benchmark-command.js` and the acceptance STILL returned
 * `ok=true / OFFLINE_ACCEPTED` with identical campaign aggregates. Two readings were left
 * open, and v1 could not separate them:
 *   (a) the mirrored path never loads that bundle (it may run the arm's CLI, `main.js`), or
 *   (b) the acceptance does not fail closed on a broken arm.
 *
 * v2 fixes v1's real defect: v1 judged at the CAMPAIGN level, but a unit that fails its case
 * is still reported `status:"completed", failureCategory:"case_failed"` — so a campaign can be
 * "ok" while every arm unit is broken. The refusal has to be read where it actually appears:
 * the PER-ARM unit records in `run/driver-result.json`.
 *
 * v2 also scrambles by INJECTING A THROW instead of renaming a binding. Renaming only changes
 * the exported name and leaves the module internally consistent, so a consistent rename can be
 * invisible to a consumer that does not call the renamed binding by name. A module that throws
 * on import cannot be loaded by ANY consumer.
 *
 * The control target list is deliberate: `benchmark-command.js` (the documented worker ABI
 * entry) and `main.js` (the CLI entry `r97-arm-worker.mjs#cliEntryOf` returns). Whichever of
 * them the mirrored path really executes will show up as the scrambled arm's units turning
 * into errors while the untouched entry changes nothing.
 *
 * SAFETY: offline only — the acceptance is driven with an offline scripted provider, the key
 * is blanked, no paid endpoint is contacted, cost is zero. Every scramble is restored from a
 * byte-exact backup and re-verified by sha256, and the script exits non-zero if any restore
 * fails. Only the candidate arm's gitignored build output is touched, never a tracked file.
 *
 * usage:
 *   node scripts/e4/n1-abi-negative-control.mjs --candidate-dir <arm> --out <dir> \
 *        [--arms-root <dir>] [--targets a,b] [--mode throw|rename] [--skip-baseline]
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..");

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? dflt : v;
}

const candidateDir = arg("candidate-dir") ?? process.env["R97_ARM_CANDIDATE_DIR"] ?? null;
const armsRoot = arg("arms-root") ?? (candidateDir === null ? null : dirname(candidateDir));
const outDir = arg("out");
const mode = arg("mode", "throw");
const skipBaseline = process.argv.includes("--skip-baseline");
const MARKER = "N1_ABI_PROBE_MARKER";
const targets = (arg("targets", "apps/cli/dist/benchmark-command.js") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

if (candidateDir === null || outDir === null) {
  console.error("n1-abi-negative-control: --candidate-dir (or $R97_ARM_CANDIDATE_DIR) and --out are required");
  process.exit(2);
}
if (mode !== "throw" && mode !== "rename") {
  console.error(`n1-abi-negative-control: --mode must be throw|rename (got ${mode})`);
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** Run the acceptance and read back both the campaign verdict and the per-arm unit records. */
function runAcceptance(label) {
  const runOut = join(outDir, label);
  let exitCode = 0;
  let stderr = "";
  try {
    execFileSync("node", [join("scripts", "e4", "r97-closed-loop.mjs"), "--acceptance", "--arms-root", armsRoot, "--out", runOut], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OPENAI_API_KEY: "" },
    });
  } catch (err) {
    exitCode = typeof err?.status === "number" ? err.status : 1;
    stderr = String(err?.stderr ?? "").slice(-600);
  }
  let summary = null;
  try {
    summary = JSON.parse(readFileSync(join(runOut, "acceptance", "acceptance-summary.json"), "utf8"));
  } catch {
    summary = null;
  }
  // The per-arm truth lives here, not in the campaign verdict.
  let units = null;
  try {
    const driver = JSON.parse(readFileSync(join(runOut, "acceptance", "run", "driver-result.json"), "utf8"));
    const profile = (arm) => {
      const rows = (driver.unitResults ?? []).filter((u) => u.arm === arm);
      const cats = {};
      for (const u of rows) {
        const key = `${u.status}/${u.failureCategory ?? "none"}`;
        cats[key] = (cats[key] ?? 0) + 1;
      }
      const sample = rows.find((u) => u.failureCategory !== "case_failed") ?? rows[0] ?? null;
      return {
        units: rows.length,
        profile: cats,
        // The arm entry's OWN identity as the driver recorded it — proves which tree ran.
        buildDigest: sample?.build?.buildDigest ?? null,
        sampleDetail: sample ? String(sample.detail ?? "").slice(0, 160) : null,
      };
    };
    units = { present: true, status: driver.status, providerRequests: driver.providerRequests ?? null, verifiedPasses: driver.verifiedPasses ?? null, candidate: profile("candidate"), baseline: profile("baseline") };
  } catch {
    units = { present: false, candidate: { units: 0, profile: {}, buildDigest: null, sampleDetail: null }, baseline: { units: 0, profile: {}, buildDigest: null, sampleDetail: null } };
  }
  return {
    label,
    exitCode,
    ok: summary?.ok ?? null,
    status: summary?.status ?? null,
    providerRequests: summary?.campaign?.providerRequests ?? null,
    externalProviderCalls: summary?.externalProviderCalls ?? null,
    measuredUnits: summary?.campaign?.measuredUnits ?? null,
    verifiedPasses: summary?.campaign?.verifiedPasses ?? null,
    strongPasses: summary?.campaign?.strongPasses ?? null,
    baselineSha: summary?.baselineSha ?? null,
    candidateSha: summary?.candidateSha ?? null,
    units,
    stderr,
  };
}

/** Only "completed"/"case_failed" is the un-scrambled arm's normal shape; anything else is a break. */
function abnormalAfterScramble(run) {
  const p = run.units?.candidate?.profile ?? {};
  const keys = Object.keys(p);
  if (keys.length === 0) return false;
  return keys.some((k) => !k.startsWith("completed/case_failed"));
}

const results = [];
let anyRestoreFailed = false;

// ---- 0. baseline: the untouched arm, so every later comparison has a same-run reference -----
const baseline = skipBaseline ? null : runAcceptance("baseline-positive");

// ---- 1..N. scramble each target, measure, restore byte-exactly ------------------------------
for (const rel of targets) {
  const path = join(candidateDir, rel);
  const slug = rel.replace(/[\\/]/g, "_").replace(/\.js$/, "");
  if (!existsSync(path)) {
    results.push({ target: rel, skipped: true, reason: "target missing in the arm checkout" });
    continue;
  }
  const originalSha = sha(path);
  const backupPath = join(outDir, `${slug}.original.js`);
  copyFileSync(path, backupPath);

  const original = readFileSync(path, "utf8");
  const occurrences = (original.match(/runOneCase/g) ?? []).length;
  let scrambledText;
  let scrambleNote;
  if (mode === "throw") {
    scrambledText = `${original}\nthrow new Error(${JSON.stringify(MARKER)});\n`;
    scrambleNote = `appended a module-level throw (${MARKER})`;
  } else {
    if (occurrences === 0) {
      results.push({ target: rel, skipped: true, reason: "no runOneCase occurrence to rename" });
      continue;
    }
    scrambledText = original.split("runOneCase").join("runOneCaseABIScrambled");
    scrambleNote = `renamed ${occurrences} runOneCase occurrence(s)`;
  }
  writeFileSync(path, scrambledText, "utf8");
  const scrambledSha = sha(path);

  const measured = runAcceptance(`scrambled-${slug}`);

  copyFileSync(backupPath, path);
  const restoredSha = sha(path);
  const restoreExact = restoredSha === originalSha;
  if (!restoreExact) anyRestoreFailed = true;

  results.push({
    target: rel,
    mode,
    scrambleNote,
    runOneCaseOccurrences: occurrences,
    sha256: { original: originalSha, scrambled: scrambledSha, restored: restoredSha },
    restoreExact,
    refusalObservedAtCampaignLevel: measured.exitCode !== 0 || measured.ok !== true || measured.status !== "OFFLINE_ACCEPTED",
    noPhysicalRequests: measured.providerRequests === 0 && measured.externalProviderCalls === 0,
    candidateUnitsBroke: abnormalAfterScramble(measured),
    run: measured,
  });
}

// ---- 2. final: the arm must be exactly as found --------------------------------------------
const final = skipBaseline ? null : runAcceptance("final-positive");

const verdict = {
  schemaVersion: "e4-n1-abi-negative-control-v2",
  candidateDir,
  mode,
  targets,
  baseline,
  results,
  final,
  assertions: {
    everyRestoreExact: !anyRestoreFailed,
    finalPositiveStillGreen: final === null || (final.exitCode === 0 && final.ok === true),
  },
  ok: !anyRestoreFailed && (final === null || (final.exitCode === 0 && final.ok === true)),
};

writeFileSync(join(outDir, "n1-abi-negative-control.json"), `${JSON.stringify(verdict, null, 2)}\n`, "utf8");

console.log("N1 ABI negative control (v2)");
console.log(`  mode=${mode}  candidateDir=${candidateDir}`);
if (baseline) {
  console.log(`  BASELINE   ok=${baseline.ok} status=${baseline.status} providerRequests=${baseline.providerRequests}`);
  console.log(`             candidate units: ${JSON.stringify(baseline.units.candidate.profile)} digest=${String(baseline.units.candidate.buildDigest).slice(0, 16)}`);
}
for (const r of results) {
  if (r.skipped) {
    console.log(`  SKIP ${r.target}: ${r.reason}`);
    continue;
  }
  console.log(`  SCRAMBLED ${r.target}`);
  console.log(`             ok=${r.run.ok} status=${r.run.status} providerRequests=${r.run.providerRequests} externalProviderCalls=${r.run.externalProviderCalls}`);
  console.log(`             candidate units: ${JSON.stringify(r.run.units.candidate.profile)} digest=${String(r.run.units.candidate.buildDigest).slice(0, 16)}`);
  console.log(`             baseline  units: ${JSON.stringify(r.run.units.baseline.profile)}`);
  if (r.run.units.candidate.sampleDetail) console.log(`             sample: ${r.run.units.candidate.sampleDetail}`);
  console.log(`             campaign-level refusal=${r.refusalObservedAtCampaignLevel}  unitsBroke=${r.candidateUnitsBroke}  restoreExact=${r.restoreExact}`);
}
if (final) console.log(`  FINAL      ok=${final.ok} status=${final.status} providerRequests=${final.providerRequests}`);
console.log(`  VERDICT: ${verdict.ok ? "ARM LEFT INTACT" : "CONTROL DAMAGED THE ARM"}`);
process.exit(verdict.ok ? 0 : 1);
