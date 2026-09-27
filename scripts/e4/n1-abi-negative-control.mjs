#!/usr/bin/env node
/**
 * N1 — NEGATIVE CONTROL: an arm whose ABI is scrambled must be REFUSED, and the
 * refusal must happen with ZERO provider factory calls and ZERO physical requests.
 *
 * plan(20260926-175819).md §N1 怎么做 3 (line 43):
 *   "准备一条负向测试：替换其中一个 checkout/打乱 ABI 后，provider factory 和物理请求
 *    均为 0，明确拒绝。"
 *
 * WHY THIS SHAPE: the positive path (two real builds executing the real harness) is
 * only trustworthy if the harness can tell a REAL arm from a DECOY. A negative
 * control that merely asserts "an invalid input is rejected" proves nothing about
 * *where* the rejection happened; the plan's requirement is specifically that no
 * provider is ever constructed. So this scrambles the REAL built arm used by the
 * positive run — renaming the exported `runOneCase` binding in the arm's own entry
 * bundle — runs the full acceptance over it, and asserts the observable counts.
 *
 * It then RESTORES the entry from a byte-exact backup and re-verifies the sha256, so
 * the control leaves the arm exactly as it found it (a control that silently
 * corrupts the positive fixture would be worse than no control).
 *
 * SAFETY: offline only. The acceptance is driven with an offline scripted provider;
 * no key, no paid endpoint, no cost. The scramble touches ONLY the candidate arm's
 * gitignored build output, never a tracked file.
 *
 * usage:
 *   node scripts/e4/n1-abi-negative-control.mjs --candidate-dir <arm> [--arms-root <dir>] --out <dir>
 *   # --candidate-dir defaults to $R97_ARM_CANDIDATE_DIR
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
if (candidateDir === null || outDir === null) {
  console.error("n1-abi-negative-control: --candidate-dir (or $R97_ARM_CANDIDATE_DIR) and --out are required");
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
const entryRel = join("apps", "cli", "dist", "benchmark-command.js");
const entryPath = join(candidateDir, entryRel);
if (!existsSync(entryPath)) {
  console.error(`n1-abi-negative-control: no built arm entry at ${entryPath}`);
  process.exit(2);
}

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const originalSha = sha(entryPath);
const backupPath = join(outDir, "benchmark-command.original.js");
copyFileSync(entryPath, backupPath);

/** Run the acceptance and read back its verdict. A non-zero exit is DATA, not a throw. */
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
  return {
    label,
    exitCode,
    ok: summary?.ok ?? null,
    status: summary?.status ?? null,
    providerRequests: summary?.campaign?.providerRequests ?? null,
    measuredUnits: summary?.campaign?.measuredUnits ?? null,
    strongPasses: summary?.campaign?.strongPasses ?? null,
    externalProviderCalls: summary?.externalProviderCalls ?? null,
    stderr,
  };
}

// ---- 1. SCRAMBLE the ABI: rename the exported `runOneCase` binding -------------
const original = readFileSync(entryPath, "utf8");
const occurrences = (original.match(/runOneCase/g) ?? []).length;
if (occurrences === 0) {
  console.error("n1-abi-negative-control: the entry does not mention runOneCase — cannot scramble");
  process.exit(2);
}
writeFileSync(entryPath, original.split("runOneCase").join("runOneCaseABIScrambled"), "utf8");
const scrambledSha = sha(entryPath);

// ---- 2. the acceptance over the scrambled arm must REFUSE with 0 requests ------
const scrambled = runAcceptance("scrambled");

// ---- 3. RESTORE byte-exactly, then re-verify ----------------------------------
copyFileSync(backupPath, entryPath);
const restoredSha = sha(entryPath);

// ---- 4. the positive path must still work after the restore -------------------
const positive = runAcceptance("positive-restored");

const refusalObserved =
  scrambled.exitCode !== 0 || scrambled.ok !== true || scrambled.status !== "OFFLINE_ACCEPTED";
const noPhysicalRequests = scrambled.providerRequests === 0 && scrambled.externalProviderCalls === 0;
const restoreExact = restoredSha === originalSha;
const positiveStillWorks = positive.exitCode === 0 && positive.ok === true;

const verdict = {
  schemaVersion: "e4-n1-abi-negative-control-v1",
  candidateDir,
  entryRel,
  scrambledIdentifierOccurrences: occurrences,
  entrySha256: { original: originalSha, scrambled: scrambledSha, restored: restoredSha },
  scrambled,
  positive,
  assertions: {
    scrambledDiffersFromOriginal: scrambledSha !== originalSha,
    refusalObserved,
    noPhysicalRequests,
    restoreExact,
    positiveStillWorks,
  },
  ok: refusalObserved && noPhysicalRequests && restoreExact && positiveStillWorks && scrambledSha !== originalSha,
};

writeFileSync(join(outDir, "n1-abi-negative-control.json"), `${JSON.stringify(verdict, null, 2)}\n`, "utf8");

console.log("N1 ABI negative control");
console.log(`  entry            : ${entryRel} (${statSync(entryPath).size} B, ${occurrences} runOneCase occurrences renamed)`);
console.log(`  original sha256  : ${originalSha.slice(0, 16)}`);
console.log(`  scrambled sha256 : ${scrambledSha.slice(0, 16)}`);
console.log(`  SCRAMBLED  exit=${scrambled.exitCode} ok=${scrambled.ok} status=${scrambled.status} providerRequests=${scrambled.providerRequests} externalProviderCalls=${scrambled.externalProviderCalls}`);
console.log(`  RESTORED   exit=${positive.exitCode} ok=${positive.ok} status=${positive.status} providerRequests=${positive.providerRequests}`);
console.log(`  restored sha256  : ${restoredSha.slice(0, 16)} (byte-exact: ${restoreExact})`);
console.log(`  VERDICT: ${verdict.ok ? "CONTROL PASS" : "CONTROL FAIL"}`);
process.exit(verdict.ok ? 0 : 1);
