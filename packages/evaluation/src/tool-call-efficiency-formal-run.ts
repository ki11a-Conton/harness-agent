/**
 * N2 + N3 — the FORMAL execution boundary for `tool_call_efficiency_v1`.
 *
 * N1 produced a canonical, fail-closed pre-registration artifact but nothing in
 * production consumed it. This module closes that gap: a paid/strict paired run
 * cannot reach a provider factory until it has
 *
 *   0. parsed the caller's arguments and refused every experiment-semantic
 *      override (only paths / output settings are accepted);
 *   1. read and strictly validated the pre-registration v2 artifact;
 *   2. re-observed the CURRENT execution identity and compared EVERY bound
 *      field (source sha, clean tree, arms, guidance, contract, provider/model/
 *      endpoint/request-profile, per-case content, decision policy);
 *   3. read an INDEPENDENT authorization artifact and verified it binds this
 *      exact pre-registration digest, subject, arms, provider/model/endpoint,
 *      caps, expiry, resume flag and paid flag;
 *   4. opened the SAME digest's atomic budget ledger (the R97 ledger), whose
 *      grant is the REAL worst-case call count — not a caller estimate;
 *   5. verified any resume state belongs to the same digest;
 *   6. and ONLY THEN called the caller's provider factory.
 *
 * The provider factory is passed as a thunk so a spy can prove that a refusal
 * never constructs a provider — the plan's `providerFactoryCalls = 0`
 * requirement, which is stronger than `providerCalls = 0` (constructing a
 * provider can read a key or probe the network).
 *
 * Budget enforcement reuses the R97 atomic ledger for the CALL dimension (one
 * logical call = one reservation) and adds a same-lock, digest-bound cost
 * budget for the token / tool-call / duration / USD dimensions. A refused
 * preflight is always `providerFactoryCalls = 0`, `providerCalls = 0`.
 */

import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ModelEvent, ModelProvider, ModelRef, ProviderConfig, ModelRequest } from "@ar/contracts";
import { stableStringify } from "./manifest.js";
import {
  assertFormalExecutionPreregistration,
  assertNoDuplicateJsonKeys,
  PROVIDER_DEFAULT_ENDPOINT_DIGEST,
  PreregistrationV2Error,
  TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
  TOOL_CALL_EFFICIENCY_PREREGISTRATION_V2_SCHEMA,
  type ToolCallEfficiencyPreregistrationV2,
} from "./tool-call-efficiency-preregistration-v2.js";
import { captureEndpointIdentity } from "./provenance-v3.js";
import { buildPairedPlan, type PairedExperimentPlan } from "./paired-plan.js";
import { openR97BudgetLedger, withR97CampaignLock, type R97BudgetLedger } from "./r97-budget-ledger.js";

// ---------------------------------------------------------------------------
// Authorization v2 — owner-provided, read-only to the code
// ---------------------------------------------------------------------------

export const TOOL_CALL_EFFICIENCY_AUTHORIZATION_V2_SCHEMA = "tool-call-efficiency-authorization-v2";

/**
 * N3 — the ONE recognized SYNTHETIC-FIXTURE admission marker.
 *
 * WHY IT EXISTS. `paid` is the paid-admission semantic ("this authorizes a billed
 * experiment"). The offline harness needs to drive the SHIPPED release CLI end to
 * end while billing nothing, and it used to say `paid:true` for that — which is
 * exactly the conflation N3 closes: a `paid:true` authorization with
 * `maxUsdMicros:null` or an unknown per-call price must never reach a provider
 * factory. Plan §N2 requires the synthetic fixture mode to be SEPARATELY
 * IDENTIFIED and to NOT be a paid-admission configuration, so this marker carries
 * that meaning explicitly:
 *
 *   - a fixture authorization MUST NOT carry `paid:true` (the parser refuses the
 *     combination outright, so it can never be confused with a paid approval);
 *   - it is admitted only when the OBSERVED transport is provably non-billable;
 *   - the money-bound/priced invariants below apply to the PAID class only, so
 *     the fixture branch can never be used to widen a paid approval.
 */
export const FIXTURE_MODE_SYNTHETIC_OFFLINE = "synthetic-offline-v1";

/**
 * R1/F1 — the brand of the TEST-HOST-owned non-billable transport capability.
 *
 * WHY THIS EXISTS (P0, plan(20260928-105425).md §R1, F1)
 * ------------------------------------------------------
 * Before R1 the fixture branch below accepted `observation.endpointIsLoopback`
 * as PROOF that the transport could not bill, and therefore skipped the paid
 * branch's money cap. An endpoint ADDRESS is not evidence about billing: the
 * user's own local relay (127.0.0.1:8317) is a paid, forwarding, loopback
 * endpoint. Any operator could point `OPENAI_BASE_URL` at a loopback relay,
 * declare `paid:false + fixtureMode`, and obtain an uncapped path to a real
 * billed upstream.
 *
 * The fix separates the ADDRESS from the BILLING CLASS: the fixture class is
 * admitted only when the CALLER supplies a capability object that can be created
 * by one exported factory and is therefore NOT derivable from any JSON, env
 * variable, marker file, port number or sentinel key. The capability carries the
 * non-billable PROVIDER ITSELF, so a fixture admission never touches the
 * operator's provider factory (and therefore never touches real credentials).
 *
 * This is deliberately an in-process capability: `createProductionPreregRunner`
 * has no option, env var or CLI flag that can construct it, so the release CLI
 * accepts NO fixture-bypass configuration (plan §R1 怎么做 1).
 */
const NON_BILLABLE_FIXTURE_BRAND: unique symbol = Symbol("ar.evaluation.nonBillableFixtureTransport");

/**
 * R1/F1 — a transport the TEST HOST owns and that provably cannot bill: it is
 * supplied together with the provider that reaches it, and the gate uses THAT
 * provider instead of the operator's `makeProvider`.
 */
export interface NonBillableFixtureTransport {
  readonly [NON_BILLABLE_FIXTURE_BRAND]: true;
  /** The address this capability was issued for. Binds it to ONE endpoint. */
  readonly endpointBaseUrl: string | null;
  /** Binds it to ONE provider/model, so it cannot be re-pointed at another. */
  readonly providerId: string;
  readonly modelId: string;
  /** The non-billable transport. Never the operator's credential-bearing one. */
  readonly provider: ModelProvider;
}

/**
 * R1/F1 — create the test-host capability. NOT reachable from the production
 * CLI: there is no env var, JSON field, marker file or flag that produces it.
 */
export function createNonBillableFixtureTransport(input: {
  endpointBaseUrl: string | null;
  providerId: string;
  modelId: string;
  provider: ModelProvider;
}): NonBillableFixtureTransport {
  return Object.freeze({
    [NON_BILLABLE_FIXTURE_BRAND]: true as const,
    endpointBaseUrl: input.endpointBaseUrl,
    providerId: input.providerId,
    modelId: input.modelId,
    provider: input.provider,
  });
}

/** R1/F1 — is this the real branded capability (not a look-alike object)? */
export function isNonBillableFixtureTransport(value: unknown): value is NonBillableFixtureTransport {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[NON_BILLABLE_FIXTURE_BRAND] === true
  );
}


export interface AuthorizationCapsV2 {
  /** Must equal the pre-registration's worst case exactly. */
  maxModelCalls: number;
  maxToolCalls: number;
  maxDurationMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
  /** Integer USD micros, or `null` when the campaign is not money-bounded. */
  maxUsdMicros: number | null;
}

export interface ToolCallEfficiencyAuthorizationV2 {
  schemaVersion: string;
  /** The EXACT pre-registration digest this approval authorizes. */
  preregistrationDigest: string;
  candidateSourceSha: string;
  baselineArmDigest: string;
  candidateArmDigest: string;
  providerId: string;
  modelId: string;
  endpointDigest: string;
  caps: AuthorizationCapsV2;
  issuedAtMs: number;
  expiresAtMs: number;
  /** Nonce / human approval id (never secret material). */
  approvalId: string;
  allowResume: boolean;
  /** Explicit paid flag — its absence is a refusal, never a default. */
  paid: boolean;
  /**
   * N3 — set ONLY by the offline synthetic harness, and only together with
   * `paid:false`. When present the admission is the separately-identified
   * FIXTURE class (see `FIXTURE_MODE_SYNTHETIC_OFFLINE`), never a paid approval.
   */
  fixtureMode?: string;
}

export class AuthorizationV2Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${TOOL_CALL_EFFICIENCY_AUTHORIZATION_V2_SCHEMA}[${code}]: ${message}`);
    this.name = "AuthorizationV2Error";
    this.code = code;
  }
}

function authFail(code: string, message: string): never {
  throw new AuthorizationV2Error(code, message);
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function authString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) authFail("INVALID_FIELD", `${field} must be a non-empty string`);
  return v;
}

function authNonNegInt(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || !Number.isSafeInteger(v)) {
    authFail("INVALID_FIELD", `${field} must be a non-negative safe integer`);
  }
  return v;
}

function authSha40(v: unknown, field: string): string {
  if (typeof v !== "string" || !/^[0-9a-f]{40}$/.test(v)) authFail("INVALID_FIELD", `${field} must be a 40-hex git SHA`);
  return v;
}

function authKeys(obj: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) authFail("UNKNOWN_FIELD", `${field}.${k} is not a known authorization field`);
  }
}

/** Strictly parse an owner-provided authorization. Never creates one. */
export function parseAndValidateAuthorizationV2(json: string): ToolCallEfficiencyAuthorizationV2 {
  // A3/F7 — the authorization is the OTHER canonical-input boundary, and it was
  // the one F7 left open: `JSON.parse` keeps only the LAST of a repeated key, so
  // a hand-edited approval could carry a second `maxUsdMicros` / `paid` /
  // `preregistrationDigest` that a byte-scan would see but the parsed object
  // silently drops. The SAME decoded-key scan the pre-registration uses is
  // applied here (escape-equivalent spellings collide), and its refusal is
  // re-labelled with this boundary's own error so a caller can distinguish the
  // two documents. Refused BEFORE any field is read.
  try {
    assertNoDuplicateJsonKeys(json);
  } catch (err) {
    if (err instanceof PreregistrationV2Error) {
      authFail("DUPLICATE_JSON_KEY", "authorization contains a repeated object key — canonical input forbids repeated keys");
    }
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    authFail("NOT_JSON", "authorization is not valid JSON");
  }
  if (!isPlain(raw)) authFail("INVALID_SHAPE", "authorization must be an object");
  const schemaVersion = authString(raw.schemaVersion, "schemaVersion");
  if (schemaVersion !== TOOL_CALL_EFFICIENCY_AUTHORIZATION_V2_SCHEMA) {
    authFail("WRONG_SCHEMA", `schemaVersion ${schemaVersion} is not ${TOOL_CALL_EFFICIENCY_AUTHORIZATION_V2_SCHEMA}`);
  }
  authKeys(
    raw,
    [
      "schemaVersion",
      "preregistrationDigest",
      "candidateSourceSha",
      "baselineArmDigest",
      "candidateArmDigest",
      "providerId",
      "modelId",
      "endpointDigest",
      "caps",
      "issuedAtMs",
      "expiresAtMs",
      "approvalId",
      "allowResume",
      "paid",
      "fixtureMode",
    ],
    "authorization",
  );
  if (!isPlain(raw.caps)) authFail("INVALID_SHAPE", "caps must be an object");
  authKeys(raw.caps, ["maxModelCalls", "maxToolCalls", "maxDurationMs", "maxInputTokens", "maxOutputTokens", "maxTotalTokens", "maxUsdMicros"], "caps");
  const caps: AuthorizationCapsV2 = {
    maxModelCalls: authNonNegInt(raw.caps.maxModelCalls, "caps.maxModelCalls"),
    maxToolCalls: authNonNegInt(raw.caps.maxToolCalls, "caps.maxToolCalls"),
    maxDurationMs: authNonNegInt(raw.caps.maxDurationMs, "caps.maxDurationMs"),
    maxInputTokens: authNonNegInt(raw.caps.maxInputTokens, "caps.maxInputTokens"),
    maxOutputTokens: authNonNegInt(raw.caps.maxOutputTokens, "caps.maxOutputTokens"),
    maxTotalTokens: authNonNegInt(raw.caps.maxTotalTokens, "caps.maxTotalTokens"),
    maxUsdMicros: raw.caps.maxUsdMicros === null ? null : authNonNegInt(raw.caps.maxUsdMicros, "caps.maxUsdMicros"),
  };
  // N3 — the synthetic-fixture marker is additive and fail-closed: it must be the
  // ONE recognized value, and it can NEVER be combined with the paid flag.
  let fixtureMode: string | undefined;
  if (raw.fixtureMode !== undefined) {
    if (raw.fixtureMode !== FIXTURE_MODE_SYNTHETIC_OFFLINE) {
      authFail("INVALID_FIXTURE_MODE", `fixtureMode must be "${FIXTURE_MODE_SYNTHETIC_OFFLINE}" when present`);
    }
    if (raw.paid === true) {
      authFail("FIXTURE_MODE_CANNOT_BE_PAID", "a synthetic-fixture authorization must not carry the paid flag");
    }
    fixtureMode = FIXTURE_MODE_SYNTHETIC_OFFLINE;
  }
  return {
    schemaVersion,
    preregistrationDigest: authString(raw.preregistrationDigest, "preregistrationDigest"),
    candidateSourceSha: authSha40(raw.candidateSourceSha, "candidateSourceSha"),
    baselineArmDigest: authString(raw.baselineArmDigest, "baselineArmDigest"),
    candidateArmDigest: authString(raw.candidateArmDigest, "candidateArmDigest"),
    providerId: authString(raw.providerId, "providerId"),
    modelId: authString(raw.modelId, "modelId"),
    endpointDigest: authString(raw.endpointDigest, "endpointDigest"),
    caps,
    issuedAtMs: authNonNegInt(raw.issuedAtMs, "issuedAtMs"),
    expiresAtMs: authNonNegInt(raw.expiresAtMs, "expiresAtMs"),
    approvalId: authString(raw.approvalId, "approvalId"),
    allowResume: raw.allowResume === true,
    paid: raw.paid === true,
    ...(fixtureMode === undefined ? {} : { fixtureMode }),
  };
}

export type AuthorizationCheckCode =
  | "AUTHORIZATION_NOT_PAID"
  | "AUTHORIZATION_EXPIRED"
  | "AUTHORIZATION_NOT_YET_VALID"
  | "AUTHORIZATION_DIGEST_MISMATCH"
  | "AUTHORIZATION_SUBJECT_MISMATCH"
  | "AUTHORIZATION_CAP_MISMATCH";

/**
 * Verify an authorization binds EXACTLY this pre-registration at `nowMs`.
 *
 * Caps must EQUAL the pre-registered worst case: an approval cannot grant more
 * than was pre-registered (that would authorize an unregistered experiment) nor
 * less (that would underfund a strict pair).
 */
export function checkAuthorizationV2(
  auth: ToolCallEfficiencyAuthorizationV2,
  prereg: ToolCallEfficiencyPreregistrationV2,
  nowMs: number,
): { ok: true } | { ok: false; code: AuthorizationCheckCode; reason: string } {
  // N3 — two distinct admission classes, each with its OWN fail-closed
  // preconditions (enforced in the gate): a PAID approval must be money-bounded
  // and priced; a separately-identified FIXTURE approval bills nothing and must
  // instead PROVE its observed transport is non-billable. The parser has already
  // refused `fixtureMode` together with `paid:true`, so the classes cannot mix.
  const isFixture = auth.fixtureMode === FIXTURE_MODE_SYNTHETIC_OFFLINE;
  if (!auth.paid && !isFixture) {
    return { ok: false, code: "AUTHORIZATION_NOT_PAID", reason: "authorization does not carry the explicit paid flag" };
  }
  if (auth.preregistrationDigest !== prereg.preregistrationDigest) {
    return {
      ok: false,
      code: "AUTHORIZATION_DIGEST_MISMATCH",
      reason: "authorization.preregistrationDigest does not match the pre-registration under validation",
    };
  }
  if (
    auth.candidateSourceSha !== prereg.subject.candidateSourceSha ||
    auth.baselineArmDigest !== prereg.subject.baselineArmDigest ||
    auth.candidateArmDigest !== prereg.subject.candidateArmDigest ||
    auth.providerId !== prereg.provider.providerId ||
    auth.modelId !== prereg.provider.modelId ||
    auth.endpointDigest !== prereg.provider.endpointDigest
  ) {
    return { ok: false, code: "AUTHORIZATION_SUBJECT_MISMATCH", reason: "authorization subject/provider identity does not match the pre-registration" };
  }
  const expected = prereg.budget;
  const c = auth.caps;
  if (
    c.maxModelCalls !== expected.campaignWorstCaseModelCalls ||
    c.maxToolCalls !== expected.maxToolCalls ||
    c.maxDurationMs !== expected.maxDurationMs ||
    c.maxInputTokens !== expected.maxInputTokens ||
    c.maxOutputTokens !== expected.maxOutputTokens ||
    c.maxTotalTokens !== expected.maxTotalTokens ||
    c.maxUsdMicros !== expected.maxUsdMicros
  ) {
    return {
      ok: false,
      code: "AUTHORIZATION_CAP_MISMATCH",
      reason: "authorization caps do not equal the pre-registered worst case (an approval may not widen or narrow the frozen budget)",
    };
  }
  if (nowMs < auth.issuedAtMs) {
    return { ok: false, code: "AUTHORIZATION_NOT_YET_VALID", reason: `authorization is not valid before ${auth.issuedAtMs}` };
  }
  if (nowMs >= auth.expiresAtMs) {
    return { ok: false, code: "AUTHORIZATION_EXPIRED", reason: `authorization expired at ${auth.expiresAtMs}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Current execution observation (re-observed NOW, never the artifact's claims)
// ---------------------------------------------------------------------------

export interface PreregisteredCampaignObservationV2 {
  candidateSourceSha: string;
  /** The worktree the runner will use must be clean. */
  cleanTree: boolean;
  baselineArmDigest: string;
  candidateArmDigest: string;
  guidanceDigest: string;
  contractDigest: string;
  runtimeConfigDigest: string;
  providerId: string;
  modelId: string;
  endpointDigest: string;
  requestProfileDigest: string;
  /** caseId -> content digest, re-derived from the real case files. */
  caseContentDigests: Record<string, string>;
  /**
   * B1 — caseId -> ELIGIBILITY digest, independently re-derived from the frozen
   * taxonomy the selection was frozen against. The old observer only re-derived
   * case CONTENT, so `selectionRule` / eligibility / provenance were whatever the
   * artifact self-declared.
   */
  eligibilityDigests: Record<string, string>;
  /**
   * B1 — the selection's own provenance digest, RECOMPUTED from the frozen
   * selection artifact body (never echoed from the artifact under validation).
   */
  selectionProvenanceDigest: string;
  decisionPolicyDigest: string;
  /**
   * The DECLARED per-call price snapshot (integer USD micros) for the resolved
   * provider/model, or `null` when the price is NOT known.
   *
   * It is observed (never a CLI override) because the money bound is part of the
   * execution identity: on a money-bounded campaign a `null` price is a refusal
   * (`PRICING_UNKNOWN`) — a silent zero would authorize unlimited spend.
   */
  usdMicrosPerCall: number | null;
  /**
   * F5/R4 — the canonical digest of the WHOLE pricing basis that produced
   * `usdMicrosPerCall`: the amount PLUS the source level (operator_declared vs
   * provider_verified), the source, the model, the endpoint, the currency, the
   * ceilings and the validity window.
   *
   * `usdMicrosPerCall` (and `budget.maxUsdMicros`) alone cannot bind the basis: a
   * swapped rate SOURCE, endpoint or validity window that happens to keep the same
   * amount would be invisible. `observationViolationsV2` therefore compares this
   * digest, so a pricing-basis change after approval is execution identity drift —
   * refused BEFORE any provider factory call.
   *
   * OPTIONAL in the type only for source compatibility with in-memory fixtures
   * that predate R4; `observeExecutionIdentity` ALWAYS sets it, and a bound digest
   * against a missing observed one is reported as drift (fail closed).
   */
  pricingDigest?: string;
  /**
   * F5/R4 — the LEVEL of the observed price: `provider_verified` (a
   * provider-published rate card), `operator_declared` (a conservative UPPER
   * BOUND the operator stated, never an invoice) or `unbilled_stub`. This is a
   * review-package diagnostic; the BINDING is `pricingDigest`.
   */
  pricingSourceKind?: "operator_declared" | "provider_verified" | "unbilled_stub" | null;
  /**
   * R1/F1 — the ADDRESS class of the resolved endpoint, NOT a billing class.
   *
   * TRUE only when the observer proved the endpoint is loopback (`127.0.0.0/8`,
   * `::1`, `localhost`). It is re-derived from the live environment on every run
   * and is never read from the artifact.
   *
   * It is NO LONGER evidence about billing and MUST NOT be used as one: a
   * loopback address can carry PAID relay traffic (a user's own local relay is
   * exactly that). The synthetic-fixture admission therefore requires an injected
   * `NonBillableFixtureTransport` capability instead — see
   * `openPreregisteredCampaignGate`. This field remains a diagnostic fact.
   */
  endpointIsLoopback: boolean;
}

/**
 * F5/R4 — the pricing digest BOUND by the pre-registration.
 *
 * The canonical location is `provider.pricingDigest`. A root-level
 * `pricingDigest` is accepted as a compatibility alias (R0's F5 counterexample
 * writes it there); new artifacts must use the `provider` location.
 */
function boundPricingDigestOf(artifact: ToolCallEfficiencyPreregistrationV2): string | null {
  const nested = artifact.provider.pricingDigest;
  if (typeof nested === "string") return nested;
  const root = (artifact as { pricingDigest?: unknown }).pricingDigest;
  return typeof root === "string" ? root : null;
}

/** F5/R4 — the per-call price the pre-registration was approved at, or
 *  `undefined` when it binds none (a legacy artifact). Same alias rule. */
function boundUsdMicrosPerCallOf(artifact: ToolCallEfficiencyPreregistrationV2): number | null | undefined {
  const nested = artifact.provider.usdMicrosPerCall;
  if (typeof nested === "number" || nested === null) return nested;
  const root = (artifact as { usdMicrosPerCall?: unknown }).usdMicrosPerCall;
  return typeof root === "number" ? root : undefined;
}

/** Compare the artifact's bound identity against a fresh observation. */
export function observationViolationsV2(
  artifact: ToolCallEfficiencyPreregistrationV2,
  obs: PreregisteredCampaignObservationV2,
): string[] {
  const issues: string[] = [];
  const cmp = (path: string, bound: unknown, observed: unknown): void => {
    if (bound !== observed) issues.push(`${path}: bound ${JSON.stringify(bound)} != observed ${JSON.stringify(observed)}`);
  };
  if (!obs.cleanTree) issues.push("worktree: not clean (a run must execute from an exact, unmodified source)");
  cmp("subject.candidateSourceSha", artifact.subject.candidateSourceSha, obs.candidateSourceSha);
  cmp("subject.baselineArmDigest", artifact.subject.baselineArmDigest, obs.baselineArmDigest);
  cmp("subject.candidateArmDigest", artifact.subject.candidateArmDigest, obs.candidateArmDigest);
  cmp("subject.runtimeConfigDigest", artifact.subject.runtimeConfigDigest, obs.runtimeConfigDigest);
  cmp("prompt.guidanceDigest", artifact.prompt.guidanceDigest, obs.guidanceDigest);
  cmp("prompt.contractDigest", artifact.prompt.contractDigest, obs.contractDigest);
  cmp("provider.providerId", artifact.provider.providerId, obs.providerId);
  cmp("provider.modelId", artifact.provider.modelId, obs.modelId);
  cmp("provider.endpointDigest", artifact.provider.endpointDigest, obs.endpointDigest);
  cmp("provider.requestProfileDigest", artifact.provider.requestProfileDigest, obs.requestProfileDigest);
  // F5/R4 — the pricing BASIS, not merely its amount. `budget.maxUsdMicros` is the
  // CAP; two bases with the same per-call amount but a different source level,
  // source, endpoint, currency, ceilings or validity window are DIFFERENT
  // execution identities and must never inherit an old approval. `undefined`
  // normalizes to `null`, so a legacy in-memory pair (neither side carries one) is
  // not spurious drift, while a BOUND digest against a missing observed one is.
  cmp("pricingDigest", boundPricingDigestOf(artifact), obs.pricingDigest ?? null);
  const boundUsdMicrosPerCall = boundUsdMicrosPerCallOf(artifact);
  if (boundUsdMicrosPerCall !== undefined) {
    cmp("provider.usdMicrosPerCall", boundUsdMicrosPerCall, obs.usdMicrosPerCall);
  }
  cmp("evaluation.decisionPolicyDigest", artifact.evaluation.decisionPolicyDigest, obs.decisionPolicyDigest);
  // B1 — the selection's provenance and every case's eligibility are compared
  // against values the observer RE-DERIVED from the frozen selection/taxonomy,
  // never against the artifact's own claims.
  cmp("dataset.selectionProvenanceDigest", artifact.dataset.selectionProvenanceDigest, obs.selectionProvenanceDigest);
  const boundIds = artifact.dataset.cases.map((c) => c.caseId).join(",");
  const observedIds = Object.keys(obs.caseContentDigests).join(",");
  if (boundIds !== observedIds) {
    issues.push(`dataset.cases: bound [${boundIds}] != observed [${observedIds}]`);
  } else {
    for (const c of artifact.dataset.cases) {
      cmp(`dataset.cases.${c.caseId}.contentDigest`, c.contentDigest, obs.caseContentDigests[c.caseId]);
    }
  }
  const boundEligIds = artifact.dataset.cases.map((c) => c.caseId).join(",");
  const observedEligIds = Object.keys(obs.eligibilityDigests).join(",");
  if (boundEligIds !== observedEligIds) {
    issues.push(`dataset.eligibility: bound [${boundEligIds}] != observed [${observedEligIds}]`);
  } else {
    for (const c of artifact.dataset.cases) {
      cmp(`dataset.cases.${c.caseId}.eligibilityDigest`, c.eligibilityDigest, obs.eligibilityDigests[c.caseId]);
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Cost budget — same-lock, digest-bound, non-call dimensions
// ---------------------------------------------------------------------------

export const TOOL_CALL_EFFICIENCY_COST_BUDGET_SCHEMA = "tool-call-efficiency-cost-budget-v1";

export interface CostBudgetCapsV2 {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
  maxToolCalls: number;
  maxDurationMs: number;
  maxUsdMicros: number | null;
  /**
   * The pre-registered campaign worst-case LOGICAL call count. Recorded here so
   * the per-call DURATION reservation can be derived as a share of
   * `maxDurationMs` (see `perCallDurationMsCeiling`) rather than reserving the
   * whole campaign wall-clock against every single call.
   */
  maxModelCalls: number;
}

// ---------------------------------------------------------------------------
// N7/F3 — the per-request / per-attempt / per-arm cost journal
//
// The `charged.totalTokens` counter alone answers "how much did the whole
// campaign consume?", which is NOT the question the champion verdict asks. The
// verdict needs "how much did the CANDIDATE consume RELATIVE TO the baseline?",
// and a campaign total cannot answer that — reading the total as a difference is
// the F3 defect (measured: total 248 was reported as `tokensDelta` 248).
//
// The journal therefore records ONE entry per BILLED PHYSICAL ATTEMPT, carrying
// the full request identity (campaign digest, armRunId, arm, case, repetition,
// requestId, attemptId, reservationId). The campaign aggregate then sums the
// entries PER ARM and computes `candidate - baseline`, while the ledger's own
// `charged.totalTokens` stays an INDEPENDENT metric of total consumption.
// ---------------------------------------------------------------------------

export const TOOL_CALL_EFFICIENCY_COST_JOURNAL_SCHEMA = "tool-call-efficiency-cost-journal-v2";

export type CostJournalArmId = "baseline" | "candidate";

/**
 * How an entry's token numbers were obtained.
 *
 *   MEASURED             — the real usage a completed response reported;
 *   RESERVED_UPPER_BOUND — the pre-send CONSERVATIVE ceiling that was charged
 *                          because the attempt's real usage was never observed
 *                          (a retry whose own usage is not separately reported,
 *                          or a dispatched call whose outcome nobody saw).
 *
 * A reservation is a BOUND, never consumption, and the two are stored in
 * different fields so no reader can mistake one for the other.
 */
export type CostJournalBasis = "MEASURED" | "RESERVED_UPPER_BOUND";

/** The exact identity every request of ONE arm run is attributed to. */
export interface CostJournalScope {
  /** Root campaign identity: the pre-registration digest of the ledger's campaign. */
  campaignDigest: string;
  armRunId: string;
  arm: CostJournalArmId;
  caseId: string;
  repetition: number;
}

/**
 * ONE billed physical attempt (the initial send, or one provider-internal retry).
 *
 * `(campaignDigest, armRunId, requestId, attemptId)` names the attempt and
 * `reservationId` (the R97 call-ledger reservation id) names the billable unit.
 * Both are enforced unique, so one physical retry is charged EXACTLY ONCE and can
 * never be attributed to two arms.
 */
export interface CostJournalEntry {
  schemaVersion: string;
  campaignDigest: string;
  armRunId: string;
  arm: CostJournalArmId;
  caseId: string;
  repetition: number;
  requestId: string;
  attemptId: number;
  /** The R97 call-ledger reservation of THIS physical attempt. */
  reservationId: string;
  /** The cost-budget reservation this entry settled. */
  costReservationId: string;
  basis: CostJournalBasis;
  /** Real observed tokens — non-null IFF `basis === "MEASURED"`. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** Conservative pre-send upper bound — non-null IFF `basis === "RESERVED_UPPER_BOUND"`. */
  reservedInputTokens: number | null;
  reservedOutputTokens: number | null;
  /** Tokens this entry added to `charged.totalTokens` (derived, not caller-asserted). */
  chargedTotalTokens: number;
  /** TRUE when the attempt was dispatched but its real outcome was never observed. */
  outcomeUnknown: boolean;
  loggedAt: number;
}

export interface CostJournalFile {
  schemaVersion: string;
  entries: CostJournalEntry[];
}

/** What a caller supplies for ONE attempt; the arm identity comes from the bound scope. */
export interface CostJournalAttempt {
  requestId: string;
  attemptId: number;
  reservationId: string;
  costReservationId: string;
  basis: CostJournalBasis;
  inputTokens: number | null;
  outputTokens: number | null;
  reservedInputTokens: number | null;
  reservedOutputTokens: number | null;
  outcomeUnknown: boolean;
}

/**
 * The durable cost ledger as READ, with its two independent facts kept apart:
 * the read-only TOTAL the ledger charged, and the per-request journal entries.
 * `entries === null` means the ledger is a legacy total-only ledger (its journal
 * section is absent): the total is readable, per-arm attribution is NOT, and no
 * arm attribution may be fabricated from the total.
 */
export interface CostJournalView {
  /** TRUE when the cost-budget file exists and parsed. */
  exists: boolean;
  /** `charged.totalTokens`, or null when it is absent/unreadable. */
  chargedTotalTokens: number | null;
  journalSchemaVersion: string | null;
  entries: CostJournalEntry[] | null;
}

export interface CostBudgetFile {
  schemaVersion: string;
  preregistrationDigest: string;
  caps: CostBudgetCapsV2;
  /**
   * R3/F4 — when the campaign was OPENED (epoch ms), written once at creation.
   */
  openedAtMs: number;
  /**
   * R3/F4 — the campaign's SINGLE wall-clock deadline (epoch ms), frozen when the
   * campaign is created and REUSED unchanged by every later open/resume. Resume
   * therefore never regains a full fresh duration: the remaining time is
   * `campaignDeadlineAtMs - now`, whatever the caller asks for.
   *
   * A LEGACY file that predates this field is treated as ALREADY EXPIRED
   * (`deadlineSource: "legacy-missing-expired"`), never as a fresh window.
   */
  campaignDeadlineAtMs: number;
  /** R3/F4 — how the deadline above was established (auditable). */
  deadlineSource?: "created" | "reused" | "legacy-missing-expired";
  charged: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    toolCalls: number;
    durationMs: number;
    usdMicros: number;
    unknownCalls: number;
  };
  /**
   * The aggregate currently RESERVED (pre-send upper bounds not yet settled).
   * A reservation is removed when its call settles (replaced by the real usage)
   * or is released. It is durable so a crash mid-call cannot refund the bound.
   */
  reserved: CostReservationDelta;
  /** Outstanding reservations by id, so each can be released/settled exactly. */
  reservations: Record<string, CostReservationDelta>;
  /**
   * N7/F3 — per-request/per-attempt/per-arm attribution. ABSENT on a ledger
   * written before this field existed (a legacy ledger): such a ledger is still
   * readable as a TOTAL, but it carries no arm attribution and none is invented.
   */
  journal?: CostJournalFile;
}

/** One reservation's per-dimension upper bound (all non-negative integers). */
export interface CostReservationDelta {
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  durationMs: number;
  usdMicros: number;
}

export interface CostBudgetView extends CostBudgetFile {
  /** True once ANY dimension is at or over its cap (charged OR reserved). */
  exhausted: boolean;
  /** Human-readable exhausted dimensions. */
  exhaustedDimensions: string[];
}

/** R3/F4 — the durable cost-budget file name (exported so tests read the same file). */
export const COST_BUDGET_FILENAME = "cost-budget.json";

/**
 * N6 — the DURABLE cost journal's corroborated token consumption for `dir`, so a
 * caller can bind `tokensDelta` to what was actually charged instead of to an
 * arm's self-reported `tokensUsed`.
 *
 * `null` means the journal does not exist (or is unreadable): explicitly UNKNOWN,
 * never `0`. The two must stay distinguishable, because "no corroborated
 * consumption" and "measured zero consumption" are different facts.
 */
export async function readCostJournalChargedTokens(dir: string): Promise<number | null> {
  return (await readCostJournal(dir)).chargedTotalTokens;
}

/**
 * N7/F3 — read the durable cost ledger as TWO independent facts: the read-only
 * charged TOTAL and the raw per-request journal entries.
 *
 * `entries === null` (with `exists === true`) means the ledger predates the
 * per-request journal: its total is still readable, but a reader must NOT invent
 * arm attribution from it. Never throws: an absent/corrupt ledger is reported
 * structurally (`exists:false` / null fields), so a caller can distinguish
 * "unreadable" from "measured zero".
 */
export async function readCostJournal(dir: string): Promise<CostJournalView> {
  let raw: string;
  try {
    raw = await readFile(join(dir, COST_BUDGET_FILENAME), "utf8");
  } catch {
    return { exists: false, chargedTotalTokens: null, journalSchemaVersion: null, entries: null };
  }
  const blank: CostJournalView = { exists: true, chargedTotalTokens: null, journalSchemaVersion: null, entries: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return blank;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return blank;
  const file = parsed as { charged?: { totalTokens?: unknown }; journal?: { schemaVersion?: unknown; entries?: unknown } };
  const total = file.charged?.totalTokens;
  const chargedTotalTokens = typeof total === "number" && Number.isSafeInteger(total) ? total : null;
  const journal = file.journal;
  if (journal === undefined || journal === null || !Array.isArray(journal.entries)) {
    return { exists: true, chargedTotalTokens, journalSchemaVersion: null, entries: null };
  }
  return {
    exists: true,
    chargedTotalTokens,
    journalSchemaVersion: typeof journal.schemaVersion === "string" ? journal.schemaVersion : null,
    // The SHAPE of each entry is validated by `costJournalEntryProblems`; this
    // reader never blesses content, it only hands the bytes on.
    entries: journal.entries as CostJournalEntry[],
  };
}

/**
 * N7/F3 — the shape problems of ONE journal attempt. EMPTY means the attempt is
 * an unambiguous statement (a MEASURED attempt carries measured tokens and no
 * reservation; a RESERVED_UPPER_BOUND attempt carries a bound and no measured
 * usage, and admits its outcome was never observed).
 *
 * The point of the shape gate is that a conservative reservation can NEVER be
 * presented as consumption, and a measured attempt can never smuggle a bound in
 * as if it were usage.
 */
export function costJournalEntryProblems(a: Partial<CostJournalAttempt> | undefined): string[] {
  if (a === undefined || a === null || typeof a !== "object") return ["journal attempt is missing"];
  const p: string[] = [];
  if (typeof a.requestId !== "string" || a.requestId === "") p.push("requestId must be a non-empty string");
  if (!Number.isSafeInteger(a.attemptId) || (a.attemptId ?? -1) < 0) p.push("attemptId must be a non-negative integer");
  if (typeof a.reservationId !== "string" || a.reservationId === "") p.push("reservationId must be a non-empty string");
  if (typeof a.costReservationId !== "string" || a.costReservationId === "") p.push("costReservationId must be a non-empty string");
  const checkInt = (v: number | null | undefined, name: string): void => {
    if (v === null || v === undefined) return;
    if (!Number.isSafeInteger(v) || v < 0) p.push(`${name} must be null or a non-negative integer`);
  };
  checkInt(a.inputTokens, "inputTokens");
  checkInt(a.outputTokens, "outputTokens");
  checkInt(a.reservedInputTokens, "reservedInputTokens");
  checkInt(a.reservedOutputTokens, "reservedOutputTokens");
  if (a.basis === "MEASURED") {
    if (a.inputTokens === null || a.inputTokens === undefined) p.push("a MEASURED attempt must carry inputTokens");
    if (a.outputTokens === null || a.outputTokens === undefined) p.push("a MEASURED attempt must carry outputTokens");
    if ((a.reservedInputTokens ?? null) !== null || (a.reservedOutputTokens ?? null) !== null) {
      p.push("a MEASURED attempt must not carry reserved tokens");
    }
  } else if (a.basis === "RESERVED_UPPER_BOUND") {
    if ((a.inputTokens ?? null) !== null || (a.outputTokens ?? null) !== null) {
      p.push("a RESERVED_UPPER_BOUND attempt must not present a reservation as measured usage");
    }
    if (a.reservedInputTokens === null || a.reservedInputTokens === undefined) p.push("a RESERVED_UPPER_BOUND attempt must carry reservedInputTokens");
    if (a.reservedOutputTokens === null || a.reservedOutputTokens === undefined) p.push("a RESERVED_UPPER_BOUND attempt must carry reservedOutputTokens");
    if (a.outcomeUnknown !== true) p.push("a RESERVED_UPPER_BOUND attempt must be flagged outcomeUnknown");
  } else {
    p.push(`unknown journal basis ${String(a.basis)}`);
  }
  return p;
}

/** The exact tokens an attempt adds to `charged.totalTokens` (derived, never asserted). */
function chargedTokensOf(attempt: CostJournalAttempt): number {
  return attempt.basis === "MEASURED"
    ? (attempt.inputTokens ?? 0) + (attempt.outputTokens ?? 0)
    : (attempt.reservedInputTokens ?? 0) + (attempt.reservedOutputTokens ?? 0);
}

const ZERO_RESERVATION: CostReservationDelta = { inputTokens: 0, outputTokens: 0, toolCalls: 0, durationMs: 0, usdMicros: 0 };

/**
 * Conservative PER-CALL upper bounds used to RESERVE budget before a request is
 * sent (plan A4). A call is only dispatched when its worst-case consumption is
 * provably within the remaining allowance; the real usage settles the
 * reservation afterwards. These are deliberately conservative ceilings, not
 * predictions.
 */
export const FORMAL_PER_CALL_INPUT_TOKEN_CEILING = 32_000;
export const FORMAL_PER_CALL_OUTPUT_TOKEN_CEILING = 32_000;

/**
 * Absolute cap on one call's WALL-CLOCK reservation.
 *
 * Unlike a token ceiling (a call provably cannot emit more tokens than the
 * model's maximum), a wall-clock reservation cannot be a true upper bound — a
 * call's duration is only known once it is over. The per-call duration
 * reservation is therefore a SCHEDULING SHARE of the campaign's `maxDurationMs`
 * (see `perCallDurationMsCeiling`): the campaign's pre-registered worst-case
 * schedule (`maxModelCalls`) must each fit within the authorized total, or no
 * call could ever be reserved against a cap as small as one call's ceiling.
 *
 * `maxDurationMs` is still an absolute cap: it is charged from the ACTUAL
 * elapsed duration (settled after the call), and once charged+reserved would
 * exceed it, further calls are refused before they leave.
 */
export const FORMAL_PER_CALL_DURATION_MS_CEILING = 600_000;

/**
 * The per-call duration reservation for a campaign: the largest uniform share
 * of `maxDurationMs` that keeps the pre-registered worst-case schedule
 * (`maxModelCalls` calls) within the cap, never above the absolute per-call
 * ceiling, and never below 1ms (a zero reservation would make the duration
 * dimension unbounded).
 */
export function perCallDurationMsCeiling(caps: Pick<CostBudgetCapsV2, "maxDurationMs" | "maxModelCalls">): number {
  const share = Math.ceil(caps.maxDurationMs / Math.max(1, caps.maxModelCalls));
  return Math.max(1, Math.min(FORMAL_PER_CALL_DURATION_MS_CEILING, share));
}

let reservationCounter = 0;

/**
 * A digest-bound, same-lock cost budget. It reuses `withR97CampaignLock` (the
 * SINGLE campaign lock) rather than implementing a third lock. Its caps must
 * equal the pre-registration's; anything else is refused.
 *
 * A4: every dimension is RESERVED before the request and settled afterwards, so
 * a cap can never be exceeded by a request that was never reserved.
 */
export class CostBudget {
  /**
   * N7/F3 — the arm-run identity every following charged attempt is attributed
   * to. It is set by the campaign DRIVER immediately before it invokes one arm
   * run and cleared immediately afterwards; the driver executes arm runs
   * strictly sequentially, so a single bound scope is unambiguous.
   */
  private journalScope: CostJournalScope | null = null;

  private constructor(private readonly dir: string, private file: CostBudgetFile) {}

  static async open(
    dir: string,
    prereg: ToolCallEfficiencyPreregistrationV2,
    opts: { allowCreate: boolean; now?: () => number },
  ): Promise<CostBudget> {
    const clock = opts.now ?? (() => Date.now());
    const path = join(dir, COST_BUDGET_FILENAME);
    const caps: CostBudgetCapsV2 = {
      maxInputTokens: prereg.budget.maxInputTokens,
      maxOutputTokens: prereg.budget.maxOutputTokens,
      maxTotalTokens: prereg.budget.maxTotalTokens,
      maxToolCalls: prereg.budget.maxToolCalls,
      maxDurationMs: prereg.budget.maxDurationMs,
      maxUsdMicros: prereg.budget.maxUsdMicros,
      maxModelCalls: prereg.budget.campaignWorstCaseModelCalls,
    };
    await mkdir(dir, { recursive: true });
    return withR97CampaignLock(dir, async () => {
      let raw: string | null = null;
      try {
        raw = await readFile(path, "utf8");
      } catch (err) {
        // Distinguish a genuinely ABSENT ledger from an unreadable/permission-
        // denied one. Only ENOENT means "a brand new campaign may create it";
        // EACCES/EPERM/EISDIR are real failures that must NOT be read as "fresh".
        if ((err as NodeJS.ErrnoException).code === "ENOENT") raw = null;
        else throw new Error(`cost budget could not be read in ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (raw === null) {
        if (!opts.allowCreate) {
          throw new Error(`cost budget missing for this campaign in ${dir} — a resume must never create a fresh allowance`);
        }
        const file: CostBudgetFile = {
          schemaVersion: TOOL_CALL_EFFICIENCY_COST_BUDGET_SCHEMA,
          preregistrationDigest: prereg.preregistrationDigest,
          caps,
          // R3/F4 — the ONE campaign deadline, frozen here and never re-created.
          openedAtMs: clock(),
          campaignDeadlineAtMs: clock() + caps.maxDurationMs,
          deadlineSource: "created",
          charged: { inputTokens: 0, outputTokens: 0, totalTokens: 0, toolCalls: 0, durationMs: 0, usdMicros: 0, unknownCalls: 0 },
          reserved: { ...ZERO_RESERVATION },
          reservations: {},
          // N7/F3 — a ledger THIS build creates declares its per-request journal
          // section immediately, so "a fresh ledger that made no request" is
          // distinguishable from "a legacy ledger that has no journal at all".
          // Without this an empty v2 ledger reads as legacy and a corroborated
          // zero could never be recognised as one.
          journal: { schemaVersion: TOOL_CALL_EFFICIENCY_COST_JOURNAL_SCHEMA, entries: [] },
        };
        await writeAtomic(path, file);
        return new CostBudget(dir, file);
      }
      let parsed: CostBudgetFile;
      try {
        parsed = JSON.parse(raw) as CostBudgetFile;
      } catch {
        // Corrupt bytes are a LOSS, never a fresh allowance.
        throw new Error(`cost budget in ${dir} is not valid JSON — refusing to treat a corrupt ledger as a new campaign`);
      }
      if (parsed.schemaVersion !== TOOL_CALL_EFFICIENCY_COST_BUDGET_SCHEMA) {
        throw new Error(`cost budget schema ${String(parsed.schemaVersion)} is not ${TOOL_CALL_EFFICIENCY_COST_BUDGET_SCHEMA}`);
      }
      if (parsed.preregistrationDigest !== prereg.preregistrationDigest) {
        throw new Error("cost budget belongs to a different pre-registration digest — refusing to reuse it");
      }
      if (stableStringify(parsed.caps) !== stableStringify(caps)) {
        throw new Error("cost budget caps do not match the pre-registration — refusing to reuse it");
      }
      parsed.reserved = { ...ZERO_RESERVATION, ...(parsed.reserved ?? {}) };
      parsed.reservations = parsed.reservations ?? {};
      // R3/F4 — the deadline is REUSED, never re-created: a resume keeps whatever
      // is left. A legacy file that predates the field is treated as ALREADY
      // EXPIRED (never as a fresh window) and the migration is persisted so the
      // fact is durable. An existing deadline field is left byte-identical.
      const parsedDeadline = (parsed as { campaignDeadlineAtMs?: unknown }).campaignDeadlineAtMs;
      const parsedOpened = (parsed as { openedAtMs?: unknown }).openedAtMs;
      if (typeof parsedDeadline === "number" && Number.isFinite(parsedDeadline)) {
        if (typeof parsedOpened !== "number" || Number.isFinite(parsedOpened) === false) {
          parsed.openedAtMs = clock();
          await writeAtomic(path, parsed);
        }
      } else {
        parsed.campaignDeadlineAtMs = clock();
        parsed.deadlineSource = "legacy-missing-expired";
        if (typeof parsedOpened !== "number" || Number.isFinite(parsedOpened) === false) parsed.openedAtMs = clock();
        await writeAtomic(path, parsed);
      }
      return new CostBudget(dir, parsed);
    });
  }

  view(): CostBudgetView {
    const c = this.file.charged;
    const caps = this.file.caps;
    const r = this.file.reserved;
    // A dimension is exhausted when charged+reserved is at/over its cap.
    const at = (charged: number, reserved: number, max: number): boolean => charged + reserved >= max;
    const exhaustedDimensions: string[] = [];
    if (at(c.inputTokens, r.inputTokens, caps.maxInputTokens)) exhaustedDimensions.push("inputTokens");
    if (at(c.outputTokens, r.outputTokens, caps.maxOutputTokens)) exhaustedDimensions.push("outputTokens");
    if (at(c.totalTokens, r.inputTokens + r.outputTokens, caps.maxTotalTokens)) exhaustedDimensions.push("totalTokens");
    if (at(c.toolCalls, r.toolCalls, caps.maxToolCalls)) exhaustedDimensions.push("toolCalls");
    if (at(c.durationMs, r.durationMs, caps.maxDurationMs)) exhaustedDimensions.push("durationMs");
    if (caps.maxUsdMicros !== null && at(c.usdMicros, r.usdMicros, caps.maxUsdMicros)) exhaustedDimensions.push("usdMicros");
    return { ...this.file, exhausted: exhaustedDimensions.length > 0, exhaustedDimensions };
  }

  /** True when a call may NOT leave: any dimension is already at/over cap. */
  cannotAffordMore(): { refused: boolean; reason: string } {
    const v = this.view();
    if (v.exhausted) return { refused: true, reason: `${v.exhaustedDimensions.join(", ")} at cap` };
    return { refused: false, reason: "" };
  }

  /**
   * N7/F3 — bind (or clear) the identity every FOLLOWING attempt is attributed
   * to. Binding a DIFFERENT arm run while one is already bound is refused: an
   * in-flight request must never be re-attributed to another arm.
   */
  bindJournalScope(scope: CostJournalScope | null): void {
    if (scope === null) {
      this.journalScope = null;
      return;
    }
    const current = this.journalScope;
    if (current !== null) {
      if (
        current.campaignDigest !== scope.campaignDigest
        || current.armRunId !== scope.armRunId
        || current.arm !== scope.arm
        || current.caseId !== scope.caseId
        || current.repetition !== scope.repetition
      ) {
        throw new Error(
          `cost journal scope is already bound to ${current.arm} ${current.armRunId} — refusing to re-attribute in-flight requests to ${scope.arm} ${scope.armRunId}`,
        );
      }
      return;
    }
    this.journalScope = { ...scope };
  }

  /** The currently bound arm-run scope, or null when nothing is bound. */
  currentJournalScope(): CostJournalScope | null {
    return this.journalScope === null ? null : { ...this.journalScope };
  }

  /**
   * Append ONE billed physical attempt to the per-request journal.
   *
   * The entry's charged amount is DERIVED from its basis (measured tokens, or the
   * conservative upper bound), so the sum of entries can be checked against the
   * ledger's own `charged.totalTokens`. Duplicate identities are refused:
   * the same `reservationId` may appear once — attributed to exactly one arm —
   * and `(armRunId, requestId, attemptId)` may appear once.
   *
   * Without a bound scope this REFUSES: an unattributable billed attempt must not
   * silently vanish from the per-arm comparison.
   */
  async recordJournalAttempt(attempt: CostJournalAttempt): Promise<CostJournalEntry> {
    const scope = this.journalScope;
    if (scope === null) {
      throw new Error("cost journal: no arm-run scope is bound — refusing to record an unattributable billed attempt");
    }
    const problems = costJournalEntryProblems(attempt);
    if (problems.length > 0) throw new Error(`cost journal: ${problems.join("; ")}`);
    const entry: CostJournalEntry = {
      schemaVersion: TOOL_CALL_EFFICIENCY_COST_JOURNAL_SCHEMA,
      campaignDigest: scope.campaignDigest,
      armRunId: scope.armRunId,
      arm: scope.arm,
      caseId: scope.caseId,
      repetition: scope.repetition,
      requestId: attempt.requestId,
      attemptId: attempt.attemptId,
      reservationId: attempt.reservationId,
      costReservationId: attempt.costReservationId,
      basis: attempt.basis,
      inputTokens: attempt.inputTokens,
      outputTokens: attempt.outputTokens,
      reservedInputTokens: attempt.reservedInputTokens,
      reservedOutputTokens: attempt.reservedOutputTokens,
      chargedTotalTokens: chargedTokensOf(attempt),
      outcomeUnknown: attempt.outcomeUnknown === true,
      loggedAt: Date.now(),
    };
    await withR97CampaignLock(this.dir, async () => {
      const file = JSON.parse(await readFile(join(this.dir, COST_BUDGET_FILENAME), "utf8")) as CostBudgetFile;
      if (file.preregistrationDigest !== entry.campaignDigest) {
        throw new Error(
          "cost journal: the bound scope's campaign digest is not this ledger's pre-registration — refusing a cross-campaign attribution",
        );
      }
      const journal = file.journal ?? { schemaVersion: TOOL_CALL_EFFICIENCY_COST_JOURNAL_SCHEMA, entries: [] };
      if (journal.schemaVersion !== TOOL_CALL_EFFICIENCY_COST_JOURNAL_SCHEMA) {
        throw new Error(`cost journal schema ${String(journal.schemaVersion)} is not ${TOOL_CALL_EFFICIENCY_COST_JOURNAL_SCHEMA}`);
      }
      const duplicateAttempt = journal.entries.find(
        (e) => e.armRunId === entry.armRunId && e.requestId === entry.requestId && e.attemptId === entry.attemptId,
      );
      if (duplicateAttempt !== undefined) {
        throw new Error(
          `cost journal: attempt ${entry.requestId}#${entry.attemptId} of ${entry.armRunId} is already recorded — refusing to charge one physical attempt twice`,
        );
      }
      const duplicateReservation = journal.entries.find((e) => e.reservationId === entry.reservationId);
      if (duplicateReservation !== undefined) {
        throw new Error(
          `cost journal: reservation ${entry.reservationId} is already attributed to ${duplicateReservation.arm} ${duplicateReservation.armRunId} — a physical attempt is charged exactly once and never to two arms`,
        );
      }
      const duplicateCostReservation = journal.entries.find((e) => e.costReservationId === entry.costReservationId);
      if (duplicateCostReservation !== undefined) {
        throw new Error(`cost journal: cost reservation ${entry.costReservationId} is already recorded — refusing a duplicate settlement attribution`);
      }
      journal.entries.push(entry);
      file.journal = journal;
      await writeAtomic(join(this.dir, COST_BUDGET_FILENAME), file);
      this.file = file;
    });
    return entry;
  }

  /** The journal as currently persisted (raw entries, in write order). */
  journalEntries(): CostJournalEntry[] {
    return [...(this.file.journal?.entries ?? [])];
  }

  /**
   * R3/F4 — the campaign's ONE durable wall-clock deadline (epoch ms). Frozen at
   * creation and reused by every later open, so a resume keeps only the time that
   * is left instead of receiving a fresh `maxDurationMs`.
   */
  deadlineAtMs(): number {
    return this.file.campaignDeadlineAtMs;
  }

  /**
   * RESERVE a conservative per-call upper bound BEFORE the request is sent. The
   * reservation is refused when charged+reserved+delta would exceed ANY cap —
   * the call is then never dispatched. Durable and same-lock.
   */
  async reserve(delta: CostReservationDelta): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
    for (const [k, v] of Object.entries(delta)) {
      if (!Number.isSafeInteger(v) || v < 0) return { ok: false, reason: `reservation ${k} must be a non-negative safe integer` };
    }
    return withR97CampaignLock(this.dir, async () => {
      const file = JSON.parse(await readFile(join(this.dir, COST_BUDGET_FILENAME), "utf8")) as CostBudgetFile;
      file.reserved = { ...ZERO_RESERVATION, ...(file.reserved ?? {}) };
      file.reservations = file.reservations ?? {};
      const c = file.charged;
      const r = file.reserved;
      const caps = file.caps;
      const totalDelta = delta.inputTokens + delta.outputTokens;
      const over = (charged: number, reserved: number, add: number, max: number): boolean => charged + reserved + add > max;
      let reason = "";
      if (over(c.inputTokens, r.inputTokens, delta.inputTokens, caps.maxInputTokens)) reason = "input-token cap would be exceeded";
      else if (over(c.outputTokens, r.outputTokens, delta.outputTokens, caps.maxOutputTokens)) reason = "output-token cap would be exceeded";
      else if (over(c.totalTokens, r.inputTokens + r.outputTokens, totalDelta, caps.maxTotalTokens)) reason = "total-token cap would be exceeded";
      else if (over(c.toolCalls, r.toolCalls, delta.toolCalls, caps.maxToolCalls)) reason = "tool-call cap would be exceeded";
      else if (over(c.durationMs, r.durationMs, delta.durationMs, caps.maxDurationMs)) reason = "duration cap would be exceeded";
      else if (caps.maxUsdMicros !== null && over(c.usdMicros, r.usdMicros, delta.usdMicros, caps.maxUsdMicros)) reason = "USD cap would be exceeded";
      if (reason !== "") return { ok: false as const, reason };
      const id = `res-${process.pid}-${Date.now()}-${(reservationCounter += 1)}`;
      file.reservations[id] = { ...delta };
      r.inputTokens += delta.inputTokens;
      r.outputTokens += delta.outputTokens;
      r.toolCalls += delta.toolCalls;
      r.durationMs += delta.durationMs;
      r.usdMicros += delta.usdMicros;
      await writeAtomic(join(this.dir, COST_BUDGET_FILENAME), file);
      this.file = file;
      return { ok: true as const, id };
    });
  }

  /** Release a reservation whose call was never dispatched (no usage). */
  async release(id: string): Promise<void> {
    await this.settle(id, {});
  }

  /**
   * Settle a reservation against the ACTUAL usage observed: the reservation is
   * released and the real numbers are charged, in ONE locked transaction.
   *
   * B2 — the settle is now REFUSABLE, not a blind `+=`:
   *   - an id that was never reserved is refused (the old code settled it as a
   *     ZERO-held "free" charge, which is a ledger forgery);
   *   - a negative / NaN / non-integer actual is refused (a negative would
   *     silently REFUND the ledger);
   *   - repeated settle of the SAME id is refused by the same rule (the id is
   *     consumed by the first settle);
   *   - a token / USD / tool-call actual that exceeds the HELD pre-send upper
   *     bound is refused: the bound was supposed to dominate the real cost, so an
   *     overrun is a bound violation that must freeze the campaign, never be
   *     charged as if it were planned. Duration is EXCLUDED from that bound check
   *     because
   *     its reservation is an explicit scheduling SHARE (a call's wall-clock is
   *     not provable in advance) — it is charged from the actual elapsed time
   *     and binds by refusing the NEXT call once charged+reserved reaches the
   *     cap. An unknown outcome must charge the reserved upper bound (never a
   *     refund).
   */
  async settle(id: string, actual: { inputTokens?: number; outputTokens?: number; toolCalls?: number; durationMs?: number; usdMicros?: number; unknown?: boolean }): Promise<CostBudgetView> {
    // Static validation is done OUTSIDE the lock: a malformed call must never
    // take the campaign lock, and a NaN/negative can never enter the ledger.
    const dims = ["inputTokens", "outputTokens", "toolCalls", "durationMs", "usdMicros"] as const;
    for (const k of dims) {
      const v = actual[k];
      if (v === undefined) continue;
      if (!Number.isSafeInteger(v) || v < 0) {
        throw new Error(`cost budget settle refused: ${k} must be a non-negative safe integer (got ${String(v)})`);
      }
    }
    return withR97CampaignLock(this.dir, async () => {
      const file = JSON.parse(await readFile(join(this.dir, COST_BUDGET_FILENAME), "utf8")) as CostBudgetFile;
      file.reserved = { ...ZERO_RESERVATION, ...(file.reserved ?? {}) };
      file.reservations = file.reservations ?? {};
      const held = file.reservations[id];
      if (held === undefined) {
        // A settle for an id nobody reserved would otherwise be charged with a
        // zero-held reservation — i.e. a FREE call. That is a ledger loss, so it
        // is refused. This also covers a REPEATED settle: the first one deleted
        // the id, so the second finds nothing and is refused instead of charging
        // twice.
        throw new Error(`cost budget settle refused: reservation id ${id} is not outstanding (unknown, already settled, or never reserved)`);
      }
      // B2/N4 — the held reservation is the trusted pre-send upper bound.
      // Token/USD actuals may not exceed it; a real overrun freezes the campaign
      // instead of being charged (see method docstring for the duration
      // exception). `toolCalls` is INCLUDED: the tool dimension is a held upper
      // bound exactly like tokens and USD, so the old omission let a settle charge
      // an arbitrarily larger tool-call count than was ever reserved.
      for (const k of ["inputTokens", "outputTokens", "toolCalls", "usdMicros"] as const) {
        const v = actual[k];
        if (v !== undefined && v > held[k]) {
          throw new Error(
            `cost budget settle refused: ${k} actual ${v} exceeds the pre-send reservation ${held[k]} — the bound did not dominate the cost, so the campaign is frozen rather than charged`,
          );
        }
      }
      file.reserved.inputTokens -= held.inputTokens;
      file.reserved.outputTokens -= held.outputTokens;
      file.reserved.toolCalls -= held.toolCalls;
      file.reserved.durationMs -= held.durationMs;
      file.reserved.usdMicros -= held.usdMicros;
      delete file.reservations[id];
      const inputTokens = actual.inputTokens ?? 0;
      const outputTokens = actual.outputTokens ?? 0;
      file.charged.inputTokens += inputTokens;
      file.charged.outputTokens += outputTokens;
      file.charged.totalTokens += inputTokens + outputTokens;
      file.charged.toolCalls += actual.toolCalls ?? 0;
      file.charged.durationMs += actual.durationMs ?? 0;
      file.charged.usdMicros += actual.usdMicros ?? 0;
      if (actual.unknown === true) file.charged.unknownCalls += 1;
      await writeAtomic(join(this.dir, COST_BUDGET_FILENAME), file);
      this.file = file;
      return this.view();
    });
  }

  /**
   * Charge actual usage without a prior reservation (legacy/tests). Atomic.
   *
   * N4 — this API used to write ANY value: it neither validated its dimensions
   * nor enforced a single cap, so a NEGATIVE charge silently credited the
   * campaign and an over-cap charge was durably recorded as if the bound had been
   * respected. It now behaves like `reserve` with respect to the caps
   * (charged + reserved + delta must fit EVERY dimension) and refuses with
   * `BUDGET_EXHAUSTED` instead of writing. Unknown tool state is charged
   * CONSERVATIVELY: callers pass the count actually observed, never a refund.
   */
  async charge(delta: { inputTokens?: number; outputTokens?: number; toolCalls?: number; durationMs?: number; usdMicros?: number; unknown?: boolean }): Promise<CostBudgetView> {
    // Static validation OUTSIDE the lock, exactly like `settle`: a malformed
    // charge must never take the campaign lock.
    const dims = ["inputTokens", "outputTokens", "toolCalls", "durationMs", "usdMicros"] as const;
    for (const k of dims) {
      const v = delta[k];
      if (v === undefined) continue;
      if (!Number.isSafeInteger(v) || v < 0) {
        throw new Error(`cost budget charge refused: ${k} must be a non-negative safe integer (got ${String(v)})`);
      }
    }
    return withR97CampaignLock(this.dir, async () => {
      const file = JSON.parse(await readFile(join(this.dir, COST_BUDGET_FILENAME), "utf8")) as CostBudgetFile;
      file.reserved = { ...ZERO_RESERVATION, ...(file.reserved ?? {}) };
      file.reservations = file.reservations ?? {};
      const c = file.charged;
      const r = file.reserved;
      const caps = file.caps;
      const inputTokens = delta.inputTokens ?? 0;
      const outputTokens = delta.outputTokens ?? 0;
      const toolCalls = delta.toolCalls ?? 0;
      const durationMs = delta.durationMs ?? 0;
      const usdMicros = delta.usdMicros ?? 0;
      const totalDelta = inputTokens + outputTokens;
      const over = (charged: number, reserved: number, add: number, max: number): boolean => charged + reserved + add > max;
      let reason = "";
      if (over(c.inputTokens, r.inputTokens, inputTokens, caps.maxInputTokens)) reason = "input-token cap would be exceeded";
      else if (over(c.outputTokens, r.outputTokens, outputTokens, caps.maxOutputTokens)) reason = "output-token cap would be exceeded";
      else if (over(c.totalTokens, r.inputTokens + r.outputTokens, totalDelta, caps.maxTotalTokens)) reason = "total-token cap would be exceeded";
      else if (over(c.toolCalls, r.toolCalls, toolCalls, caps.maxToolCalls)) reason = "tool-call cap would be exceeded";
      else if (over(c.durationMs, r.durationMs, durationMs, caps.maxDurationMs)) reason = "duration cap would be exceeded";
      else if (caps.maxUsdMicros !== null && over(c.usdMicros, r.usdMicros, usdMicros, caps.maxUsdMicros)) reason = "USD cap would be exceeded";
      // Refuse BEFORE mutating, so a refused charge writes nothing at all.
      if (reason !== "") throw new Error(`E4-N3: BUDGET_EXHAUSTED: charge refused — ${reason}`);
      c.inputTokens += inputTokens;
      c.outputTokens += outputTokens;
      c.totalTokens += inputTokens + outputTokens;
      c.toolCalls += toolCalls;
      c.durationMs += durationMs;
      c.usdMicros += usdMicros;
      if (delta.unknown === true) c.unknownCalls += 1;
      await writeAtomic(join(this.dir, COST_BUDGET_FILENAME), file);
      this.file = file;
      return this.view();
    });
  }
}

/**
 * Atomically replace `path` with `value`.
 *
 * The previous version did `rm(path)` then `rename(tmp, path)`, which leaves a
 * window where the ledger file does not exist (a crash there would look like a
 * fresh campaign). `rename` over an existing file is atomic on POSIX AND on
 * Windows (libuv uses MOVEFILE_REPLACE_EXISTING), so the delete window is
 * removed entirely; the temp file is fsynced first so the rename cannot expose
 * a partially written ledger.
 */
async function writeAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const data = `${stableStringify(value)}\n`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(data, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    // A failed cleanup must NOT mask the rename failure, but it must not be a
    // silent swallow either (P14-6): report the leftover temp file, then
    // re-throw the original error.
    try {
      await rm(tmp, { force: true });
    } catch (cleanupErr) {
      process.stderr.write(
        `[degraded] cost-ledger temp cleanup failed for ${tmp}: ${
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        }\n`,
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Budgeted provider (calls via R97 ledger, other dimensions via CostBudget)
// ---------------------------------------------------------------------------

export interface FormalBudgetStats {
  logicalCalls: number;
  refusedCalls: number;
  unknownCalls: number;
  retries: number;
  chargedInputTokens: number;
  chargedOutputTokens: number;
  chargedUsdMicros: number;
  /** N4 — tool calls the run actually made and that were charged to the budget. */
  chargedToolCalls: number;
  /**
   * R3/F4 — the DIAGNOSTIC "how many tools the MODEL DECLARED in its completed
   * responses". This is a different fact from "tools actually dispatched", it is
   * NEVER charged to the tool dimension here (the pre-dispatch reservation at the
   * real dispatch point does that), and the two values are expected to differ:
   * a declared tool that is never dispatched must not appear as consumption.
   */
  declaredToolCalls: number;
}

/** R3/F4 — the stable reason codes the durable tool-dispatch budget refuses with. */
export const TOOL_DISPATCH_BUDGET_EXHAUSTED = "TOOL_BUDGET_EXHAUSTED";
export const TOOL_DISPATCH_DEADLINE_EXCEEDED = "CAMPAIGN_DEADLINE_EXCEEDED";

/**
 * R3/F4 — the durable PRE-DISPATCH tool budget. It implements the STRUCTURAL
 * capability `packages/tools` declares (no import in either direction), and it is
 * bound by the host into `ToolOrchestrator({ toolBudget })`.
 *
 * One REAL dispatch = one `{ toolCalls: 1 }` reservation on the SAME durable,
 * same-lock `CostBudget` whose `maxToolCalls` cap it enforces. `reserve()`
 * therefore refuses BEFORE the tool body runs, and the campaign deadline is
 * checked in the same place, so no tool starts after it.
 */
export interface DurableToolDispatchBudget {
  reserve(request: {
    toolCallId: string;
    tool: string;
    sessionId: string;
    turnId?: string;
    readOnly: boolean;
    sideEffectScope: string;
  }): Promise<{
    ok: boolean;
    reason?: string;
    settle(outcome: "dispatched" | "not_executed" | "unknown"): Promise<void>;
  }>;
  /** MEASURED counters for evidence; never a substitute for the durable journal. */
  stats(): {
    reserved: number;
    dispatched: number;
    released: number;
    unknown: number;
    capRefused: number;
    deadlineRefused: number;
  };
}

export function createDurableToolDispatchBudget(opts: {
  costBudget: CostBudget;
  deadlineAtMs: number | null;
  now?: () => number;
}): DurableToolDispatchBudget {
  const clock = opts.now ?? (() => Date.now());
  const counters = { reserved: 0, dispatched: 0, released: 0, unknown: 0, capRefused: 0, deadlineRefused: 0 };
  return {
    stats: () => ({ ...counters }),
    async reserve() {
      if (opts.deadlineAtMs !== null && clock() >= opts.deadlineAtMs) {
        counters.deadlineRefused += 1;
        return { ok: false, reason: TOOL_DISPATCH_DEADLINE_EXCEEDED, async settle() {} };
      }
      const reserved = await opts.costBudget.reserve({ inputTokens: 0, outputTokens: 0, toolCalls: 1, durationMs: 0, usdMicros: 0 });
      if (!reserved.ok) {
        counters.capRefused += 1;
        return { ok: false, reason: TOOL_DISPATCH_BUDGET_EXHAUSTED, async settle() {} };
      }
      counters.reserved += 1;
      let settled = false;
      return {
        ok: true,
        async settle(outcome) {
          if (settled) return;
          settled = true;
          if (outcome === "dispatched") {
            counters.dispatched += 1;
            // SETTLE (not `charge`): the held `{ toolCalls: 1 }` reservation is
            // replaced by the actual one, so the cap is checked exactly once and
            // the reservation cannot be double-counted.
            await opts.costBudget.settle(reserved.id, { toolCalls: 1 });
            return;
          }
          if (outcome === "unknown") {
            counters.unknown += 1;
            // A dispatch whose effects nobody saw is charged at its upper bound
            // and NEVER refunded.
            await opts.costBudget.settle(reserved.id, { toolCalls: 1, unknown: true });
            return;
          }
          counters.released += 1;
          await opts.costBudget.release(reserved.id);
        },
      };
    },
  };
}

/**
 * Wrap a provider so every logical call reserves through the R97 ledger before
 * it leaves, bills provider-internal retries as further calls, and settles the
 * token/USD dimensions from the observed usage. A call refused by the ledger or
 * the cost budget never reaches the inner provider.
 */
export function createFormalBudgetedProvider(opts: {
  provider: ModelProvider;
  ledger: R97BudgetLedger;
  costBudget: CostBudget;
  arm: string;
  usdMicrosPerCall: number | null;
  /**
   * R3/F4 — the campaign's ONE durable deadline. Every physical send (the initial
   * request AND every retry) is refused once it has passed, so no HTTP request
   * leaves after the deadline. `null` = no deadline.
   */
  deadlineAtMs?: number | null;
  /** R3/F4 — injectable clock for the deadline check (offline-testable). */
  now?: () => number;
}): { provider: ModelProvider; stats: FormalBudgetStats } {
  const clock = opts.now ?? (() => Date.now());
  const deadlineAtMs = opts.deadlineAtMs ?? null;
  const deadlinePassed = (): boolean => deadlineAtMs !== null && clock() >= deadlineAtMs;
  const stats: FormalBudgetStats = {
    logicalCalls: 0,
    refusedCalls: 0,
    unknownCalls: 0,
    retries: 0,
    chargedInputTokens: 0,
    chargedOutputTokens: 0,
    chargedUsdMicros: 0,
    chargedToolCalls: 0,
    declaredToolCalls: 0,
  };
  /**
   * N7/F3 — the per-arm-run logical request counter that names each request in
   * the cost journal (`<armRunId>:r<N>`). It lives with the provider so the
   * names are unique across the whole campaign.
   */
  const journalRequestCounters = new Map<string, number>();

  const wrapped: ModelProvider = {
    id: opts.provider.id,
    async listModels() {
      return opts.provider.listModels();
    },
    createClient(model: ModelRef, config: ProviderConfig) {
      const inner = opts.provider.createClient(model, config);
      return {
        async *generate(request: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelEvent> {
          const usdCeiling = opts.usdMicrosPerCall ?? 0;
          // N7/F3 — the journal identity of THIS logical request. It is taken from
          // the arm-run scope the campaign driver bound before it invoked this arm
          // run. With no bound scope there is no attribution, and the aggregate
          // will refuse to call the campaign's per-arm cost proven (never `0`).
          const journalScope = opts.costBudget.currentJournalScope();
          let journalRequestId: string | null = null;
          if (journalScope !== null) {
            const next = (journalRequestCounters.get(journalScope.armRunId) ?? 0) + 1;
            journalRequestCounters.set(journalScope.armRunId, next);
            journalRequestId = `${journalScope.armRunId}:r${next}`;
          }
          // The conservative per-call upper bound reserved for EVERY physical
          // attempt (the initial send AND each internal retry — B2). A retry is a
          // real second HTTP request that may be billed, so it must fit the frozen
          // budget on EVERY dimension before it leaves.
          const costDeltaForAttempt = (): CostReservationDelta => ({
            inputTokens: FORMAL_PER_CALL_INPUT_TOKEN_CEILING,
            outputTokens: FORMAL_PER_CALL_OUTPUT_TOKEN_CEILING,
            toolCalls: 0,
            durationMs: perCallDurationMsCeiling(opts.costBudget.view().caps),
            usdMicros: usdCeiling,
          });
          const reserveCost = async (what: string): Promise<string> => {
            const r = await opts.costBudget.reserve(costDeltaForAttempt());
            if (!r.ok) {
              stats.refusedCalls += 1;
              throw new Error(`E4-N3: BUDGET_EXHAUSTED: ${what} cost reservation refused (${r.reason}) — refusing to send a call the frozen budget cannot afford`);
            }
            return r.id;
          };
          /**
           * N7/F3 — record ONE billed physical attempt in the durable journal with
           * its arm-run identity (from the bound scope), its request/attempt names
           * and its R97 reservation id. A MEASURED attempt contributes its real
           * tokens; an attempt whose real usage was never observed contributes its
           * CONSERVATIVE bound, flagged `outcomeUnknown`, never as consumption.
           */
          const recordAttempt = async (entry: {
            attemptId: number;
            reservationId: string;
            costReservationId: string;
            basis: CostJournalBasis;
            inputTokens: number | null;
            outputTokens: number | null;
            reservedInputTokens: number | null;
            reservedOutputTokens: number | null;
            outcomeUnknown: boolean;
          }): Promise<void> => {
            if (journalScope === null || journalRequestId === null) return;
            await opts.costBudget.recordJournalAttempt({ requestId: journalRequestId, ...entry });
          };

          // A4/B2 — RESERVE every billed dimension's conservative per-call upper
          // bound BEFORE the request is sent. If the frozen budget cannot prove
          // the call fits, it is never dispatched: the cap is never exceeded by
          // an unreserved request.
          const costReservationId = await reserveCost("initial");
          const reserved = await opts.ledger.reserve(opts.arm, 1);
          if (!reserved.ok || reserved.reservationId === null) {
            // The call-ledger reservation was refused: release the cost
            // reservation we just took so it cannot be left stranded.
            await opts.costBudget.release(costReservationId);
            stats.refusedCalls += 1;
            throw new Error(`E4-N3: BUDGET_EXHAUSTED: ${reserved.reason} — refusing to send an unbilled call`);
          }
          const reservationId = reserved.reservationId;
          stats.logicalCalls += 1;

          // Every physical attempt's cost reservation id, in send order. The
          // FIRST belongs to the request whose usage the stream reports; the rest
          // belong to retries and are settled at their reserved upper bound.
          const costReservationIds: string[] = [costReservationId];
          // N7/F3 — the R97 call-ledger reservation of EACH physical attempt, in
          // the same send order, so every journal entry names exactly one billable
          // unit (and therefore can never be attributed to two arms).
          const attemptLedgerIds: string[] = [reservationId];
          let entered = false;
          let completed = false;
          let inputTokens = 0;
          let outputTokens = 0;
          let usdMicros = 0;
          let retries = 0;
          let settleStarted = false;
          const startedAt = Date.now();

          const settle = async (): Promise<void> => {
            if (settleStarted) return;
            settleStarted = true;
            const durationMs = Math.max(0, Date.now() - startedAt);
            const delta = costDeltaForAttempt();
            const primary = costReservationIds[0];
            if (primary === undefined) {
              // Unreachable: the initial reservation is pushed before the stream
              // starts. Guarded so a future edit cannot settle an absent id.
              throw new Error("E4-N3: BUDGET_STATE_REJECTED: no cost reservation exists for a dispatched call");
            }
            const extraAttempts = costReservationIds.slice(1);
            if (!entered) {
              await opts.ledger.abandon(reservationId);
              // Nothing was sent: release every cost reservation in full.
              for (const id of costReservationIds) await opts.costBudget.release(id);
              return;
            }
            if (!completed) {
              await opts.ledger.markUnknown(reservationId);
              stats.unknownCalls += 1;
              // A dispatched call whose outcome nobody saw may already be
              // billed: settle at the RESERVED upper bound (never a refund).
              for (let i = 0; i < costReservationIds.length; i += 1) {
                const id = costReservationIds[i]!;
                await opts.costBudget.settle(id, { ...delta, unknown: true });
                // N7/F3 — the attempt WAS dispatched; its real usage is unknown, so
                // its cost is the conservative reservation. It is recorded as such
                // and can therefore never be read as measured consumption.
                await recordAttempt({
                  attemptId: i,
                  reservationId: attemptLedgerIds[i]!,
                  costReservationId: id,
                  basis: "RESERVED_UPPER_BOUND",
                  inputTokens: null,
                  outputTokens: null,
                  reservedInputTokens: delta.inputTokens,
                  reservedOutputTokens: delta.outputTokens,
                  outcomeUnknown: true,
                });
              }
              return;
            }
            await opts.ledger.commit(reservationId, 1, retries);
            const chargedMicros = Math.max(usdMicros, usdCeiling);
            // R3/F4 — STATE MACHINE: a failure between `ledger.commit` and the cost
            // settlement must NOT leave "model ledger committed / cost unsettled"
            // silently behind. It is recorded as `unknown` and the campaign STOPS.
            let view: CostBudgetView;
            try {
              view = await opts.costBudget.settle(primary, {
                inputTokens,
                outputTokens,
                durationMs,
                usdMicros: chargedMicros,
              });
            } catch (err) {
              stats.unknownCalls += 1;
              throw new Error(
                `E4-R3: BUDGET_STATE_REJECTED: the model ledger committed reservation ${reservationId} but its cost settlement failed (${err instanceof Error ? err.message : String(err)}); recorded as unknown and stopping rather than continuing with an unsettled charge`,
              );
            }
            // N7/F3 — the initial send completed and its usage WAS observed: this
            // attempt contributes MEASURED tokens to its arm and to nothing else.
            // LEAD MERGE RESOLUTION: R3's state machine and R2's attribution are
            // both required here and neither replaces the other — the settlement is
            // guarded (R3), and the guarded-successful attempt is then attributed
            // to its arm (R2).
            await recordAttempt({
              attemptId: 0,
              reservationId: attemptLedgerIds[0]!,
              costReservationId: primary,
              basis: "MEASURED",
              inputTokens,
              outputTokens,
              reservedInputTokens: null,
              reservedOutputTokens: null,
              outcomeUnknown: false,
            });
            stats.chargedInputTokens += inputTokens;
            stats.chargedOutputTokens += outputTokens;
            stats.chargedUsdMicros += chargedMicros;
            void view;
            // R3/F4 — the TOOL dimension is NO LONGER charged here. This path used
            // to `charge` the tool calls the model DECLARED in its response, i.e.
            // an after-the-fact tally that could throw AFTER the ledger commit and
            // that counted tools that were never dispatched (F4). Tool quota is now
            // reserved at the REAL dispatch point
            // (`createDurableToolDispatchBudget` + `ToolOrchestrator.toolBudget`),
            // and the declared count is kept ONLY as a diagnostic
            // (`stats.declaredToolCalls`).
            // Each retry WAS a physical send. Its own usage is not separately
            // reported, so it is charged at its reserved upper bound — the
            // conservative settlement, never a refund. N7/F3 records it as a
            // RESERVED_UPPER_BOUND attempt (a bound, not consumption).
            for (let i = 0; i < extraAttempts.length; i += 1) {
              const id = extraAttempts[i]!;
              await opts.costBudget.settle(id, { ...delta, unknown: true });
              await recordAttempt({
                attemptId: i + 1,
                reservationId: attemptLedgerIds[i + 1]!,
                costReservationId: id,
                basis: "RESERVED_UPPER_BOUND",
                inputTokens: null,
                outputTokens: null,
                reservedInputTokens: delta.inputTokens,
                reservedOutputTokens: delta.outputTokens,
                outcomeUnknown: true,
              });
            }
          };

          /**
           * R3/F4 residual — the MID-STREAM half. The gates below cover a deadline
           * that has ALREADY passed (initial send and retry). Neither covers a
           * stream entered while the deadline is still in the future that then
           * STALLS past it: without a timer nothing aborts the caller's signal, so
           * a hung provider outlives the campaign deadline and the unit never
           * converges (§R3 怎么验收: "截止后没有新的 HTTP 或工具启动，进程最终可收敛").
           *
           * The caller owns `signal`; we do not replace it. We arm one timer that
           * fires AT the deadline and aborts a linked controller, and we observe
           * that controller for the rest of this generator. The timer is cleared in
           * the `finally` so a prompt call leaves no pending handle.
           */
          const midStreamAbort = new AbortController();
          const onCallerAbort = (): void => midStreamAbort.abort();
          if (signal.aborted) onCallerAbort();
          else signal.addEventListener("abort", onCallerAbort, { once: true });
          let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
          let deadlineAborted = false;
          if (deadlineAtMs !== null) {
            const remaining = deadlineAtMs - clock();
            if (remaining > 0) {
              deadlineTimer = setTimeout(() => {
                deadlineAborted = true;
                midStreamAbort.abort();
              }, remaining);
              // A pending aborter must never hold the event loop open on its own.
              if (typeof deadlineTimer === "object" && deadlineTimer !== null && "unref" in deadlineTimer) {
                (deadlineTimer as { unref: () => void }).unref();
              }
            }
          }

          try {
            // R3/F4 — THE DEADLINE GATE, before the initial physical send. Once the
            // single campaign deadline has passed, no new HTTP request leaves.
            if (deadlinePassed()) {
              // The `finally` below releases the cost reservation and abandons the
              // call-ledger reservation exactly once (`entered` is still false), so
              // this branch only refuses.
              stats.refusedCalls += 1;
              throw new Error(
                `E4-R3: ${TOOL_DISPATCH_DEADLINE_EXCEEDED}: the campaign deadline (${new Date(deadlineAtMs ?? 0).toISOString()}) passed before this request was sent — refusing to send after the deadline`,
              );
            }
            const stream = inner.generate(request, midStreamAbort.signal);
            entered = true;
            for await (const ev of stream) {
              // R3/F4 — the deadline fired while this stream was in flight (or the
              // caller cancelled). Stop consuming and surface the deadline as the
              // cause rather than reporting a truncated stream as a completion.
              if (deadlineAborted) {
                stats.refusedCalls += 1;
                throw new Error(
                  `E4-R3: ${TOOL_DISPATCH_DEADLINE_EXCEEDED}: the campaign deadline (${new Date(deadlineAtMs ?? 0).toISOString()}) passed while this stream was in flight — the in-flight request was aborted`,
                );
              }
              if (ev.type === "retry") {
                retries += 1;
                stats.retries += 1;
                // A retry is a NEW physical request that may be billed, so it
                // must take its OWN reservation — on BOTH the call ledger AND
                // every cost dimension — before it leaves. A refused reservation
                // must STOP the stream; silently continuing would let an
                // unbilled request leave the process. The reservations are taken
                // at the `retry` event, which the client emits immediately BEFORE
                // the next fetch, so a refusal here aborts the generator before
                // that fetch runs. R3/F4 — the same deadline gate applies: a hung
                // retry may NOT resume sending after the deadline.
                if (deadlinePassed()) {
                  stats.refusedCalls += 1;
                  throw new Error(
                    `E4-R3: ${TOOL_DISPATCH_DEADLINE_EXCEEDED}: the campaign deadline passed before this retry could be sent — refusing to continue after the deadline`,
                  );
                }
                const retryCostId = await reserveCost("retry");
                const retryReservation = await opts.ledger.reserve(opts.arm, 1);
                if (!retryReservation.ok || retryReservation.reservationId === null) {
                  await opts.costBudget.release(retryCostId);
                  stats.refusedCalls += 1;
                  throw new Error(
                    `E4-N3: BUDGET_EXHAUSTED: retry reservation refused (${retryReservation.reason}) — refusing to continue an unbilled retry`,
                  );
                }
                await opts.ledger.commit(retryReservation.reservationId, 1, 1);
                costReservationIds.push(retryCostId);
                attemptLedgerIds.push(retryReservation.reservationId);
                stats.logicalCalls += 1;
              } else if (ev.type === "usage") {
                inputTokens = Math.max(inputTokens, ev.usage.inputTokens);
                outputTokens = Math.max(outputTokens, ev.usage.outputTokens);
                if (typeof ev.usage.estimatedCostUsd === "number" && ev.usage.estimatedCostUsd > 0) {
                  usdMicros = Math.round(ev.usage.estimatedCostUsd * 1_000_000);
                }
              } else if (ev.type === "completed") {
                completed = true;
                // R3/F4 — "how many tools the model DECLARED" is a DIAGNOSTIC. It is
                // recorded here and NEVER charged to the tool dimension: the real
                // dispatch point reserves and charges one unit per ACTUAL dispatch,
                // so a declared-but-never-dispatched tool cannot look like
                // consumption and a dispatch that ran without being declared still
                // pays.
                const declared = (ev.result as { toolCalls?: unknown } | undefined)?.toolCalls;
                if (Array.isArray(declared)) {
                  stats.declaredToolCalls += declared.length;
                }
              }
              yield ev;
            }
            // The stream ENDED. If the deadline fired while it was in flight the
            // abort is the cause, and a truncated response must not be reported as
            // a clean completion.
            if (deadlineAborted) {
              stats.refusedCalls += 1;
              throw new Error(
                `E4-R3: ${TOOL_DISPATCH_DEADLINE_EXCEEDED}: the campaign deadline (${new Date(deadlineAtMs ?? 0).toISOString()}) passed while this stream was in flight — the in-flight request was aborted`,
              );
            }
          } finally {
            if (deadlineTimer !== null) clearTimeout(deadlineTimer);
            signal.removeEventListener("abort", onCallerAbort);
            await settle();
          }
        },
      };
    },
  };
  return { provider: wrapped, stats };
}

// ---------------------------------------------------------------------------
// Formal run gate
// ---------------------------------------------------------------------------

export type FormalRunCode =
  | "OVERRIDE_REJECTED"
  | "PREREGISTRATION_INVALID"
  | "PREREGISTRATION_IDENTITY_DRIFT"
  | "AUTHORIZATION_INVALID"
  | "AUTHORIZATION_NOT_PAID"
  | "AUTHORIZATION_EXPIRED"
  | "AUTHORIZATION_NOT_YET_VALID"
  | "AUTHORIZATION_DIGEST_MISMATCH"
  | "AUTHORIZATION_SUBJECT_MISMATCH"
  | "AUTHORIZATION_CAP_MISMATCH"
  | "RESUME_NOT_ALLOWED"
  | "PRICING_UNKNOWN"
  | "PAID_WITHOUT_USD_CAP"
  | "FIXTURE_TRANSPORT_NOT_NON_BILLABLE"
  | "BUDGET_STATE_REJECTED";

export interface FormalRunRefusal {
  status: "REFUSED";
  code: FormalRunCode;
  reason: string;
  providerFactoryCalls: number;
  providerCalls: number;
}

export interface FormalRunAdmission {
  status: "ADMITTED";
  preregistrationDigest: string;
  plan: PairedExperimentPlan;
  ledger: R97BudgetLedger;
  costBudget: CostBudget;
  provider: ModelProvider;
  budgetStats: FormalBudgetStats;
  providerFactoryCalls: number;
  /**
   * R3/F4 — the durable PRE-DISPATCH tool budget this campaign must bind into its
   * `ToolOrchestrator` (`new ToolOrchestrator({ …, toolBudget: admission.toolDispatchBudget })`).
   * The binding is ONE line in the host composition root, which is why this is
   * returned here rather than constructed there: the durable implementation needs
   * the SAME `CostBudget` the gate just opened.
   */
  toolDispatchBudget: DurableToolDispatchBudget;
  /** R3/F4 — the campaign's ONE durable deadline (epoch ms). */
  campaignDeadlineAtMs: number;
}

export interface PreregisteredCampaignOptions {
  /** Raw pre-registration artifact bytes (never a parsed object). */
  preregistrationJson: string;
  /** Raw authorization artifact bytes (never a parsed object). */
  authorizationJson: string;
  /** The identity re-observed NOW, from the real source/config/cases. */
  observation: PreregisteredCampaignObservationV2;
  /** Ledger + cost-budget directory. */
  budgetDir: string;
  mode?: "auto" | "first-run" | "resume";
  now?: () => number;
  /** The provider factory. Called ONLY after every preflight passed. */
  makeProvider: () => ModelProvider | Promise<ModelProvider>;
  /**
   * R1/F1 — the TEST-HOST capability that admits the separately-identified
   * synthetic-fixture class. Only `createNonBillableFixtureTransport` produces a
   * value this option accepts; there is no JSON/env/marker/flag path to it, and
   * the production CLI never sets it.
   *
   * When present (and only then) a `fixtureMode` authorization is admissible, and
   * the gate uses the capability's OWN provider — `makeProvider` is never called,
   * so an operator's real credentials can never be combined with a fixture
   * admission. When absent, the fixture class is refused: an endpoint address,
   * port, sentinel key or marker file proves NOTHING about billing.
   */
  nonBillableTransport?: unknown;
}

function refusal(code: FormalRunCode, reason: string): FormalRunRefusal {
  return { status: "REFUSED", code, reason, providerFactoryCalls: 0, providerCalls: 0 };
}

/**
 * Run the ordered preflight and return either a refusal (factory never called)
 * or an admission carrying a ready, budget-wrapped provider.
 */
export async function openPreregisteredCampaignGate(
  opts: PreregisteredCampaignOptions,
): Promise<FormalRunRefusal | FormalRunAdmission> {
  // STEP 0: experiment-semantic overrides are refused. Only the artifact may
  // determine cases / repetitions / provider / model / budget.
  const mode = opts.mode ?? "auto";

  // STEP 1: strict pre-registration validation (recomputes every derived field).
  let artifact: ToolCallEfficiencyPreregistrationV2;
  try {
    artifact = assertFormalExecutionPreregistration(opts.preregistrationJson);
  } catch (err) {
    return refusal("PREREGISTRATION_INVALID", err instanceof Error ? err.message : String(err));
  }

  // STEP 2: re-observe the CURRENT identity and compare every bound field.
  const drift = observationViolationsV2(artifact, opts.observation);
  if (drift.length > 0) {
    return refusal("PREREGISTRATION_IDENTITY_DRIFT", `execution identity drifted from the pre-registration: ${drift.join("; ")}`);
  }

  // STEP 2b: the money bound. A campaign that BOUND USD must declare a real
  // per-call price in its observed identity; a missing/null price is an unknown
  // price, and an unknown price on a money-bounded campaign is a refusal — not a
  // silent zero that would let spend run past the bound.
  const usdMicrosPerCall = opts.observation.usdMicrosPerCall;
  if (usdMicrosPerCall !== null && (!Number.isSafeInteger(usdMicrosPerCall) || usdMicrosPerCall < 0)) {
    return refusal("PRICING_UNKNOWN", `observed usdMicrosPerCall ${String(usdMicrosPerCall)} is not a non-negative integer`);
  }
  if (artifact.budget.maxUsdMicros !== null && usdMicrosPerCall === null) {
    return refusal(
      "PRICING_UNKNOWN",
      "the pre-registration is money-bounded (maxUsdMicros is set) but the observed per-call price is unknown — refusing rather than treating an unknown price as free",
    );
  }

  // STEP 3: independent authorization, bound exactly.
  let auth;
  try {
    auth = parseAndValidateAuthorizationV2(opts.authorizationJson);
  } catch (err) {
    return refusal("AUTHORIZATION_INVALID", err instanceof Error ? err.message : String(err));
  }
  const nowMs = (opts.now ?? (() => Date.now()))();
  const authCheck = checkAuthorizationV2(auth, artifact, nowMs);
  if (!authCheck.ok) return refusal(authCheck.code, authCheck.reason);

  // STEP 3b: N3/R1 — the two admission classes have DIFFERENT fail-closed
  // preconditions, and neither may borrow the other's. This runs after the
  // authorization is parsed (the class lives there) and before ANY budget,
  // ledger or provider construction.
  //
  // R1/F1 — THE FIX. The fixture branch used to accept
  // `observation.endpointIsLoopback === true` (or a declared price of 0) as PROOF
  // that the transport could not bill, and therefore skipped the paid branch's
  // money cap. An endpoint ADDRESS is not a billing class: a loopback relay can be
  // a paid forwarding endpoint (the user's own local relay), so a fixture
  // admission now requires a capability the TEST HOST injected — one that also
  // carries the non-billable PROVIDER, is BOUND to the observed endpoint and
  // provider/model, and cannot be produced from any artifact, env, marker, port
  // or sentinel key.
  const isFixture = auth.fixtureMode === FIXTURE_MODE_SYNTHETIC_OFFLINE;
  const fixtureTransport = isFixture && isNonBillableFixtureTransport(opts.nonBillableTransport)
    ? opts.nonBillableTransport
    : null;
  if (isFixture) {
    if (fixtureTransport === null) {
      return refusal(
        "FIXTURE_TRANSPORT_NOT_NON_BILLABLE",
        "a synthetic-fixture admission must PROVE its transport is non-billable by INJECTING a test-host non-billable transport (createNonBillableFixtureTransport); the observation shows no such capability. An endpoint address is not evidence about billing — 127.0.0.1 / localhost / ::1 can carry PAID relay traffic (a user's own local relay is exactly that), so no address, port, sentinel key or marker can make a transport free",
      );
    }
    // The capability is BOUND: it cannot be re-pointed at another endpoint or
    // another model than the one this run observed.
    const capabilityEndpointDigest =
      captureEndpointIdentity(fixtureTransport.endpointBaseUrl) ?? PROVIDER_DEFAULT_ENDPOINT_DIGEST;
    if (capabilityEndpointDigest !== opts.observation.endpointDigest) {
      return refusal(
        "FIXTURE_TRANSPORT_NOT_NON_BILLABLE",
        "the injected non-billable transport was issued for a DIFFERENT endpoint than the one observed now — a fixture capability cannot be applied to another endpoint",
      );
    }
    if (
      fixtureTransport.providerId !== opts.observation.providerId ||
      fixtureTransport.modelId !== opts.observation.modelId
    ) {
      return refusal(
        "FIXTURE_TRANSPORT_NOT_NON_BILLABLE",
        `the injected non-billable transport was issued for ${fixtureTransport.providerId}/${fixtureTransport.modelId}, not the observed ${opts.observation.providerId}/${opts.observation.modelId} — a fixture capability cannot be applied to another model`,
      );
    }
  } else {
    if (artifact.budget.maxUsdMicros === null) {
      return refusal(
        "PAID_WITHOUT_USD_CAP",
        "a paid authorization must be money-bounded, but the pre-registration's maxUsdMicros is null — an unbounded paid campaign is refused rather than admitted",
      );
    }
    if (usdMicrosPerCall === null) {
      return refusal(
        "PRICING_UNKNOWN",
        "the pre-registration is money-bounded (maxUsdMicros is set) but the observed per-call price is unknown — refusing rather than treating an unknown price as free",
      );
    }
  }

  // STEP 3c: `allowResume: false` is a REAL prohibition. A requested resume is
  // refused before any budget is opened.
  if (mode === "resume" && !auth.allowResume) {
    return refusal("RESUME_NOT_ALLOWED", "the authorization forbids resuming (allowResume is false)");
  }

  // STEP 4 + 5: open the SAME digest's atomic call ledger and cost budget. A
  // resume must not create a fresh allowance; a first run must not adopt a
  // foreign one.
  let ledger: R97BudgetLedger;
  let costBudget: CostBudget;
  try {
    ledger = await openR97BudgetLedger(opts.budgetDir, {
      planDigest: artifact.preregistrationDigest,
      campaignModelCalls: artifact.budget.campaignWorstCaseModelCalls,
      mode,
    });
  } catch (err) {
    return refusal("BUDGET_STATE_REJECTED", err instanceof Error ? err.message : String(err));
  }

  // The LEDGER, not the requested mode, decides whether this open RESUMED an
  // existing campaign. `auto`/`first-run` against an existing ledger both adopt
  // it, and an adopted campaign must honour `allowResume` exactly like an
  // explicit resume.
  if (ledger.mode === "resume" && !auth.allowResume) {
    return refusal("RESUME_NOT_ALLOWED", "this campaign already exists and the authorization forbids resuming (allowResume is false)");
  }

  // On the PAID v2 path, "this approval is still live in another directory" is a
  // refusal — never a silent second allowance. The generic R97 ledger RECORDS
  // the duplicate for other callers; the formal gate must not admit it.
  if (ledger.duplicateCampaignDirs.length > 0) {
    return refusal(
      "BUDGET_STATE_REJECTED",
      `this authorization is still live in ${ledger.duplicateCampaignDirs.join(", ")} — refusing to open a second budget for one approval`,
    );
  }

  try {
    // R3/F4 — the SAME injectable clock the caller uses for the authorization is
    // used to freeze the campaign deadline, so an offline test controls it.
    costBudget = await CostBudget.open(opts.budgetDir, artifact, {
      allowCreate: ledger.mode !== "resume",
      now: opts.now ?? (() => Date.now()),
    });
  } catch (err) {
    return refusal("BUDGET_STATE_REJECTED", err instanceof Error ? err.message : String(err));
  }

  // STEP 6: ONLY NOW construct the provider. On the PAID path that is the
  // caller's factory (the real, credential-bearing transport). On the
  // synthetic-fixture path it is the injected capability's OWN non-billable
  // provider, so `makeProvider` — and therefore any operator credential — is
  // never reached by a fixture admission.
  const provider = fixtureTransport !== null ? fixtureTransport.provider : await opts.makeProvider();
  const plan = buildPairedPlan({
    suite: artifact.dataset.suiteId,
    cases: artifact.dataset.cases.map((c) => c.caseId),
    repetitions: artifact.schedule.repetitions,
    orderSeed: artifact.schedule.orderSeed,
  });
  // R3/F4 — the campaign's ONE deadline, read from the durable budget. A resume
  // reuses whatever is left: `resume` can never obtain a fresh `maxDurationMs`.
  const campaignDeadlineAtMs = costBudget.deadlineAtMs();
  const clock = opts.now ?? (() => Date.now());
  const { provider: budgeted, stats } = createFormalBudgetedProvider({
    provider,
    ledger,
    costBudget,
    arm: TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
    usdMicrosPerCall,
    deadlineAtMs: campaignDeadlineAtMs,
    now: clock,
  });
  const toolDispatchBudget = createDurableToolDispatchBudget({
    costBudget,
    deadlineAtMs: campaignDeadlineAtMs,
    now: clock,
  });
  return {
    status: "ADMITTED",
    preregistrationDigest: artifact.preregistrationDigest,
    plan,
    ledger,
    costBudget,
    provider: budgeted,
    budgetStats: stats,
    providerFactoryCalls: 1,
    toolDispatchBudget,
    campaignDeadlineAtMs,
  };
}

/** Digest helper so a caller can bind an approval to exact artifact bytes. */
export function preregistrationBytesDigest(json: string): string {
  return createHash("sha256").update(json, "utf8").digest("hex");
}

/** The schema this module consumes — exported so callers can assert quickly. */
export const FORMAL_RUN_PREREGISTRATION_SCHEMA = TOOL_CALL_EFFICIENCY_PREREGISTRATION_V2_SCHEMA;