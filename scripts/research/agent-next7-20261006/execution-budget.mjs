/** Reuse the existing durable call, cost, retry and tool admission machinery. */
import { join } from "node:path";
import { assert, dependencies, endpointOf } from "./execution-common.mjs";

export async function openBudgets(out, binding, prereg, campaignDigest, { resume = false, soak = false } = {}) {
  const { evaluation: ev } = await dependencies();
  const budget = { ...prereg.budget, ...(soak ? { campaignWorstCaseModelCalls: 24 } : {}) };
  const budgetArtifact = { budget, preregistrationDigest: campaignDigest };
  const dir = join(out, "budget");
  const ledger = await ev.openR97BudgetLedger(dir, { planDigest: campaignDigest, campaignModelCalls: budget.campaignWorstCaseModelCalls,
    mode: resume ? "resume" : "first-run" });
  assert(ledger.duplicateCampaignDirs.length === 0, "DUPLICATE_CAMPAIGN");
  await ledger.recover();
  const view = await ledger.view();
  assert(view.unknown === 0 && view.outstanding === 0, "UNKNOWN_DISPATCH_REQUIRES_RECONCILIATION");
  const costBudget = await ev.CostBudget.open(dir, budgetArtifact, { allowCreate: !resume });
  const deadlineAtMs = costBudget.deadlineAtMs();
  const toolBudget = ev.createDurableToolDispatchBudget({ costBudget, deadlineAtMs, journal: { dir, campaignDigest } });
  const wrap = (provider, arm) => ev.createFormalBudgetedProvider({ provider, ledger, costBudget, arm,
    usdMicrosPerCall: binding.pricing.amountUsdMicros, pricingGuard: binding.pricing, deadlineAtMs });
  return { ledger, costBudget, toolBudget, deadlineAtMs, wrap };
}
export function withModelCallCap(provider, cap) {
  let attempts = 0; // shared by every client in this single arm run
  return { id: provider.id, listModels: () => provider.listModels(), createClient(model, config) {
    const inner = provider.createClient(model, config);
    return { async *generate(request, signal) {
      assert(attempts < cap, "PER_RUN_MODEL_CALL_CAP");
      attempts++;
      yield* inner.generate(request, signal);
    } };
  } };
}
export async function realProvider(binding) {
  const { provider: mod, model } = await dependencies();
  const resolved = await mod.resolveModelProvider({ baseUrl: endpointOf(), modelId: binding.provider.modelId });
  assert(resolved.billingClass === "external-billed" && resolved.provider.id === binding.provider.providerId, "REAL_PROVIDER_REQUIRED");
  return model.withOpenAIRequestPolicy(resolved.provider, binding.provider.requestPolicy);
}
