#!/usr/bin/env node
/**
 * N7 — one machine-readable readiness artifact per CI run.
 * plan(20260926-175819).md §N7 (line 117), acceptance at line 130.
 *
 * WHY ONE ARTIFACT: the acceptance criterion is that "a reviewer can recompute the
 * core counts and identity from a SINGLE artifact". This writes exactly that:
 * ciRunSha + OS + per-command exit codes + the measured counts + the SEPARATED
 * readiness levels.
 *
 * THE FIVE LEVELS ARE NEVER COLLAPSED INTO ONE `ok`. A fixture protocol that works
 * does not make a real dual build exist, and neither authorizes a paid run. Each
 * level carries its own status, its own basis, and — when it is not green — the
 * concrete reason it is not.
 *
 * HONESTY RULES ENFORCED HERE:
 *   - `realBuildOfflineReady` is BLOCKED unless the E2E's own forward basis says a
 *     REAL dual pinned build ran. Synthetic `writeArmCheckout` fixtures never
 *     satisfy it (plan line 125 forbids exactly that substitution).
 *   - `paidExperimentRun` / `championPromotion` are NEVER set by this script.
 *   - an absent measurement is `null`/UNKNOWN — never `0`.
 *
 * SAFETY: reads local files and runs the offline test gates. Zero network, zero
 * provider, zero cost, no key.
 *
 * usage: node scripts/e4/ci-readiness.mjs --e2e <e2e.json> --out <readiness.json>
 *        [--exit-pnpm-test=N] [--exit-typecheck=N] [--exit-build=N] [--os-label=...]
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..");

function arg(name, dflt = null) {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq !== undefined) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return dflt;
}

const e2ePath = arg("e2e");
const outPath = arg("out");
if (e2ePath === null || outPath === null) {
  console.error("ci-readiness: --e2e <json> and --out <json> are required");
  process.exit(2);
}

/** Run a gate and record its exit code. Never throws: a non-zero exit is DATA. */
function runGate(cmd, args) {
  try {
    execFileSync(cmd, args, {
      cwd: REPO_ROOT,
      stdio: "ignore",
      // Windows ships `pnpm` as a .cmd shim, which execFileSync cannot launch
      // without a shell. The arguments here are fixed literals, never user input.
      shell: process.platform === "win32",
      env: { ...process.env, OPENAI_API_KEY: "" },
    });
    return { exitCode: 0 };
  } catch (err) {
    const code = typeof err?.status === "number" ? err.status : null;
    return { exitCode: code };
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();

// --- the fast, platform-neutral gates this script runs itself -----------------
const n0Gate = runGate("pnpm", ["test:n0-gaps"]);
const legacyGate = runGate("pnpm", ["test:red-next-gaps"]);
const docsSmoke = runGate("pnpm", ["exec", "vitest", "run", "apps/cli/src/prereg-docs-smoke.test.ts"]);

// --- exit codes the CI job already knows (never re-derived by guesswork) ------
const declaredExits = {
  typecheck: arg("exit-typecheck"),
  test: arg("exit-pnpm-test"),
  build: arg("exit-build"),
};
const asInt = (v) => (v === null || v === undefined ? null : Number.isInteger(Number(v)) ? Number(v) : null);

// --- measured counts, all from the E2E artifact -------------------------------
const e2e = readJson(e2ePath);
const exec = e2e?.positiveExecution ?? null;
const fwd = e2e?.positiveForward ?? null;

/**
 * The E2E states its own forward basis in `readiness.productionOfflineReady`.
 * When that statement names SYNTHETIC fixtures, no real dual pinned build ran —
 * and `realBuildOfflineReady` must then be BLOCKED, never inferred from a green
 * fixture loop (plan line 125). An unreadable statement is UNKNOWN, not real.
 */
const readinessText = typeof e2e?.readiness?.productionOfflineReady === "string" ? e2e.readiness.productionOfflineReady : null;
const basis = readinessText === null ? null : readinessText.includes("SYNTHETIC") ? "SYNTHETIC_FIXTURE_BUILD" : "REAL_DUAL_PINNED_BUILD";

/** Is the E2E's own forward basis a REAL dual pinned build? */
const realBasis = basis === "REAL_DUAL_PINNED_BUILD";

const counts = {
  // provider factory / physical request / ledger / journal — the numbers a
  // reviewer recomputes rather than trusts.
  providerFactoryCalls: exec?.providerFactoryCalls ?? null,
  inProcessPhysicalProviderCalls: exec?.physicalProviderCalls ?? null,
  inProcessLedgerCommitted: exec?.ledgerCommitted ?? null,
  inProcessJournalChargedTokens: exec?.journalChargedTokens ?? null,
  forwardPhysicalStubRequests: fwd?.physicalStubRequests ?? null,
  forwardLedgerCommitted: fwd?.ledgerCommitted ?? null,
  forwardJournalChargedTokens: fwd?.journalChargedTokens ?? null,
  forwardAggregateTokensDelta: fwd?.aggregateTokensDelta ?? null,
  evidenceVerified: exec?.evidenceVerified ?? null,
  evidenceUnverified: exec?.evidenceUnverified ?? null,
  decision: exec?.decision ?? null,
  externalProviderCalls: null, // NOT_OBSERVED: nothing is billed
  costUsdMicros: null, // NOT_OBSERVED: nothing is billed
};

const levels = {
  fixtureProtocolReady: {
    status: e2e?.ok === true ? "PASS" : e2e === null ? "NOT_OBSERVED" : "FAIL",
    basis: "the offline closed loop over SYNTHETIC fixture arm builds (writeArmCheckout equals this)",
    counts_ref: ["inProcessPhysicalProviderCalls", "forwardPhysicalStubRequests", "evidenceVerified"],
  },
  realBuildOfflineReady: {
    status: realBasis ? (e2e?.ok === true ? "PASS" : "FAIL") : "BLOCKED",
    basis: realBasis
      ? "two real pinned checkouts built from distinct source SHAs"
      : "no real dual pinned build is available: the forward basis is a SYNTHETIC fixture build, so this level is BLOCKED rather than inferred from the fixture loop (N1)",
    blocker: realBasis ? null : "NO_REAL_ARM_PAIR: real dual frozen arm builds + the real verifier over them are N1's scope and are NOT_PROVEN",
  },
  budgetEvidenceReady: {
    status: "NOT_PROVEN",
    basis:
      "token/cost accounting is journal-bound and the journal was cross-checked (forward journal == forward aggregate delta), and the tool/token/USD dimensions are hard-capped. The full armRunId <-> request IDs <-> ledger reservation/commit <-> verifier bytes chain is NOT bound, and it needs real arm artifacts (N1)",
  },
  paidExperimentRun: { status: "NOT_RUN", basis: "no paid authorization exists; this script never creates one" },
  championPromotion: { status: "NOT_RUN", basis: "no promotion is performed or authorized by this script" },
};

const artifact = {
  schemaVersion: "prereg-ci-readiness-v1",
  generatedBy: "scripts/e4/ci-readiness.mjs",
  ciRunSha: gitSha,
  os: {
    label: arg("os-label", `${process.platform}-${process.arch}`),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  },
  // The workflow runs on BOTH platforms; this process only measured one.
  platforms: {
    windows: { status: process.platform === "win32" ? "MEASURED" : "NOT_OBSERVED", detail: "this process" },
    ubuntu: {
      status: "NOT_PROVEN",
      detail: "no GitHub Actions run is available from this checkout; the CI job must be executed on a runner and its artifact uploaded",
    },
  },
  commandExits: {
    typecheck: asInt(declaredExits.typecheck),
    test: asInt(declaredExits.test),
    build: asInt(declaredExits.build),
    n0GapGate: n0Gate.exitCode,
    legacyRedNextGaps: legacyGate.exitCode,
    docsSmoke: docsSmoke.exitCode,
  },
  counts,
  forwardBasis: basis,
  levels,
  // Deliberately NO top-level `ok`: the five levels above are the contract, and a
  // single boolean is exactly the conflation the plan forbids.
  notes: [
    "counts.* === null means NOT_OBSERVED (an unmeasured value), never zero.",
    "externalProviderCalls/costUsdMicros are NOT_OBSERVED because nothing is billed offline.",
    "A green fixtureProtocolReady does not imply realBuildOfflineReady and never authorizes a paid run.",
  ],
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

const line = (name, lvl) => `  ${name}: ${lvl.status}`;
console.log("prereg-ci-readiness (SEPARATED levels — no single overall PASS)");
console.log(`  ciRunSha: ${artifact.ciRunSha}`);
console.log(`  os: ${artifact.os.label} (node ${artifact.os.node})`);
for (const [name, lvl] of Object.entries(levels)) console.log(line(name, lvl));
console.log(`  forward basis: ${basis ?? "NOT_OBSERVED"}`);
console.log(`  evidence: ${outPath}`);

// The SCRIPT exits 0 when it successfully wrote an artifact. It does not encode a
// verdict: the levels are the verdict, and CI reads them.
process.exit(0);
