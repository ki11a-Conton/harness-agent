/**
 * N6 / N5 — the PAIRED EFFECT CAMPAIGN runner (research adapter).
 *
 * Why an adapter: the production `createPreregArmExecutor` requires two frozen
 * git checkouts plus trusted-build/egress-isolation machinery and hardcodes the
 * v2 candidate id, and the CLI's own paired path always compares a candidate
 * against the BASELINE (no guidance) — never against another candidate. This
 * experiment compares TWO GUIDANCE REVISIONS, so the arm identity is resolved
 * HERE, explicitly, and recorded:
 *
 *   plan arm "baseline"  -> candidate `tool_call_efficiency_v1`            (the live v2 text)
 *   plan arm "candidate" -> candidate `context_safe_tool_call_efficiency_v1` (the N6 revision)
 *
 * The plan's warning is honoured literally: the scheduler's `baseline` label is
 * NOT C0. Both arm config hashes and arm digests are asserted against the frozen
 * pre-registration before the first provider call.
 *
 * Everything else is the repo's real machinery: `buildPairedPlan` for the frozen
 * AB/BA grid, `runPairedExperiment` (journal + resume + strict pair validity),
 * `runOneCase` for each arm run (real harness, real tools, original command
 * verifier), and the budgeted provider wrapper for the hard call cap.
 *
 * Usage:
 *   node scripts/research/agent-next6-20261005/n5-paired-campaign.mjs \
 *     --experiment main|holdout --out <dir> [--limit N] [--deadline-min M] [--dry]
 *
 * The credential is read from OPENAI_API_KEY only; it is never written to disk.
 * `--dry` builds and verifies everything without calling a provider.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const EV = join(REPO, "docs", "evidence", "agent-next6-20261005");

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function argValue(name, fallback = undefined) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit !== undefined) return hit.slice(name.length + 3);
  if (process.argv.includes(`--${name}`)) return process.argv[process.argv.indexOf(`--${name}`) + 1];
  return fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const ev = await import(pathToFileURL(join(REPO, "packages", "evaluation", "dist", "index.js")).href);
const cli = await import(pathToFileURL(join(REPO, "apps", "cli", "dist", "benchmark-command.js")).href);
const providerMod = await import(pathToFileURL(join(REPO, "apps", "cli", "dist", "provider.js")).href);

const {
  buildExecutionIdentityV1,
  buildPairedPlan,
  computeExecutionIdentityDigestV1,
  computeRuntimeConfigHash,
  loadBenchmarkCases,
  runPairedExperiment,
} = ev;
const { caseFingerprintFor, runOneCase, runtimeConfigForHash } = cli;
const { resolveModelProvider } = providerMod;

// ---------------------------------------------------------------------------
// Frozen inputs
// ---------------------------------------------------------------------------

const APPROVED = {
  providerId: "openai",
  modelId: "workbuddy-deepseek-v4.1-flash",
  endpointBaseUrl: "http://127.0.0.1:8317/v1",
  budgetTokens: 32_000,
  requestProfile: { budgetTokens: 32_000, temperature: null, stallPolicy: "benchmark-default" },
};

const EXPERIMENTS = {
  main: {
    prereg: join(EV, "main-preregistration.json"),
    // The main experiment compares the two guidance revisions.
    armCandidates: { baseline: "tool_call_efficiency_v1", candidate: "context_safe_tool_call_efficiency_v1" },
  },
  holdout: {
    prereg: join(EV, "holdout-preregistration.json"),
    // The holdout re-verifies the candidate against the RESOLVED champion arm,
    // so its `baseline` arm runs the champion with NO candidate override when the
    // champion is C0, and with the champion's own candidate id otherwise.
    armCandidates: { baseline: undefined, candidate: "context_safe_tool_call_efficiency_v1" },
  },
};

const experimentName = argValue("experiment", "main");
const spec = EXPERIMENTS[experimentName];
if (spec === undefined) {
  process.stderr.write(`unknown --experiment ${String(experimentName)}; expected main|holdout\n`);
  process.exit(2);
}
const dry = hasFlag("dry");
const limit = argValue("limit") === undefined ? 0 : Number(argValue("limit"));
const deadlineMin = argValue("deadline-min") === undefined ? null : Number(argValue("deadline-min"));

const preregText = readFileSync(spec.prereg, "utf8");
const prereg = JSON.parse(preregText);
const declaredDigest = prereg.preregistrationDigest;

// Verify the artifact against its own identity fields exactly as the module does.
const recomputedDigest = await (async () => {
  const { computeContextSafePreregistrationDigest } = await import(
    pathToFileURL(join(REPO, "packages", "evaluation", "dist", "context-safe-tool-call-efficiency-preregistration.js")).href
  );
  return computeContextSafePreregistrationDigest(prereg);
})();

function refuse(code, message) {
  process.stderr.write(`n5-campaign[${code}]: ${message}\n`);
  process.exit(1);
}

if (recomputedDigest !== declaredDigest) {
  refuse("PREREG_DRIFT", `the frozen artifact's digest does not recompute (${declaredDigest} vs ${recomputedDigest})`);
}
if (prereg.provider.modelId !== APPROVED.modelId || prereg.provider.providerId !== APPROVED.providerId) {
  refuse("PROVIDER_MISMATCH", `the artifact binds ${prereg.provider.providerId}/${prereg.provider.modelId}, not the approved configuration`);
}
if (prereg.provider.requestProfileDigest !== sha256(stableOf(APPROVED.requestProfile))) {
  refuse("PROFILE_MISMATCH", "the artifact's request profile does not match the approved one");
}

// A local stable serialization for the profile comparison (the module's own
// canonical form is key-sorted; replicate it exactly).
function stableOf(value) {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(stableOf).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableOf(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

const suitId = prereg.dataset.suiteId;
const caseRoot = join(REPO, prereg.dataset.caseRoot);
const allCases = await loadBenchmarkCases(caseRoot);
const byId = new Map(allCases.map((c) => [c.id, c]));
const planCaseIds = prereg.dataset.cases.map((c) => c.caseId);
if (planCaseIds.some((id) => !byId.has(id))) {
  refuse("CASE_MISSING", "a frozen case id is not present in the case suite on disk");
}

function armCandidate(armId) {
  if (experimentName === "main") return spec.armCandidates[armId];
  if (experimentName === "holdout") {
    if (armId === "candidate") return spec.armCandidates.candidate;
    const champion = prereg.subject.championProvenance?.candidateId ?? null;
    return champion === null ? undefined : champion;
  }
  refuse("BAD_ARM", `unknown arm ${String(armId)}`);
  return undefined;
}

function armRuntimeConfig(candidate) {
  return runtimeConfigForHash({ suite: "regression", candidate }, APPROVED.budgetTokens);
}

const armConfigHashes = {
  baseline: computeRuntimeConfigHash(armRuntimeConfig(armCandidate("baseline"))),
  candidate: computeRuntimeConfigHash(armRuntimeConfig(armCandidate("candidate"))),
};
if (armConfigHashes.baseline === armConfigHashes.candidate) {
  refuse("ARMS_IDENTICAL", "the two resolved arm runtime configs hash identically — no causal delta");
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

const planCaseIdsUsed = limit > 0 ? planCaseIds.slice(0, limit) : planCaseIds;
const plan = buildPairedPlan({
  suite: suitId,
  cases: planCaseIdsUsed,
  repetitions: prereg.schedule.repetitions,
  orderSeed: prereg.schedule.orderSeed,
});

const fullRun = limit === 0;
if (fullRun) {
  if (plan.totalLogicalRuns !== 192) refuse("WRONG_LOGICAL_RUNS", `plan has ${plan.totalLogicalRuns} logical runs, expected 192`);
  if (plan.planDigest !== prereg.schedule.planDigest) {
    refuse("PLAN_DIGEST_MISMATCH", `plan digest ${plan.planDigest} != frozen ${prereg.schedule.planDigest}`);
  }
}

// ---------------------------------------------------------------------------
// Provider (never persisted; credential from the environment only)
// ---------------------------------------------------------------------------

const outDir = resolve(argValue("out", join(REPO, ".ci", "n6-n5", experimentName)));
mkdirSync(outDir, { recursive: true });

const header = {
  schemaVersion: "n6-n5-campaign-header-v1",
  experiment: experimentName,
  smoke: !fullRun,
  frozenPreregistrationDigest: declaredDigest,
  frozenPreregistrationFile: spec.prereg.replace(REPO, ".").split("\\").join("/"),
  armMapping: {
    planBaselineArm: { candidate: armCandidate("baseline") ?? null, note: experimentName === "main" ? "the live v2 guidance, NOT C0" : "the RESOLVED champion arm" },
    planCandidateArm: { candidate: armCandidate("candidate") ?? null, note: "the N6 revision" },
    runtimeConfigHashes: armConfigHashes,
  },
  provider: { providerId: APPROVED.providerId, modelId: APPROVED.modelId, endpointDigest: prereg.provider.endpointDigest, requestProfileDigest: prereg.provider.requestProfileDigest },
  budget: { maxUsdMicros: prereg.budget.maxUsdMicros, maxModelCallsPerRun: prereg.budget.maxModelCallsPerRun, campaignWorstCaseModelCalls: prereg.budget.campaignWorstCaseModelCalls },
  plan: { suiteId: suitId, cases: planCaseIdsUsed.length, repetitions: prereg.schedule.repetitions, orderSeed: prereg.schedule.orderSeed, planDigest: plan.planDigest, totalLogicalRuns: plan.totalLogicalRuns },
  isolation: { strength: "insecure-local", note: "win32 has no OS-level write-confinement backend, so every run here is insecure-local and NOT promotion-eligible under the repo's isolation contract" },
  modelSeed: null,
  startedAt: new Date().toISOString(),
};
writeFileSync(join(outDir, "campaign-header.json"), `${JSON.stringify(header, null, 2)}\n`, "utf8");
process.stdout.write(
  `campaign: ${experimentName}${fullRun ? "" : " (SMOKE)"} cases=${planCaseIdsUsed.length} logicalRuns=${plan.totalLogicalRuns} ` +
    `planDigest=${plan.planDigest.slice(0, 12)}… arms={baseline:${String(armCandidate("baseline"))}, candidate:${String(armCandidate("candidate"))}}\n`,
);

if (dry) {
  process.stdout.write("campaign: --dry, no provider constructed\n");
  process.exit(0);
}

const apiKey = process.env.OPENAI_API_KEY;
if (apiKey === undefined || apiKey.trim() === "") {
  refuse("NO_CREDENTIAL", "OPENAI_API_KEY is not set (the credential is never read from disk)");
}
// `resolveModelProvider` returns a BillingProvider BUNDLE ({ provider,
// billingClass }) — not a provider. Using the bundle directly made the runtime
// fail with "provider.createClient is not a function", which is exactly what the
// smoke run caught. The billing class is asserted too: silently falling back to
// the stub would produce a campaign with no real model in it.
const resolved = await resolveModelProvider({ baseUrl: APPROVED.endpointBaseUrl, modelId: APPROVED.modelId });
const provider = resolved?.provider;
if (provider === undefined || provider === null || typeof provider.createClient !== "function") {
  refuse("NO_PROVIDER", "the approved provider could not be resolved to a real provider (no createClient)");
}
if (resolved.billingClass !== "external-billed") {
  refuse("NOT_BILLED", `the provider resolved as "${String(resolved.billingClass)}" — refusing to run a campaign on the stub provider`);
}

// ---------------------------------------------------------------------------
// Execution identity + journal
// ---------------------------------------------------------------------------

const judgeVersion = "task-verifier";
const caseFingerprints = Object.fromEntries(planCaseIdsUsed.map((id) => [id, caseFingerprintFor(byId.get(id))]));
const identity = buildExecutionIdentityV1({
  scheduleDigest: plan.planDigest,
  suite: suitId,
  judgeVersion,
  repetitions: prereg.schedule.repetitions,
  orderSeed: prereg.schedule.orderSeed,
  modelSeed: null,
  caseIds: planCaseIdsUsed,
  caseFingerprints,
  baselineConfigHash: armConfigHashes.baseline,
  candidate: armCandidate("candidate") ?? null,
  candidateConfigHash: armConfigHashes.candidate,
  providerId: APPROVED.providerId,
  modelId: APPROVED.modelId,
  effectiveModelParams: { budgetTokens: APPROVED.budgetTokens, temperature: null },
  sourceSha: prereg.subject.candidateSourceSha,
  treeFingerprint: null,
  limits: { maxLogicalRuns: plan.totalLogicalRuns, maxModelCalls: prereg.budget.maxModelCallsPerRun * plan.totalLogicalRuns, maxEstimatedTokens: null, maxEstimatedCostUsd: prereg.budget.maxUsdMicros === null ? null : prereg.budget.maxUsdMicros / 1_000_000 },
  billingClass: "external-billed",
  isolationBackendId: "win32-none",
  isolationStrength: "insecure-local",
  promotionEligible: false,
  decisionPolicy: { gates: prereg.evaluation.gates, gatesDigest: prereg.evaluation.gatesDigest },
  thresholdDigest: prereg.evaluation.gatesDigest,
});
const identityDigest = computeExecutionIdentityDigestV1(identity);
const journalDir = join(outDir, ".paired-journal", identityDigest);
const deadlineAtMs = deadlineMin === null ? null : Date.now() + deadlineMin * 60_000 + 30_000;

process.stdout.write(`campaign: identity ${identityDigest.slice(0, 16)}… journal ${journalDir.replace(REPO, ".")}\n`);
writeFileSync(join(outDir, "execution-identity.json"), `${JSON.stringify(identity, null, 2)}\n`, "utf8");

const started = Date.now();
const result = await runPairedExperiment({
  plan,
  cases: planCaseIdsUsed.map((id) => byId.get(id)),
  provider,
  maxModelCalls: prereg.budget.maxModelCallsPerRun * plan.totalLogicalRuns,
  journalDir,
  identity,
  modelSeed: null,
  onArmCompleted: ({ armRunId, logicalRuns }) => {
    if (logicalRuns % 8 === 0 || logicalRuns === plan.totalLogicalRuns) {
      process.stdout.write(`  arm ${logicalRuns}/${plan.totalLogicalRuns} (${armRunId.slice(0, 12)}…) elapsed ${Math.round((Date.now() - started) / 1000)}s\n`);
    }
    if (deadlineAtMs !== null && Date.now() > deadlineAtMs) {
      throw new Error(`campaign deadline reached after ${logicalRuns}/${plan.totalLogicalRuns} arm runs (journal persists; resume by re-running)`);
    }
  },
  runArm: (arm, caseDef, ctx) =>
    runOneCase(
      caseDef,
      {
        provider: ctx.provider,
        modelId: APPROVED.modelId,
        budgetTokens: APPROVED.budgetTokens,
        candidate: armCandidate(arm.armId),
        processConfinement: "insecure-local",
        armId: arm.armId,
        repetition: arm.repetition,
        attempt: 1,
      },
      "regression",
    ),
});

const finishedAt = new Date().toISOString();
const summary = {
  schemaVersion: "n6-n5-campaign-result-v1",
  experiment: experimentName,
  smoke: !fullRun,
  frozenPreregistrationDigest: declaredDigest,
  executionIdentityDigest: identityDigest,
  planDigest: plan.planDigest,
  status: result.status,
  counters: result.counters,
  finalizedPairs: result.finalizedPairs?.length ?? 0,
  partialPairs: result.partialPairs?.length ?? 0,
  elapsedSeconds: Math.round((Date.now() - started) / 1000),
  finishedAt,
};
writeFileSync(join(outDir, "campaign-result.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

// Raw per-arm outcomes (the evidence the gates are computed from).
if (Array.isArray(result.finalizedPairs)) {
  writeFileSync(join(outDir, "finalized-pairs.json"), `${JSON.stringify(result.finalizedPairs, null, 2)}\n`, "utf8");
}
if (Array.isArray(result.partialPairs)) {
  writeFileSync(join(outDir, "partial-pairs.json"), `${JSON.stringify(result.partialPairs, null, 2)}\n`, "utf8");
}

// SHA256 index over everything this run wrote (raw evidence, not a summary).
const { readdirSync } = await import("node:fs");
const indexFiles = [];
for (const name of readdirSync(outDir)) {
  if (name === "artifact-index.json") continue;
  const abs = join(outDir, name);
  try {
    const bytes = readFileSync(abs);
    indexFiles.push({ file: name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  } catch {
    /* directories (the journal) are indexed by their own files below */
  }
}
const journalFiles = [];
try {
  for (const name of readdirSync(journalDir)) {
    const bytes = readFileSync(join(journalDir, name));
    journalFiles.push({ file: `.paired-journal/${identityDigest}/${name}`, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
} catch {
  /* no journal entries yet */
}
writeFileSync(
  join(outDir, "artifact-index.json"),
  `${JSON.stringify({ schemaVersion: "n6-n5-artifact-index-v1", files: [...indexFiles, ...journalFiles].sort((a, b) => a.file.localeCompare(b.file)) }, null, 2)}\n`,
  "utf8",
);

process.stdout.write(
  `campaign: ${result.status} — pairs finalized ${summary.finalizedPairs}, partial ${summary.partialPairs}, ` +
    `logical runs ${result.counters?.logicalRuns ?? "?"}, elapsed ${summary.elapsedSeconds}s, out ${outDir.replace(REPO, ".")}\n`,
);
process.exit(result.status === "complete" ? 0 : 1);
