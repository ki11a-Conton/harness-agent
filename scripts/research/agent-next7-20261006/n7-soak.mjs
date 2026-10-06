/** Real-provider qualification only. Synthetic probes cannot produce this receipt. */
import { join, resolve } from "node:path";
import { arg, digest, flag, freshDirectory, main, readJson, REPO, validateBinding, writeIndex, writeJson } from "./execution-common.mjs";
import { openBudgets, realProvider } from "./execution-budget.mjs";
import { runSoak } from "./provider-observation.mjs";

await main(async () => {
  const binding = readJson(resolve(arg("binding", join(REPO, ".ci/n7/execution-binding/execution-binding.json"))));
  const { experiments } = await validateBinding(binding, { paid: true, allowInsecure: flag("allow-insecure-local-benchmark"), confirm: arg("plan-digest") });
  const out = freshDirectory(resolve(arg("out", join(REPO, ".ci/n7/soak"))));
  writeJson(join(out, "execution-binding.json"), binding);
  const campaignDigest = digest({ binding: binding.executionBindingDigest, phase: "24-call-soak" });
  const budgets = await openBudgets(out, binding, experiments[0].prereg, campaignDigest, { soak: true });
  const channel = budgets.wrap(await realProvider(binding), "soak");
  const startedAt = new Date().toISOString();
  const result = await runSoak(channel.provider, { modelId: binding.provider.modelId,
    beforeCall(i) {
      budgets.costBudget.bindJournalScope(null);
      budgets.costBudget.bindJournalScope({ campaignDigest, armRunId: `soak-${i + 1}`, arm: "candidate", caseId: "infrastructure-soak", repetition: i });
    } });
  writeJson(join(out, "soak-result.json"), { schemaVersion: "n7-soak-result-v1", evidenceKind: "REAL_PROVIDER",
    executionBindingDigest: binding.executionBindingDigest, campaignDigest, startedAt, finishedAt: new Date().toISOString(),
    ...result, status: result.passed ? "QUALIFIED" : "INFRASTRUCTURE_FAILED", modelQuality: "NOT_RUN", promotion: "NOT_RUN",
    ledger: await budgets.ledger.view(), costBudget: budgets.costBudget.view(), budgetStats: channel.stats });
  writeIndex(out);
  process.stdout.write(`N7 soak ${result.passed ? "QUALIFIED" : "INFRASTRUCTURE_FAILED"}: ${result.counts.generateCalls}/24 calls\n`);
  process.exitCode = result.passed ? 0 : 1;
});
