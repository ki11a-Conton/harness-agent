/**
 * E4-R92 — the real small A/B authorization envelope (plan §R92).
 *
 * Plan §R92 asks for an AUDITABLE, AUTHORIZATION-READY plan for a real small
 * A/B, prepared entirely offline: the deliverable is a specific plan a human
 * can approve, not a run. This module is the part of that deliverable a
 * machine can check, so that "ready for authorization" is a computed property
 * rather than a paragraph of prose.
 *
 * Three separations are enforced structurally, because collapsing them is the
 * failure mode the plan names:
 *
 *  1. **Plan vs run.** `r92AuthorizationGate` returns `planStatus` and
 *     `runStatus` as two independent fields. A gate can return
 *     `READY_FOR_AUTHORIZATION` while `runStatus` stays `NOT_RUN` forever;
 *     there is no code path in this module that executes anything.
 *
 *  2. **Enforceable vs claimed caps.** `classifyR92Caps` labels every cap with
 *     the layer that ACTUALLY enforces it. A cap the runner cannot enforce is
 *     reported `blocked: true` and makes the gate refuse
 *     (`CAP_NOT_ENFORCEABLE`) — the plan forbids substituting prose for a
 *     hard limit ("不能通过文字宣称已限制").
 *
 *  3. **Selection digest vs authorization digest.** The R87 selection digest
 *     covers case choice only. The authorization digest here additionally binds
 *     the two build SHAs, the arm-identity mode, the invocation mode, the case
 *     CONTENT fingerprints, provider/model/endpoint identity, the nested
 *     execution-plan digest, config, caps, repetitions, serialism, expiry and
 *     the output location — which is why the selection digest alone is
 *     explicitly insufficient as a paid-authorization digest (plan §R92 怎么做).
 *
 * The enforcement classification is MEASURED from this repository, not
 * asserted. Each `evidence` string names the call site that justifies the
 * label:
 *   - `maxModelCalls` — `createBudgetedProvider` throws BEFORE the call and the
 *     executor breaks the loop (`packages/evaluation/src/paired-executor.ts`),
 *     and the CLI forwards it (`benchmark-command.ts` `maxModelCalls:
 *     opts.maxModelCalls ?? 0`). Runtime-enforced ONLY when one invocation owns
 *     the whole campaign: `scripts/benchmark/run-campaign.ps1` passes a
 *     PER-CASE `--max-model-calls 60` and keeps no campaign-wide counter, so
 *     with per-case invocations no single process can enforce a global cap.
 *   - `maxEstimatedTokens` / `maxEstimatedCostUsd` — checked in preflight
 *     against a fixed planning constant (`PREFLIGHT_ESTIMATE`), BEFORE any
 *     call; nothing re-checks them once execution starts. `maxEstimatedCostUsd`
 *     is additionally non-hard at the agent-run layer (`isHardLimit` returns
 *     false for it), so it cannot even terminate a single run.
 *   - `maxToolCalls` / `maxDurationMs` — `RunBudgetTracker.onToolCall` /
 *     `onDurationCheck` are consulted during the run and terminate it.
 */

import { computeRuntimeConfigHash, stableStringify } from "./manifest.js";

export const R92_AUTHORIZATION_SCHEMA = "e4-r92-authorization-v1";

/** Plan §R92: 6–10 non-holdout development-set cases. */
export const R92_MIN_CASES = 6;
export const R92_MAX_CASES = 10;

/** How the two arms are realised. These two are NEVER mixed in one experiment
 *  (plan §R92 做什么 #2): an isolated-checkout-build experiment really builds
 *  both revisions, a controlled-switch experiment runs ONE build and flips a
 *  runtime knob. Recording the latter as the former is a falsified provenance
 *  claim, so the gate refuses that combination explicitly. */
export type R92ArmIdentityMode = "isolated-checkout-build" | "same-version-controlled-switch";

/** How the campaign is driven. Decisive for whether a campaign-wide cap can be
 *  enforced by a single process (see the module header). */
export type R92InvocationMode = "single-invocation-over-frozen-list" | "per-case-invocation";

/** Which layer actually enforces a cap. */
export type R92Enforcement =
  /** The call/execution layer itself refuses or terminates. */
  | "runtime-enforced"
  /** Checked once, before the first call, against a planning estimate. */
  | "preflight-only"
  /** Cannot be proven from anything the runner can read (e.g. USD price). */
  | "unprovable";

export type R92CapName =
  | "maxModelCalls"
  | "maxLogicalRuns"
  | "maxEstimatedTokens"
  | "maxEstimatedCostUsd"
  | "maxToolCalls"
  | "maxDurationMs";

export type R92CapScope = "campaign-wide" | "per-case" | "per-arm";

export interface R92CapDeclaration {
  cap: R92CapName;
  scope: R92CapScope;
  /** `null` = the plan declares no value for this cap. */
  value: number | null;
  enforcement: R92Enforcement;
  /** True when the plan must NOT proceed until this is resolved. */
  blocked: boolean;
  /** The measured call site justifying `enforcement` — never a restatement. */
  evidence: string;
}

/** The caps the plan INTENDS, before classification. */
export interface R92CapIntent {
  /** Global model-call budget for the whole campaign. `null` = undeclared. */
  campaignModelCalls: number | null;
  perCaseToolCalls: number;
  perCaseDurationMs: number;
  maxLogicalRuns: number | null;
  maxEstimatedTokens: number | null;
  maxEstimatedCostUsd: number | null;
  caseCount: number;
  repetitions: number;
  armCount: number;
  invocationMode: R92InvocationMode;
}

/** How one arm was realised. Binding this PER ARM is what makes "two isolated
 *  checkouts" checkable: the two experiment kinds are never mixed, and neither
 *  may be recorded as the other. */
export type R92ArmBuildMode = "isolated-checkout" | "same-version-switch";

export interface R92ArmIdentity {
  /** 40-hex commit. Both arms share one value in a same-version switch. */
  sha: string;
  /**
   * The arm's OWN execution-plan digest. Two isolated checkouts necessarily
   * differ here, because the plan binds `sourceSha` and `treeFingerprint`; a
   * single shared digest would silently hide one arm's build identity.
   */
  executionPlanDigest: string;
  buildMode: R92ArmBuildMode;
}

export type R92FixScope = "single-fix-H2" | "joint-multi-fix";

export interface R92AuthorizationV1 {
  schemaVersion: typeof R92_AUTHORIZATION_SCHEMA;
  authorizationId: string;
  createdAt: string;
  expiresAt: string;
  /** Must deny population representativeness (plan §R92 做什么 #1). */
  scopeStatement: string;
  /** The R87 selection digest — case choice only; NOT sufficient to authorize. */
  selectionDigest: string;
  caseIds: string[];
  caseFingerprints: Record<string, string>;
  arms: { baseline: R92ArmIdentity; candidate: R92ArmIdentity };
  armIdentityMode: R92ArmIdentityMode;
  /** Plan §R92 怎么做: H2 alone vs several fixes together, stated separately. */
  fixScope: R92FixScope;
  fixScopeStatement: string;
  /** Required when `fixScope` is joint, so a gain is never wholly credited to H2. */
  jointAttributionNote: string | null;
  invocationMode: R92InvocationMode;
  providerId: string;
  modelId: string;
  /** Normalized digest, never a raw URL (may carry tokens). */
  endpointIdentity: string | null;
  effectiveModelParams: Readonly<Record<string, unknown>>;
  repetitions: number;
  serialism: number;
  caps: R92CapDeclaration[];
  unknownCostItems: string[];
  outputDir: string;
  promotionEligible: false;
}

const hex64 = (v: unknown): boolean => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const hex40 = (v: unknown): boolean => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;

/**
 * Label every cap with the layer that actually enforces it, and decide whether
 * the plan may proceed.
 *
 * The BLOCKED rule follows plan §R92 literally: "如果调用层不能执行所声明的硬上限，
 * 先把该项标 BLOCKED" — when a hard cap is DECLARED but the call layer cannot
 * execute it, the item is BLOCKED. Declaring nothing is not a blocked claim; it
 * is a documented unknown (and must appear in `unknownCostItems`).
 *
 * The distinction that decides `blocked` is whether the preflight check bounds
 * ACTUAL consumption or only an ESTIMATE of it:
 *   - `maxLogicalRuns` — `cases × repeat × arms` is exact, so the preflight
 *     rejection genuinely bounds what can run. Honest label: preflight-only,
 *     NOT blocked.
 *   - `maxEstimatedTokens` / `maxEstimatedCostUsd` — compared against
 *     `PREFLIGHT_ESTIMATE` planning constants, so actual use can exceed them
 *     freely. A DECLARED cap here is a claim the layer cannot honour → BLOCKED.
 *   - `maxModelCalls` — the only cost cap with a real runtime enforcer
 *     (`paired-executor` budget), so it is enforceable when ONE invocation owns
 *     the campaign. It is also the global budget a paid plan must declare, so a
 *     missing value is BLOCKED.
 */
export function classifyR92Caps(intent: R92CapIntent): R92CapDeclaration[] {
  const singleInvocation = intent.invocationMode === "single-invocation-over-frozen-list";
  const plannedRuns = intent.caseCount * intent.repetitions * intent.armCount;

  const campaignCallsEnforced = intent.campaignModelCalls !== null && singleInvocation;
  const campaignCalls: R92CapDeclaration = {
    cap: "maxModelCalls",
    scope: "campaign-wide",
    value: intent.campaignModelCalls,
    enforcement: campaignCallsEnforced ? "runtime-enforced" : "preflight-only",
    blocked: !campaignCallsEnforced,
    evidence: singleInvocation
      ? "paired-executor.ts createBudgetedProvider throws before the call, sets hitCap and breaks the arm loop; benchmark-command.ts forwards maxModelCalls into runPairedExperiment, so one invocation enforces the whole campaign's budget"
      : "run-campaign.ps1 passes a PER-CASE --max-model-calls and keeps no campaign-wide counter, so no single process can enforce a global model-call cap across per-case invocations",
  };

  return [
    campaignCalls,
    {
      cap: "maxLogicalRuns",
      scope: "campaign-wide",
      value: intent.maxLogicalRuns,
      enforcement: "preflight-only",
      blocked: false,
      evidence: `benchmark-command.ts compares the exact planned ${plannedRuns} logical runs (cases x repeat x arms) against --max-logical-runs before any provider call; because the count is exact and precedes all spend, the bound holds even though nothing re-checks it later`,
    },
    {
      cap: "maxEstimatedTokens",
      scope: "campaign-wide",
      value: intent.maxEstimatedTokens,
      // Declared-but-unenforceable is the blocked case; an undeclared cap is an
      // honest unknown that must be listed in unknownCostItems instead.
      enforcement: "preflight-only",
      blocked: intent.maxEstimatedTokens !== null,
      evidence: "benchmark-command.ts multiplies PREFLIGHT_ESTIMATE.tokensPerCall by the planned call count and compares once, preflight; ACTUAL token use is never compared to it, so a declared token hard cap is not executable",
    },
    {
      cap: "maxEstimatedCostUsd",
      scope: "campaign-wide",
      value: intent.maxEstimatedCostUsd,
      enforcement: "unprovable",
      blocked: intent.maxEstimatedCostUsd !== null,
      evidence: "benchmark-command.ts checks a PREFLIGHT_ESTIMATE cost constant before the first call; run-budget.ts isHardLimit returns false for maxEstimatedCostUsd, so it cannot terminate a run, and no per-token price is bound anywhere the runner can read",
    },
    {
      cap: "maxToolCalls",
      scope: "per-case",
      value: intent.perCaseToolCalls,
      enforcement: "runtime-enforced",
      blocked: false,
      evidence: "benchmark-command.ts sets per-case limits.maxToolCalls=100 and run-budget.ts RunBudgetTracker.onToolCall is consulted during the run and terminates it",
    },
    {
      cap: "maxDurationMs",
      scope: "per-case",
      value: intent.perCaseDurationMs,
      enforcement: "runtime-enforced",
      blocked: false,
      evidence: "benchmark-command.ts sets per-case limits.maxDurationMs (case maxDurationMs ?? 600000) and runtime.ts consults budget.onDurationCheck(), terminating with RESOURCE_LIMIT",
    },
  ];
}

/** A cap is a violation when it is blocked, or when it claims an enforcement
 *  layer that the measured call sites do not support. */
export function r92CapViolations(caps: readonly R92CapDeclaration[]): string[] {
  const issues: string[] = [];
  const byCap = new Map(caps.map((c) => [c.cap, c]));

  for (const c of caps) {
    if (c.blocked) {
      issues.push(
        `${c.cap} (${c.scope}) is BLOCKED: the declared cap cannot be enforced as stated — ${c.evidence}`,
      );
    }
    if (c.cap === "maxEstimatedCostUsd" && c.enforcement === "runtime-enforced") {
      issues.push(
        "maxEstimatedCostUsd claims runtime enforcement but the measured layer is preflight-only and non-hard (run-budget.ts isHardLimit)",
      );
    }
    if (c.cap === "maxEstimatedTokens" && c.enforcement === "runtime-enforced") {
      issues.push("maxEstimatedTokens claims runtime enforcement but the measured layer is preflight-only");
    }
    if (c.cap === "maxLogicalRuns" && c.enforcement === "runtime-enforced") {
      issues.push("maxLogicalRuns claims runtime enforcement but the measured layer is preflight-only");
    }
  }

  const globalCalls = byCap.get("maxModelCalls");
  if (globalCalls === undefined || globalCalls.value === null) {
    issues.push(
      "no campaign-wide maxModelCalls (global budget) is declared — a paid plan without a global model-call budget is not authorizable",
    );
  } else if (globalCalls.enforcement !== "runtime-enforced") {
    issues.push(
      `campaign-wide maxModelCalls is ${globalCalls.enforcement}, not runtime-enforced — the global budget would rest on an unenforced claim`,
    );
  }
  return issues;
}

/**
 * Static validation of the envelope itself: shape, scope honesty, arm
 * distinctness, fingerprint coverage and expiry ordering. Runtime facts (drift,
 * expiry vs "now") are checked by the gate, not here.
 */
export function r92AuthorizationIssuesV1(auth: R92AuthorizationV1): string[] {
  const issues: string[] = [];

  if (auth.schemaVersion !== R92_AUTHORIZATION_SCHEMA) {
    issues.push(`schemaVersion must be ${R92_AUTHORIZATION_SCHEMA} (got ${String(auth.schemaVersion)})`);
  }
  if (!nonEmpty(auth.authorizationId)) issues.push("authorizationId must be a non-empty id");
  if (!nonEmpty(auth.createdAt)) issues.push("createdAt must be a timestamp");
  if (!nonEmpty(auth.expiresAt)) issues.push("expiresAt must be a timestamp");
  const created = Date.parse(auth.createdAt);
  const expires = Date.parse(auth.expiresAt);
  if (Number.isFinite(created) && Number.isFinite(expires) && expires <= created) {
    issues.push("expiresAt must be strictly after createdAt (an already-expired authorization is not an authorization)");
  }

  // Scope honesty: a dev-set mechanism run must not be presented as a
  // population-level result. The denial is checked FIRST: an honest statement
  // that explicitly disclaims a pass-rate claim ("never a pass-rate claim")
  // must not be misread as making one.
  const scope = auth.scopeStatement.toLowerCase();
  if (!nonEmpty(auth.scopeStatement)) {
    issues.push("scopeStatement is required");
  } else {
    const denies = /not population-representative|mechanism verification only|dev(elopment)?[- ]set only/.test(scope);
    // Affirmative over-claims only: each pattern requires a positive verb or a
    // claimed improvement, so a disclaimer cannot trip it.
    const claimsPopulation =
      /\bproves?\b/.test(scope) ||
      /represents? the (overall|population)/.test(scope) ||
      /pass[- ]rate (improvement|gain|increase)/.test(scope);
    if (!denies || claimsPopulation) {
      issues.push(
        "scopeStatement must state the dev-set mechanism-verification scope and deny population representativeness (no pass-rate claim)",
      );
    }
  }

  if (!hex64(auth.selectionDigest)) issues.push("selectionDigest must be 64-hex (the R87 selection digest)");

  if (!Array.isArray(auth.caseIds) || auth.caseIds.length === 0) {
    issues.push("caseIds must be a non-empty list");
  } else if (auth.caseIds.length < R92_MIN_CASES || auth.caseIds.length > R92_MAX_CASES) {
    issues.push(
      `caseIds must contain ${R92_MIN_CASES}-${R92_MAX_CASES} non-holdout development-set cases (got ${auth.caseIds.length})`,
    );
  }
  if (new Set(auth.caseIds).size !== auth.caseIds.length) issues.push("caseIds must be unique");
  for (const id of auth.caseIds) {
    if (/^holdout\//.test(id)) issues.push(`case ${id} is a holdout case — plan §R92 requires non-holdout cases only`);
    if (!hex64(auth.caseFingerprints?.[id])) {
      issues.push(`caseFingerprints must carry a 64-hex input fingerprint for ${id}`);
    }
  }

  if (auth.armIdentityMode !== "isolated-checkout-build" && auth.armIdentityMode !== "same-version-controlled-switch") {
    issues.push("armIdentityMode must be isolated-checkout-build or same-version-controlled-switch");
  }
  if (auth.invocationMode !== "single-invocation-over-frozen-list" && auth.invocationMode !== "per-case-invocation") {
    issues.push("invocationMode must be single-invocation-over-frozen-list or per-case-invocation");
  }

  // ---- Per-arm build identity -------------------------------------------
  const arms = auth.arms;
  if (arms === undefined || arms === null) {
    issues.push("arms must bind both the baseline and candidate build identities");
  } else {
    const expectedMode: R92ArmBuildMode =
      auth.armIdentityMode === "isolated-checkout-build" ? "isolated-checkout" : "same-version-switch";
    for (const key of ["baseline", "candidate"] as const) {
      const a = arms[key];
      if (a === undefined || a === null) {
        issues.push(`arms.${key} is required`);
        continue;
      }
      if (!hex40(a.sha)) issues.push(`arms.${key}.sha must be a 40-hex commit SHA`);
      if (!hex64(a.executionPlanDigest)) {
        issues.push(`arms.${key}.executionPlanDigest must be 64-hex (the arm's own execution-plan digest)`);
      }
      if (a.buildMode !== expectedMode) {
        issues.push(
          `arms.${key}.buildMode is "${String(a.buildMode)}" but armIdentityMode "${String(auth.armIdentityMode)}" requires "${expectedMode}" — the two experiment kinds must not be mixed`,
        );
      }
    }
    // Distinctness is mode-dependent: an isolated-checkout-build experiment MUST
    // build two different revisions, whereas a same-version controlled switch
    // runs ONE revision and flips a runtime knob — requiring distinct SHAs there
    // would force a false provenance claim.
    if (
      auth.armIdentityMode === "isolated-checkout-build" &&
      hex40(arms.baseline?.sha) &&
      arms.baseline.sha === arms.candidate?.sha
    ) {
      issues.push(
        "arms.baseline.sha and arms.candidate.sha must be distinct commits for an isolated-checkout-build experiment",
      );
    }
  }

  if (!nonEmpty(auth.fixScopeStatement)) {
    issues.push("fixScopeStatement is required so the fix scope is stated explicitly, never assumed");
  }
  if (auth.fixScope === "joint-multi-fix" && !nonEmpty(auth.jointAttributionNote)) {
    issues.push(
      "jointAttributionNote is required for a joint-multi-fix experiment: a joint delta must not be wholly attributed to H2",
    );
  }

  if (!nonEmpty(auth.providerId)) issues.push("providerId is required");
  if (!nonEmpty(auth.modelId)) issues.push("modelId is required");
  if (!hex64(auth.endpointIdentity)) {
    issues.push(
      "endpointIdentity must be a 64-hex normalized digest (a raw URL or null is not an authorization surface)",
    );
  }

  if (auth.repetitions !== 1) issues.push(`repetitions must be 1 for this experiment (got ${String(auth.repetitions)})`);
  if (auth.serialism !== 1) issues.push(`serialism must be 1 (serial execution) (got ${String(auth.serialism)})`);

  if (auth.promotionEligible !== false) {
    issues.push("promotionEligible must be false — a dev-set mechanism A/B is not a promotion-eligible run");
  }

  if (!nonEmpty(auth.outputDir)) issues.push("outputDir is required (the plan must name where results would land)");

  if (!Array.isArray(auth.caps) || auth.caps.length === 0) {
    issues.push("caps must declare the call/token/time budget surface");
  }

  if (!Array.isArray(auth.unknownCostItems) || auth.unknownCostItems.length === 0) {
    issues.push("unknownCostItems must name the cost terms the runner cannot bound (empty implies a provable USD cap)");
  }

  return issues;
}

/** The canonical digest of the envelope. Key-ordered and value-stable via the
 *  shared serializer, so the digest the user approves is reproducible. */
export function computeR92AuthorizationDigestV1(auth: R92AuthorizationV1): string {
  return computeRuntimeConfigHash(auth);
}

/** One arm's observed build identity at execution time. `null` fields mean the
 *  arm was not observed at all — which is drift, never a skip. */
export interface R92ObservedArmBuild {
  sha: string | null;
  executionPlanDigest: string | null;
}

/** Facts observed at execution time, compared field-by-field against the
 *  envelope BEFORE any provider is created. */
export interface R92GateFacts {
  now: string;
  executingSourceSha: string;
  observedArmBuilds: { baseline: R92ObservedArmBuild; candidate: R92ObservedArmBuild };
  observedCaseFingerprints: Record<string, string>;
  observedProviderId: string;
  observedModelId: string;
  observedEndpointIdentity: string | null;
}

export type R92GateCode =
  | "PAID_AUTHORIZATION_REQUIRED"
  | "AUTHORIZATION_EXPIRED"
  | "AUTHORIZATION_DIGEST_MISMATCH"
  | "IDENTITY_DRIFT"
  | "CASE_CONTENT_DRIFT"
  | "ARM_IDENTITY_MIXED"
  | "ARM_BUILD_DRIFT"
  | "CAP_NOT_ENFORCEABLE"
  | "BUDGET_INCOMPLETE"
  | "PLAN_INVALID";

export interface R92GateResult {
  /** True ONLY when every precondition holds. Never implies a run happened. */
  authorizedToExecute: boolean;
  /** Whether a human could approve this plan as written. */
  planStatus: "READY_FOR_AUTHORIZATION" | "NOT_READY";
  /** Always NOT_RUN: this module executes nothing. */
  runStatus: "NOT_RUN";
  code?: R92GateCode;
  reason: string;
  issues: string[];
}

export interface R92GateInput {
  env: Record<string, string | undefined>;
  authorization: R92AuthorizationV1 | null;
  facts: R92GateFacts;
}

/**
 * The pre-provider gate. Returns a refusal reason instead of throwing so a
 * caller can report it, and NEVER performs a provider call — the whole point is
 * that an unauthorized/expired/mismatched plan is refused before the first
 * request, at zero cost.
 *
 * Order matters: the cheapest and most fundamental refusals come first, so the
 * reported code names the PRIMARY obstacle rather than a downstream symptom.
 */
export function r92AuthorizationGate(input: R92GateInput): R92GateResult {
  const { env, authorization, facts } = input;
  const notRun = { runStatus: "NOT_RUN" as const };

  if (authorization === null) {
    return {
      authorizedToExecute: false,
      planStatus: "NOT_READY",
      ...notRun,
      code: "PAID_AUTHORIZATION_REQUIRED",
      reason: "no R92 authorization envelope was supplied — nothing to authorize, nothing to run",
      issues: [],
    };
  }

  const staticIssues = r92AuthorizationIssuesV1(authorization);
  if (staticIssues.length > 0) {
    return {
      authorizedToExecute: false,
      planStatus: "NOT_READY",
      ...notRun,
      code: "PLAN_INVALID",
      reason: `the authorization envelope is incomplete or self-inconsistent (${staticIssues.length} issue(s)) — a malformed plan is refused, never best-effort executed`,
      issues: staticIssues,
    };
  }

  const hasR92Auth = env.E4_R92_PAID_AUTH === "1";
  const hasSharedSwitch = env.RUN_PAID_BENCHMARKS === "1";
  const suppliedDigest = env.E4_R92_PAID_AUTH_DIGEST;
  const digest = computeR92AuthorizationDigestV1(authorization);

  if (!hasR92Auth || !hasSharedSwitch || suppliedDigest !== digest) {
    const missing: string[] = [];
    if (!hasR92Auth) missing.push("E4_R92_PAID_AUTH=1");
    if (!hasSharedSwitch) missing.push("RUN_PAID_BENCHMARKS=1");
    if (suppliedDigest !== digest) missing.push("E4_R92_PAID_AUTH_DIGEST matching this envelope");
    return {
      authorizedToExecute: false,
      planStatus: "READY_FOR_AUTHORIZATION",
      ...notRun,
      code: suppliedDigest !== undefined && suppliedDigest !== digest
        ? "AUTHORIZATION_DIGEST_MISMATCH"
        : "PAID_AUTHORIZATION_REQUIRED",
      reason: `not authorized: missing ${missing.join(", ")}. The plan below is complete and awaiting a human decision; R83/R87 authorization does not carry over.`,
      issues: [],
    };
  }

  const nowMs = Date.parse(facts.now);
  const expiresMs = Date.parse(authorization.expiresAt);
  if (Number.isFinite(nowMs) && Number.isFinite(expiresMs) && nowMs > expiresMs) {
    return {
      authorizedToExecute: false,
      planStatus: "READY_FOR_AUTHORIZATION",
      ...notRun,
      code: "AUTHORIZATION_EXPIRED",
      reason: `authorization expired at ${authorization.expiresAt} (now ${facts.now}) — a stale authorization must be re-issued, not reused`,
      issues: [],
    };
  }

  if (facts.executingSourceSha !== authorization.arms.candidate.sha) {
    return {
      authorizedToExecute: false,
      planStatus: "READY_FOR_AUTHORIZATION",
      ...notRun,
      code: "IDENTITY_DRIFT",
      reason: `sourceSha drift: executing ${facts.executingSourceSha} but the authorization binds candidate sha ${authorization.arms.candidate.sha}`,
      issues: [],
    };
  }

  const capIssues = r92CapViolations(authorization.caps);
  if (capIssues.some((i) => i.includes("maxModelCalls"))) {
    return {
      authorizedToExecute: false,
      planStatus: "READY_FOR_AUTHORIZATION",
      ...notRun,
      code: "BUDGET_INCOMPLETE",
      reason: `the global budget is not runtime-enforceable as declared: ${capIssues.join("; ")}`,
      issues: capIssues,
    };
  }
  if (capIssues.length > 0) {
    return {
      authorizedToExecute: false,
      planStatus: "READY_FOR_AUTHORIZATION",
      ...notRun,
      code: "CAP_NOT_ENFORCEABLE",
      reason: `a declared cap cannot be enforced by the layer that would have to enforce it: ${capIssues.join("; ")}`,
      issues: capIssues,
    };
  }

  for (const id of authorization.caseIds) {
    const expected = authorization.caseFingerprints[id];
    const observed = facts.observedCaseFingerprints[id];
    if (observed === undefined) {
      return {
        authorizedToExecute: false,
        planStatus: "READY_FOR_AUTHORIZATION",
        ...notRun,
        code: "CASE_CONTENT_DRIFT",
        reason: `case ${id} was not observed at execution time — an unobserved planned case is drift, not a skip`,
        issues: [],
      };
    }
    if (observed !== expected) {
      return {
        authorizedToExecute: false,
        planStatus: "READY_FOR_AUTHORIZATION",
        ...notRun,
        code: "CASE_CONTENT_DRIFT",
        reason: `case content drift for ${id}: authorized ${expected} but observed ${observed}`,
        issues: [],
      };
    }
  }

  if (facts.observedProviderId !== authorization.providerId || facts.observedModelId !== authorization.modelId) {
    return {
      authorizedToExecute: false,
      planStatus: "READY_FOR_AUTHORIZATION",
      ...notRun,
      code: "IDENTITY_DRIFT",
      reason: `provider/model drift: authorized ${authorization.providerId}/${authorization.modelId} but observed ${facts.observedProviderId}/${facts.observedModelId}`,
      issues: [],
    };
  }

  if (facts.observedEndpointIdentity !== authorization.endpointIdentity) {
    return {
      authorizedToExecute: false,
      planStatus: "READY_FOR_AUTHORIZATION",
      ...notRun,
      code: "IDENTITY_DRIFT",
      reason: `endpointIdentity drift: authorized ${String(authorization.endpointIdentity)} but observed ${String(facts.observedEndpointIdentity)}`,
      issues: [],
    };
  }

  // ---- Arm identity, per arm --------------------------------------------
  // Each arm's observed build must match the arm's OWN authorized identity.
  // Two isolated checkouts legitimately differ in both sha and plan digest;
  // what must never happen is one arm's build standing in for the other's, or
  // a same-version switch being recorded as a historical checkout.
  //
  // ORDER: (1) was each arm observed at all, (2) does the OBSERVED relationship
  // between the arms match the declared experiment kind, (3) does each arm match
  // its own authorized value. Step (2) must precede (3) to be reachable: once
  // both arms match their own authorized values the observed shas are distinct by
  // construction, so a "one build recorded as two" defect has to be diagnosed
  // from the observed relationship BEFORE the per-arm comparison masks it as a
  // generic sha drift.
  for (const key of ["baseline", "candidate"] as const) {
    const observed = facts.observedArmBuilds?.[key];
    if (observed === undefined || observed === null || observed.sha === null) {
      return {
        authorizedToExecute: false,
        planStatus: "READY_FOR_AUTHORIZATION",
        ...notRun,
        code: "ARM_BUILD_DRIFT",
        reason: `arm "${key}" build identity was not observed — an unobserved arm is drift, not a skip`,
        issues: [],
      };
    }
  }

  const observedDistinct = facts.observedArmBuilds.baseline.sha !== facts.observedArmBuilds.candidate.sha;
  if (authorization.armIdentityMode === "isolated-checkout-build" && !observedDistinct) {
    return {
      authorizedToExecute: false,
      planStatus: "READY_FOR_AUTHORIZATION",
      ...notRun,
      code: "ARM_IDENTITY_MIXED",
      reason:
        "the authorization declares isolated-checkout-build arms but both arms observed the SAME build — a same-version switch must never be recorded as a historical checkout",
      issues: [],
    };
  }
  if (authorization.armIdentityMode === "same-version-controlled-switch" && observedDistinct) {
    return {
      authorizedToExecute: false,
      planStatus: "READY_FOR_AUTHORIZATION",
      ...notRun,
      code: "ARM_IDENTITY_MIXED",
      reason:
        "the authorization declares a same-version controlled switch but the arms observed two different builds — the two experiment kinds must not be mixed",
      issues: [],
    };
  }

  for (const key of ["baseline", "candidate"] as const) {
    const authorizedArm = authorization.arms[key];
    const observed = facts.observedArmBuilds[key];
    if (observed.sha !== authorizedArm.sha) {
      return {
        authorizedToExecute: false,
        planStatus: "READY_FOR_AUTHORIZATION",
        ...notRun,
        code: "ARM_BUILD_DRIFT",
        reason: `arm "${key}" sha drift: authorized ${authorizedArm.sha} but observed ${String(observed.sha)}`,
        issues: [],
      };
    }
    if (observed.executionPlanDigest !== authorizedArm.executionPlanDigest) {
      return {
        authorizedToExecute: false,
        planStatus: "READY_FOR_AUTHORIZATION",
        ...notRun,
        code: "ARM_BUILD_DRIFT",
        reason: `arm "${key}" execution-plan digest drift: authorized ${authorizedArm.executionPlanDigest} but observed ${String(observed.executionPlanDigest)}`,
        issues: [],
      };
    }
  }

  return {
    authorizedToExecute: true,
    planStatus: "READY_FOR_AUTHORIZATION",
    ...notRun,
    reason: "authorization present, unexpired, digest-matched, and every bound identity agrees",
    issues: [],
  };
}

void stableStringify;
