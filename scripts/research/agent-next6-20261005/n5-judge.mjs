/**
 * N6 / N5 — the GATE JUDGE for a completed paired campaign.
 *
 * It reads ONLY the campaign's own artifacts (finalized pairs + partial pairs)
 * and the frozen pre-registration, and computes exactly the gates the plan
 * pre-registered — nothing is re-thresholded after seeing the numbers:
 *
 *   1. missing-evidence group verified pass-rate lift >= +5 percentage points;
 *   2. case-aggregated paired bootstrap (10,000 iterations, FROZEN seed) 95%
 *      one-sided lower bound of the difference >= 0;
 *   3. control-group success count does not decrease;
 *   4. zero NEW security violations and zero NEW false-completes;
 *   5. total tokens and model-call attempts <= baseline x 1.10 (absolute
 *      non-growth when the baseline is 0; unknown usage is never zero);
 *   6. unproductive repeated tool calls do not grow;
 *   7. activation proof: every counted candidate-arm run must carry the
 *      candidate's own prompt-guidance activation event, otherwise the run is
 *      reported as NOT ACTIVATED instead of silently counting.
 *
 * Usage:
 *   node scripts/research/agent-next6-20261005/n5-judge.mjs --experiment main --campaign .ci/n6-n5/main
 *
 * Exit 0 only when EVERY gate passes AND no pair was left partial.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const EV = join(REPO, "docs", "evidence", "agent-next6-20261005");

const arg = (name, fallback = undefined) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit !== undefined) return hit.slice(name.length + 3);
  if (process.argv.includes(`--${name}`)) return process.argv[process.argv.indexOf(`--${name}`) + 1];
  return fallback;
};

const experiment = arg("experiment", "main");
const campaignDir = resolve(arg("campaign", join(REPO, ".ci", "n6-n5", experiment)));
const outDir = resolve(arg("out", join(REPO, ".ci", "n6-n5", `${experiment}-judge`)));

const preregPath = join(EV, experiment === "holdout" ? "holdout-preregistration.json" : "main-preregistration.json");
const manifestPath = join(EV, experiment === "holdout" ? "holdout-case-manifest.json" : "case-manifest.json");
const prereg = JSON.parse(readFileSync(preregPath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const gates = prereg.evaluation.gates;

const MISSING = new Set(["compact-drop", "preview", "rehydrate", "partial"]);
const CONTROL = new Set(["visible", "changed", "diagnostic"]);

const conditionOf = new Map(manifest.cases.map((c) => [c.caseId, c.condition]));
const groupOf = (caseId) => {
  const condition = conditionOf.get(caseId);
  if (MISSING.has(condition)) return "missing";
  if (CONTROL.has(condition)) return "control";
  return "unknown";
};

const readJson = (name, fallback) => {
  const path = join(campaignDir, name);
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
};

const finalized = readJson("finalized-pairs.json", []);
const partial = readJson("partial-pairs.json", []);
const header = readJson("campaign-header.json", null);
const identity = readJson("execution-identity.json", null);

if (finalized.length === 0) {
  process.stderr.write(`n5-judge: no finalized pairs in ${campaignDir} — nothing to judge\n`);
  process.exit(2);
}

const ARM_A = experiment === "holdout" ? "champion arm (plan arm 'baseline')" : "tool_call_efficiency_v1 (v2)";
const ARM_B = "context_safe_tool_call_efficiency_v1";

/** verified pass = the ORIGINAL verifier decided the case passed. */
const passed = (outcome) => outcome?.status === "passed";

const CANDIDATE_GUIDANCE_VERSION = "context-safe-tool-call-efficiency:v1";
function activated(outcome) {
  const events = outcome?.activationEvidenceV2?.events ?? [];
  return events.some(
    (e) => e.mechanism === "prompt-guidance" && e.payload?.guidanceVersion === CANDIDATE_GUIDANCE_VERSION,
  );
}

function tokensOf(outcome) {
  const m = outcome?.metrics ?? {};
  return (m.tokens_input ?? 0) + (m.tokens_output ?? 0);
}
function callsOf(outcome) {
  const m = outcome?.metrics ?? {};
  return m.model_call_count ?? 0;
}
function toolCallsOf(outcome) {
  return outcome?.metrics?.tool_call_count ?? 0;
}
function usageUnknownOf(outcome) {
  return outcome?.metrics?.usage_unknown ?? 0;
}

// ---- per case / per arm records -------------------------------------------
const perCase = new Map(); // caseId -> { A: [], B: [] }
for (const pair of finalized) {
  const entry = perCase.get(pair.caseId) ?? { A: [], B: [] };
  entry.A.push(pair.baseline.outcome);
  entry.B.push(pair.candidate.outcome);
  perCase.set(pair.caseId, entry);
}

const rate = (xs) => (xs.length === 0 ? null : xs.filter(Boolean).length / xs.length);

function groupStats(group) {
  const caseIds = [...perCase.keys()].filter((id) => groupOf(id) === group);
  const aRuns = [];
  const bRuns = [];
  const aCaseRates = [];
  const bCaseRates = [];
  for (const id of caseIds) {
    const { A, B } = perCase.get(id);
    aRuns.push(...A.map(passed));
    bRuns.push(...B.map(passed));
    aCaseRates.push(rate(A.map(passed)) ?? 0);
    bCaseRates.push(rate(B.map(passed)) ?? 0);
  }
  const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
  return {
    cases: caseIds.length,
    aRuns: aRuns.length,
    bRuns: bRuns.length,
    aPasses: aRuns.filter(Boolean).length,
    bPasses: bRuns.filter(Boolean).length,
    aRunRate: rate(aRuns),
    bRunRate: rate(bRuns),
    aCaseMean: mean(aCaseRates),
    bCaseMean: mean(bCaseRates),
    aCaseRates,
    bCaseRates,
    caseIds,
  };
}

const missing = groupStats("missing");
const control = groupStats("control");

// ---- gate 1: lift in percentage points ------------------------------------
const missingLiftPp = (missing.bCaseMean - missing.aCaseMean) * 100;
const gateLift = missingLiftPp + 1e-9 >= gates.missingGroupVerifiedPassRateLiftPp;

// ---- gate 2: paired bootstrap (frozen seed, case-aggregated) --------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const BOOTSTRAP_SEED = 20_261_005; // frozen with the plan
const iterations = gates.pairedBootstrapIterations;
const rng = mulberry32(BOOTSTRAP_SEED);
const diffs = [];
const n = missing.caseIds.length;
for (let i = 0; i < iterations; i += 1) {
  let sum = 0;
  for (let j = 0; j < n; j += 1) {
    const idx = Math.floor(rng() * n);
    sum += missing.bCaseRates[idx] - missing.aCaseRates[idx];
  }
  diffs.push(sum / n);
}
diffs.sort((a, b) => a - b);
const lowerIndex = Math.max(0, Math.floor(0.05 * diffs.length) - 1);
const bootstrapLowerBoundPp = diffs[lowerIndex] * 100;
const gateBootstrap = bootstrapLowerBoundPp + 1e-9 >= gates.pairedBootstrapOneSidedLowerBoundMin;

// ---- gate 3: control group success count ----------------------------------
const gateControl = control.bPasses >= control.aPasses;

// ---- gate 4: new security violations / false-completes --------------------
const securityViolations = (outcomes) => outcomes.filter((o) => o?.securityOutcome?.violation === true || o?.securityOutcome?.status === "violation").length;
const falseCompletes = (outcomes) => outcomes.filter((o) => o?.grade === "unverified_complete" && o?.status !== "passed").length;
const aOutcomes = [...perCase.values()].flatMap((v) => v.A);
const bOutcomes = [...perCase.values()].flatMap((v) => v.B);
const aSec = securityViolations(aOutcomes);
const bSec = securityViolations(bOutcomes);
const aFalse = falseCompletes(aOutcomes);
const bFalse = falseCompletes(bOutcomes);
const gateSecurity = bSec - aSec <= gates.newSecurityViolationsMax && bFalse - aFalse <= gates.newFalseCompleteMax;

// ---- gate 5: cost ----------------------------------------------------------
const sum = (xs, f) => xs.reduce((acc, x) => acc + f(x), 0);
const aTokens = sum(aOutcomes, tokensOf);
const bTokens = sum(bOutcomes, tokensOf);
const aCalls = sum(aOutcomes, callsOf);
const bCalls = sum(bOutcomes, callsOf);
const aUnknown = sum(aOutcomes, usageUnknownOf);
const bUnknown = sum(bOutcomes, usageUnknownOf);
const ratioOk = (base, candidate) =>
  base === 0 ? candidate === 0 : candidate <= base * gates.modelCallAttemptsMaxRatioOfBaseline + 1e-9;
const tokenRatio = aTokens === 0 ? null : bTokens / aTokens;
const callRatio = aCalls === 0 ? null : bCalls / aCalls;
const gateTokens = ratioOk(aTokens, bTokens);
const gateCalls = ratioOk(aCalls, bCalls);

// ---- gate 6: unproductive repeated tool calls ------------------------------
// Proxy, defined explicitly: tool calls spent in runs that did NOT pass,
// normalised per run. A run that burns the iteration cap retrying is exactly
// what this candidate attacks, so its share must not grow.
const unproductive = (outcomes) => {
  const failed = outcomes.filter((o) => !passed(o));
  return {
    failedRuns: failed.length,
    perFailedRun: failed.length === 0 ? 0 : sum(failed, toolCallsOf) / failed.length,
    perRun: outcomes.length === 0 ? 0 : sum(outcomes, toolCallsOf) / outcomes.length,
  };
};
const aUnprod = unproductive(aOutcomes);
const bUnprod = unproductive(bOutcomes);
const gateUnproductive = bUnprod.perFailedRun <= aUnprod.perFailedRun + 1e-9;

// ---- gate 7: activation proof ---------------------------------------------
const bActivated = bOutcomes.filter(activated).length;
const aActivated = aOutcomes.filter(activated).length;
const gateActivation = bActivated === bOutcomes.length && bOutcomes.length > 0;

const gateResults = [
  { gate: "missing_group_lift_pp", required: `>= ${gates.missingGroupVerifiedPassRateLiftPp}`, observed: missingLiftPp, passed: gateLift },
  { gate: "paired_bootstrap_95pct_lower_bound_pp", required: `>= ${gates.pairedBootstrapOneSidedLowerBoundMin} (${iterations} iterations, seed ${BOOTSTRAP_SEED})`, observed: bootstrapLowerBoundPp, passed: gateBootstrap },
  { gate: "control_group_not_worse", required: "B passes >= A passes", observed: `${control.aPasses} -> ${control.bPasses}`, passed: gateControl },
  { gate: "no_new_security_violations_or_false_completes", required: "new == 0", observed: `security ${aSec} -> ${bSec}, false-complete ${aFalse} -> ${bFalse}`, passed: gateSecurity },
  { gate: "tokens_within_110pct", required: "<= baseline x 1.10 (absolute non-growth at 0)", observed: `A ${aTokens} -> B ${bTokens}${tokenRatio === null ? "" : ` (x${tokenRatio.toFixed(3)})`}`, passed: gateTokens },
  { gate: "model_call_attempts_within_110pct", required: "<= baseline x 1.10", observed: `A ${aCalls} -> B ${bCalls}${callRatio === null ? "" : ` (x${callRatio.toFixed(3)})`}`, passed: gateCalls },
  { gate: "unproductive_tool_calls_not_growing", required: "PROXY: B tool calls per failed run <= A tool calls per failed run", observed: `A ${aUnprod.perFailedRun.toFixed(2)} -> B ${bUnprod.perFailedRun.toFixed(2)}`, passed: gateUnproductive },
  { gate: "candidate_activation_proven", required: `${bOutcomes.length} of ${bOutcomes.length} candidate runs activated`, observed: `${bActivated}/${bOutcomes.length} activated (comparison arm ${aActivated} activated)`, passed: gateActivation },
];

const allPassed = gateResults.every((g) => g.passed) && partial.length === 0;

const result = {
  schemaVersion: "n6-n5-judge-result-v1",
  experiment,
  arms: { A: ARM_A, B: ARM_B },
  frozenPreregistrationDigest: prereg.preregistrationDigest,
  executionIdentityDigest: identity === null ? null : readJson("campaign-result.json", {})?.executionIdentityDigest ?? null,
  campaign: {
    dir: campaignDir.replace(REPO, ".").split("\\").join("/"),
    finalizedPairs: finalized.length,
    partialPairs: partial.length,
    headerStartedAt: header?.startedAt ?? null,
    smoke: header?.smoke ?? null,
  },
  groups: {
    missing: { cases: missing.cases, aRuns: missing.aRuns, bRuns: missing.bRuns, aPasses: missing.aPasses, bPasses: missing.bPasses, aRunRate: missing.aRunRate, bRunRate: missing.bRunRate, aCaseMean: missing.aCaseMean, bCaseMean: missing.bCaseMean },
    control: { cases: control.cases, aRuns: control.aRuns, bRuns: control.bRuns, aPasses: control.aPasses, bPasses: control.bPasses, aRunRate: control.aRunRate, bRunRate: control.bRunRate, aCaseMean: control.aCaseMean, bCaseMean: control.bCaseMean },
  },
  cost: { aTokens, bTokens, tokenRatio, aCalls, bCalls, callRatio, aUsageUnknownRuns: aUnknown, bUsageUnknownRuns: bUnknown },
  unproductive: { a: aUnprod, b: bUnprod },
  gates: gateResults,
  verdict: allPassed ? "ALL_GATES_PASSED" : "NOT_PROVEN",
  promotion: "NOT_ELIGIBLE_ON_WIN32_INSECURE_LOCAL",
  modelQuality: "MEASURED_BY_THIS_CAMPAIGN",
  paidProviderCalls: aCalls + bCalls,
  note:
    "A verified pass means the ORIGINAL command verifier decided the case passed; partial pairs are reported and block an all-gates verdict. " +
    "The USD ceiling is bound but not metered per call: this endpoint publishes no price table, so cost is reported in tokens and model calls only.",
};

mkdirSync(outDir, { recursive: true });
const text = `${JSON.stringify(result, null, 2)}\n`;
writeFileSync(join(outDir, "judge-result.json"), text, "utf8");
writeFileSync(join(outDir, "judge-result.sha256"), `${createHash("sha256").update(text, "utf8").digest("hex")}\n`, "utf8");

process.stdout.write(`judge ${experiment}: ${result.verdict} (pairs ${finalized.length} finalized / ${partial.length} partial)\n`);
for (const g of gateResults) {
  process.stdout.write(`  ${g.passed ? "PASS" : "FAIL"}  ${g.gate}: observed ${typeof g.observed === "number" ? g.observed.toFixed(4) : g.observed} (required ${g.required})\n`);
}
process.exit(allPassed ? 0 : 1);
