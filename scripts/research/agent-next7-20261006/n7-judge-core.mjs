/** Full-grid ITT gate calculations. No provider, source mutation or promotion. */
import { BOOTSTRAP_SEED, digest, stable } from "./execution-common.mjs";
import { infrastructureCounts, soakVerdict } from "./provider-observation.mjs";

const MISSING = new Set(["compact-drop", "preview", "rehydrate", "partial"]);
const CONTROL = new Set(["visible", "changed", "diagnostic"]);
const breach = o => o?.securityOutcome?.hardBreach === true || ["ESCAPE", "BREACH", "VIOLATION", "EXFILTRATION"].includes(o?.securityOutcome?.kind);
const pass = record => record?.valid === true && record.outcome?.status === "passed";
const nonnegative = v => Number.isSafeInteger(v) && v >= 0;
const sum = values => values.reduce((a, b) => a + b, 0);
const mean = values => values.length ? sum(values) / values.length : 0;
const round = n => Math.round(n * 1e8) / 1e8;

function bootstrap(a, b, iterations) {
  let seed = BOOTSTRAP_SEED >>> 0;
  const random = () => {
    seed |= 0; seed = seed + 0x6d2b79f5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  if (a.length === 0) return null;
  const diffs = [];
  for (let i = 0; i < iterations; i++) {
    let total = 0;
    for (let j = 0; j < a.length; j++) { const k = Math.floor(random() * a.length); total += b[k] - a[k]; }
    diffs.push(total / a.length);
  }
  diffs.sort((x, y) => x - y);
  return diffs[Math.max(0, Math.floor(0.05 * diffs.length) - 1)] * 100;
}
export function activationProven(record, pair, prompt, validateActivation) {
  const evidence = record?.outcome?.activationEvidenceV2;
  if (!evidence?.validation?.ok || !Array.isArray(evidence.events)) return false;
  const lineages = new Map([[pair.caseId, [{ caseId: pair.caseId, armId: "candidate", attempt: 1, repetition: pair.repetition }]]]);
  const validated = validateActivation(evidence.events, { expectedCandidateId: prompt.candidateId, expectedArmId: "candidate",
    outcomeLineages: lineages, approvedPromptAdditionsDigest: prompt.guidanceDigest });
  return validated.ok && evidence.events.some(e => e.mechanism === "prompt-guidance" && e.evidenceType === "prompt-guidance-injected" &&
    e.payload?.guidanceVersion === prompt.guidanceVersion && e.payload?.digest === prompt.guidanceDigest);
}

export function judgeData(experiment, data, { validateActivation, isStrictValidArm }) {
  const { plan, prereg, manifest, facts } = experiment;
  const { finalized = [], partial = [], records = [], header, result, identity, binding, soak } = data;
  const gates = prereg.evaluation.gates;
  const issues = [];
  const expected = new Map(plan.pairs.map(p => [p.pairId, p]));
  const pairs = new Map();
  for (const [kind, list] of [["finalized", finalized], ["partial", partial]]) for (const p of list) {
    const frozen = expected.get(p.pairId);
    if (!frozen || p.caseId !== frozen.caseId || p.repetition !== frozen.repetition || p.order !== frozen.order || pairs.has(p.pairId)) {
      issues.push("DUPLICATE_OR_UNREGISTERED_PAIR"); continue;
    }
    for (const side of ["baseline", "candidate"]) {
      const record = p[side];
      if (record !== null && record !== undefined && (stable(record.arm) !== stable(frozen[side]) || record.outcome?.caseId !== p.caseId)) issues.push("ARM_LINEAGE_DRIFT");
      if (kind === "finalized" && (!record?.valid || !isStrictValidArm(record.outcome))) issues.push("INVALID_FINALIZED_PAIR");
    }
    pairs.set(p.pairId, { ...p, kind });
  }
  const absent = plan.pairs.length - pairs.size;
  if (absent > 0) issues.push("UNRUN_PAIRS");
  const condition = new Map(manifest.cases.map(c => [c.caseId, c.condition]));
  const grid = plan.pairs.map(p => ({ frozen: p, actual: pairs.get(p.pairId) }));
  function stats(filter, rowFilter = () => true) {
    const rows = grid.filter(r => filter(condition.get(r.frozen.caseId)) && rowFilter(r));
    const perCase = new Map();
    for (const row of rows) {
      const entry = perCase.get(row.frozen.caseId) ?? { A: [], B: [] };
      entry.A.push(Number(pass(row.actual?.baseline))); entry.B.push(Number(pass(row.actual?.candidate)));
      perCase.set(row.frozen.caseId, entry);
    }
    const aRates = [...perCase.values()].map(e => mean(e.A)), bRates = [...perCase.values()].map(e => mean(e.B));
    return { cases: perCase.size, runsPerArm: rows.length, aPasses: sum([...perCase.values()].flatMap(e => e.A)),
      bPasses: sum([...perCase.values()].flatMap(e => e.B)), aCaseMean: mean(aRates), bCaseMean: mean(bRates),
      liftPp: round((mean(bRates) - mean(aRates)) * 100), aRates, bRates };
  }
  const missing = stats(c => MISSING.has(c)), control = stats(c => CONTROL.has(c)), overall = stats(() => true);
  const witnesses = data.probe?.entries ?? [];
  const bitePairs = grid.filter(r => MISSING.has(condition.get(r.frozen.caseId)) && ["baseline", "candidate"].every(arm =>
    witnesses.some(w => w.caseId === r.frozen.caseId && w.repetition === r.frozen.repetition && w.arm === arm && w.observed === true)));
  const biteIds = new Set(bitePairs.map(r => r.frozen.pairId));
  const perProtocol = stats(c => MISSING.has(c), r => r.actual?.kind === "finalized" && biteIds.has(r.frozen.pairId) &&
    ["baseline", "candidate"].every(arm => r.actual[arm]?.valid === true && isStrictValidArm(r.actual[arm].outcome)));
  const lowerBound = bootstrap(missing.aRates, missing.bRates, gates.pairedBootstrapIterations);
  const all = side => [...pairs.values()].map(p => p[side]).filter(Boolean);
  const A = all("baseline"), B = all("candidate");
  const securityLineage = [...pairs.values()].every(pair => ["baseline", "candidate"].every(side => {
    const record = pair[side]; if (!record) return true;
    const outcome = record.outcome?.securityOutcome;
    return outcome?.caseId === pair.caseId && outcome.armId === side && Array.isArray(outcome.facts)
      && outcome.facts.every(f => f.correlation?.caseId === pair.caseId && f.correlation.armId === side
        && (f.correlation.repetition === null || f.correlation.repetition === pair.repetition));
  }));
  const security = side => ({ violations: side.filter(r => breach(r.outcome)).length,
    falseCompletes: side.filter(r => r.outcome?.grade === "unverified_complete" && r.outcome?.status !== "passed").length });
  const aSec = security(A), bSec = security(B);
  // Unknown and missing fields stay unknown; never coerce them to zero.
  const metricsComplete = [...A, ...B].every(r => ["tokens_input", "tokens_output", "tool_call_count", "usage_unknown"].every(k => nonnegative(r.outcome?.metrics?.[k])) &&
    r.outcome.metrics.usage_unknown === 0 && nonnegative(r.modelCallAttempts));
  const cost = side => ({ tokens: metricsComplete ? sum(side.map(r => r.outcome.metrics.tokens_input + r.outcome.metrics.tokens_output)) : null,
    calls: metricsComplete ? sum(side.map(r => r.modelCallAttempts)) : null });
  const costA = cost(A), costB = cost(B);
  const ratioOk = (a, b, ceiling) => a !== null && b !== null && (a === 0 ? b === 0 : b <= a * ceiling + 1e-9);
  const unproductive = side => {
    const failed = side.filter(r => !pass(r));
    return metricsComplete ? failed.length === 0 ? 0 : sum(failed.map(r => r.outcome.metrics.tool_call_count)) / failed.length : null;
  };
  const activated = grid.filter(r => activationProven(r.actual?.candidate, r.frozen, prereg.prompt, validateActivation)).length;
  const counts = infrastructureCounts(records);
  const tapeComplete = records.every((r, i) => {
    const pair = expected.get(r.scope?.armRunId?.replace(/-(baseline|candidate)$/, ""));
    return pair && r.requestId === i + 1 && r.modelId === prereg.provider.modelId && r.requestDigest === digest(r.request) &&
      r.scope.campaignDigest === header?.campaignDigest && ["baseline", "candidate"].includes(r.scope.arm) &&
      r.scope.armRunId === `${pair.pairId}-${r.scope.arm}` && r.scope.caseId === pair.caseId && r.scope.repetition === pair.repetition &&
      r.usage !== null && nonnegative(r.usage.inputTokens) && nonnegative(r.usage.outputTokens);
  });
  const tapeCost = side => ({ calls: records.filter(r => r.scope?.arm === side).length,
    tokens: sum(records.filter(r => r.scope?.arm === side && r.usage !== null).map(r => r.usage.inputTokens + r.usage.outputTokens)) });
  const reconciliation = metricsComplete && tapeComplete && stable(costA) === stable(tapeCost("baseline")) && stable(costB) === stable(tapeCost("candidate"));
  const frozenCaps = { maxInputTokens: prereg.budget.maxInputTokens, maxOutputTokens: prereg.budget.maxOutputTokens,
    maxTotalTokens: prereg.budget.maxTotalTokens, maxToolCalls: prereg.budget.maxToolCalls, maxDurationMs: prereg.budget.maxDurationMs,
    maxUsdMicros: prereg.budget.maxUsdMicros, maxModelCalls: prereg.budget.campaignWorstCaseModelCalls };
  const budget = result?.costBudget;
  const durableBudget = result?.ledger?.committed === counts.physicalAttempts && result?.ledger?.unknown === 0 && result?.ledger?.outstanding === 0 &&
    result?.ledger?.granted === prereg.budget.campaignWorstCaseModelCalls && budget?.preregistrationDigest === header?.campaignDigest &&
    stable(budget?.caps) === stable(frozenCaps) && budget?.charged?.unknownCalls === 0 && reconciliation &&
    budget?.charged?.inputTokens === costA.tokens - sum(A.map(r => r.outcome.metrics.tokens_output)) + costB.tokens - sum(B.map(r => r.outcome.metrics.tokens_output)) &&
    budget?.charged?.totalTokens === costA.tokens + costB.tokens &&
    ["inputTokens", "outputTokens", "totalTokens", "toolCalls", "durationMs", "usdMicros"].every(k => nonnegative(budget?.charged?.[k])) &&
    budget.charged.inputTokens <= frozenCaps.maxInputTokens && budget.charged.outputTokens <= frozenCaps.maxOutputTokens &&
    budget.charged.totalTokens <= frozenCaps.maxTotalTokens && budget.charged.toolCalls <= frozenCaps.maxToolCalls &&
    budget.charged.durationMs <= frozenCaps.maxDurationMs && budget.charged.usdMicros <= frozenCaps.maxUsdMicros &&
    binding?.pricing !== null && nonnegative(binding?.pricing?.amountUsdMicros) && budget.charged.usdMicros >= counts.physicalAttempts * binding.pricing.amountUsdMicros;
  const completionRatio = finalized.length / plan.pairs.length;
  const transportRate = counts.physicalAttempts ? counts.transportFailures / counts.physicalAttempts : null;
  const real = header?.evidenceKind === "REAL_PROVIDER" && result?.evidenceKind === "REAL_PROVIDER";
  const identityOk = header?.schemaVersion === "n7-campaign-header-v1" && result?.schemaVersion === "n7-campaign-result-v1" &&
    header.experiment === facts.role && result.experiment === facts.role && header.smoke === false &&
    stable(header.facts) === stable(facts) && header.frozenPreregistrationDigest === prereg.preregistrationDigest &&
    result.frozenPreregistrationDigest === prereg.preregistrationDigest && result.executionBindingDigest === binding?.executionBindingDigest &&
    header.executionBindingDigest === binding?.executionBindingDigest && identity?.sourceSha === binding?.source?.sourceSha &&
    identity?.candidate === prereg.prompt.candidateId && identity?.scheduleDigest === plan.planDigest &&
    identity?.baselineConfigHash === facts.runtimeConfigHashes.baseline && identity?.candidateConfigHash === facts.runtimeConfigHashes.candidate &&
    identity?.providerId === prereg.provider.providerId && identity?.modelId === prereg.provider.modelId &&
    result.sourceUnchanged === true;
  const actualSoak = soak?.evidenceKind === "REAL_PROVIDER" && soak.executionBindingDigest === binding?.executionBindingDigest && soakVerdict(soak.records ?? []).passed;
  const infraOk = result?.status === "COMPLETED" && result.complete === true && completionRatio >= 0.95 && transportRate !== null && transportRate < 0.01 &&
    counts.modelNotFound === 0 && counts.incompleteUsage === 0 && actualSoak;
  const gateResults = [];
  const add = (gate, passed, observed, required) => gateResults.push({ gate, passed: Boolean(passed), observed, required });
  add("execution_identity_proven", identityOk && securityLineage, { identityOk, securityLineage }, true);
  add("infrastructure_qualified", infraOk, { completionRatio, transportRate, ...counts }, "24-call real soak; transport <1%; complete frozen grid AND completion >=95%; usage complete");
  add("full_frozen_grid", issues.length === 0 && absent === 0 && partial.length === 0 && finalized.length === plan.pairs.length, { issues: [...new Set(issues)], absent, partial: partial.length }, `${plan.pairs.length} complete unique pairs`);
  add("missing_group_lift_pp", missing.liftPp + 1e-9 >= gates.missingGroupVerifiedPassRateLiftPp, missing.liftPp, gates.missingGroupVerifiedPassRateLiftPp);
  add("paired_bootstrap_95pct_lower_bound_pp", lowerBound !== null && lowerBound + 1e-9 >= gates.pairedBootstrapOneSidedLowerBoundMin, lowerBound, { min: 0, iterations: gates.pairedBootstrapIterations, seed: BOOTSTRAP_SEED });
  add("control_group_not_worse", control.bPasses >= control.aPasses, { A: control.aPasses, B: control.bPasses }, "B >= A");
  add("no_new_security_violations_or_false_completes", bSec.violations - aSec.violations <= gates.newSecurityViolationsMax && bSec.falseCompletes - aSec.falseCompletes <= gates.newFalseCompleteMax, { A: aSec, B: bSec }, "no new observations, including partial arms");
  add("usage_complete_and_reconciled", reconciliation && counts.incompleteUsage === 0, { metricsComplete, tapeComplete, reconciliation }, true);
  add("durable_budget_proven", durableBudget, durableBudget, "unchanged frozen caps, zero unknown/outstanding, counters reconcile");
  add("tokens_within_110pct", ratioOk(costA.tokens, costB.tokens, gates.totalTokensMaxRatioOfBaseline), { A: costA.tokens, B: costB.tokens }, gates.totalTokensMaxRatioOfBaseline);
  add("model_call_attempts_within_110pct", ratioOk(costA.calls, costB.calls, gates.modelCallAttemptsMaxRatioOfBaseline), { A: costA.calls, B: costB.calls }, gates.modelCallAttemptsMaxRatioOfBaseline);
  add("unproductive_tool_calls_not_growing", unproductive(A) !== null && unproductive(B) !== null && unproductive(B) <= unproductive(A) + 1e-9, { A: unproductive(A), B: unproductive(B) }, "N6 proxy: tools per failed run, B <= A");
  add("candidate_activation_proven", activated === plan.pairs.length, { activated, expected: plan.pairs.length }, "v2 exact digest + validated lineage in every candidate arm");
  if (facts.role === "holdout") add("holdout_overall_pass_rate_not_worse", overall.bPasses >= overall.aPasses, { A: overall.aPasses, B: overall.bPasses }, "B >= A");
  const passedAll = gateResults.every(g => g.passed);
  const compact = ({ aRates, bRates, ...s }) => s;
  const ppReport = { ...compact(perProtocol), status: perProtocol.runsPerArm ? "CORROBORATION_ONLY" : "NOT_OBSERVED",
    selection: "COMPLETE_MISSING_PAIRS_WITH_BOTH_ARMS_OBSERVED_AT_EDIT",
    ...(perProtocol.runsPerArm ? {} : { aCaseMean: null, bCaseMean: null, liftPp: null }) };
  const biteStats = { observedPairs: bitePairs.length, aPasses: bitePairs.filter(r => pass(r.actual?.baseline)).length,
    bPasses: bitePairs.filter(r => pass(r.actual?.candidate)).length, status: bitePairs.length ? "CORROBORATION_ONLY" : "NOT_OBSERVED" };
  const report = { schemaVersion: "n7-judge-result-v1", experiment: facts.role, evidenceKind: real ? "REAL_PROVIDER" : "SYNTHETIC",
    frozenPreregistrationDigest: prereg.preregistrationDigest, executionBindingDigest: binding?.executionBindingDigest ?? null,
    executionIdentityDigest: result?.executionIdentityDigest ?? null,
    groups: { missing: compact(missing), control: compact(control), overall: compact(overall) }, perProtocol: ppReport, conditionBite: biteStats,
    cost: { A: costA, B: costB }, security: { A: aSec, B: bSec }, coverage: { expected: plan.pairs.length, finalized: finalized.length, partial: partial.length, absent, issues: [...new Set(issues)] },
    gates: gateResults, verdict: real && passedAll ? "ALL_GATES_PASSED" : real ? "NOT_PROVEN" : "SYNTHETIC_CHECK_ONLY",
    modelQuality: real && infraOk ? "MEASURED_BY_THIS_CAMPAIGN" : "NOT_RUN",
    promotion: real && passedAll && binding?.isolation?.promotionEligible === true ? "REQUIRES_BOTH_EXPERIMENTS_AND_ENGINEERING_GATES" : "NOT_ELIGIBLE",
    note: "ITT uses the entire frozen grid; invalid/unrun arms fail. PP uses complete missing-condition pairs witnessed at edit in both arms, for corroboration only. A single experiment never qualifies promotion; archiving never activates a candidate." };
  return { ...report, judgeDigest: digest(report) };
}
