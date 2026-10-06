/** N7 runner: actual v2 arm, 512 main / 192 holdout; original Harness/verifier. */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { arg, assert, campaignFiles, dependencies, digest, executionIdentity, flag, freshDirectory, loadExperiment, main, readJson, REPO,
  sourceSnapshot, stable, validateBinding, verifyCampaignRaw, verifyIndex, writeIndex, writeJson } from "./execution-common.mjs";
import { openBudgets, realProvider, withModelCallCap } from "./execution-budget.mjs";
import { infrastructureCounts, observedProvider, soakVerdict } from "./provider-observation.mjs";
import { conditionProbe } from "./condition-probe.mjs";

export function validateSoak(soak, binding) {
  assert(soak.schemaVersion === "n7-soak-result-v1" && soak.evidenceKind === "REAL_PROVIDER" && soak.status === "QUALIFIED", "REAL_SOAK_REQUIRED");
  assert(soak.executionBindingDigest === binding.executionBindingDigest, "SOAK_BINDING_DRIFT");
  assert(soak.records.every((r, i) => r.requestId === i + 1 && r.modelId === binding.provider.modelId), "SOAK_RECORD_DRIFT");
  const computed = soakVerdict(soak.records);
  assert(computed.passed && stable(computed.counts) === stable(soak.counts), "SOAK_FAILED");
  assert(soak.ledger?.committed === 24 && soak.ledger?.unknown === 0 && soak.ledger?.outstanding === 0, "SOAK_BUDGET_UNPROVEN");
}
export function recoverPairs(plan, journalDir) {
  const finalizedPairs = [], partialPairs = [];
  for (const pair of plan.pairs) {
    const records = {};
    for (const side of ["baseline", "candidate"]) {
      const path = join(journalDir, `${pair.pairId}-${side}.json`);
      if (!existsSync(path)) { records[side] = null; continue; }
      const item = readJson(path);
      assert(item.planDigest === plan.planDigest && stable(item.arm) === stable(pair[side]), "JOURNAL_DRIFT");
      records[side] = { arm: item.arm, valid: item.valid, outcome: item.outcome, modelCallAttempts: item.modelCallAttempts, transportRetries: item.transportRetries };
    }
    if (records.baseline === null && records.candidate === null) continue;
    const result = { pairId: pair.pairId, caseId: pair.caseId, repetition: pair.repetition, order: pair.order, ...records };
    if (records.baseline?.valid && records.candidate?.valid) finalizedPairs.push(result);
    else partialPairs.push({ ...result, reason: records.baseline && records.candidate ? "invalid-arm" : "half-pair" });
  }
  return { finalizedPairs, partialPairs };
}
async function run() {
  const role = arg("experiment", "main");
  const experiment = await loadExperiment(role);
  const { prereg, cases, plan, facts } = experiment;
  const out = resolve(arg("out", join(REPO, ".ci/n7", role)));
  if (flag("dry")) {
    freshDirectory(out);
    writeJson(join(out, "dry-run.json"), { schemaVersion: "n7-campaign-dry-run-v1", ...facts,
      source: sourceSnapshot({ requireClean: false }), candidate: facts.candidates.candidate,
      ab: plan.pairs.filter(p => p.order === "AB").length, ba: plan.pairs.filter(p => p.order === "BA").length,
      providerCalls: 0, paidProviderCalls: 0, modelQuality: "NOT_RUN", promotion: "NOT_RUN",
      note: "Wiring proof only. Execution requires a clean binding, qualified real soak, valid pricing and paid confirmation." });
    writeIndex(out);
    process.stdout.write(`N7 ${role}: ${plan.totalLogicalRuns} logical runs, ${plan.pairs.length} pairs, candidate=${facts.candidates.candidate}, paidCalls=0\n`);
    return;
  }
  const binding = readJson(resolve(arg("binding", join(REPO, ".ci/n7/execution-binding/execution-binding.json"))));
  await validateBinding(binding, { paid: true, allowInsecure: flag("allow-insecure-local-benchmark"), confirm: arg("plan-digest") });
  const soakDir = resolve(arg("soak", join(REPO, ".ci/n7/soak")));
  verifyIndex(soakDir);
  const soak = readJson(join(soakDir, "soak-result.json"));
  validateSoak(soak, binding);
  const { evaluation: ev, cli } = await dependencies();
  const identity = await executionIdentity(experiment, binding);
  const identityDigest = ev.computeExecutionIdentityDigestV1(identity);
  const campaignDigest = digest({ binding: binding.executionBindingDigest, role, identityDigest });
  const resume = flag("resume");
  const header = { schemaVersion: "n7-campaign-header-v1", evidenceKind: "REAL_PROVIDER", experiment: role, smoke: false,
    executionBindingDigest: binding.executionBindingDigest, frozenPreregistrationDigest: prereg.preregistrationDigest,
    executionIdentityDigest: identityDigest, campaignDigest, facts, isolation: binding.isolation, source: binding.source };
  if (!resume) freshDirectory(out);
  // Reuse the existing lock implementation in the campaign root. The call/cost
  // ledger uses its own budget directory, so nested per-call locking is safe.
  await ev.withR97CampaignLock(out, async () => {
  if (resume) {
    assert(stable(readJson(join(out, "campaign-header.json"))) === stable(header), "RESUME_IDENTITY_DRIFT");
    // Verify the preceding attempt's immutable index before opening its budgets.
    for (const name of readdirSync(join(out, "attempts"))) verifyIndex(join(out, "attempts", name));
    const latest = readdirSync(join(out, "attempts")).sort().at(-1);
    assert(latest !== undefined, "RESUME_EVIDENCE_MISSING");
    verifyCampaignRaw(out, join(out, "attempts", latest));
  } else {
    writeJson(join(out, "campaign-header.json"), header);
    writeJson(join(out, "execution-binding.json"), binding);
    writeJson(join(out, "execution-identity.json"), identity);
    writeJson(join(out, "soak-result.json"), soak);
    mkdirSync(join(out, "requests"));
    mkdirSync(join(out, "attempts"));
  }
  const attemptDir = freshDirectory(join(out, "attempts", String(readdirSync(join(out, "attempts")).length + 1).padStart(4, "0")));
  const budgets = await openBudgets(out, binding, prereg, campaignDigest, { resume });
  const previousRecords = readdirSync(join(out, "requests")).sort().map(name => readJson(join(out, "requests", name)));
  const observed = observedProvider(await realProvider(binding), { initialRecords: previousRecords, secrets: [process.env.OPENAI_API_KEY],
    scope: () => budgets.costBudget.currentJournalScope(), record: r => writeJson(join(out, "requests", `${String(r.requestId).padStart(7, "0")}.json`), r) });
  const journalDir = join(out, ".paired-journal", identityDigest);
  let result, stop = null;
  const startedAt = new Date().toISOString();
  try {
    result = await ev.runPairedExperiment({ plan, cases, provider: observed.provider,
      maxModelCalls: prereg.budget.campaignWorstCaseModelCalls, journalDir, identity, modelSeed: null,
      async runArm(arm, caseDef, ctx) {
        budgets.costBudget.bindJournalScope({ campaignDigest, armRunId: ctx.armRunId, arm: arm.armId, caseId: caseDef.id, repetition: arm.repetition });
        const channel = budgets.wrap(ctx.provider, arm.armId);
        try {
          return await cli.runOneCase(caseDef, { provider: withModelCallCap(channel.provider, prereg.budget.maxModelCallsPerRun), modelId: binding.provider.modelId,
            budgetTokens: binding.provider.profile.budgetTokens, candidate: facts.candidates[arm.armId] ?? undefined,
            processConfinement: binding.isolation.strength, armId: arm.armId, repetition: arm.repetition, attempt: 1,
            toolBudget: budgets.toolBudget, dispatchDeadlineAtMs: () => budgets.deadlineAtMs }, "regression");
        } finally { budgets.costBudget.bindJournalScope(null); }
      },
      onArmCompleted({ logicalRuns }) {
        if (logicalRuns % 8 === 0) process.stdout.write(`N7 ${role} ${logicalRuns}/${plan.totalLogicalRuns} arms\n`);
        const last = observed.records.at(-1), counts = infrastructureCounts(observed.records);
        assert(counts.modelNotFound === 0, "MODEL_NOT_FOUND");
        assert(!last || last.usage !== null, "USAGE_INCOMPLETE");
        const recent = observed.records.slice(-6);
        assert(recent.length < 6 || !recent.every(r => r.failure === "transport"), "TRANSPORT_CIRCUIT_BREAKER");
        assert(Date.now() < budgets.deadlineAtMs, "CAMPAIGN_DEADLINE_EXCEEDED");
      } });
    assert(result.status === "ok", "RESUME_REJECTED");
  } catch (error) {
    stop = error.code ?? "EXECUTION_ABORTED";
    result = { ...recoverPairs(plan, journalDir), complete: false, counters: null };
  }
  const pairRecords = [...result.finalizedPairs, ...result.partialPairs];
  const counts = infrastructureCounts(observed.records);
  const completionRatio = result.finalizedPairs.length / plan.pairs.length;
  const transportRate = counts.physicalAttempts === 0 ? null : counts.transportFailures / counts.physicalAttempts;
  const qualified = stop === null && result.complete === true && completionRatio >= 0.95 && transportRate !== null && transportRate < 0.01 && counts.modelNotFound === 0 && counts.incompleteUsage === 0;
  const bounded = p => ({ ...p, baseline: p.baseline && { ...p.baseline, outcome: cli.boundOutcomeEvents(p.baseline.outcome) },
    candidate: p.candidate && { ...p.candidate, outcome: cli.boundOutcomeEvents(p.candidate.outcome) } });
  writeJson(join(attemptDir, "finalized-pairs.json"), result.finalizedPairs.map(bounded));
  writeJson(join(attemptDir, "partial-pairs.json"), result.partialPairs.map(bounded));
  writeJson(join(attemptDir, "campaign-result.json"), { schemaVersion: "n7-campaign-result-v1", experiment: role, evidenceKind: "REAL_PROVIDER",
    executionBindingDigest: binding.executionBindingDigest, executionIdentityDigest: identityDigest, frozenPreregistrationDigest: prereg.preregistrationDigest,
    status: qualified ? "COMPLETED" : "INFRASTRUCTURE_FAILED", stop, complete: result.complete, counters: result.counters,
    observedArmRuns: pairRecords.reduce((n, p) => n + Number(p.baseline !== null) + Number(p.candidate !== null), 0),
    finalizedPairs: result.finalizedPairs.length, partialPairs: result.partialPairs.length, expectedPairs: plan.pairs.length,
    infrastructure: { ...counts, completionRatio, transportRate }, ledger: await budgets.ledger.view(), costBudget: budgets.costBudget.view(),
    sourceUnchanged: stable(sourceSnapshot({ requireClean: false })) === stable(binding.source), startedAt, finishedAt: new Date().toISOString(),
    modelQuality: qualified ? "MEASURED_PENDING_JUDGMENT" : "NOT_PROVEN", promotion: "NOT_RUN" });
  writeJson(join(attemptDir, "budget-ledger-snapshot.json"), await budgets.ledger.read());
  writeJson(join(attemptDir, "cost-budget-snapshot.json"), budgets.costBudget.view());
  writeJson(join(attemptDir, "condition-probe.json"), conditionProbe(experiment, observed.records, pairRecords));
  writeJson(join(attemptDir, "raw-index.json"), { schemaVersion: "n7-campaign-raw-index-v1", files: campaignFiles(out) });
  writeIndex(attemptDir);
  process.stdout.write(`N7 ${role}: ${qualified ? "COMPLETED" : "INFRASTRUCTURE_FAILED"}, ${result.finalizedPairs.length}/${plan.pairs.length} pairs\n`);
  process.exitCode = qualified ? 0 : 1;
  });
}
// Keep recover/qualification helpers importable without starting a campaign.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(run);
