/** Engineering evidence only: synthetic outcomes + non-billed localhost HTTP. */
import { execFileSync, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "@ar/model";
import type { ModelEvent, ModelProvider } from "@ar/contracts";
import { buildActivationEvidenceFromSignalsV2, CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2,
  validateActivationV2, isStrictValidArm } from "@ar/evaluation";

const REPO = resolve(import.meta.dirname, "../../..");
const SCRIPTS = join(REPO, "scripts/research/agent-next7-20261006");
const support = await import(pathToFileURL(join(SCRIPTS, "execution-common.mjs")).href);
const observation = await import(pathToFileURL(join(SCRIPTS, "provider-observation.mjs")).href);
const judging = await import(pathToFileURL(join(SCRIPTS, "n7-judge-core.mjs")).href);
const decision = await import(pathToFileURL(join(SCRIPTS, "n7-decision-core.mjs")).href);
const campaign = await import(pathToFileURL(join(SCRIPTS, "n7-paired-campaign.mjs")).href);
const condition = await import(pathToFileURL(join(SCRIPTS, "condition-probe.mjs")).href);
const evidence = await import(pathToFileURL(join(SCRIPTS, "campaign-evidence.mjs")).href);
const budgetModule = await import(pathToFileURL(join(SCRIPTS, "execution-budget.mjs")).href);
const roots: string[] = [], servers: Server[] = [];
const temporary = () => { const root = mkdtempSync(join(tmpdir(), "n7-execution-")); roots.push(root); return root; };
let main: any, holdout: any;
beforeAll(async () => { [main, holdout] = await Promise.all([support.loadExperiment("main"), support.loadExperiment("holdout")]); });
afterAll(async () => {
  vi.unstubAllEnvs();
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const gate = (report: any, name: string) => report.gates.find((g: any) => g.gate === name);

async function fixture(experiment = main) {
  const source = { sourceSha: "f".repeat(40), sourceDigest: "a".repeat(64) };
  const binding: any = { schemaVersion: "n7-execution-binding-v1", source, experiments: [main.facts, holdout.facts],
    provider: { providerId: "openai", modelId: experiment.prereg.provider.modelId, profile: support.PROFILE, requestPolicy: support.REQUEST_POLICY },
    bootstrapSeed: support.BOOTSTRAP_SEED, infrastructureGates: support.INFRASTRUCTURE_GATES,
    isolation: { backendId: "synthetic-fixture", strength: "insecure-local", contractDigest: "b".repeat(64), promotionEligible: false },
    pricing: { amountUsdMicros: 1, basisDigest: "a".repeat(64), sourceKind: "operator_declared", currency: "USD",
      issuedAtMs: Date.now() - 10000, expiresAtMs: Date.now() + 60000, coveredTokenCeiling: 64000, requiredTokenCeiling: 64000 } };
  binding.executionBindingDigest = support.bindingDigest(binding);
  const identity = await support.executionIdentity(experiment, binding);
  const { evaluation } = await support.dependencies();
  const identityDigest = evaluation.computeExecutionIdentityDigestV1(identity);
  const campaignDigest = support.digest({ binding: binding.executionBindingDigest, role: experiment.facts.role, identityDigest });
  const header = { schemaVersion: "n7-campaign-header-v1", evidenceKind: "SYNTHETIC", experiment: experiment.facts.role, smoke: false,
    facts: experiment.facts, frozenPreregistrationDigest: experiment.prereg.preregistrationDigest,
    executionBindingDigest: binding.executionBindingDigest, executionIdentityDigest: identityDigest, campaignDigest };
  const record = (side: string, p: any, passed: boolean) => ({ arm: p[side], valid: true, modelCallAttempts: 1, transportRetries: 0,
    outcome: { caseId: p.caseId, status: passed ? "passed" : "failed", actualStatus: passed ? "completed" : "failed", grade: passed ? "verified_complete" : "failed",
      metrics: { tokens_input: 10, tokens_output: 2, tool_call_count: 1, usage_unknown: 0, model_call_count: 1 },
      securityOutcome: { kind: "NO_ATTACK_ATTEMPT", hardBreach: false },
      ...(side === "candidate" ? { activationEvidenceV2: buildActivationEvidenceFromSignalsV2({ candidateId: experiment.prereg.prompt.candidateId,
        caseId: p.caseId, armId: side, repetition: p.repetition, attempt: 1, eligible: true,
        approvedPromptAdditionsDigest: experiment.prereg.prompt.guidanceDigest,
        signals: [{ type: "context_safe_tool_call_efficiency_guidance_injected", payload: {
          guidanceVersion: experiment.prereg.prompt.guidanceVersion, blockText: CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2 } }] }) } : {}) } });
  const missingIds = new Set(experiment.manifest.cases.filter((c: any) => ["compact-drop", "preview", "rehydrate", "partial"].includes(c.condition)).map((c: any) => c.caseId));
  const finalized = experiment.plan.pairs.map((p: any) => ({ pairId: p.pairId, caseId: p.caseId, repetition: p.repetition, order: p.order,
    baseline: record("baseline", p, missingIds.has(p.caseId) ? p.repetition < 1 : p.repetition < 3),
    candidate: record("candidate", p, missingIds.has(p.caseId) ? p.repetition < 2 : p.repetition < 3) }));
  const records: any[] = [];
  for (const p of finalized) for (const arm of ["baseline", "candidate"]) {
    const request = { messages: [{ role: "user", content: "SYNTHETIC" }] };
    records.push({ requestId: records.length + 1, modelId: binding.provider.modelId, completed: true, usage: { inputTokens: 10, outputTokens: 2 },
      retries: [], failure: null, request, requestDigest: support.digest(request), scope: { campaignDigest, armRunId: `${p.pairId}-${arm}`, arm, caseId: p.caseId, repetition: p.repetition } });
  }
  const result = { schemaVersion: "n7-campaign-result-v1", evidenceKind: "SYNTHETIC", status: "COMPLETED", complete: true,
    experiment: experiment.facts.role, executionBindingDigest: binding.executionBindingDigest,
    frozenPreregistrationDigest: experiment.prereg.preregistrationDigest, executionIdentityDigest: identityDigest, sourceUnchanged: true,
    ledger: { granted: experiment.prereg.budget.campaignWorstCaseModelCalls, committed: records.length, unknown: 0, outstanding: 0, remaining: experiment.prereg.budget.campaignWorstCaseModelCalls - records.length, transportRetries: 0 },
    costBudget: { preregistrationDigest: campaignDigest, caps: { maxInputTokens: experiment.prereg.budget.maxInputTokens,
      maxOutputTokens: experiment.prereg.budget.maxOutputTokens, maxTotalTokens: experiment.prereg.budget.maxTotalTokens,
      maxToolCalls: experiment.prereg.budget.maxToolCalls, maxDurationMs: experiment.prereg.budget.maxDurationMs,
      maxUsdMicros: experiment.prereg.budget.maxUsdMicros, maxModelCalls: experiment.prereg.budget.campaignWorstCaseModelCalls },
      charged: { inputTokens: records.length * 10, outputTokens: records.length * 2, totalTokens: records.length * 12,
        toolCalls: records.length, durationMs: 100, usdMicros: records.length, unknownCalls: 0 } } };
  const soakRecords = Array.from({ length: 24 }, (_, i) => ({ requestId: i + 1, modelId: binding.provider.modelId,
    completed: true, usage: { inputTokens: 1, outputTokens: 1 }, retries: [], failure: null }));
  const soak = { schemaVersion: "n7-soak-result-v1", evidenceKind: "REAL_PROVIDER", status: "QUALIFIED", executionBindingDigest: binding.executionBindingDigest,
    records: soakRecords, ...observation.soakVerdict(soakRecords), ledger: { committed: 24, unknown: 0, outstanding: 0 } };
  return { finalized, partial: [] as any[], records, header, result, identity, binding, soak };
}
function judge(data: any, experiment = main) { return judging.judgeData(experiment, data, { validateActivation: validateActivationV2, isStrictValidArm }); }

async function writeSyntheticBundle(experiment: any, raw: string) {
  mkdirSync(join(raw, "attempts/0001"), { recursive: true }); mkdirSync(join(raw, "requests"));
  const f = await fixture(experiment), { evaluation } = await support.dependencies();
  const ledger = await evaluation.openR97BudgetLedger(join(raw, "budget"), { planDigest: f.header.campaignDigest,
    campaignModelCalls: experiment.prereg.budget.campaignWorstCaseModelCalls, mode: "first-run" });
  const reservation = await ledger.reserve("synthetic-fixture", f.records.length);
  await ledger.commit(reservation.reservationId, f.records.length);
  f.result.ledger = await ledger.view();
  const cost = await evaluation.CostBudget.open(join(raw, "budget"), { ...experiment.prereg, preregistrationDigest: f.header.campaignDigest }, { allowCreate: true });
  await cost.charge({ inputTokens: f.records.length * 10, outputTokens: f.records.length * 2, toolCalls: f.records.length, durationMs: 100, usdMicros: f.records.length });
  f.result.costBudget = cost.view();
  for (const [name, value] of [["campaign-header", f.header], ["execution-identity", f.identity], ["execution-binding", f.binding], ["soak-result", f.soak]])
    support.writeJson(join(raw, `${name}.json`), value);
  for (const r of f.records) support.writeJson(join(raw, "requests", `${String(r.requestId).padStart(7, "0")}.json`), r);
  const attempt = join(raw, "attempts/0001");
  for (const [name, value] of [["campaign-result", f.result], ["finalized-pairs", f.finalized], ["partial-pairs", f.partial],
    ["budget-ledger-snapshot", await ledger.read()], ["cost-budget-snapshot", cost.view()], ["condition-probe", condition.conditionProbe(experiment, f.records)]])
    support.writeJson(join(attempt, `${name}.json`), value);
  support.writeJson(join(attempt, "raw-index.json"), { files: support.campaignFiles(raw) }); support.writeIndex(attempt);
}

describe("N7 frozen wiring and identity", () => {
  it("derives 512 main / 192 holdout, both v2, with exact frozen arm identities", () => {
    expect(main.plan.totalLogicalRuns).toBe(512); expect(holdout.plan.totalLogicalRuns).toBe(192);
    expect(main.facts.candidates).toEqual({ baseline: "tool_call_efficiency_v1", candidate: "context_safe_tool_call_efficiency_v2" });
    expect(holdout.facts.candidates.baseline).toBe(holdout.prereg.subject.championProvenance.candidateId);
    expect(holdout.facts.candidates.candidate).toBe("context_safe_tool_call_efficiency_v2");
  });
  it.each(["main", "holdout"])("the real %s CLI dry-run makes zero calls despite a configured fake credential", (role) => {
    const out = join(temporary(), "dry");
    execFileSync(process.execPath, [join(SCRIPTS, "n7-paired-campaign.mjs"), "--experiment", role, "--dry", "--out", out], {
      cwd: REPO, env: { ...process.env, OPENAI_API_KEY: "offline-not-a-credential", RUN_PAID_BENCHMARKS: "0" }, stdio: "pipe" });
    const result = JSON.parse(readFileSync(join(out, "dry-run.json"), "utf8"));
    expect(result.logicalRuns).toBe(role === "main" ? 512 : 192); expect(result.ab).toBe(result.ba);
    expect(result.paidProviderCalls).toBe(0); expect(result.modelQuality).toBe("NOT_RUN");
    expect(result.candidate).toBe("context_safe_tool_call_efficiency_v2"); support.verifyIndex(out);
  });
  it("separately binds the frozen origin and the full executed endpoint path", () => {
    expect(support.frozenEndpointDigest("http://127.0.0.1:8317/v1")).toBe(main.prereg.provider.endpointDigest);
    expect(support.frozenEndpointDigest("http://127.0.0.1:8317/other")).toBe(main.prereg.provider.endpointDigest);
    expect(support.sha256("http://127.0.0.1:8317/v1")).not.toBe(support.sha256("http://127.0.0.1:8317/other"));
    expect(() => support.endpointOf({ OPENAI_BASE_URL: "http://secret@127.0.0.1:8317/v1" })).toThrow("INVALID_ENDPOINT");
  });
  it("source/build/price/limits changes alter the execution authorization rather than copying the old source SHA", async () => {
    const f = await fixture();
    for (const patch of [{ source: { ...f.binding.source, sourceSha: "e".repeat(40) } }, { provider: { ...f.binding.provider, modelId: "changed" } },
      { pricing: { amountUsdMicros: 1 } }, { source: { ...f.binding.source, buildDigest: "changed" } }])
      expect(support.bindingDigest({ ...f.binding, ...patch })).not.toBe(f.binding.executionBindingDigest);
    expect(f.identity.sourceSha).not.toBe(main.prereg.subject.candidateSourceSha);
  });
  it("tampered binding is refused before any provider resolution or paid call", async () => {
    const root = temporary(), f = await fixture(); f.binding.source.sourceSha = "e".repeat(40);
    const path = join(root, "binding.json"); writeFileSync(path, JSON.stringify(f.binding));
    const processResult = spawnSync(process.execPath, [join(SCRIPTS, "n7-soak.mjs"), "--binding", path, "--out", join(root, "out")],
      { cwd: REPO, env: { ...process.env, OPENAI_API_KEY: "offline-not-a-credential", RUN_PAID_BENCHMARKS: "0" }, encoding: "utf8" });
    expect(processResult.status).toBe(1); expect(processResult.stderr).toContain("BINDING_DRIFT");
    expect(processResult.stderr).not.toContain("offline-not-a-credential");
  });
  it("rejects forged isolation eligibility and changed statistical/infra policies even with a recomputed root digest", async () => {
    for (const kind of ["isolation", "bootstrap", "infra"]) {
      const f = await fixture();
      if (kind === "isolation") f.binding.isolation.promotionEligible = true;
      if (kind === "bootstrap") f.binding.bootstrapSeed++;
      if (kind === "infra") f.binding.infrastructureGates = { ...f.binding.infrastructureGates, completedPairsMinRatio: 0.5 };
      f.binding.executionBindingDigest = support.bindingDigest(f.binding);
      expect(() => support.validateBindingPolicy(f.binding)).toThrow();
    }
  });
});

describe("N7 ITT gates and safety", () => {
  it("checks the entire frozen grid; a favourable synthetic campaign never proves real model quality", async () => {
    const report = judge(await fixture());
    expect(report.gates.every((g: any) => g.passed)).toBe(true);
    expect(report.groups.missing.runsPerArm).toBe(192); expect(report.groups.missing.liftPp).toBe(25);
    expect(report.verdict).toBe("SYNTHETIC_CHECK_ONLY"); expect(report.modelQuality).toBe("NOT_RUN"); expect(report.promotion).toBe("NOT_ELIGIBLE");
    expect(report.perProtocol.status).toBe("NOT_OBSERVED"); expect(report.perProtocol.runsPerArm).toBe(0); expect(report.perProtocol.liftPp).toBeNull();
  });
  it("reports PP only on complete missing pairs witnessed at edit in both arms, retaining ITT unchanged", async () => {
    const f: any = await fixture(), before = judge(f);
    const caseId = main.manifest.cases.find((c: any) => c.condition === "compact-drop").caseId;
    const selected = f.finalized.filter((p: any) => p.caseId === caseId && p.repetition < 3);
    const controlId = main.manifest.cases.find((c: any) => c.condition === "visible").caseId;
    const control = f.finalized.find((p: any) => p.caseId === controlId);
    f.probe = { entries: [...selected, control].flatMap((p: any) => ["baseline", "candidate"].map(arm => ({
      caseId: p.caseId, repetition: p.repetition, arm, observed: p.repetition !== 2 || arm === "candidate" }))) };
    const report = judge(f);
    expect(report.perProtocol).toMatchObject({ cases: 1, runsPerArm: 2, aPasses: 1, bPasses: 2, liftPp: 50, status: "CORROBORATION_ONLY" });
    expect(report.groups).toEqual(before.groups); expect(report.gates).toEqual(before.gates);
  });
  it.each(["partial", "invalid"])("a witnessed %s pair does not enter PP", async (kind) => {
    const f: any = await fixture();
    const caseId = main.manifest.cases.find((c: any) => c.condition === "compact-drop").caseId;
    const pair = f.finalized.find((p: any) => p.caseId === caseId);
    if (kind === "partial") { f.finalized = f.finalized.filter((p: any) => p !== pair); f.partial.push(pair); }
    else pair.baseline.valid = false;
    f.probe = { entries: ["baseline", "candidate"].map(arm => ({ caseId, repetition: pair.repetition, arm, observed: true })) };
    expect(judge(f).perProtocol).toMatchObject({ runsPerArm: 0, liftPp: null, status: "NOT_OBSERVED" });
  });
  it("holdout includes overall success and independent 96-pair coverage", async () => {
    const report = judge(await fixture(holdout), holdout);
    expect(report.coverage.expected).toBe(96); expect(gate(report, "holdout_overall_pass_rate_not_worse").passed).toBe(true);
  });
  it.each(["delete", "duplicate", "extra", "wrong-order", "wrong-repetition"])("%s pair fails the full-grid gate", async (mode) => {
    const f = await fixture();
    if (mode === "delete") f.finalized.pop();
    if (mode === "duplicate") f.finalized.push(structuredClone(f.finalized[0]));
    if (mode === "extra") f.finalized.push({ ...structuredClone(f.finalized[0]), pairId: "foreign" });
    if (mode === "wrong-order") f.finalized[0].order = "foreign";
    if (mode === "wrong-repetition") f.finalized[0].repetition = 100;
    expect(gate(judge(f), "full_frozen_grid").passed).toBe(false);
  });
  it.each(["v1", "digest", "lineage", "label-only", "invalid-validation"])("%s activation cannot qualify v2", async (mode) => {
    const f = await fixture(), activation = f.finalized[0].candidate.outcome.activationEvidenceV2;
    if (mode === "v1") activation.events[0].payload.guidanceVersion = "context-safe-tool-call-efficiency:v1";
    if (mode === "digest") activation.events[0].payload.digest = "a".repeat(64);
    if (mode === "lineage") activation.events[0].lineage.repetition = 100;
    if (mode === "label-only") delete activation.events[0].payload.digest;
    if (mode === "invalid-validation") activation.validation.ok = false;
    expect(gate(judge(f), "candidate_activation_proven").passed).toBe(false);
  });
  it.each(["absent", "unknown", "negative", "NaN"])("%s usage fails instead of becoming zero", async (mode) => {
    const f = await fixture(), metrics = f.finalized[0].candidate.outcome.metrics;
    if (mode === "absent") delete metrics.tokens_input;
    if (mode === "unknown") metrics.usage_unknown = 1;
    if (mode === "negative") metrics.tokens_output = -1;
    if (mode === "NaN") metrics.tokens_input = NaN;
    const report = judge(f);
    expect(gate(report, "usage_complete_and_reconciled").passed).toBe(false); expect(report.cost.B.tokens).toBeNull();
  });
  it("uses paired attempt counts and reconciles the independent provider tape", async () => {
    const f = await fixture(); f.finalized[0].candidate.modelCallAttempts = 100;
    expect(gate(judge(f), "usage_complete_and_reconciled").passed).toBe(false);
    expect(gate(judge(f), "model_call_attempts_within_110pct").passed).toBe(false);
  });
  it("retains candidate security observations from a partial pair", async () => {
    const f = await fixture(), p = f.finalized.shift();
    p.candidate.valid = false; p.candidate.outcome.securityOutcome = { kind: "ESCAPE", hardBreach: true };
    f.partial.push({ ...p, reason: "invalid-arm" });
    const report = judge(f);
    expect(report.security.B.violations).toBe(1); expect(gate(report, "no_new_security_violations_or_false_completes").passed).toBe(false);
    expect(gate(report, "full_frozen_grid").passed).toBe(false);
  });
  it("counts new false completion rather than claiming verifier success", async () => {
    const f = await fixture(); f.finalized[0].candidate.outcome.status = "failed";
    f.finalized[0].candidate.outcome.grade = "unverified_complete";
    expect(gate(judge(f), "no_new_security_violations_or_false_completes").passed).toBe(false);
  });
  it("transport rate exactly 1% and insufficient completed pairs fail qualification", async () => {
    const f = await fixture(); f.records = f.records.slice(0, 99); f.records[0].retries = ["transport"];
    const report = judge(f); expect(gate(report, "infrastructure_qualified").observed.transportRate).toBe(0.01);
    expect(gate(report, "infrastructure_qualified").passed).toBe(false);
    const incomplete = await fixture(); incomplete.partial.push(...incomplete.finalized.splice(0, 20));
    expect(gate(judge(incomplete), "infrastructure_qualified").passed).toBe(false);
  });
  it("a renewed or unmetered budget cannot qualify the frozen caps", async () => {
    const f = await fixture(); f.result.costBudget.caps.maxDurationMs *= 2;
    expect(gate(judge(f), "durable_budget_proven").passed).toBe(false);
  });
  it("control regression fails independently of missing-group improvement", async () => {
    const f = await fixture(), controlId = main.manifest.cases.find((c: any) => c.condition === "visible").caseId;
    for (const p of f.finalized.filter((p: any) => p.caseId === controlId)) p.candidate.outcome.status = "failed";
    expect(gate(judge(f), "control_group_not_worse").passed).toBe(false);
  });
});

describe("N7 joint decision (fabricated unit inputs only, zero model evidence)", () => {
  const report = (role: string, patch: any = {}) => {
    const body = { schemaVersion: "n7-judge-result-v1", experiment: role, evidenceKind: "REAL_PROVIDER", verdict: "ALL_GATES_PASSED",
      modelQuality: "MEASURED_BY_THIS_CAMPAIGN", executionBindingDigest: "a".repeat(64),
      gates: [{ gate: "unit-fixture", passed: true }], promotion: "REQUIRES_BOTH_EXPERIMENTS_AND_ENGINEERING_GATES", ...patch };
    return { ...body, judgeDigest: support.digest(body) };
  };
  it("requires both independent experiments and leaves promotion to the engineering/champion flow", () => {
    const combined = decision.combineJudgments(report("main"), report("holdout"));
    expect(combined.verdict).toBe("BOTH_EXPERIMENT_GATES_PASSED");
    expect(combined.promotion).toBe("AWAITING_ENGINEERING_AND_EXISTING_CHAMPION_FLOW");
  });
  it.each(["missing-holdout", "duplicate-main", "failed-holdout", "synthetic-holdout", "different-binding", "altered-judge"])("%s cannot qualify a joint win", (kind) => {
    const a = report("main"); let b: any = report("holdout");
    if (kind === "missing-holdout") b = undefined;
    if (kind === "duplicate-main") b = report("main");
    if (kind === "failed-holdout") b = report("holdout", { gates: [{ gate: "unit-fixture", passed: false }] });
    if (kind === "synthetic-holdout") b = report("holdout", { evidenceKind: "SYNTHETIC" });
    if (kind === "different-binding") b = report("holdout", { executionBindingDigest: "b".repeat(64) });
    if (kind === "altered-judge") b.modelQuality = "NOT_RUN";
    const combined = decision.combineJudgments(a, b);
    expect(combined.verdict).toBe("NOT_PROVEN"); expect(combined.promotion).toBe("NOT_ELIGIBLE");
  });
  it("even two measured gate passes cannot qualify an insecure-local run for promotion", () => {
    const combined = decision.combineJudgments(report("main", { promotion: "NOT_ELIGIBLE" }), report("holdout", { promotion: "NOT_ELIGIBLE" }));
    expect(combined.verdict).toBe("BOTH_EXPERIMENT_GATES_PASSED");
    expect(combined.strongIsolationQualified).toBe(false); expect(combined.promotion).toBe("NOT_ELIGIBLE");
  });
});

async function localhost(mode: "healthy" | "retry" | "missing-model" | "no-usage" | "hang") {
  let calls = 0;
  const http = createServer((req, res) => {
    calls++; req.resume(); req.on("end", () => {
      if (mode === "hang") return;
      if (mode === "missing-model") { res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":{"code":"model_not_found"}}'); return; }
      if (mode === "retry" && calls === 1) { res.writeHead(503, { "Content-Type": "application/json" }); res.end('{"error":"offline transient"}'); return; }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }],
        ...(mode === "no-usage" ? {} : { usage: { prompt_tokens: 10, completion_tokens: 2 } }) })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(done => http.listen(0, "127.0.0.1", done)); servers.push(http);
  const provider = new OpenAICompatibleProvider({ apiKey: "offline-not-a-credential", baseUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`,
    requestPolicy: { maxProviderRetries: 2, retryDelayMs: 0, requestTimeoutMs: 1000 } });
  return { provider, calls: () => calls };
}
describe("N7 actual localhost provider boundary (not a real-model qualification)", () => {
  it("performs all 24 independent HTTP calls and observes actual usage", async () => {
    const local = await localhost("healthy"), result = await observation.runSoak(local.provider, { modelId: "offline-fixture" });
    expect(local.calls()).toBe(24); expect(result.passed).toBe(true); expect(result.counts.physicalAttempts).toBe(24);
    expect(result.records.every((r: any) => r.usage.inputTokens === 10 && r.usage.outputTokens === 2)).toBe(true);
  });
  it("a recovered 503 still fails soak and counts the physical retry", async () => {
    const local = await localhost("retry"), result = await observation.runSoak(local.provider, { modelId: "offline-fixture" });
    expect(local.calls()).toBe(2); expect(result.passed).toBe(false); expect(result.counts.transportFailures).toBe(1);
    expect(result.counts.generateCalls).toBe(1); expect(result.counts.physicalAttempts).toBe(2);
  });
  it.each(["missing-model", "no-usage", "hang"] as const)("%s is rejected after the first logical call", async mode => {
    const local = await localhost(mode), result = await observation.runSoak(local.provider, { modelId: "offline-fixture", signal: () => AbortSignal.timeout(100) });
    expect(result.passed).toBe(false); expect(result.counts.generateCalls).toBe(1);
    if (mode === "missing-model") expect(result.counts.modelNotFound).toBe(1);
  });
  it("a one-call durable budget refuses the second physical send before HTTP retry", async () => {
    const local = await localhost("retry"), root = temporary();
    vi.stubEnv("R97_CAMPAIGN_CLAIMS_DIR", join(root, "claims"));
    const f = await fixture(); f.binding.pricing = { amountUsdMicros: 1, basisDigest: "a".repeat(64), sourceKind: "operator_declared", currency: "USD",
      issuedAtMs: Date.now() - 10000, expiresAtMs: Date.now() + 60000, coveredTokenCeiling: 64000, requiredTokenCeiling: 64000 };
    const prereg = { ...main.prereg, budget: { ...main.prereg.budget, campaignWorstCaseModelCalls: 1 } };
    const budgets = await budgetModule.openBudgets(root, f.binding, prereg, f.header.campaignDigest);
    budgets.costBudget.bindJournalScope({ campaignDigest: f.header.campaignDigest, armRunId: "offline", arm: "candidate", caseId: "offline", repetition: 0 });
    const channel = budgets.wrap(local.provider, "candidate");
    await observation.runSoak(channel.provider, { modelId: "offline-fixture" });
    expect(local.calls()).toBe(1); expect((await budgets.ledger.view()).remaining).toBe(0);
  });
  it("the per-arm model cap applies across multiple clients before another HTTP request", async () => {
    const local = await localhost("healthy"), capped = budgetModule.withModelCallCap(local.provider, 1);
    const request = { messages: [{ id: "m", sessionId: "s", role: "user", content: "offline cap", createdAt: 0 }] };
    for await (const _ of capped.createClient({ providerId: "openai", modelId: "offline-fixture" }, {}).generate(request, new AbortController().signal)) { /* consume */ }
    await expect(async () => {
      for await (const _ of capped.createClient({ providerId: "openai", modelId: "offline-fixture" }, {}).generate(request, new AbortController().signal)) { /* consume */ }
    }).rejects.toThrow("PER_RUN_MODEL_CALL_CAP");
    expect(local.calls()).toBe(1);
  });
});

describe("N7 evidence and condition witnesses", () => {
  it("verifies every byte and refuses additional or edited evidence", () => {
    const root = temporary(); writeFileSync(join(root, "raw.json"), "original"); support.writeIndex(root); support.verifyIndex(root);
    writeFileSync(join(root, "raw.json"), "tampered"); expect(() => support.verifyIndex(root)).toThrow("ARTIFACT_DRIFT");
  });
  it("refuses output overwrite and symlink evidence", () => {
    const root = temporary(); expect(() => support.freshDirectory(root)).toThrow();
    mkdirSync(join(root, "target")); symlinkSync(join(root, "target"), join(root, "link"), "junction");
    expect(() => support.filesIn(root)).toThrow("SYMLINK_EVIDENCE");
  });
  it("refuses synthetic or incomplete soak receipts", async () => {
    const f = await fixture(); f.soak.evidenceKind = "SYNTHETIC";
    expect(() => campaign.validateSoak(f.soak, f.binding)).toThrow("REAL_SOAK_REQUIRED");
    f.soak.evidenceKind = "REAL_PROVIDER"; f.soak.records.pop();
    expect(() => campaign.validateSoak(f.soak, f.binding)).toThrow("SOAK_FAILED");
  });
  it("captures secrets only as redacted request data", () => {
    expect(JSON.stringify(observation.redactRequest({ messages: [{ content: "secret-fixture-value" }] }, ["secret-fixture-value"]))).not.toContain("secret-fixture-value");
  });
  it("observes visible-then-absent from the actual messages; a case tag alone proves nothing", () => {
    const inputs = [{ path: "spec/rule.txt", lines: ["build_jobs = 12"] }];
    const request = (content: string) => ({ messages: [{ role: "tool", content }] });
    expect(condition.sourceVisibilityWitnesses([request("summary only")], inputs, "compact-drop").observed).toBe(false);
    expect(condition.sourceVisibilityWitnesses([request(JSON.stringify({ content: "build_jobs = 12" })), request("summary only")], inputs, "compact-drop").observed).toBe(false);
    expect(condition.sourceVisibilityWitnesses([request(JSON.stringify({ content: "build_jobs = 12" })), request("summary only")], inputs, "compact-drop", [1]).observed).toBe(true);
  });
  it("links a real Harness write dispatch to its captured model request without replacing the original verifier", async () => {
    const target = main.cases[0], definition = main.manifest.cases[0];
    let call = 0;
    const provider: ModelProvider = { id: "n7-scripted-offline", async listModels() { return []; }, createClient() { return {
      async *generate(): AsyncGenerator<ModelEvent> {
        call++;
        const tools = call === 1 ? [{ id: "n7-read" as never, name: "read_file", args: { path: "spec/ci-policy.txt", versioned: true } }]
          : call === 2 ? [{ id: "n7-write" as never, name: "write_file", args: { path: "src/build.js", content: definition.referenceFix["src/build.js"] } }] : [];
        yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 }, timestamp: 0 };
        yield { type: "completed", timestamp: 0, result: { finishReason: tools.length ? "tool_calls" : "stop", toolCalls: tools,
          usage: { inputTokens: 10, outputTokens: 2 }, text: tools.length ? "" : "scripted offline repair" } };
      } }; } };
    const p = main.plan.pairs.find((pair: any) => pair.caseId === target.id && pair.repetition === 0);
    const watched = observation.observedProvider(provider, { scope: () => ({ caseId: target.id, arm: "candidate", repetition: 0 }) });
    const { cli } = await support.dependencies();
    const outcome = await cli.runOneCase(target, { provider: watched.provider, modelId: "scripted-offline", budgetTokens: 32000,
      candidate: "context_safe_tool_call_efficiency_v2", armId: "candidate", repetition: 0, attempt: 1, processConfinement: "insecure-local" }, "regression");
    expect(outcome.status).toBe("passed"); expect(call).toBe(3);
    expect(outcome.events.some((event: any) => event.type === "tool.started" && event.payload.toolCallId === "n7-write")).toBe(true);
    const probe = condition.conditionProbe(main, watched.records, [{ ...p, candidate: { outcome } }]);
    const armProbe = probe.entries.find((entry: any) => entry.caseId === target.id && entry.arm === "candidate" && entry.repetition === 0);
    expect(armProbe.editMomentsObserved).toBe(1);
    expect(watched.records[0].request.system).toContain(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2);
  });
  it("judge and archive reject an unindexed bundle without fabricating a verdict", async () => {
    const root = temporary(); mkdirSync(join(root, "attempts/0001"), { recursive: true });
    await expect(evidence.loadJudgment("main", root)).rejects.toThrow();
    const processResult = spawnSync(process.execPath, [join(SCRIPTS, "archive-n7-evidence.mjs"), "--campaign", root, "--judge", root, "--out", join(root, "archive")], { cwd: REPO, encoding: "utf8" });
    expect(processResult.status).toBe(1);
    const joint = spawnSync(process.execPath, [join(SCRIPTS, "n7-decision.mjs"), "--main", root, "--holdout", root, "--out", join(root, "joint")], { cwd: REPO, encoding: "utf8" });
    expect(joint.status).toBe(1);
  });
  it("recomputes judgment, archives namespaced raw bytes, and rejects a forged verdict after index regeneration", async () => {
    const root = temporary(), raw = join(root, "campaign"), out = join(root, "judge"), archive = join(root, "archive");
    vi.stubEnv("R97_CAMPAIGN_CLAIMS_DIR", join(root, "claims"));
    await writeSyntheticBundle(main, raw);
    const loaded = await evidence.loadJudgment("main", raw);
    expect(loaded.judgment.verdict).toBe("SYNTHETIC_CHECK_ONLY");
    const judgeProcess = spawnSync(process.execPath, [join(SCRIPTS, "n7-judge.mjs"), "--campaign", raw, "--out", out], { cwd: REPO, encoding: "utf8" });
    expect(judgeProcess.status).toBe(1); // SYNTHETIC never exits as a real win
    const archiveProcess = spawnSync(process.execPath, [join(SCRIPTS, "archive-n7-evidence.mjs"), "--campaign", raw, "--judge", out, "--out", archive], { cwd: REPO, encoding: "utf8" });
    expect(archiveProcess.status, archiveProcess.stderr).toBe(0);
    const verified = await evidence.verifyArchive("main", archive, raw, out);
    expect(verified.modelQuality).toBe("NOT_RUN"); expect(verified.promotion).toBe("NOT_ELIGIBLE");
    const manifest = support.readJson(join(archive, "RAW-MANIFEST.json"));
    expect(new Set(manifest.files.map((file: any) => file.path)).size).toBe(manifest.files.length);
    const holdoutRaw = join(root, "holdout"), jointOut = join(root, "joint");
    await writeSyntheticBundle(holdout, holdoutRaw);
    const joint = spawnSync(process.execPath, [join(SCRIPTS, "n7-decision.mjs"), "--main", raw, "--holdout", holdoutRaw, "--out", jointOut], { cwd: REPO, encoding: "utf8" });
    expect(joint.status).toBe(1); support.verifyIndex(jointOut);
    expect(support.readJson(join(jointOut, "decision.json"))).toMatchObject({ verdict: "NOT_PROVEN", promotion: "NOT_ELIGIBLE" });
    expect(support.readJson(join(jointOut, "holdout-judge-result.json"))).toMatchObject({ experiment: "holdout", coverage: { expected: 96 }, evidenceKind: "SYNTHETIC" });
    const forged = support.readJson(join(out, "judge-result.json")); forged.verdict = "ALL_GATES_PASSED";
    writeFileSync(join(out, "judge-result.json"), JSON.stringify(forged)); rmSync(join(out, "artifact-index.json")); support.writeIndex(out);
    const refused = spawnSync(process.execPath, [join(SCRIPTS, "archive-n7-evidence.mjs"), "--campaign", raw, "--judge", out, "--out", join(root, "forged-archive")], { cwd: REPO, encoding: "utf8" });
    expect(refused.status).toBe(1); expect(refused.stderr).toContain("FORGED_JUDGMENT");
  });
});
