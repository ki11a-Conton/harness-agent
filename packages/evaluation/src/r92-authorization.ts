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

/**
 * The CURRENT approval-material contract version.
 *
 * ---- WHY THIS MOVED TO v2 (E4-R104 / plan §A4 怎么做 8) ---------------------
 *
 * "更新 schema/版本和拒绝信息；旧材料缺新身份字段应明确拒绝重新生成，不能静默补字段后
 *  继续使用旧授权."
 *
 * `R92_ARM_FIELDS` is a CLOSED allow-list, and A4 added `buildDigest` to it. That
 * changed the SHAPE of an accepted envelope. A version label is the only thing
 * that makes "this material predates the new contract" a CHECKABLE fact: with the
 * label left at v1, an envelope written under the old shape is indistinguishable
 * from one written under the new shape, and — because the field is legitimately
 * optional at this layer (see `R92ArmIdentity.buildDigest`) — an old envelope that
 * simply omits it would reach the gate with no build comparison performed at all.
 *
 * Bumping the label does NOT silently upgrade anything: old material is REFUSED
 * and must be regenerated, which is exactly what the plan asks for. Nothing in
 * this repository is a pre-existing v1 artifact, so no issued approval is
 * invalidated by this move.
 */
export const R92_AUTHORIZATION_SCHEMA = "e4-r92-authorization-v2";

/**
 * Schema labels this contract SUPERSEDES.
 *
 * Named explicitly so the refusal can tell an operator that their material
 * predates the execution-identity contract and must be regenerated, rather than
 * reporting a generic version mismatch that reads like a typo.
 */
export const R92_AUTHORIZATION_SCHEMA_SUPERSEDED: readonly string[] = ["e4-r92-authorization-v1"];

/** Plan §R92: 6–10 non-holdout development-set cases. */
export const R92_MIN_CASES = 6;
export const R92_MAX_CASES = 10;

/**
 * The development-set suites a REAL campaign may select cases from. The rule is
 * an allow-list, not the old `^holdout/` denylist: `adversarial`, `tools`,
 * `baseline-e4-r74` and a bare case id are all refused — and so is `holdout`,
 * the generalization set, which plan §R92 excludes outright.
 */
export const R92_SUPPORTED_SUITES: readonly string[] = ["regression", "stress"];

/**
 * The synthetic suite the OFFLINE rehearsal (`r92-rehearsal.ts`) uses for its
 * in-process cases. It is accepted by the same case-id rule so the rehearsal
 * exercises the real validator rather than a relaxed copy of it, and it is kept
 * OUT of `R92_SUPPORTED_SUITES` so no real plan can select it: the real plan's
 * case list is read from the frozen R87 selection, which contains only
 * `regression/` and `stress/` cases.
 */
export const R92_REHEARSAL_SUITE = "rehearsal";

/**
 * The suites the case-id rule accepts. `R92_SUPPORTED_SUITES` is the REAL
 * campaign's set; the rehearsal suite is added because the offline rehearsal
 * must pass the SAME validator rather than a relaxed copy of it. It is exported
 * separately so a test can still assert that no real plan may select it.
 */
const R92_ALLOWED_CASE_SUITES: readonly string[] = [...R92_SUPPORTED_SUITES, R92_REHEARSAL_SUITE];

/**
 * The time contract. A contract timestamp is an ISO-8601 instant that MUST carry
 * a timezone designator: without one the instant is ambiguous, so the same
 * envelope would authorize different windows in different places. Date-only
 * strings and free-form strings `Date.parse` happens to accept are not contract
 * times.
 */
export const R92_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Days per month, so a syntactically valid but impossible date is refused. */
const R92_DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Parse a contract timestamp to epoch milliseconds, or `null` when the input is
 * not a contract timestamp. Returning `null` — never `NaN` — is the whole point:
 * the previous `Number.isFinite(Date.parse(...))` guard turned a malformed
 * timestamp into a SKIPPED comparison, so a garbage `expiresAt` read as
 * "not expired" and a garbage `createdAt` read as "already valid".
 *
 * The calendar fields are range-checked independently of `Date.parse`, because
 * `Date.parse` silently rolls impossible dates over (`2026-02-30` becomes
 * March 2), which would accept a date that does not exist.
 */
export function parseR92Timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !R92_TIMESTAMP_PATTERN.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  if (month < 1 || month > 12) return null;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const maxDay = month === 2 && leap ? 29 : R92_DAYS_IN_MONTH[month - 1]!;
  if (day < 1 || day > maxDay) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

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
  /**
   * The arm's EXECUTION BUILD digest — the sha256 of the bytes that actually run
   * a case, derived from the real static ESM import graph (E4-R104 / A4).
   *
   * ---- WHY THIS IS A SEPARATE FIELD AND NOT PART OF `executionPlanDigest` -----
   *
   * MEASURED DEFECT F4 (plan §A4): `executionPlanDigest` is derived from git —
   * the CLI binds `sourceSha` and `treeFingerprint`. `dist/` is GITIGNORED
   * (`.gitignore:2`), so a rebuilt `packages/core/dist/runtime/runtime.js` moves
   * neither the working tree's status nor, therefore, this digest. Rewriting the
   * code that executes a case left the approved identity byte-identical and the
   * old approval valid.
   *
   * The two values answer different questions and both are required by the FORMAL
   * campaign:
   *   - `executionPlanDigest` — "which revision/plan did the arm declare?"
   *   - `buildDigest`          — "which BYTES will actually execute?"
   *
   * ---- WHY IT IS OPTIONAL HERE AND REQUIRED BY R97 ---------------------------
   *
   * This is the SAME layering as `driverBuildDigest`: the R92 layer is a general
   * envelope contract, and the R92 development-mechanism plan names two HISTORICAL
   * pinned commits that are not checked out in this repository, so it has no build
   * to hash. Fabricating one there would be exactly the dishonesty this plan
   * fights. The R97 formal campaign — which really does hold both checkouts — makes
   * the field MANDATORY (`ARM_BUILD_UNBOUND`), so old material lacking it is
   * refused and must be regenerated rather than silently reused
   * (plan §A4 做什么 3: "新合同需要重新生成批准材料").
   *
   * When it IS present, the R92 gate compares it like any other bound identity.
   */
  buildDigest?: string;
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
  /**
   * The executor that would run this plan, bound so the approval covers the
   * CODE and not merely the inputs.
   *
   * Plan §R97 line 214 lists 驱动器版本 among the values a finalized plan must
   * freeze, and line 229 requires that changing any bound field invalidates the
   * old approval. Measured defect this field closes: the R97 approval package
   * printed "Driver that would execute it: e4-r97-campaign-driver-v1" as a bound
   * value, but the version sat OUTSIDE the envelope, so it was outside
   * `planDigest` — a driver could be rewritten while the approved digest stayed
   * byte-identical, and nothing compared the running driver to the plan's.
   *
   * Because it is an envelope field it is covered by
   * `computeR92AuthorizationDigestV1`, and the executor must additionally assert
   * equality with its OWN version before constructing a provider.
   *
   * Optional in the type so the R92 plan (whose driver did not exist yet) stays
   * representable; R97's readiness check requires it before finalizing.
   */
  driverVersion?: string;
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
/**
 * The scope/enforcement/blocked triple a cap MUST have, derived ONLY from the
 * cap's name, its declared value and the invocation mode — never from the
 * declaration's own `enforcement`/`blocked` fields.
 *
 * This is the single source of truth for both `classifyR92Caps` (which builds a
 * declaration) and `r92CapDeclarationIssues` (which checks one). Sharing it is
 * what makes "the envelope's self-report is not evidence" structural: an
 * envelope cannot assert a capability the measured call sites do not have,
 * because the expected label is computed here rather than read from the input.
 */
function capContract(
  cap: R92CapName,
  value: number | null,
  invocationMode: R92InvocationMode,
): { scope: R92CapScope; enforcement: R92Enforcement; blocked: boolean } {
  switch (cap) {
    case "maxModelCalls": {
      // The ONLY cost cap with a real runtime enforcer, and only when one
      // invocation owns the whole campaign.
      const enforced = value !== null && invocationMode === "single-invocation-over-frozen-list";
      return {
        scope: "campaign-wide",
        enforcement: enforced ? "runtime-enforced" : "preflight-only",
        blocked: !enforced,
      };
    }
    case "maxLogicalRuns":
      // cases x repeat x arms is exact and checked before all spend, so the
      // bound holds even though nothing re-checks it later.
      return { scope: "campaign-wide", enforcement: "preflight-only", blocked: false };
    case "maxEstimatedTokens":
      // Declared-but-unenforceable is the blocked case; undeclared is an honest
      // unknown that must be listed in unknownCostItems instead.
      return { scope: "campaign-wide", enforcement: "preflight-only", blocked: value !== null };
    case "maxEstimatedCostUsd":
      return { scope: "campaign-wide", enforcement: "unprovable", blocked: value !== null };
    case "maxToolCalls":
      return { scope: "per-case", enforcement: "runtime-enforced", blocked: false };
    case "maxDurationMs":
      return { scope: "per-case", enforcement: "runtime-enforced", blocked: false };
  }
}

export function classifyR92Caps(intent: R92CapIntent): R92CapDeclaration[] {
  const singleInvocation = intent.invocationMode === "single-invocation-over-frozen-list";
  const plannedRuns = intent.caseCount * intent.repetitions * intent.armCount;
  const contract = (
    cap: R92CapName,
    value: number | null,
    evidence: string,
  ): R92CapDeclaration => ({ cap, value, evidence, ...capContract(cap, value, intent.invocationMode) });

  return [
    contract(
      "maxModelCalls",
      intent.campaignModelCalls,
      singleInvocation
        ? "paired-executor.ts createBudgetedProvider throws before the call, sets hitCap and breaks the arm loop; benchmark-command.ts forwards maxModelCalls into runPairedExperiment, so one invocation enforces the whole campaign's budget. UNIT: this bounds LOGICAL generate calls, not physical HTTP attempts — a transport retry is a separate request that this cap does not count, so it is not a fully-qualified billing bound."
        : "run-campaign.ps1 passes a PER-CASE --max-model-calls and keeps no campaign-wide counter, so no single process can enforce a global model-call cap across per-case invocations. UNIT: even where a count exists it bounds LOGICAL generate calls only; physical HTTP/retry attempts are not counted.",
    ),
    contract(
      "maxLogicalRuns",
      intent.maxLogicalRuns,
      `benchmark-command.ts compares the exact planned ${plannedRuns} logical runs (cases x repeat x arms) against --max-logical-runs before any provider call; because the count is exact and precedes all spend, the bound holds even though nothing re-checks it later`,
    ),
    contract(
      "maxEstimatedTokens",
      intent.maxEstimatedTokens,
      "benchmark-command.ts multiplies PREFLIGHT_ESTIMATE.tokensPerCall by the planned call count and compares once, preflight; ACTUAL token use is never compared to it, so a declared token hard cap is not executable",
    ),
    contract(
      "maxEstimatedCostUsd",
      intent.maxEstimatedCostUsd,
      "benchmark-command.ts checks a PREFLIGHT_ESTIMATE cost constant before the first call; run-budget.ts isHardLimit returns false for maxEstimatedCostUsd, so it cannot terminate a run, and no per-token price is bound anywhere the runner can read",
    ),
    contract(
      "maxToolCalls",
      intent.perCaseToolCalls,
      "benchmark-command.ts sets per-case limits.maxToolCalls=100 and run-budget.ts RunBudgetTracker.onToolCall is consulted during the run and terminates it",
    ),
    contract(
      "maxDurationMs",
      intent.perCaseDurationMs,
      "benchmark-command.ts sets per-case limits.maxDurationMs (case maxDurationMs ?? 600000) and runtime.ts consults budget.onDurationCheck(), terminating with RESOURCE_LIMIT",
    ),
  ];
}

/** The closed field set of one cap declaration. */
const R92_CAP_FIELDS: readonly string[] = ["cap", "scope", "value", "enforcement", "blocked", "evidence"];
const R92_CAP_NAMES: readonly string[] = [
  "maxModelCalls",
  "maxLogicalRuns",
  "maxEstimatedTokens",
  "maxEstimatedCostUsd",
  "maxToolCalls",
  "maxDurationMs",
];

/** A declared value must be a POSITIVE safe integer: a negative, fractional,
 *  non-finite or unsafe value is not a budget any layer could execute, and zero
 *  leaves a paid plan no headroom at all. */
function capValueIssue(cap: string, value: unknown): string | null {
  if (typeof value !== "number") {
    return `${cap}.value must be a number (got ${typeof value})`;
  }
  if (!Number.isFinite(value)) {
    return `${cap}.value must be finite (got ${String(value)})`;
  }
  if (!Number.isSafeInteger(value)) {
    return `${cap}.value must be a safe integer (got ${String(value)})`;
  }
  if (value <= 0) {
    return `${cap}.value must be strictly positive (got ${String(value)})`;
  }
  return null;
}

/**
 * Validate the cap DECLARATION against the measured call sites and the plan's
 * own shape. Every problem is reported as a field path plus a reason; a cap's
 * own `enforcement`/`blocked`/`evidence` fields are INPUT to be checked, never
 * evidence that the capability exists.
 *
 * The issues are reported per cap name so the caller can tell a missing global
 * budget (unusable at any price) from a merely mis-declared cap.
 */
export function r92CapDeclarationIssues(
  caps: readonly R92CapDeclaration[],
  auth: R92AuthorizationV1,
): string[] {
  const issues: string[] = [];
  if (!Array.isArray(caps)) return ["caps must be an array of cap declarations"];

  const seen = new Map<string, R92CapDeclaration>();
  for (const raw of caps as readonly unknown[]) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      issues.push("caps[] must be an object (got a non-object entry)");
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const name = typeof entry.cap === "string" ? entry.cap : String(entry.cap);
    const path = `caps[${name}]`;

    for (const key of Object.keys(entry)) {
      if (!R92_CAP_FIELDS.includes(key)) {
        issues.push(`${path} carries an unknown field "${key}" — the cap schema is closed`);
      }
    }
    if (!R92_CAP_NAMES.includes(name)) {
      issues.push(`${path} is not a known cap name`);
      continue;
    }

    if (seen.has(name)) {
      const prior = seen.get(name)!;
      const conflict = prior.value !== entry.value || prior.scope !== entry.scope;
      issues.push(
        conflict
          ? `${path} is a DUPLICATE of an earlier ${name} entry that declares a different value or scope (${String(prior.value)}/${prior.scope} vs ${String(entry.value)}/${String(entry.scope)}) — a conflicting duplicate has no single authoritative bound`
          : `${path} is a DUPLICATE: each cap must appear exactly once`,
      );
    } else {
      seen.set(name, entry as unknown as R92CapDeclaration);
    }

    const expected = capContract(name as R92CapName, entry.value as number | null, auth.invocationMode);
    if (entry.scope !== expected.scope) {
      issues.push(
        `${path}.scope is "${String(entry.scope)}" but a ${name} cap has ${expected.scope} scope — the declared scope must match the layer that owns the cap`,
      );
    }
    if (entry.enforcement !== expected.enforcement) {
      issues.push(
        `${path}.enforcement claims "${String(entry.enforcement)}" but the measured layer for ${name} is ${expected.enforcement} — a self-reported capability is not evidence`,
      );
    }
    if (entry.blocked !== expected.blocked) {
      issues.push(
        `${path}.blocked claims ${String(entry.blocked)} but the measured layer for ${name} is ${expected.blocked ? "BLOCKED" : "not blocked"}`,
      );
    }
    if (entry.value !== null) {
      const valueIssue = capValueIssue(path, entry.value);
      if (valueIssue !== null) issues.push(valueIssue);
    }
    if (typeof entry.evidence !== "string" || entry.evidence.trim().length === 0) {
      issues.push(`${path}.evidence must name the measured call site that justifies the label`);
    } else if (name === "maxModelCalls" && !/logical|physical|retry/i.test(entry.evidence)) {
      issues.push(
        `${path}.evidence must state whether this cap bounds LOGICAL generate calls or physical HTTP/retry attempts — a logical-call cap is not a fully-qualified billing bound`,
      );
    }

    // The run cap must be able to CONTAIN the plan it authorizes.
    if (name === "maxLogicalRuns" && typeof entry.value === "number" && Number.isFinite(entry.value)) {
      const required = auth.caseIds.length * 2 * auth.repetitions;
      if (entry.value < required) {
        issues.push(
          `${path} is ${String(entry.value)} but the plan needs at least ${required} logical runs (${auth.caseIds.length} cases x 2 arms x ${String(auth.repetitions)} repetition(s)) — a cap below the plan size cannot contain it`,
        );
      }
    }
  }

  for (const name of R92_CAP_NAMES) {
    if (!seen.has(name)) issues.push(`caps is missing the required ${name} declaration`);
  }
  return issues;
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
    // E4-R104 (A4 怎么做 8): a SUPERSEDED label is refused with the remedy named.
    // The distinction matters operationally: "you typed the version wrong" and
    // "your approval predates the execution-identity contract and the arms it
    // names bind no executed bytes" call for different actions, and only the
    // second requires regenerating the material rather than editing a field.
    if (R92_AUTHORIZATION_SCHEMA_SUPERSEDED.includes(String(auth.schemaVersion))) {
      issues.push(
        `schemaVersion is the SUPERSEDED contract ${String(auth.schemaVersion)}; this material predates the execution-identity contract (its arms bind no executed bytes) and must be REGENERATED as ${R92_AUTHORIZATION_SCHEMA}, never patched in place`,
      );
    } else {
      issues.push(`schemaVersion must be ${R92_AUTHORIZATION_SCHEMA} (got ${String(auth.schemaVersion)})`);
    }
  }
  if (!nonEmpty(auth.authorizationId)) issues.push("authorizationId must be a non-empty id");

  // ---- Time contract -----------------------------------------------------
  // Every comparison below is guarded by a parse that returns `null` for a
  // malformed input, so a garbage timestamp is REFUSED rather than silently
  // skipping the rule it was supposed to satisfy.
  const created = parseR92Timestamp(auth.createdAt);
  const expires = parseR92Timestamp(auth.expiresAt);
  if (created === null) {
    issues.push(
      `createdAt must be a timezone-bearing ISO-8601 timestamp (e.g. 2026-09-17T00:00:00.000Z) — got ${JSON.stringify(auth.createdAt)}`,
    );
  }
  if (expires === null) {
    issues.push(
      `expiresAt must be a timezone-bearing ISO-8601 timestamp (e.g. 2026-10-17T00:00:00.000Z) — got ${JSON.stringify(auth.expiresAt)}`,
    );
  }
  if (created !== null && expires !== null && expires <= created) {
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
    // An ALLOW-LIST, not the old `^holdout/` denylist: excluding one prefix left
    // every other suite (and a bare id) selectable. The suite the id names must
    // be one this plan is allowed to draw from.
    const suite = typeof id === "string" ? (id.split("/")[0] ?? "") : "";
    const caseSegment = typeof id === "string" ? (id.split("/")[1] ?? "") : "";
    const hasCaseSegment = caseSegment.length > 0;
    if (!hasCaseSegment || !R92_ALLOWED_CASE_SUITES.includes(suite)) {
      issues.push(
        `case ${String(id)} is not in a supported development-set suite — case ids must be <suite>/<case> with suite in ${R92_SUPPORTED_SUITES.join(", ")} (holdout is excluded)`,
      );
    }
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
      // E4-R104 (A4): the arm's EXECUTION build digest. When the field is
      // PRESENT it must be a real 64-hex digest — an empty/whitespace/garbage
      // value is never "no opinion", because it would read as a bound identity
      // while binding nothing. When it is OMITTED entirely the R92 layer stays
      // silent and the R97 formal campaign refuses it (`ARM_BUILD_UNBOUND`):
      // this envelope contract is shared with the R92 development-mechanism plan,
      // which names two historical commits that are not checked out here and so
      // has no build to hash. Fabricating one there would be the dishonesty this
      // plan fights. Plan §A4 做什么 3: "新合同需要重新生成批准材料."
      if (a.buildDigest !== undefined) {
        if (typeof a.buildDigest !== "string" || a.buildDigest.trim() === "") {
          issues.push(
            `arms.${key}.buildDigest is present but empty — an unbound identity must be OMITTED or regenerated, never spelled as a blank value`,
          );
        } else if (!hex64(a.buildDigest)) {
          issues.push(`arms.${key}.buildDigest must be 64-hex (the sha256 of the arm's executed build closure)`);
        }
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

  // The executor is a BOUND field for a FINALIZED plan (plan §R97 line 214).
  //
  // It is optional in THIS shared schema on purpose: the R92 plan is a real,
  // committed artifact whose own text says its driver "does not exist yet and
  // will be written only after you approve", so R92 could not name one.
  // Demanding it here would be a retroactive lie. R97's readiness check is what
  // REQUIRES it before a plan may finalize, and the driver refuses to run a plan
  // that names no executor. When present it must be a real value.
  if (auth.driverVersion !== undefined && !nonEmpty(auth.driverVersion)) {
    issues.push("driverVersion, when present, must be a non-empty executor version");
  }

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
  /**
   * The arm's re-derived EXECUTION build digest (E4-R104 / A4). `null` means the
   * closure could not be established in that checkout — a refusal, never a skip.
   */
  buildDigest: string | null;
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

/**
 * The CLOSED set of gate codes. Derived from the array so the runtime list and
 * the type cannot drift apart, and so a caller can assert the set is closed.
 */
export const R92_GATE_CODES = [
  "PAID_AUTHORIZATION_REQUIRED",
  "AUTHORIZATION_EXPIRED",
  "AUTHORIZATION_NOT_YET_VALID",
  "AUTHORIZATION_TIME_INVALID",
  "AUTHORIZATION_DIGEST_MISMATCH",
  "IDENTITY_DRIFT",
  "CASE_CONTENT_DRIFT",
  "ARM_IDENTITY_MIXED",
  "ARM_BUILD_DRIFT",
  "CAP_INVALID",
  "CAP_NOT_ENFORCEABLE",
  "BUDGET_INCOMPLETE",
  "PLAN_INVALID",
] as const;

export type R92GateCode = (typeof R92_GATE_CODES)[number];

/** The closed top-level field set of the envelope. */
const R92_AUTH_FIELDS: readonly string[] = [
  "schemaVersion",
  "authorizationId",
  "createdAt",
  "expiresAt",
  "scopeStatement",
  "selectionDigest",
  "caseIds",
  "caseFingerprints",
  "arms",
  "armIdentityMode",
  "fixScope",
  "fixScopeStatement",
  "jointAttributionNote",
  "invocationMode",
  "providerId",
  "modelId",
  "endpointIdentity",
  "effectiveModelParams",
  "repetitions",
  "serialism",
  "caps",
  "unknownCostItems",
  "outputDir",
  "promotionEligible",
];

/**
 * The closed field set of one arm's identity.
 *
 * `buildDigest` is on this list because it is a REQUIRED part of the envelope
 * contract (E4-R104 / A4), not an optional extension: the closed-schema rule
 * exists so an envelope cannot carry a field a human never approved, and an
 * arm's executed bytes are precisely something a human must approve.
 */
const R92_ARM_FIELDS: readonly string[] = ["sha", "executionPlanDigest", "buildDigest", "buildMode"];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Report the keys of `obj` that are not in `allowed`, naming the KEY only —
 *  never the value, which may be a credential. */
function unknownFieldIssues(obj: Record<string, unknown>, allowed: readonly string[], prefix: string): string[] {
  return Object.keys(obj)
    .filter((k) => !allowed.includes(k))
    .map((k) => `${prefix}${k} is not a field of this schema — the envelope schema is closed`);
}

/**
 * Parse an authorization envelope from `unknown`. Never throws: every problem is
 * returned as a field path plus a reason, and `authorization` is non-null ONLY
 * when there is nothing to report.
 *
 * The whitelist is the point. An envelope that carries an extra field is not the
 * envelope a human approved, and `now` in particular must never be accepted from
 * the envelope: the executor's clock is the only trusted time source, so a plan
 * that tries to supply its own `now` is refused rather than silently honoured.
 */
export function parseR92AuthorizationV1(raw: unknown): {
  authorization: R92AuthorizationV1 | null;
  issues: string[];
} {
  if (!isPlainObject(raw)) {
    return {
      authorization: null,
      issues: [`authorization must be a JSON object (got ${Array.isArray(raw) ? "array" : typeof raw})`],
    };
  }

  const issues: string[] = [];
  issues.push(...unknownFieldIssues(raw, R92_AUTH_FIELDS, ""));

  // ---- Structural type checks -------------------------------------------
  const arrayFields = ["caseIds", "caps", "unknownCostItems"] as const;
  for (const field of arrayFields) {
    if (!Array.isArray(raw[field])) issues.push(`${field} must be an array`);
  }
  const objectFields = ["caseFingerprints", "effectiveModelParams"] as const;
  for (const field of objectFields) {
    if (!isPlainObject(raw[field])) issues.push(`${field} must be an object`);
  }

  const arms = raw.arms;
  if (!isPlainObject(arms)) {
    issues.push("arms must be an object binding both the baseline and candidate identities");
  } else {
    for (const key of ["baseline", "candidate"] as const) {
      const a = arms[key];
      if (!isPlainObject(a)) {
        issues.push(`arms.${key} is required and must be an object`);
        continue;
      }
      issues.push(...unknownFieldIssues(a, R92_ARM_FIELDS, `arms.${key}.`));
    }
  }

  if (Array.isArray(raw.caps)) {
    raw.caps.forEach((entry, i) => {
      if (!isPlainObject(entry)) {
        issues.push(`caps[${i}] must be an object`);
        return;
      }
      issues.push(...unknownFieldIssues(entry, R92_CAP_FIELDS, `caps[${i}].`));
    });
  }

  if (issues.length > 0) return { authorization: null, issues };

  // The shape is confirmed, so the semantic validator can read every field
  // without a defensive dance; its findings are reported the same way.
  const typed = raw as unknown as R92AuthorizationV1;
  const semantic = r92AuthorizationIssuesV1(typed);
  if (semantic.length > 0) return { authorization: null, issues: semantic };
  return { authorization: typed, issues: [] };
}

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

  /** A refusal that is a property of the PLAN, so the plan is NOT authorizable
   *  as written and no human decision could make it so. */
  const notReady = (code: R92GateCode, reason: string, issues: string[] = []): R92GateResult => ({
    authorizedToExecute: false,
    planStatus: "NOT_READY",
    ...notRun,
    code,
    reason,
    issues,
  });
  /** A refusal that is a property of the AUTHORIZATION, so the plan itself stays
   *  approvable (`READY_FOR_AUTHORIZATION`) and simply has not been approved. */
  const ready = (code: R92GateCode, reason: string, issues: string[] = []): R92GateResult => ({
    authorizedToExecute: false,
    planStatus: "READY_FOR_AUTHORIZATION",
    ...notRun,
    code,
    reason,
    issues,
  });

  if (authorization === null) {
    return notReady(
      "PAID_AUTHORIZATION_REQUIRED",
      "no R92 authorization envelope was supplied — nothing to authorize, nothing to run",
    );
  }

  // =========================================================================
  // PHASE 1 — READINESS. Is this plan authorizable AT ALL?
  //
  // Readiness is a property of the PLAN and is computed BEFORE the environment
  // is consulted. Checking the auth env vars first (the finding-D defect) meant
  // a plan with an unenforceable budget or a malformed envelope reported
  // `READY_FOR_AUTHORIZATION` whenever nobody had exported the variables yet —
  // i.e. it reported the plan as approvable precisely because it had not been
  // examined.
  // =========================================================================

  // (1) The time contract, against the EXECUTOR's injected clock. The envelope's
  // own timestamps are inputs; `facts.now` is the only trusted reading of "now",
  // and it is never copied from the plan. An unparseable value on either side is
  // refused rather than skipped: `Number.isFinite(NaN)` being false is exactly
  // how a malformed expiry used to read as "not expired".
  //
  // This precedes the general static check so a malformed timestamp is reported
  // as the TIME defect it is, not as a generic PLAN_INVALID.
  const nowMs = parseR92Timestamp(facts.now);
  const expiresMs = parseR92Timestamp(authorization.expiresAt);
  const createdMs = parseR92Timestamp(authorization.createdAt);
  if (nowMs === null) {
    return notReady(
      "AUTHORIZATION_TIME_INVALID",
      `the executor's clock reading is not a timezone-bearing ISO-8601 timestamp — refusing to evaluate expiry against an unreadable clock`,
    );
  }
  if (expiresMs === null || createdMs === null) {
    return notReady(
      "AUTHORIZATION_TIME_INVALID",
      `the envelope carries an unparseable createdAt/expiresAt — an unreadable validity window cannot be treated as open`,
    );
  }
  if (createdMs > nowMs) {
    return notReady(
      "AUTHORIZATION_NOT_YET_VALID",
      `the authorization is not valid yet: createdAt ${authorization.createdAt} is in the future (now ${facts.now}) — no clock tolerance is granted`,
    );
  }
  // The boundary is INCLUSIVE: the instant the window closes is already closed.
  if (nowMs >= expiresMs) {
    return ready(
      "AUTHORIZATION_EXPIRED",
      `authorization expired at ${authorization.expiresAt} (now ${facts.now}) — a stale authorization must be re-issued, not reused`,
    );
  }

  // (2) Structure and static self-consistency.
  const staticIssues = r92AuthorizationIssuesV1(authorization);
  if (staticIssues.length > 0) {
    return notReady(
      "PLAN_INVALID",
      `the authorization envelope is incomplete or self-inconsistent (${staticIssues.length} issue(s)) — a malformed plan is refused, never best-effort executed`,
      staticIssues,
    );
  }

  // (3) Mode capability and the budget surface. A cap the measured layer cannot
  // enforce, a duplicate/conflicting cap, a cap with the wrong scope or a value
  // no layer could execute, and a missing global budget all make the plan
  // unapprovable — regardless of whether anyone has authorized it.
  const declarationIssues = r92CapDeclarationIssues(authorization.caps, authorization);
  if (declarationIssues.length > 0) {
    const budgetRelated = declarationIssues.some((i) => i.includes("maxModelCalls"));
    return notReady(
      budgetRelated ? "BUDGET_INCOMPLETE" : "CAP_INVALID",
      budgetRelated
        ? `the global budget is not enforceable or not declared as required: ${declarationIssues.join("; ")}`
        : `the cap declaration is invalid and no layer could execute it as stated: ${declarationIssues.join("; ")}`,
      declarationIssues,
    );
  }
  const capIssues = r92CapViolations(authorization.caps);
  if (capIssues.length > 0) {
    // The historical split is preserved: a defective GLOBAL BUDGET is reported
    // as a budget problem, any other unenforceable cap as a cap problem.
    const budgetRelated = capIssues.some((i) => i.includes("maxModelCalls"));
    return notReady(
      budgetRelated ? "BUDGET_INCOMPLETE" : "CAP_NOT_ENFORCEABLE",
      budgetRelated
        ? `the global budget is not runtime-enforceable as declared: ${capIssues.join("; ")}`
        : `a declared cap cannot be enforced by the layer that would have to enforce it: ${capIssues.join("; ")}`,
      capIssues,
    );
  }

  // (4) Required observations. These are facts the executor must be able to
  // observe; a plan whose arms or cases were never observed is not authorizable.
  if (facts.executingSourceSha !== authorization.arms.candidate.sha) {
    return ready(
      "IDENTITY_DRIFT",
      `sourceSha drift: executing ${facts.executingSourceSha} but the authorization binds candidate sha ${authorization.arms.candidate.sha}`,
    );
  }

  for (const id of authorization.caseIds) {
    const expected = authorization.caseFingerprints[id];
    const observed = facts.observedCaseFingerprints[id];
    if (observed === undefined) {
      return ready(
        "CASE_CONTENT_DRIFT",
        `case ${id} was not observed at execution time — an unobserved planned case is drift, not a skip`,
      );
    }
    if (observed !== expected) {
      return ready("CASE_CONTENT_DRIFT", `case content drift for ${id}: authorized ${expected} but observed ${observed}`);
    }
  }

  if (facts.observedProviderId !== authorization.providerId || facts.observedModelId !== authorization.modelId) {
    return ready(
      "IDENTITY_DRIFT",
      `provider/model drift: authorized ${authorization.providerId}/${authorization.modelId} but observed ${facts.observedProviderId}/${facts.observedModelId}`,
    );
  }

  if (facts.observedEndpointIdentity !== authorization.endpointIdentity) {
    return ready(
      "IDENTITY_DRIFT",
      `endpointIdentity drift: authorized ${String(authorization.endpointIdentity)} but observed ${String(facts.observedEndpointIdentity)}`,
    );
  }

  // =========================================================================
  // PHASE 2 — AUTHORIZATION. The plan is ready; has a human approved THIS one?
  // =========================================================================
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
    // E4-R104 (A4): the executed BYTES. This is the comparison that catches a
    // rebuilt `dist/` — the sha and the execution-plan digest both stay put
    // because `dist/` is gitignored, so without this line a patched executor ran
    // under an approval that described different code. `null` is an unestablished
    // identity and is drift, exactly like an unobserved arm.
    //
    // Only compared when the envelope actually BINDS a value: an omitted field is
    // the R92 development-mechanism plan's honest "no build was checked out to
    // hash", and the R97 formal layer is what makes the binding mandatory
    // (`ARM_BUILD_UNBOUND`). Stripping a bound field is not a way through — the
    // envelope body is covered by `planDigest`, so removal is a digest mismatch.
    if (authorizedArm.buildDigest !== undefined && observed.buildDigest !== authorizedArm.buildDigest) {
      return {
        authorizedToExecute: false,
        planStatus: "READY_FOR_AUTHORIZATION",
        ...notRun,
        code: "ARM_BUILD_DRIFT",
        reason: `arm "${key}" buildDigest drift: authorized ${authorizedArm.buildDigest} but observed ${String(observed.buildDigest)} — the bytes that execute a case changed`,
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
