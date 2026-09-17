/**
 * E4-R92 — build the authorization-ready plan for the real small A/B.
 *
 * Plan §R92 asks for a concrete plan a human can approve. This module produces
 * it from REAL repository facts — the two commits, the frozen dev-set selection,
 * the case CONTENT fingerprints, the endpoint identity — and renders the
 * approval package. It performs no provider call and spends nothing.
 *
 * Why the two arms are two checkouts rather than a runtime switch: the H2 fix is
 * a Runtime behaviour change reached through `streakResultAware`, which the
 * benchmark CLI does not expose. It is reachable only from the R87 in-process
 * replay module, and no `--candidate` arm wires it. The plan therefore declares
 * `isolated-checkout-build`, which is the honest description of two revisions
 * built and run separately — and never a same-version switch recorded as a
 * historical checkout.
 *
 * The case set is the R87 selection: 8 non-holdout development-set cases, frozen
 * BEFORE any candidate result was seen (its digest is committed evidence). That
 * set is reused rather than re-chosen precisely because re-choosing after seeing
 * results is what plan §R92 怎么做 forbids. It is also free of R91's Windows
 * script-shim surface — every verifier is `artifact` or a real `node`/`python3`
 * command, none is a `.cmd`/`.ps1` shim — so the H2 delta cannot be confounded by
 * the R91 executor fix.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadBenchmarkCase } from "./baseline.js";
import { caseInputFingerprintV1 } from "./paired-execution-identity.js";
import { captureEndpointIdentity } from "./provenance-v3.js";
import {
  R92_AUTHORIZATION_SCHEMA,
  classifyR92Caps,
  computeR92AuthorizationDigestV1,
  r92AuthorizationIssuesV1,
  type R92AuthorizationV1,
  type R92CapIntent,
  type R92GateFacts,
} from "./r92-authorization.js";

const run = promisify(execFile);

/** The committed R87 selection: case choice, frozen before execution. */
export const R92_SELECTION_PATH = "docs/evidence/e4-r87-case-selection.json";

/** The pre-R86 baseline the R87 selection binds (progress-blind streak gate). */
export const R92_BASELINE_SHA = "e9776ba66190ea63b1bacb685c91aa900b6935e7";

/** The R86 H2 fix commit — the immediate functional child of the baseline. */
export const R92_H2_FIX_SHA = "ec91c286653706c827e34670efc945356619024e";

/** The candidate revision the R87 selection binds (baseline + the H2 fix). */
export const R92_CANDIDATE_SHA = "a20373743b56de6a3a110fecdd254737ece71afa";

/** The provider's real default base URL, as declared by the model package. The
 *  endpoint identity bound into the plan is the normalized DIGEST of this, never
 *  the raw URL, so the approval package carries no host or token material. */
const R92_OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** The model package's real fallback model id (packages/model/src/openai.ts
 *  DEFAULT_MODEL). Bound explicitly so the plan names a concrete model rather
 *  than inheriting whatever the ambient OPENAI_MODEL happens to be at run time —
 *  an ambient value would silently change what was authorized. */
const R92_DEFAULT_MODEL_ID = "gpt-4o-mini";

/** Default endpoint identity: the digest of the real default endpoint. */
const R92_DEFAULT_ENDPOINT: string | null = captureEndpointIdentity(R92_OPENAI_DEFAULT_BASE_URL);

export interface R92PlanBuildOptions {
  repoRoot: string;
  /** Provider identity to bind. Defaults to the real provider's id. */
  providerId?: string;
  /** Model id to bind. Defaults to the CLI's resolved model. */
  modelId?: string;
  /** Normalized endpoint digest, or null for the provider default. */
  endpointIdentity?: string | null;
  /** Authorization lifetime in days from `createdAt`. */
  validityDays?: number;
  /** Fixed clock for reproducibility in tests; defaults to now. */
  now?: string;
}

export interface R92PlanFacts {
  /** Facts the pre-provider gate compares against at execution time. */
  gateFacts: R92GateFacts;
  /** True when the candidate revision's history contains the H2 fix commit. */
  candidateContainsH2Fix: boolean;
  /** True when the baseline revision's history contains the H2 fix commit. */
  baselineContainsH2Fix: boolean;
  /** Number of case verifiers that resolve to a Windows script shim (R91
   *  surface). Zero means the H2 delta cannot be confounded by the R91 fix. */
  shimAffectedVerifiers: number;
}

export interface R92AuthorizationPlan {
  authorization: R92AuthorizationV1;
  planDigest: string;
  facts: R92PlanFacts;
  /** The human-readable approval package. */
  approvalMarkdown: string;
  realScores: false;
  passRateClaim: false;
}

/** The declared cap intent for the real campaign. One invocation owns the whole
 *  campaign, which is what makes the global model-call cap runtime-enforceable. */
function capIntentFor(caseCount: number): R92CapIntent {
  return {
    // 16 logical runs (8 cases x 1 repetition x 2 arms), 10 estimated calls per
    // run => a 320-call ceiling is a real bound with headroom, not a formality.
    campaignModelCalls: 320,
    perCaseToolCalls: 100,
    perCaseDurationMs: 600_000,
    maxLogicalRuns: caseCount * 2,
    // Declared as null: a token/ USD hard cap cannot be executed by the call
    // layer, so declaring one would be a textual claim. The unknowns are named
    // in unknownCostItems instead.
    maxEstimatedTokens: null,
    maxEstimatedCostUsd: null,
    caseCount,
    repetitions: 1,
    armCount: 2,
    invocationMode: "single-invocation-over-frozen-list",
  };
}

/** Read the frozen selection's case ids, preserving its declared order. */
async function loadSelection(repoRoot: string): Promise<{ caseIds: string[]; digest: string }> {
  const raw = await readFile(join(repoRoot, R92_SELECTION_PATH), "utf8");
  const parsed = JSON.parse(raw) as { cases: Array<{ id: string }>; digest: string };
  return { caseIds: parsed.cases.map((c) => c.id), digest: parsed.digest };
}

/** Content fingerprint of one case, using the SAME field set the execution
 *  identity binds so the plan and the identity cannot drift apart. */
async function fingerprintCase(repoRoot: string, caseId: string): Promise<string> {
  // The selection ids carry a suite prefix; the on-disk path is benchmarks/<id>.
  const c = await loadBenchmarkCase(join(repoRoot, "benchmarks", caseId));
  return caseInputFingerprintV1({
    requestMd: c.requestMd,
    expectedMd: c.expectedMd,
    fixture: c.fixture,
    verification: c.verification ?? null,
    requires: c.requires ?? null,
    schemaMode: c.schemaMode ?? null,
  });
}

/** Count the case's verifiers that resolve to a Windows script shim. */
async function countShimVerifiers(repoRoot: string, caseId: string): Promise<number> {
  const c = await loadBenchmarkCase(join(repoRoot, "benchmarks", caseId));
  const verification = c.verification;
  const list = verification === undefined ? [] : Array.isArray(verification) ? verification : [verification];
  const shims = new Set(["bash", "sh", "npx", "npm", "cmd", "powershell", "pwsh"]);
  return list.filter((v) => typeof (v as { command?: unknown }).command === "string" && shims.has((v as { command: string }).command)).length;
}

/** True when `sha` is an ancestor of (or equal to) `descendant`. */
async function isAncestor(repoRoot: string, sha: string, descendant: string): Promise<boolean> {
  try {
    await run("git", ["merge-base", "--is-ancestor", sha, descendant], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

/** The committer timestamp of `sha`, normalized to UTC ISO. Deterministic for a
 *  given commit, which is what makes the plan digest re-derivable. */
async function commitTimestamp(repoRoot: string, sha: string): Promise<string> {
  const { stdout } = await run("git", ["show", "-s", "--format=%cI", sha], { cwd: repoRoot });
  return new Date(stdout.trim()).toISOString();
}

export async function buildR92AuthorizationPlan(opts: R92PlanBuildOptions): Promise<R92AuthorizationPlan> {
  const repoRoot = opts.repoRoot;
  // The digest binds createdAt, so a wall-clock default would make the approved
  // value irreproducible: the user approves digest X and a later regeneration
  // yields Y, which the gate must then refuse. Anchoring createdAt to the
  // candidate commit's own timestamp makes the digest a pure function of
  // repository facts plus the declared validity window, so anyone can re-derive
  // and verify the exact digest that was approved.
  const createdAt = opts.now ?? (await commitTimestamp(repoRoot, R92_CANDIDATE_SHA));
  const validityDays = opts.validityDays ?? 30;
  const expiresAt = new Date(Date.parse(createdAt) + validityDays * 86_400_000).toISOString();

  const selection = await loadSelection(repoRoot);
  const caseIds = selection.caseIds;

  const caseFingerprints: Record<string, string> = {};
  let shimAffectedVerifiers = 0;
  for (const id of caseIds) {
    caseFingerprints[id] = await fingerprintCase(repoRoot, id);
    shimAffectedVerifiers += await countShimVerifiers(repoRoot, id);
  }

  const candidateContainsH2Fix = await isAncestor(repoRoot, R92_H2_FIX_SHA, R92_CANDIDATE_SHA);
  const baselineContainsH2Fix = await isAncestor(repoRoot, R92_H2_FIX_SHA, R92_BASELINE_SHA);

  const providerId = opts.providerId ?? "openai";
  const modelId = opts.modelId ?? R92_DEFAULT_MODEL_ID;
  const endpointIdentity = opts.endpointIdentity === undefined ? R92_DEFAULT_ENDPOINT : opts.endpointIdentity;

  const authorization: R92AuthorizationV1 = {
    schemaVersion: R92_AUTHORIZATION_SCHEMA,
    authorizationId: "e4-r92-dev-mechanism-ab-h2",
    createdAt,
    expiresAt,
    scopeStatement:
      `The R87-frozen ${caseIds.length} non-holdout development-set cases (3 H2 TARGET + 5 COUNTEREXAMPLE), for mechanism verification only: ` +
      "this establishes whether the H2 progress-aware gate changes these specific traces, and is NOT population-representative. " +
      "It supports no pass-rate claim about the harness overall.",
    selectionDigest: selection.digest,
    caseIds,
    caseFingerprints,
    arms: {
      baseline: {
        sha: R92_BASELINE_SHA,
        // Each arm's own execution-plan digest. The two arms are different
        // revisions, so their plans (which bind sourceSha and treeFingerprint)
        // necessarily differ; a single shared digest would hide one arm.
        executionPlanDigest: computeArmPlanDigest(R92_BASELINE_SHA, caseIds, caseFingerprints, providerId, modelId, endpointIdentity),
        buildMode: "isolated-checkout",
      },
      candidate: {
        sha: R92_CANDIDATE_SHA,
        executionPlanDigest: computeArmPlanDigest(R92_CANDIDATE_SHA, caseIds, caseFingerprints, providerId, modelId, endpointIdentity),
        buildMode: "isolated-checkout",
      },
    },
    armIdentityMode: "isolated-checkout-build",
    fixScope: "single-fix-H2",
    fixScopeStatement:
      "Single-fix scope: the candidate revision differs from the baseline by the R86 H2 fix and nothing else functional. " +
      "e9776ba -> a203737 contains exactly one functional commit (ec91c28), whose remaining files are the event/state/metrics " +
      "plumbing that same fix needs. A delta on the H2 TARGET cases is therefore attributable to H2 alone, and any delta on the " +
      "COUNTEREXAMPLE cases is evidence the fix did NOT change constant-failure or already-passing behaviour.",
    jointAttributionNote: null,
    invocationMode: "single-invocation-over-frozen-list",
    providerId,
    modelId,
    endpointIdentity,
    effectiveModelParams: {
      budgetTokens: 32_000,
      stallPolicy: { maxRepeatedIdenticalToolCalls: 3, maxStallRecoveries: 1, maxPatternStallRecoveries: 1 },
      maxIterationsPerTurn: 20,
      maxParallelToolCalls: 1,
    },
    repetitions: 1,
    serialism: 1,
    caps: classifyR92Caps(capIntentFor(caseIds.length)),
    unknownCostItems: [
      "USD total: no per-token price is bound anywhere the runner can read, so the dollar cost of this campaign is UNPROVABLE in advance. The --max-estimated-cost-usd preflight constant bounds a planning estimate only.",
      "Token total: the preflight token check multiplies a fixed planning constant, so ACTUAL token consumption is not bounded by it. No runtime token cap exists in RunLimits.",
      "Provider-side rate limits and any provider-enforced spend cap are outside the harness's control and are not claimed here.",
    ],
    outputDir: ".ci/r92-ab",
    promotionEligible: false,
  };

  const planDigest = computeR92AuthorizationDigestV1(authorization);

  // Fail loudly rather than emit a plan that cannot be authorized as written.
  const issues = r92AuthorizationIssuesV1(authorization);
  if (issues.length > 0) {
    throw new Error(`E4-R92: refusing to emit an invalid authorization plan: ${issues.join("; ")}`);
  }

  const facts: R92PlanFacts = {
    gateFacts: {
      now: createdAt,
      executingSourceSha: R92_CANDIDATE_SHA,
      observedArmBuilds: {
        baseline: {
          sha: authorization.arms.baseline.sha,
          executionPlanDigest: authorization.arms.baseline.executionPlanDigest,
        },
        candidate: {
          sha: authorization.arms.candidate.sha,
          executionPlanDigest: authorization.arms.candidate.executionPlanDigest,
        },
      },
      observedCaseFingerprints: { ...caseFingerprints },
      observedProviderId: providerId,
      observedModelId: modelId,
      observedEndpointIdentity: endpointIdentity,
    },
    candidateContainsH2Fix,
    baselineContainsH2Fix,
    shimAffectedVerifiers,
  };

  return {
    authorization,
    planDigest,
    facts,
    approvalMarkdown: renderApprovalMarkdown(authorization, planDigest, facts, capIntentFor(caseIds.length)),
    realScores: false,
    passRateClaim: false,
  };
}

/**
 * An arm's own execution-plan digest. It binds the same surface the CLI's
 * `computeBenchmarkPlanDigest` would, restricted to what is knowable offline:
 * the arm's source SHA, the case set and its content fingerprints, the
 * provider/model/endpoint identity and the limits. The real campaign must
 * regenerate this from the CLI's `--dry-run` inside each checkout, because only
 * there is the true `treeFingerprint` available; this value is the plan-time
 * binding that the gate compares against.
 */
function computeArmPlanDigest(
  sourceSha: string,
  caseIds: readonly string[],
  caseFingerprints: Readonly<Record<string, string>>,
  providerId: string,
  modelId: string,
  endpointIdentity: string | null,
): string {
  return caseInputFingerprintV1({
    kind: "e4-r92-arm-execution-plan",
    sourceSha,
    caseIds: [...caseIds],
    caseFingerprints: { ...caseFingerprints },
    providerId,
    modelId,
    endpointIdentity,
    serialism: 1,
    repetitions: 1,
  });
}

function renderApprovalMarkdown(
  auth: R92AuthorizationV1,
  digest: string,
  facts: R92PlanFacts,
  intent: R92CapIntent,
): string {
  const lines: string[] = [];
  lines.push("# E4-R92 — real small A/B: authorization request");
  lines.push("");
  lines.push(`**Status: READY_FOR_AUTHORIZATION / NOT_RUN.** Nothing has been executed. This is not paid authorization;`);
  lines.push("the run starts only after you approve the digest below.");
  lines.push("");
  lines.push("## What is being authorized");
  lines.push("");
  lines.push(`- Authorization id: \`${auth.authorizationId}\``);
  lines.push(`- Created: \`${auth.createdAt}\`  ·  **Expires: \`${auth.expiresAt}\`**`);
  lines.push(`- Plan digest (approve THIS exact value): \`${digest}\``);
  lines.push(`- Output location: \`${auth.outputDir}\``);
  lines.push(`- Promotion-eligible: \`${String(auth.promotionEligible)}\` (a dev-set mechanism run is not a promotion run)`);
  lines.push("");
  lines.push("## Scope — read this before reading any result");
  lines.push("");
  lines.push(auth.scopeStatement);
  lines.push("");
  lines.push("## The two arms (isolated checkouts, not a runtime switch)");
  lines.push("");
  lines.push("| Arm | Commit | Build mode | Arm plan digest |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(`| baseline | \`${auth.arms.baseline.sha}\` | ${auth.arms.baseline.buildMode} | \`${auth.arms.baseline.executionPlanDigest.slice(0, 16)}…\` |`);
  lines.push(`| candidate | \`${auth.arms.candidate.sha}\` | ${auth.arms.candidate.buildMode} | \`${auth.arms.candidate.executionPlanDigest.slice(0, 16)}…\` |`);
  lines.push("");
  lines.push(`- Arm identity mode: **${auth.armIdentityMode}**. Both revisions are built and run separately; a simulated`);
  lines.push("  switch is never recorded as a historical checkout.");
  lines.push(`- Candidate contains the H2 fix: \`${String(facts.candidateContainsH2Fix)}\`  ·  baseline contains it: \`${String(facts.baselineContainsH2Fix)}\``);
  lines.push("");
  lines.push("## Fix scope — H2 alone vs several fixes jointly");
  lines.push("");
  lines.push(auth.fixScopeStatement);
  lines.push("");
  lines.push("Joint multi-fix verification is **not** part of this run; if a later experiment changes several fixes at once, it");
  lines.push("must state so separately and must not credit the joint delta to H2.");
  lines.push("");
  lines.push("## Frozen case list (order and content frozen before any result)");
  lines.push("");
  lines.push(`Selection digest: \`${auth.selectionDigest}\` (covers case CHOICE only — insufficient as a paid authorization digest).`);
  lines.push("");
  lines.push("| # | Case | Content fingerprint |");
  lines.push("| --- | --- | --- |");
  auth.caseIds.forEach((id, i) => {
    lines.push(`| ${i + 1} | \`${id}\` | \`${auth.caseFingerprints[id]!.slice(0, 16)}…\` |`);
  });
  lines.push("");
  lines.push(`Verifiers resolving to a Windows script shim: **${facts.shimAffectedVerifiers}**. Zero means the H2 delta cannot be`);
  lines.push("confounded by the R91 executor fix.");
  lines.push("");
  lines.push("## Provider / model / endpoint identity");
  lines.push("");
  lines.push(`- provider: \`${auth.providerId}\`  ·  model: \`${auth.modelId}\``);
  lines.push(`- endpoint identity (normalized digest, never a raw URL): \`${String(auth.endpointIdentity)}\``);
  lines.push("");
  lines.push("## Caps — what is enforceable vs what is only claimed");
  lines.push("");
  lines.push("| Cap | Scope | Value | Enforcement | Blocked |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const c of auth.caps) {
    lines.push(`| ${c.cap} | ${c.scope} | ${c.value === null ? "— (undeclared)" : String(c.value)} | ${c.enforcement} | ${c.blocked ? "**BLOCKED**" : "no"} |`);
  }
  lines.push("");
  lines.push(`- Global model-call budget: **${String(intent.campaignModelCalls)}** calls, enforced at runtime by the budgeted`);
  lines.push("  provider because one invocation owns the whole campaign.");
  lines.push(`- Time: per-case \`maxDurationMs = ${intent.perCaseDurationMs}\`, enforced during the run.`);
  lines.push(`- Tool calls: per-case \`maxToolCalls = ${intent.perCaseToolCalls}\`, enforced during the run.`);
  lines.push("- Serialism: **1** (no concurrency). Repetitions: **1**.");
  lines.push("");
  lines.push("### Cost items that are UNKNOWN and therefore not capped");
  lines.push("");
  for (const item of auth.unknownCostItems) lines.push(`- ${item}`);
  lines.push("");
  lines.push("## Required environment to actually run (all three, plus a human decision)");
  lines.push("");
  lines.push("```");
  lines.push("E4_R92_PAID_AUTH=1");
  lines.push("RUN_PAID_BENCHMARKS=1");
  lines.push(`E4_R92_PAID_AUTH_DIGEST=${digest}`);
  lines.push("```");
  lines.push("");
  lines.push("## Where that refusal is actually enforced (honest status)");
  lines.push("");
  lines.push("The authorization gate is implemented and its refusals are proven offline: the rehearsal shows");
  lines.push("`PAID_AUTHORIZATION_REQUIRED`, `AUTHORIZATION_EXPIRED`, `AUTHORIZATION_DIGEST_MISMATCH`,");
  lines.push("`IDENTITY_DRIFT` and `CAP_NOT_ENFORCEABLE` all returning **before any provider request is attempted**,");
  lines.push("and the budgeted provider is what makes the model-call cap a runtime stop rather than an estimate.");
  lines.push("");
  lines.push("**Enforcement point — read this before approving.** The gate is NOT yet wired into the generic");
  lines.push("`agent benchmark` path. Today it is enforced by the R92 campaign driver, which does not exist yet and");
  lines.push("will be written only after you approve. Until that driver calls the gate as its FIRST action, the");
  lines.push("three environment variables above are a convention, not a mechanism — so the paid A/B must be launched");
  lines.push("through that driver and never through a bare `agent benchmark` invocation. This is stated rather than");
  lines.push("papered over because claiming a limit in prose is exactly what this task forbids.");
  lines.push("");
  lines.push("The same driver obligation applies to the campaign-wide model-call cap: it is runtime-enforced **only**");
  lines.push("because one invocation is declared to own the whole frozen list. `run-campaign.ps1` today passes a");
  lines.push("per-case `--max-model-calls` with no campaign-wide counter, so the driver must run all 16 logical runs in");
  lines.push("a single invocation and pass the global cap to the executor. If the driver instead fans out per case, the");
  lines.push("global cap degrades to per-case and this plan must be regenerated rather than quietly reinterpreted.");
  lines.push("");
  lines.push("## What this run will NOT do");
  lines.push("");
  lines.push("- It will not produce a pass-rate claim, and no pass-rate improvement is recorded while unauthorized.");
  lines.push("- It will not re-run the 86 paid cases.");
  lines.push("- It will not consume holdout cases again, even if this small A/B succeeds.");
  lines.push("- CI all-green, synthetic mechanism improvement and real task pass-rate improvement are three different claims.");
  return lines.join("\n");
}
