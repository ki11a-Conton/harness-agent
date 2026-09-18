/**
 * E4-R97 — the FINALIZED authorization plan, built from REAL arm observations.
 *
 * Plan §R97 怎么做 (line 211-213) is the specification for this module:
 *
 *   - "现有 computeArmPlanDigest 是计划期自定义摘要，不能用作真实 CLI dry-run
 *     摘要替身。先无 key 检出、构建、加载实际案例，再由真实 dry-run 生成每臂执行
 *     计划。" — the plan-time custom digest is NOT a substitute for the real CLI
 *     dry-run digest. Each arm's execution-plan digest must come from running the
 *     REAL CLI `--dry-run` inside that arm's own checkout.
 *
 *   - "删掉'observed 值从 authorization 对应字段复制'作为真实性证明的路径。facts
 *     来自 git/build manifest、实际 case 文件、实际 provider 配置。" — DELETE the
 *     path where observed values are copied from the authorization's own fields.
 *     Facts must come from the git/build manifest, the actual case files and the
 *     actual provider configuration.
 *
 *   - "计划草案有缺失 build/tree fingerprint 或未验证 caps 时 NOT_READY/DRAFT；
 *     正式材料必须无需修改就能执行。构建后值变化就重新生成并重新审批，不能继续用
 *     旧 digest。" — a draft missing a build/tree fingerprint or with unverified
 *     caps is NOT_READY/DRAFT; finalized materials must be executable without
 *     modification.
 *
 * The distinction this module enforces is therefore structural, not cosmetic:
 *
 *   DRAFT      — built from the CURRENT checkout only. It has no per-arm
 *                observation, so its arm digests are UNKNOWN (`null`) and it can
 *                never be authorized. A draft exists to be inspected, not approved.
 *
 *   FINALIZED  — built from two REAL per-arm CLI dry-run observations. Every
 *                bound value is an OBSERVED value, so the digest the human
 *                approves is the digest the executor will re-derive.
 *
 * The module never constructs a provider and never performs a network call.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadBenchmarkCase } from "./baseline.js";
import { caseInputFingerprintV1 } from "./paired-execution-identity.js";
import {
  R92_AUTHORIZATION_SCHEMA,
  classifyR92Caps,
  computeR92AuthorizationDigestV1,
  r92AuthorizationIssuesV1,
  r92CapDeclarationIssues,
  r92CapViolations,
  type R92AuthorizationV1,
  type R92CapIntent,
  type R92GateFacts,
} from "./r92-authorization.js";

export const R97_PLAN_SCHEMA = "e4-r97-finalized-authorization-plan-v1";
export const R97_DRAFT_SCHEMA = "e4-r97-draft-authorization-plan-v1";

/** The frozen R87 selection: case choice and ORDER, frozen before execution. */
export const R97_SELECTION_PATH = "docs/evidence/e4-r87-case-selection.json";

/** The driver identity bound into the plan, so the plan names the code that
 *  would execute it. Bumped whenever the driver's behaviour changes. */
export const R97_DRIVER_VERSION = "e4-r97-campaign-driver-v1";

/** Plan status. Only FINALIZED may be presented for a human decision. */
export type R97PlanStatus = "DRAFT" | "FINALIZED_AUTHORIZATION_PLAN" | "NOT_READY";

/**
 * ONE arm's observation, produced by running the REAL CLI `--dry-run` inside
 * that arm's own checkout.
 *
 * Every field here is something the CLI PRINTED. Nothing is inferred from the
 * other arm, and nothing is copied from an authorization envelope — that is the
 * whole point of the type.
 */
export interface R97ArmObservation {
  arm: "baseline" | "candidate";
  /** The directory the dry-run ran in. Recorded so the observation is auditable. */
  checkoutDir: string;
  /** `sourceSha` as the CLI reported it (git HEAD of that checkout). */
  sourceSha: string;
  /**
   * `treeFingerprint` as the CLI reported it. `null` is the CLI's own honest
   * value for a PROVABLY CLEAN tree (see `probeSourceSnapshot`), so it is a
   * legitimate observation — but the caller must know which it is.
   */
  treeFingerprint: string | null;
  /** Whether that checkout was clean per the CLI's own probe. */
  clean: boolean;
  /** The CLI's `planDigest` — the REAL execution-plan digest for this arm. */
  planDigest: string;
  providerId: string;
  modelId: string;
  endpointIdentity: string | null;
  /**
   * The case ids the CLI actually planned. MEASURED: the real CLI prints BARE
   * directory names (`reg-16-cicd-step`), NOT the suite-prefixed ids the R87
   * selection uses (`regression/reg-16-cicd-step`). Both are recorded so the
   * mapping between them is explicit rather than assumed.
   */
  cliCaseIds: string[];
  /** The suite-prefixed frozen ids this observation covers, in the selection's
   *  order. Derived by mapping `cliCaseIds` onto the frozen selection. */
  caseIds: string[];
  /** Per-case input fingerprints, computed from the case files IN THIS ARM'S
   *  CHECKOUT. The CLI does not print fingerprints, so they are read from the
   *  arm's own source — an independent observation of the same build. */
  caseFingerprints: Record<string, string>;
  /** The CLI's effective model params, as bound into its digest. */
  effectiveModelParams: Record<string, unknown>;
  /** Total logical runs the CLI planned. */
  totalLogicalRuns: number;
  /** The suite the CLI planned under. */
  suite: string;
}

/**
 * Map the CLI's BARE case ids onto the frozen selection's suite-prefixed ids.
 *
 * The mapping is by last path segment, which is only sound when no two frozen
 * cases share a bare name — otherwise `regression/x` and `stress/x` are
 * indistinguishable in the CLI's output. That ambiguity is checked, not assumed:
 * an ambiguous selection is refused rather than silently mis-mapped.
 */
export function mapCliCaseIdsToSelection(
  cliCaseIds: readonly string[],
  selectionCaseIds: readonly string[],
): { caseIds: string[] | null; issue: string | null } {
  const bareOf = (id: string): string => id.split("/").pop() ?? id;
  const byBare = new Map<string, string[]>();
  for (const id of selectionCaseIds) {
    const b = bareOf(id);
    byBare.set(b, [...(byBare.get(b) ?? []), id]);
  }
  const ambiguous = [...byBare.entries()].filter(([, ids]) => ids.length > 1).map(([b]) => b);
  if (ambiguous.length > 0) {
    return {
      caseIds: null,
      issue: `the frozen selection has ambiguous bare case names (${ambiguous.join(", ")}) — the CLI prints bare names, so these cases cannot be distinguished`,
    };
  }
  const mapped: string[] = [];
  for (const cli of cliCaseIds) {
    const hit = byBare.get(cli);
    if (hit === undefined) return { caseIds: null, issue: `the CLI planned an unknown case "${cli}"` };
    mapped.push(hit[0]!);
  }
  return { caseIds: mapped, issue: null };
}

/** Parse ONE arm's CLI `--dry-run` JSON into an observation. Fails closed.
 *
 *  `caseFingerprints` is supplied by the CALLER, read from the case files in
 *  that arm's own checkout: MEASURED, the real CLI dry-run does NOT print a
 *  `caseFingerprints` object, so requiring one would reject every real
 *  observation. The fingerprints still come from an independent read of the
 *  arm's build rather than from the envelope — which is what plan §R97 line 212
 *  requires. */
export function parseR97ArmObservation(
  arm: "baseline" | "candidate",
  checkoutDir: string,
  raw: unknown,
  caseFingerprints: Record<string, string> = {},
): { observation: R97ArmObservation | null; issues: string[] } {
  const issues: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { observation: null, issues: [`arm ${arm}: the dry-run output is not a JSON object`] };
  }
  const o = raw as Record<string, unknown>;
  const str = (k: string): string => {
    const v = o[k];
    if (typeof v !== "string" || v === "") {
      issues.push(`arm ${arm}: dry-run field ${k} must be a non-empty string`);
      return "";
    }
    return v;
  };
  if (o["mode"] !== "dry-run") issues.push(`arm ${arm}: dry-run output declares mode ${String(o["mode"])}, not "dry-run"`);
  if (o["providerCalls"] !== 0) {
    // A dry-run that reports any provider call is not a dry-run.
    issues.push(`arm ${arm}: dry-run output reports providerCalls=${String(o["providerCalls"])}, expected 0`);
  }
  const sourceSha = str("sourceSha");
  const planDigest = str("planDigest");
  const providerId = str("providerId");
  const modelId = str("modelId");
  const cliCaseIds = Array.isArray(o["caseIds"]) ? (o["caseIds"] as unknown[]).filter((c): c is string => typeof c === "string") : [];
  if (cliCaseIds.length === 0) issues.push(`arm ${arm}: dry-run output carries no caseIds`);
  const tree = o["treeFingerprint"];
  const treeFingerprint = typeof tree === "string" && tree !== "" ? tree : null;
  const suite = typeof o["suite"] === "string" ? o["suite"] : "";
  if (suite === "") issues.push(`arm ${arm}: dry-run output carries no suite`);

  if (issues.length > 0) return { observation: null, issues };

  return {
    observation: {
      arm,
      checkoutDir,
      sourceSha,
      treeFingerprint,
      clean: treeFingerprint === null,
      planDigest,
      providerId,
      modelId,
      endpointIdentity: typeof o["endpointIdentity"] === "string" ? o["endpointIdentity"] : null,
      cliCaseIds,
      caseIds: cliCaseIds,
      caseFingerprints: { ...caseFingerprints },
      effectiveModelParams:
        typeof o["effectiveModelParams"] === "object" && o["effectiveModelParams"] !== null
          ? { ...(o["effectiveModelParams"] as Record<string, unknown>) }
          : {},
      totalLogicalRuns: typeof o["totalLogicalRuns"] === "number" ? o["totalLogicalRuns"] : 0,
      suite,
    },
    issues: [],
  };
}

/** The frozen selection, read from the committed evidence file. */
export interface R97FrozenSelection {
  caseIds: string[];
  digest: string;
  /** Content fingerprint per case, computed from the ACTUAL case files. */
  caseFingerprints: Record<string, string>;
}

export async function loadR97FrozenSelection(repoRoot: string): Promise<R97FrozenSelection> {
  const raw = await readFile(join(repoRoot, R97_SELECTION_PATH), "utf8");
  const parsed = JSON.parse(raw) as { cases: Array<{ id: string }>; digest: string };
  const caseIds = parsed.cases.map((c) => c.id);
  const caseFingerprints: Record<string, string> = {};
  for (const id of caseIds) {
    const c = await loadBenchmarkCase(join(repoRoot, "benchmarks", id));
    caseFingerprints[id] = caseInputFingerprintV1({
      requestMd: c.requestMd,
      expectedMd: c.expectedMd,
      fixture: c.fixture,
      verification: c.verification ?? null,
      requires: c.requires ?? null,
      schemaMode: c.schemaMode ?? null,
    });
  }
  return { caseIds, digest: parsed.digest, caseFingerprints };
}

export interface R97CapIntentInput {
  caseCount: number;
  campaignModelCalls: number;
  perCaseToolCalls: number;
  perCaseDurationMs: number;
  repetitions: number;
  armCount: number;
}

export function r97CapIntent(input: R97CapIntentInput): R92CapIntent {
  return {
    campaignModelCalls: input.campaignModelCalls,
    perCaseToolCalls: input.perCaseToolCalls,
    perCaseDurationMs: input.perCaseDurationMs,
    maxLogicalRuns: input.caseCount * input.repetitions * input.armCount,
    // Declared null: no layer can execute a token or USD hard cap, so declaring
    // one would be a textual claim. The unknowns are named instead.
    maxEstimatedTokens: null,
    maxEstimatedCostUsd: null,
    caseCount: input.caseCount,
    repetitions: input.repetitions,
    armCount: input.armCount,
    invocationMode: "single-invocation-over-frozen-list",
  };
}

/** One reason a plan cannot be finalized. */
export interface R97ReadinessIssue {
  code: string;
  detail: string;
}

/**
 * The readiness computation. Readiness is a property of the OBSERVATIONS, and it
 * is computed BEFORE any authorization is consulted — the R95 lesson applied to
 * the finalization step.
 */
export function r97ReadinessIssues(input: {
  selection: R97FrozenSelection;
  baseline: R97ArmObservation | null;
  candidate: R97ArmObservation | null;
  caps: ReturnType<typeof classifyR92Caps>;
  authorizationForCaps: R92AuthorizationV1;
  expectedProviderId: string;
  expectedModelId: string;
  expectedEndpointIdentity: string | null;
}): R97ReadinessIssue[] {
  const issues: R97ReadinessIssue[] = [];
  const { baseline, candidate, selection } = input;

  // (1) BOTH arms must have been OBSERVED. A draft has none.
  if (baseline === null) issues.push({ code: "ARM_NOT_OBSERVED", detail: 'arm "baseline" was never observed by a real CLI dry-run' });
  if (candidate === null) issues.push({ code: "ARM_NOT_OBSERVED", detail: 'arm "candidate" was never observed by a real CLI dry-run' });

  for (const obs of [baseline, candidate]) {
    if (obs === null) continue;
    // (2) The arm's real execution-plan digest must exist and be a real digest.
    if (!/^[0-9a-f]{64}$/.test(obs.planDigest)) {
      issues.push({ code: "ARM_PLAN_DIGEST_INVALID", detail: `arm "${obs.arm}" dry-run planDigest is not a 64-hex digest: ${obs.planDigest}` });
    }
    if (!/^[0-9a-f]{40}$/.test(obs.sourceSha)) {
      issues.push({ code: "ARM_SOURCE_SHA_INVALID", detail: `arm "${obs.arm}" sourceSha is not a 40-hex commit: ${obs.sourceSha}` });
    }
    // (3) The arm must have been a CLEAN checkout. A dirty arm means the build
    //     the digest describes is not the build that would run.
    if (!obs.clean) {
      issues.push({
        code: "ARM_CHECKOUT_DIRTY",
        detail: `arm "${obs.arm}" was observed with a non-clean tree (treeFingerprint ${String(obs.treeFingerprint)}) — a finalized plan must bind a reproducible build`,
      });
    }
    // (4) Identity must agree with the declared provider/model/endpoint.
    if (obs.providerId !== input.expectedProviderId || obs.modelId !== input.expectedModelId) {
      issues.push({
        code: "ARM_IDENTITY_MISMATCH",
        detail: `arm "${obs.arm}" observed ${obs.providerId}/${obs.modelId} but the plan declares ${input.expectedProviderId}/${input.expectedModelId}`,
      });
    }
    if (obs.endpointIdentity !== input.expectedEndpointIdentity) {
      issues.push({
        code: "ARM_ENDPOINT_MISMATCH",
        detail: `arm "${obs.arm}" observed endpoint ${String(obs.endpointIdentity)} but the plan declares ${String(input.expectedEndpointIdentity)}`,
      });
    }
    // (5) The arm must have planned EXACTLY the frozen case SET.
    //
    // MEASURED, and the reason this is a set comparison plus a separate
    // cross-arm order check: `loadBenchmarkCases` SORTS its directory entries
    // (`baseline.ts`: `.sort()`), so the CLI's `caseIds` are always in
    // alphabetical order and can never equal the R87 selection file's array
    // order (which is TARGET-first, then counterexamples). Demanding array
    // equality would reject every real observation.
    //
    // What the frozen selection actually requires (its own `armRule`) is that
    // "both arms run the same runner with ... the same case order". So the
    // contract is enforced as: the SET matches the selection exactly, AND both
    // arms observed the SAME order as each other. Both are checked below; the
    // cross-arm order check lives in section (7).
    if (obs.caseIds.length !== selection.caseIds.length) {
      issues.push({
        code: "CASE_SET_DRIFT",
        detail: `arm "${obs.arm}" planned ${obs.caseIds.length} case(s) but the frozen selection has ${selection.caseIds.length}`,
      });
    } else {
      const want = new Set(selection.caseIds);
      const missing = selection.caseIds.filter((id) => !obs.caseIds.includes(id));
      const extra = obs.caseIds.filter((id) => !want.has(id));
      if (missing.length > 0 || extra.length > 0) {
        issues.push({
          code: "CASE_SET_DRIFT",
          detail: `arm "${obs.arm}" planned a different case set than the frozen selection (missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"})`,
        });
      }
    }
    // (6) The CLI's OWN fingerprints must match the fingerprints of the case
    //     files on disk. This is the anti-copy check: the plan cannot assert a
    //     fingerprint the executing checkout does not actually have.
    for (const id of selection.caseIds) {
      const observed = obs.caseFingerprints[id];
      if (observed === undefined) {
        issues.push({ code: "CASE_FINGERPRINT_MISSING", detail: `arm "${obs.arm}" did not fingerprint case ${id}` });
      } else if (observed !== selection.caseFingerprints[id]) {
        issues.push({
          code: "CASE_CONTENT_DRIFT",
          detail: `arm "${obs.arm}" case ${id} fingerprint ${observed} does not match the case source on disk (${String(selection.caseFingerprints[id])})`,
        });
      }
    }
  }

  // (7) The two arms must be TWO builds, not one build recorded twice.
  if (baseline !== null && candidate !== null) {
    if (baseline.sourceSha === candidate.sourceSha) {
      issues.push({
        code: "ARMS_NOT_DISTINCT",
        detail: `both arms observed sourceSha ${baseline.sourceSha} — a same-build switch must never be recorded as two historical checkouts`,
      });
    }
    if (baseline.planDigest === candidate.planDigest) {
      issues.push({
        code: "ARMS_NOT_DISTINCT",
        detail: "both arms produced the SAME execution-plan digest — one arm's plan is standing in for the other's",
      });
    }
    // The frozen selection's `armRule` requires "the same case order" in both
    // arms. The CLI sorts alphabetically, so this is an ORDER check between the
    // arms rather than against the selection file's array order.
    if (baseline.caseIds.length === candidate.caseIds.length) {
      const differs = baseline.caseIds.some((id, i) => id !== candidate.caseIds[i]);
      if (differs) {
        issues.push({
          code: "ARM_ORDER_MISMATCH",
          detail: "the two arms planned the frozen cases in DIFFERENT orders — the frozen selection requires the same order in both arms",
        });
      }
    }
  }

  // (8) Caps must be genuinely enforceable, using the SAME contract the R95 gate
  //     applies. A plan carrying an unenforceable cap is NOT_READY, not DRAFT.
  const declarationIssues = r92CapDeclarationIssues(input.caps, input.authorizationForCaps);
  for (const i of declarationIssues) issues.push({ code: "CAP_DECLARATION_INVALID", detail: i });
  for (const i of r92CapViolations(input.caps)) issues.push({ code: "CAP_NOT_ENFORCEABLE", detail: i });

  return issues;
}

export interface R97PlanBuildOptions {
  repoRoot: string;
  /** The two arms' REAL observations. `null` = not observed (a draft). */
  baseline: R97ArmObservation | null;
  candidate: R97ArmObservation | null;
  providerId: string;
  modelId: string;
  endpointIdentity: string | null;
  outputDir: string;
  /** Authorization lifetime in days from `createdAt`. */
  validityDays?: number;
  /** The trusted clock reading. Never copied from the plan. */
  now: string;
  /** Pinned `createdAt`, so the digest is reproducible for a fixed clock. */
  createdAt: string;
  campaignModelCalls: number;
  perCaseToolCalls?: number;
  perCaseDurationMs?: number;
}

export interface R97PlanResult {
  status: R97PlanStatus;
  schemaVersion: string;
  /** `null` for a draft: a draft has no authorization envelope to approve. */
  authorization: R92AuthorizationV1 | null;
  planDigest: string | null;
  /** Facts the executor's gate compares against, derived from OBSERVATIONS. */
  gateFacts: R92GateFacts;
  readinessIssues: R97ReadinessIssue[];
  /** True ONLY for a FINALIZED plan with zero readiness issues. */
  authorizable: boolean;
  approvalMarkdown: string;
  realScores: false;
  passRateClaim: false;
  /** The driver that would execute this plan. Bound so the plan names its code. */
  driverVersion: string;
}

/**
 * Build the plan. The status is DERIVED, never passed in:
 *
 *   - any readiness issue                -> NOT_READY
 *   - no arm observed at all             -> DRAFT
 *   - every observation complete         -> FINALIZED_AUTHORIZATION_PLAN
 *
 * `gateFacts` is built from the OBSERVATIONS. Plan §R97 line 212 forbids
 * deriving it from the authorization, so the previous implementation's
 * `authorization.arms.baseline.sha` reads are gone: an unobserved arm yields
 * `null` here, which the gate reports as ARM_BUILD_DRIFT rather than as a match.
 */
export async function buildR97AuthorizationPlan(opts: R97PlanBuildOptions): Promise<R97PlanResult> {
  const selection = await loadR97FrozenSelection(opts.repoRoot);
  const caseCount = selection.caseIds.length;
  const repetitions = 1;
  const armCount = 2;

  const intent = r97CapIntent({
    caseCount,
    campaignModelCalls: opts.campaignModelCalls,
    perCaseToolCalls: opts.perCaseToolCalls ?? 100,
    perCaseDurationMs: opts.perCaseDurationMs ?? 600_000,
    repetitions,
    armCount,
  });
  const caps = classifyR92Caps(intent);

  // The envelope is assembled so the CAP CONTRACT can be evaluated against a
  // real authorization. It is NOT returned unless the plan finalizes.
  const createdAt = opts.createdAt;
  const validityDays = opts.validityDays ?? 30;
  const expiresAt = new Date(Date.parse(createdAt) + validityDays * 86_400_000).toISOString();

  // The plan binds the order the ARM actually planned in, not the selection
  // file's array order. `loadBenchmarkCases` sorts alphabetically, so the two
  // genuinely differ; binding the arm's order is what makes the authorized list
  // the list that will run. The selection digest still covers case CHOICE, and
  // the frozen selection's own `armRule` is what requires the two arms to agree
  // on the order (checked in readiness section 7).
  const plannedOrder = opts.candidate?.caseIds ?? opts.baseline?.caseIds ?? selection.caseIds;

  const baselineSha = opts.baseline?.sourceSha ?? "";
  const candidateSha = opts.candidate?.sourceSha ?? "";
  const envelope: R92AuthorizationV1 = {
    schemaVersion: R92_AUTHORIZATION_SCHEMA,
    authorizationId: "e4-r97-finalized-dev-mechanism-ab-h2",
    createdAt,
    expiresAt,
    scopeStatement:
      `The R87-frozen ${caseCount} non-holdout development-set cases (3 H2 TARGET + 5 COUNTEREXAMPLE), for mechanism verification only: ` +
      "this establishes whether the H2 progress-aware gate changes these specific traces, and is NOT population-representative. " +
      "It supports no pass-rate claim about the harness overall.",
    selectionDigest: selection.digest,
    // The ARM's planned order, which is what will actually execute.
    caseIds: [...plannedOrder],
    // The fingerprints are the ones the ARM OBSERVED, not a plan-time guess.
    caseFingerprints: { ...(opts.candidate?.caseFingerprints ?? selection.caseFingerprints) },
    arms: {
      // Each arm's digest is the arm's REAL dry-run digest. `null` is impossible
      // here because a null-observed arm never finalizes; a DRAFT carries no
      // envelope at all, so no placeholder digest can ever be approved.
      baseline: { sha: baselineSha, executionPlanDigest: opts.baseline?.planDigest ?? "", buildMode: "isolated-checkout" },
      candidate: { sha: candidateSha, executionPlanDigest: opts.candidate?.planDigest ?? "", buildMode: "isolated-checkout" },
    },
    armIdentityMode: "isolated-checkout-build",
    fixScope: "single-fix-H2",
    fixScopeStatement:
      "Single-fix scope: the candidate revision differs from the baseline by the R86 H2 fix and nothing else functional. " +
      "The candidate must NOT be described as carrying later shim fixes, and no benefit may be attributed to H2 that the " +
      "two revisions do not isolate.",
    jointAttributionNote: null,
    invocationMode: "single-invocation-over-frozen-list",
    providerId: opts.providerId,
    modelId: opts.modelId,
    endpointIdentity: opts.endpointIdentity,
    effectiveModelParams: { ...(opts.candidate?.effectiveModelParams ?? {}) },
    repetitions,
    serialism: 1,
    caps,
    unknownCostItems: [
      "USD total: no per-token price is bound anywhere the runner can read, so the dollar cost of this campaign is UNPROVABLE in advance. The --max-estimated-cost-usd preflight constant bounds a planning estimate only.",
      "Token total: the preflight token check multiplies a fixed planning constant, so ACTUAL token consumption is not bounded by it. No runtime token cap exists in RunLimits.",
      "Physical HTTP attempts: the campaign budget bounds LOGICAL generate calls. A transport retry is a separate request that the logical cap does not count, so the physical request count is recorded separately and is not fully bounded in advance.",
      "Provider-side rate limits and any provider-enforced spend cap are outside the harness's control and are not claimed here.",
    ],
    outputDir: opts.outputDir,
    promotionEligible: false,
  };

  const readinessIssues = r97ReadinessIssues({
    selection,
    baseline: opts.baseline,
    candidate: opts.candidate,
    caps,
    authorizationForCaps: envelope,
    expectedProviderId: opts.providerId,
    expectedModelId: opts.modelId,
    expectedEndpointIdentity: opts.endpointIdentity,
  });

  // ---- Gate facts, built from OBSERVATIONS (never from the envelope) -------
  const gateFacts: R92GateFacts = {
    // The executor's clock, supplied by the caller. Never read from the plan.
    now: opts.now,
    executingSourceSha: candidateSha,
    observedArmBuilds: {
      baseline: { sha: opts.baseline?.sourceSha ?? null, executionPlanDigest: opts.baseline?.planDigest ?? null },
      candidate: { sha: opts.candidate?.sourceSha ?? null, executionPlanDigest: opts.candidate?.planDigest ?? null },
    },
    observedCaseFingerprints: { ...(opts.candidate?.caseFingerprints ?? {}) },
    observedProviderId: opts.candidate?.providerId ?? "",
    observedModelId: opts.candidate?.modelId ?? "",
    observedEndpointIdentity: opts.candidate?.endpointIdentity ?? null,
  };

  const bothObserved = opts.baseline !== null && opts.candidate !== null;
  const anyObserved = opts.baseline !== null || opts.candidate !== null;

  // Status is DERIVED, and the DRAFT/NOT_READY split is meaningful rather than
  // cosmetic:
  //
  //   DRAFT      — NOTHING has been observed yet, so there is no build to judge.
  //                This is a plan-in-progress: it names what must still be done.
  //   NOT_READY  — something WAS observed and it fails a readiness check, or the
  //                envelope is not executable as written. A human cannot fix this
  //                by approving it.
  //   FINALIZED  — both arms observed, every check passed, envelope valid.
  //
  // Plan §R97 line 213 groups the first two ("NOT_READY/DRAFT"); separating them
  // keeps the report honest about WHICH situation the reader is in.
  const envelopeIssues: R97ReadinessIssue[] = r92AuthorizationIssuesV1(envelope).map((detail) => ({
    code: "PLAN_INVALID",
    detail,
  }));
  const allIssues = [...readinessIssues, ...envelopeIssues];

  const status: R97PlanStatus = !anyObserved
    ? "DRAFT"
    : bothObserved && allIssues.length === 0
      ? "FINALIZED_AUTHORIZATION_PLAN"
      : "NOT_READY";
  const authorizable = status === "FINALIZED_AUTHORIZATION_PLAN";
  const planDigest = authorizable ? computeR92AuthorizationDigestV1(envelope) : null;

  return {
    status,
    schemaVersion: authorizable ? R97_PLAN_SCHEMA : R97_DRAFT_SCHEMA,
    authorization: authorizable ? envelope : null,
    planDigest,
    gateFacts,
    readinessIssues: allIssues,
    authorizable,
    approvalMarkdown: renderR97Markdown({
      status,
      envelope,
      planDigest,
      gateFacts,
      readinessIssues: allIssues,
      selection,
      intent,
      driverVersion: R97_DRIVER_VERSION,
    }),
    realScores: false,
    passRateClaim: false,
    driverVersion: R97_DRIVER_VERSION,
  };
}

function renderR97Markdown(input: {
  status: R97PlanStatus;
  envelope: R92AuthorizationV1;
  planDigest: string | null;
  gateFacts: R92GateFacts;
  readinessIssues: R97ReadinessIssue[];
  selection: R97FrozenSelection;
  intent: R92CapIntent;
  driverVersion: string;
}): string {
  const { status, envelope: a, planDigest, gateFacts, readinessIssues, selection, intent } = input;
  const L: string[] = [];
  L.push("# E4-R97 — finalized authorization plan for the real small A/B");
  L.push("");
  L.push(`**Status: ${status}**`);
  L.push("");
  if (status === "FINALIZED_AUTHORIZATION_PLAN") {
    L.push("This plan is **FINALIZED_AUTHORIZATION_PLAN — READY_FOR_AUTHORIZATION / NOT_RUN.** Nothing has been");
    L.push("executed. The run starts only after you approve the digest below, and the executor re-derives every bound");
    L.push("value before the first request.");
  } else if (status === "DRAFT") {
    L.push("This is a **DRAFT**. It carries no authorization envelope and **cannot be approved**: at least one arm has");
    L.push("not been observed by a real CLI dry-run, so no execution-plan digest exists to bind. Run the two-arm");
    L.push("observation to finalize it.");
  } else {
    L.push("This plan is **NOT_READY**. It cannot be approved as written, and no human decision can make it so. The");
    L.push("reasons are listed below; a plan that fails readiness is refused before any provider is constructed.");
  }
  L.push("");
  L.push("## What is being authorized");
  L.push("");
  L.push(`- Plan digest (approve THIS exact value): \`${planDigest ?? "<none — not finalizable>"}\``);
  L.push(`- Created: \`${a.createdAt}\`  ·  **Expires: \`${a.expiresAt}\`**`);
  L.push(`- Driver that would execute it: \`${input.driverVersion}\``);
  L.push(`- Output location: \`${a.outputDir}\``);
  L.push(`- Promotion-eligible: \`${String(a.promotionEligible)}\` (a dev-set mechanism run is not a promotion run)`);
  L.push("");
  L.push("## Readiness");
  L.push("");
  if (readinessIssues.length === 0) {
    L.push("Every readiness check passed: both arms were observed by a real CLI `--dry-run` in their own clean");
    L.push("checkout, and every bound value is an OBSERVED value.");
  } else {
    L.push("| Code | Detail |");
    L.push("| --- | --- |");
    for (const i of readinessIssues) L.push(`| ${i.code} | ${i.detail} |`);
  }
  L.push("");
  L.push("## The two arms — observed, not declared");
  L.push("");
  L.push("| Arm | Observed sourceSha | Real CLI dry-run plan digest |");
  L.push("| --- | --- | --- |");
  for (const key of ["baseline", "candidate"] as const) {
    const b = gateFacts.observedArmBuilds[key];
    L.push(`| ${key} | \`${b.sha ?? "<NOT OBSERVED>"}\` | \`${b.executionPlanDigest ?? "<NOT OBSERVED>"}\` |`);
  }
  L.push("");
  L.push("Both digests above come from running the real CLI `--dry-run` inside each arm's own checkout. They are NOT");
  L.push("plan-time substitutes: a plan-time digest cannot prove the build it describes.");
  L.push("");
  L.push("## Frozen case list (content frozen before any result)");
  L.push("");
  L.push(`Selection digest: \`${selection.digest}\` (covers case CHOICE only).`);
  L.push("");
  L.push("The list below is in the order the ARM planned, which is the order that will execute. `loadBenchmarkCases`");
  L.push("sorts alphabetically, so this order is the CLI's, not the selection file's array order; the selection's own");
  L.push("`armRule` requires only that BOTH arms use the same order, which readiness checks separately.");
  L.push("");
  L.push("| # | Case | Fingerprint observed by the arm |");
  L.push("| --- | --- | --- |");
  a.caseIds.forEach((id, i) => {
    const fp = gateFacts.observedCaseFingerprints[id];
    L.push(`| ${i + 1} | \`${id}\` | \`${fp === undefined ? "<NOT OBSERVED>" : `${fp.slice(0, 16)}…`}\` |`);
  });
  L.push("");
  L.push("## Provider / model / endpoint identity");
  L.push("");
  L.push(`- provider: \`${a.providerId}\`  ·  model: \`${a.modelId}\``);
  L.push(`- endpoint identity (normalized digest, never a raw URL): \`${String(a.endpointIdentity)}\``);
  L.push("");
  L.push("## Caps — what is enforceable vs what is only claimed");
  L.push("");
  L.push("| Cap | Scope | Value | Enforcement | Blocked |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const c of a.caps) {
    L.push(`| ${c.cap} | ${c.scope} | ${c.value === null ? "— (undeclared)" : String(c.value)} | ${c.enforcement} | ${c.blocked ? "**BLOCKED**" : "no"} |`);
  }
  L.push("");
  L.push(`- Global model-call budget: **${String(intent.campaignModelCalls)}** LOGICAL calls, held in a cross-process`);
  L.push("  ledger (`e4-r97-budget-ledger-v1`) that is reserved BEFORE each call and shared by both arms. A restart");
  L.push("  does NOT refresh the allowance, and an attempt whose outcome is unknown keeps its reservation.");
  L.push(`- Physical transport retries are recorded SEPARATELY from logical calls and are not bounded by the above.`);
  L.push(`- Time: per-case \`maxDurationMs = ${intent.perCaseDurationMs}\`. Tool calls: per-case \`maxToolCalls = ${intent.perCaseToolCalls}\`.`);
  L.push(`- Serialism: **1** (no concurrency). Repetitions: **${a.repetitions}**.`);
  L.push("");
  L.push("### Cost items that are UNKNOWN and therefore not capped");
  L.push("");
  for (const item of a.unknownCostItems) L.push(`- ${item}`);
  L.push("");
  L.push("## What this run will NOT do");
  L.push("");
  L.push("- It will not produce a pass-rate claim, and no pass-rate improvement is recorded while unauthorized.");
  L.push("- It will not re-run the 86 paid cases.");
  L.push("- It will not consume holdout cases again, even if this small A/B succeeds.");
  L.push("- CI all-green, synthetic mechanism improvement and real task pass-rate improvement are three different claims.");
  L.push("");
  L.push("## Fix scope");
  L.push("");
  L.push(a.fixScopeStatement);
  return L.join("\n");
}
