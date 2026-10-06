/** Verify historical raw evidence without changing source or contacting a provider. */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { assert, dependencies, digest, executionIdentity, filesIn, loadExperiment, readJson, stable, validateBindingPolicy, verifyCampaignRaw, verifyIndex } from "./execution-common.mjs";
import { recoverPairs, validateSoak } from "./n7-paired-campaign.mjs";
import { judgeData } from "./n7-judge-core.mjs";
import { conditionProbe } from "./condition-probe.mjs";

export async function loadJudgment(role, root) {
  const experiment = await loadExperiment(role);
  const names = readdirSync(join(root, "attempts")).sort();
  assert(names.length > 0 && names.every(n => /^\d{4}$/.test(n)), "ATTEMPT_MISSING");
  const attempt = join(root, "attempts", names.at(-1));
  verifyCampaignRaw(root, attempt);
  const binding = readJson(join(root, "execution-binding.json"));
  validateBindingPolicy(binding);
  assert(stable(binding.experiments.find(e => e.role === role)) === stable(experiment.facts), "EXPERIMENT_BINDING_DRIFT");
  const header = readJson(join(root, "campaign-header.json"));
  const identity = readJson(join(root, "execution-identity.json"));
  const result = readJson(join(attempt, "campaign-result.json"));
  const { evaluation: ev, cli } = await dependencies();
  assert(stable(identity) === stable(await executionIdentity(experiment, binding)), "EXECUTION_IDENTITY_DRIFT");
  const identityDigest = ev.computeExecutionIdentityDigestV1(identity);
  assert(identityDigest === result.executionIdentityDigest && identityDigest === header.executionIdentityDigest, "EXECUTION_IDENTITY_DRIFT");
  assert(header.campaignDigest === digest({ binding: binding.executionBindingDigest, role, identityDigest }), "CAMPAIGN_IDENTITY_DRIFT");
  const soak = readJson(join(root, "soak-result.json"));
  validateSoak(soak, binding);
  const finalized = readJson(join(attempt, "finalized-pairs.json"));
  const partial = readJson(join(attempt, "partial-pairs.json"));
  const records = readdirSync(join(root, "requests")).sort().map(n => readJson(join(root, "requests", n)));
  const ledger = readJson(join(attempt, "budget-ledger-snapshot.json"));
  const parsed = ev.parseR97Ledger(ledger);
  assert(parsed.ledger !== null && ledger.planDigest === header.campaignDigest, "BUDGET_IDENTITY_DRIFT");
  const view = ev.viewOfR97Ledger(parsed.ledger);
  assert(stable(view) === stable(result.ledger), "BUDGET_COUNT_DRIFT");
  assert(view.committed + view.unknown >= records.length && view.outstanding === 0, "BUDGET_COUNT_DRIFT");
  const cost = readJson(join(attempt, "cost-budget-snapshot.json"));
  assert(stable(cost) === stable(result.costBudget) && cost.preregistrationDigest === header.campaignDigest, "COST_BUDGET_DRIFT");
  // A budget-exhausted/unknown run is archivable as failure, never eligible.
  let originalPairs = [...finalized, ...partial];
  if (header.evidenceKind === "REAL_PROVIDER") {
    const recovered = recoverPairs(experiment.plan, join(root, ".paired-journal", identityDigest));
    const bounded = p => ({ ...p, baseline: p.baseline && { ...p.baseline, outcome: cli.boundOutcomeEvents(p.baseline.outcome) },
      candidate: p.candidate && { ...p.candidate, outcome: cli.boundOutcomeEvents(p.candidate.outcome) } });
    assert(stable(recovered.finalizedPairs.map(bounded)) === stable(finalized) && stable(recovered.partialPairs.map(bounded)) === stable(partial), "PAIR_JOURNAL_DRIFT");
    originalPairs = [...recovered.finalizedPairs, ...recovered.partialPairs];
  }
  const probe = conditionProbe(experiment, records, originalPairs);
  assert(stable(probe) === stable(readJson(join(attempt, "condition-probe.json"))), "CONDITION_PROBE_DRIFT");
  const data = { finalized, partial, records, header, result, identity, binding, soak, probe };
  const judgment = judgeData(experiment, data, { validateActivation: ev.validateActivationV2, isStrictValidArm: ev.isStrictValidArm });
  return { experiment, data, judgment, attempt };
}
export function rawManifestFiles(campaign, judge) {
  return [...filesIn(campaign).map(f => ({ ...f, path: `campaign/${f.path}` })), ...filesIn(judge).map(f => ({ ...f, path: `judge/${f.path}` }))];
}
export async function verifyArchive(role, archive, campaign, judge) {
  verifyIndex(archive); verifyIndex(judge);
  const manifest = readJson(join(archive, "RAW-MANIFEST.json"));
  assert(manifest.schemaVersion === "n7-raw-manifest-v1" && manifest.experiment === role &&
    stable(manifest.files) === stable(rawManifestFiles(campaign, judge)), "ARCHIVE_RAW_DRIFT");
  const { judgment } = await loadJudgment(role, campaign);
  assert(stable(judgment) === stable(readJson(join(archive, "judge-result.json"))) && stable(judgment) === stable(readJson(join(judge, "judge-result.json"))), "FORGED_JUDGMENT");
  return judgment;
}
