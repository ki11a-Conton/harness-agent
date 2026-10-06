/** N7 research-only execution helpers. No production Runtime changes. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const EVIDENCE = join(REPO, "docs/evidence/agent-next7-20261006");
export const PROFILE = Object.freeze({ budgetTokens: 32000, temperature: null, stallPolicy: "benchmark-default" });
export const REQUEST_POLICY = Object.freeze({ maxProviderRetries: 2, retryDelayMs: 200, requestTimeoutMs: 120000 });
export const BOOTSTRAP_SEED = 20261005; // retain the original N6 statistical seed
export const SOAK_CALLS = 24;
export const INFRASTRUCTURE_GATES = Object.freeze({ soakCalls: 24, soakFailuresMax: 0, transportFailureRateExclusiveMax: 0.01, completedPairsMinRatio: 0.95 });
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`
  : JSON.stringify(value);
export const digest = (value) => sha256(stable(value));
export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export function assert(condition, code) { if (!condition) throw Object.assign(new Error(code), { code }); }
export function arg(name, fallback) {
  const eq = process.argv.find(v => v.startsWith(`--${name}=`));
  if (eq !== undefined) return eq.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  assert(process.argv[index + 1] !== undefined && !process.argv[index + 1].startsWith("--"), "ARGUMENT_MISSING");
  return process.argv[index + 1];
}
export const flag = (name) => process.argv.includes(`--${name}`);
export function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" }); }
export function freshDirectory(path) {
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(path); // refuse existing evidence, including an empty directory
  return path;
}
export function inside(root, path) {
  const rel = relative(root, path);
  assert(rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), "PATH_ESCAPE");
  return rel.split(sep).join("/");
}
export function filesIn(root) {
  assert(!lstatSync(root).isSymbolicLink(), "SYMLINK_EVIDENCE");
  const entries = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      assert(!entry.isSymbolicLink(), "SYMLINK_EVIDENCE");
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        assert(entry.isFile(), "NON_FILE_EVIDENCE");
        const bytes = readFileSync(path);
        entries.push({ path: inside(root, path), bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  walk(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
export function writeIndex(root) {
  writeJson(join(root, "artifact-index.json"), { schemaVersion: "n7-artifact-index-v1", files: filesIn(root) });
}
export function verifyIndex(root) {
  const expected = readJson(join(root, "artifact-index.json"));
  const actual = filesIn(root).filter(f => f.path !== "artifact-index.json");
  assert(expected.schemaVersion === "n7-artifact-index-v1" && stable(expected.files) === stable(actual), "ARTIFACT_DRIFT");
  return actual;
}
export const campaignFiles = root => filesIn(root).filter(f => !["artifact-index.json", "raw-index.json", "budget-ledger.lock"].includes(f.path.split("/").at(-1)));
export function verifyCampaignRaw(root, attempt) {
  verifyIndex(attempt);
  assert(stable(readJson(join(attempt, "raw-index.json")).files) === stable(campaignFiles(root)), "CAMPAIGN_RAW_DRIFT");
}
let modules;
export async function dependencies() {
  modules ??= Promise.all([
    import(pathToFileURL(join(REPO, "packages/evaluation/dist/index.js")).href),
    import(pathToFileURL(join(REPO, "apps/cli/dist/benchmark-command.js")).href),
    import(pathToFileURL(join(REPO, "apps/cli/dist/provider.js")).href),
    import(pathToFileURL(join(REPO, "packages/tools/dist/process/sandbox-executor.js")).href),
    import(pathToFileURL(join(REPO, "packages/model/dist/index.js")).href),
    import(pathToFileURL(join(REPO, "apps/cli/dist/prereg-execution-identity.js")).href),
  ]).then(([evaluation, cli, provider, sandbox, model, pricing]) => ({ evaluation, cli, provider, sandbox, model, pricing }));
  return modules;
}
export function endpointOf(env = process.env) {
  let url;
  try { url = new URL(env.OPENAI_BASE_URL || "http://127.0.0.1:8317/v1"); } catch { assert(false, "INVALID_ENDPOINT"); }
  assert(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, "INVALID_ENDPOINT");
  return url.href.replace(/\/$/, "");
}
export function frozenEndpointDigest(endpoint) {
  const url = new URL(endpoint);
  return sha256(`${url.protocol.slice(0, -1)}://${url.hostname.toLowerCase()}:${url.port || (url.protocol === "https:" ? "443" : "80")}`);
}
function caseContentDigest(dir) {
  // Match the original generator's LF canonicalization on Windows, too.
  return sha256(filesIn(dir).map(f => `${f.path}\0${sha256(readFileSync(join(dir, f.path), "utf8").replace(/\r\n/g, "\n"))}`).sort().join("\n"));
}
export async function loadExperiment(role) {
  assert(role === "main" || role === "holdout", "UNKNOWN_EXPERIMENT");
  const { evaluation: ev, cli } = await dependencies();
  const preregPath = join(EVIDENCE, `${role}-preregistration.json`);
  const prereg = readJson(preregPath);
  const report = ev.dryRunContextSafeV2Preregistration(prereg);
  assert(report.ok, "PREREGISTRATION_DRIFT");
  assert(stable(prereg.evaluation.gates) === stable(ev.CONTEXT_SAFE_V2_GATES), "GATE_DRIFT");
  assert((prereg.role ?? "main") === role, "EXPERIMENT_MISMATCH");
  const manifest = readJson(join(EVIDENCE, role === "main" ? "case-manifest.json" : "holdout-case-manifest.json"));
  assert(prereg.dataset.selectionProvenanceDigest === manifest.manifestDigest, "MANIFEST_DRIFT");
  assert(stable(prereg.dataset.cases) === stable(ev.contextSafeCaseEntriesFromManifest(manifest.cases)), "CASE_SELECTION_DRIFT");
  const loaded = await ev.loadBenchmarkCases(join(REPO, prereg.dataset.caseRoot));
  const byId = new Map(loaded.map(c => [c.id, c]));
  assert(byId.size === prereg.dataset.cases.length && loaded.length === byId.size, "CASE_COUNT_DRIFT");
  const cases = prereg.dataset.cases.map(c => {
    assert(byId.has(c.caseId), "CASE_MISSING");
    assert(caseContentDigest(join(REPO, prereg.dataset.caseRoot, c.caseId)) === c.contentDigest, "CASE_CONTENT_DRIFT");
    return byId.get(c.caseId);
  });
  const candidates = { baseline: role === "main" ? prereg.prompt.comparisonCandidateId : prereg.subject.championProvenance?.candidateId,
    candidate: prereg.prompt.candidateId };
  assert(candidates.baseline !== undefined && candidates.candidate === "context_safe_tool_call_efficiency_v2", "ARM_MISMATCH");
  if (role === "holdout") {
    const state = readFileSync(join(REPO, "docs/evolution/champion-state.json"), "utf8").replace(/\r\n/g, "\n");
    assert(sha256(state) === prereg.subject.championProvenance.stateDigest, "CHAMPION_DRIFT");
    assert((JSON.parse(state).candidateId ?? null) === candidates.baseline, "CHAMPION_DRIFT");
  }
  const arms = Object.fromEntries(Object.entries(candidates).map(([name, id]) => [name, ev.getArmFactory().resolveArm(id)]));
  assert(arms.baseline.digest === prereg.subject.baselineArmDigest && arms.candidate.digest === prereg.subject.candidateArmDigest, "ARM_DIGEST_DRIFT");
  assert(arms.candidate.promptAdditionsDigest === prereg.prompt.guidanceDigest, "GUIDANCE_DRIFT");
  const runtimeConfigHashes = Object.fromEntries(Object.entries(candidates).map(([name, candidate]) =>
    [name, ev.computeRuntimeConfigHash(cli.runtimeConfigForHash({ suite: "regression", candidate: candidate ?? undefined }, PROFILE.budgetTokens))]));
  assert(runtimeConfigHashes.baseline !== runtimeConfigHashes.candidate, "IDENTICAL_ARMS");
  const plan = ev.buildPairedPlan({ suite: prereg.dataset.suiteId, cases: cases.map(c => c.id), repetitions: prereg.schedule.repetitions, orderSeed: prereg.schedule.orderSeed });
  assert(plan.planDigest === prereg.schedule.planDigest && plan.totalLogicalRuns === prereg.schedule.logicalRuns, "PLAN_DRIFT");
  const facts = { role, frozenPreregistrationDigest: prereg.preregistrationDigest,
    frozenPreregistrationFileSha256: sha256(readFileSync(preregPath)), frozenSourceSha: prereg.subject.candidateSourceSha,
    candidates, armDigests: { baseline: arms.baseline.digest, candidate: arms.candidate.digest }, runtimeConfigHashes,
    caseFingerprints: Object.fromEntries(cases.map(c => [c.id, cli.caseFingerprintFor(c)])),
    planDigest: plan.planDigest, logicalRuns: plan.totalLogicalRuns, expectedPairs: plan.pairs.length };
  return { prereg, manifest, cases, plan, facts };
}
export function sourceSnapshot({ requireClean = true } = {}) {
  const git = args => execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const sourceSha = git(["rev-parse", "HEAD"]).trim();
  const clean = git(["status", "--porcelain", "--untracked-files=all"]).trim() === "";
  assert(!requireClean || clean, "SOURCE_NOT_CLEAN");
  const paths = git(["ls-files", "-z", "packages", "apps", "scripts", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json"]).split("\0").filter(Boolean).sort();
  const source = paths.map(path => { const bytes = readFileSync(join(REPO, path)); return { path, bytes: bytes.length, sha256: sha256(bytes) }; });
  const build = [];
  for (const prefix of ["packages", "apps"]) for (const entry of readdirSync(join(REPO, prefix), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = join(REPO, prefix, entry.name, "dist");
    if (existsSync(root)) build.push(...filesIn(root).map(f => ({ ...f, path: `${prefix}/${entry.name}/dist/${f.path}` })));
  }
  build.sort((a, b) => a.path.localeCompare(b.path));
  assert(build.length > 0, "BUILD_MISSING");
  return { sourceSha, clean, sourceFiles: source, sourceDigest: digest(source), buildFiles: build, buildDigest: digest(build) };
}
export async function environmentFacts({ allowInsecure = false, env = process.env } = {}) {
  const { evaluation: ev, sandbox, model, pricing } = await dependencies();
  const endpoint = endpointOf(env);
  const modelId = env.OPENAI_MODEL || "workbuddy-deepseek-v4.1-flash";
  const prereg = readJson(join(EVIDENCE, "main-preregistration.json"));
  assert(modelId === prereg.provider.modelId && frozenEndpointDigest(endpoint) === prereg.provider.endpointDigest, "PROVIDER_DRIFT");
  assert(digest(PROFILE) === prereg.provider.requestProfileDigest, "PROFILE_DRIFT");
  const effective = model.resolveOpenAIRequestPolicy({}, env);
  assert(stable(effective) === stable(REQUEST_POLICY), "REQUEST_POLICY_DRIFT");
  const report = await sandbox.capabilityProbe();
  const isolation = { backendId: report.backendId, strength: report.ok && report.strongIsolation && !allowInsecure ? "strong" : allowInsecure ? "insecure-local" : "unavailable",
    promotionEligible: report.ok && report.strongIsolation && !allowInsecure,
    contractDigest: digest({ backendId: report.backendId, ok: report.ok, probes: report.selfTest.probes.map(p => ({ id: p.id, prevented: p.prevented })) }),
    selfTest: report.selfTest };
  const resolved = pricing.resolvePricingBasis("openai", { modelId, endpointBaseUrl: endpoint, requiredTokenCeiling: 64000 }, env, Date.now(), "injected");
  const price = resolved.ok ? { pricingDigest: resolved.basis.pricingDigest, amountUsdMicros: resolved.basis.usdMicrosPerCall,
    basisDigest: resolved.basis.pricingDigest, sourceKind: resolved.basis.sourceKind, currency: resolved.basis.currency,
    issuedAtMs: Date.parse(resolved.basis.validity.issuedAt), expiresAtMs: Date.parse(resolved.basis.validity.expiresAt),
    coveredTokenCeiling: resolved.basis.coverage.coveredTokenCeiling, requiredTokenCeiling: 64000 } : null;
  return { provider: { providerId: "openai", modelId, endpointDigest: prereg.provider.endpointDigest, fullEndpointDigest: sha256(endpoint), profile: PROFILE, requestPolicy: REQUEST_POLICY },
    pricing: price, isolation, credentialPresent: Boolean(env.OPENAI_API_KEY?.trim()) };
}
export function bindingDigest(binding) { const { executionBindingDigest, ...body } = binding; return digest(body); }
export function validateBindingPolicy(binding) {
  assert(binding.schemaVersion === "n7-execution-binding-v1" && bindingDigest(binding) === binding.executionBindingDigest, "BINDING_DRIFT");
  assert(binding.bootstrapSeed === BOOTSTRAP_SEED && stable(binding.infrastructureGates) === stable(INFRASTRUCTURE_GATES), "BINDING_POLICY_DRIFT");
  assert(binding.isolation?.promotionEligible === (binding.isolation?.strength === "strong" && binding.isolation?.selfTest?.ok === true), "ISOLATION_ELIGIBILITY_FORGED");
}
export async function validateBinding(binding, { paid = false, allowInsecure = false, confirm, env = process.env } = {}) {
  validateBindingPolicy(binding);
  const source = sourceSnapshot();
  assert(stable(source) === stable(binding.source), "SOURCE_BUILD_DRIFT");
  const experiments = await Promise.all([loadExperiment("main"), loadExperiment("holdout")]);
  assert(stable(experiments.map(e => e.facts)) === stable(binding.experiments), "EXPERIMENT_BINDING_DRIFT");
  const current = await environmentFacts({ allowInsecure, env });
  assert(stable(current.provider) === stable(binding.provider) && stable(current.pricing) === stable(binding.pricing), "ENVIRONMENT_BINDING_DRIFT");
  assert(current.isolation.strength === binding.isolation.strength && current.isolation.contractDigest === binding.isolation.contractDigest &&
    current.isolation.promotionEligible === binding.isolation.promotionEligible, "ISOLATION_DRIFT");
  if (paid) {
    assert(confirm === binding.executionBindingDigest, "CONFIRMATION_REQUIRED");
    assert(env.RUN_PAID_BENCHMARKS === "1", "PAID_AUTHORIZATION_REQUIRED");
    assert(current.credentialPresent, "CREDENTIAL_MISSING");
    assert(binding.pricing !== null, "PRICING_UNKNOWN");
    const { evaluation: ev } = await dependencies();
    assert(ev.checkPricingExecutionGuard(binding.pricing, Date.now()) === null, "PRICING_NOT_EXECUTABLE");
    assert(binding.isolation.strength === "strong" || allowInsecure && binding.isolation.strength === "insecure-local", "STRONG_ISOLATION_REQUIRED");
  }
  return { experiments, current };
}
export async function executionIdentity(experiment, binding) {
  const { evaluation: ev } = await dependencies();
  const { prereg, plan, facts, cases } = experiment;
  return ev.buildExecutionIdentityV1({ scheduleDigest: plan.planDigest, suite: prereg.dataset.suiteId,
    judgeVersion: prereg.evaluation.judgeId, repetitions: prereg.schedule.repetitions, orderSeed: prereg.schedule.orderSeed,
    modelSeed: null, caseIds: cases.map(c => c.id), caseFingerprints: facts.caseFingerprints,
    baselineConfigHash: facts.runtimeConfigHashes.baseline, candidate: facts.candidates.candidate, candidateConfigHash: facts.runtimeConfigHashes.candidate,
    providerId: binding.provider.providerId, modelId: binding.provider.modelId, effectiveModelParams: { ...binding.provider.profile, requestPolicy: binding.provider.requestPolicy },
    sourceSha: binding.source.sourceSha, treeFingerprint: binding.source.sourceDigest,
    limits: { maxLogicalRuns: plan.totalLogicalRuns, maxModelCalls: prereg.budget.campaignWorstCaseModelCalls,
      maxEstimatedTokens: prereg.budget.maxTotalTokens, maxEstimatedCostUsd: prereg.budget.maxUsdMicros / 1000000 }, billingClass: "external-billed",
    isolationBackendId: binding.isolation.backendId, isolationStrength: binding.isolation.strength, isolationSelfTestId: binding.isolation.contractDigest,
    promotionEligible: binding.isolation.promotionEligible, decisionPolicy: { gates: prereg.evaluation.gates, executionBindingDigest: binding.executionBindingDigest },
    thresholdDigest: prereg.evaluation.gatesDigest });
}
export async function main(action) {
  try { await action(); } catch (error) {
    // Never print provider error messages, request URLs or environment values.
    process.stderr.write(`n7[${error.code ?? "EXECUTION_REFUSED"}]\n`);
    process.exitCode = 1;
  }
}
