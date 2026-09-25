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

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ModelEvent, ModelProvider, ModelRef, ProviderConfig, ModelRequest } from "@ar/contracts";
import { stableStringify } from "./manifest.js";
import {
  assertFormalExecutionPreregistration,
  TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
  TOOL_CALL_EFFICIENCY_PREREGISTRATION_V2_SCHEMA,
  type ToolCallEfficiencyPreregistrationV2,
} from "./tool-call-efficiency-preregistration-v2.js";
import { buildPairedPlan, type PairedExperimentPlan } from "./paired-plan.js";
import { openR97BudgetLedger, withR97CampaignLock, type R97BudgetLedger } from "./r97-budget-ledger.js";

// ---------------------------------------------------------------------------
// Authorization v2 — owner-provided, read-only to the code
// ---------------------------------------------------------------------------

export const TOOL_CALL_EFFICIENCY_AUTHORIZATION_V2_SCHEMA = "tool-call-efficiency-authorization-v2";

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
  if (!auth.paid) {
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
  cmp("evaluation.decisionPolicyDigest", artifact.evaluation.decisionPolicyDigest, obs.decisionPolicyDigest);
  const boundIds = artifact.dataset.cases.map((c) => c.caseId).join(",");
  const observedIds = Object.keys(obs.caseContentDigests).join(",");
  if (boundIds !== observedIds) {
    issues.push(`dataset.cases: bound [${boundIds}] != observed [${observedIds}]`);
  } else {
    for (const c of artifact.dataset.cases) {
      cmp(`dataset.cases.${c.caseId}.contentDigest`, c.contentDigest, obs.caseContentDigests[c.caseId]);
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
}

export interface CostBudgetFile {
  schemaVersion: string;
  preregistrationDigest: string;
  caps: CostBudgetCapsV2;
  charged: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    toolCalls: number;
    durationMs: number;
    usdMicros: number;
    unknownCalls: number;
  };
}

export interface CostBudgetView extends CostBudgetFile {
  /** True once ANY dimension is at or over its cap. */
  exhausted: boolean;
  /** Human-readable exhausted dimensions. */
  exhaustedDimensions: string[];
}

const COST_BUDGET_FILENAME = "cost-budget.json";

/**
 * A digest-bound, same-lock cost budget. It reuses `withR97CampaignLock` (the
 * SINGLE campaign lock) rather than implementing a third lock. Its caps must
 * equal the pre-registration's; anything else is refused.
 */
export class CostBudget {
  private constructor(private readonly dir: string, private file: CostBudgetFile) {}

  static async open(dir: string, prereg: ToolCallEfficiencyPreregistrationV2, opts: { allowCreate: boolean }): Promise<CostBudget> {
    const path = join(dir, COST_BUDGET_FILENAME);
    const caps: CostBudgetCapsV2 = {
      maxInputTokens: prereg.budget.maxInputTokens,
      maxOutputTokens: prereg.budget.maxOutputTokens,
      maxTotalTokens: prereg.budget.maxTotalTokens,
      maxToolCalls: prereg.budget.maxToolCalls,
      maxDurationMs: prereg.budget.maxDurationMs,
      maxUsdMicros: prereg.budget.maxUsdMicros,
    };
    await mkdir(dir, { recursive: true });
    return withR97CampaignLock(dir, async () => {
      let raw: string | null = null;
      try {
        raw = await readFile(path, "utf8");
      } catch {
        raw = null;
      }
      if (raw === null) {
        if (!opts.allowCreate) {
          throw new Error(`cost budget missing for this campaign in ${dir} — a resume must never create a fresh allowance`);
        }
        const file: CostBudgetFile = {
          schemaVersion: TOOL_CALL_EFFICIENCY_COST_BUDGET_SCHEMA,
          preregistrationDigest: prereg.preregistrationDigest,
          caps,
          charged: { inputTokens: 0, outputTokens: 0, totalTokens: 0, toolCalls: 0, durationMs: 0, usdMicros: 0, unknownCalls: 0 },
        };
        await writeAtomic(path, file);
        return new CostBudget(dir, file);
      }
      const parsed = JSON.parse(raw) as CostBudgetFile;
      if (parsed.schemaVersion !== TOOL_CALL_EFFICIENCY_COST_BUDGET_SCHEMA) {
        throw new Error(`cost budget schema ${String(parsed.schemaVersion)} is not ${TOOL_CALL_EFFICIENCY_COST_BUDGET_SCHEMA}`);
      }
      if (parsed.preregistrationDigest !== prereg.preregistrationDigest) {
        throw new Error("cost budget belongs to a different pre-registration digest — refusing to reuse it");
      }
      if (stableStringify(parsed.caps) !== stableStringify(caps)) {
        throw new Error("cost budget caps do not match the pre-registration — refusing to reuse it");
      }
      return new CostBudget(dir, parsed);
    });
  }

  view(): CostBudgetView {
    const c = this.file.charged;
    const caps = this.file.caps;
    const exhaustedDimensions: string[] = [];
    if (c.inputTokens > caps.maxInputTokens) exhaustedDimensions.push("inputTokens");
    if (c.outputTokens > caps.maxOutputTokens) exhaustedDimensions.push("outputTokens");
    if (c.totalTokens > caps.maxTotalTokens) exhaustedDimensions.push("totalTokens");
    if (c.toolCalls > caps.maxToolCalls) exhaustedDimensions.push("toolCalls");
    if (c.durationMs > caps.maxDurationMs) exhaustedDimensions.push("durationMs");
    if (caps.maxUsdMicros !== null && c.usdMicros > caps.maxUsdMicros) exhaustedDimensions.push("usdMicros");
    return { ...this.file, exhausted: exhaustedDimensions.length > 0, exhaustedDimensions };
  }

  /** True when a call may NOT leave: any dimension is already at/over cap. */
  cannotAffordMore(): { refused: boolean; reason: string } {
    const c = this.file.charged;
    const caps = this.file.caps;
    if (c.inputTokens >= caps.maxInputTokens) return { refused: true, reason: "input-token cap reached" };
    if (c.outputTokens >= caps.maxOutputTokens) return { refused: true, reason: "output-token cap reached" };
    if (c.totalTokens >= caps.maxTotalTokens) return { refused: true, reason: "total-token cap reached" };
    if (c.toolCalls >= caps.maxToolCalls) return { refused: true, reason: "tool-call cap reached" };
    if (c.durationMs >= caps.maxDurationMs) return { refused: true, reason: "duration cap reached" };
    if (caps.maxUsdMicros !== null && c.usdMicros >= caps.maxUsdMicros) return { refused: true, reason: "USD cap reached" };
    return { refused: false, reason: "" };
  }

  /** Charge actual usage after a call returned. Atomic under the campaign lock. */
  async charge(delta: { inputTokens?: number; outputTokens?: number; toolCalls?: number; durationMs?: number; usdMicros?: number; unknown?: boolean }): Promise<CostBudgetView> {
    return withR97CampaignLock(this.dir, async () => {
      const file = JSON.parse(await readFile(join(this.dir, COST_BUDGET_FILENAME), "utf8")) as CostBudgetFile;
      const c = file.charged;
      const inputTokens = delta.inputTokens ?? 0;
      const outputTokens = delta.outputTokens ?? 0;
      c.inputTokens += inputTokens;
      c.outputTokens += outputTokens;
      c.totalTokens += inputTokens + outputTokens;
      c.toolCalls += delta.toolCalls ?? 0;
      c.durationMs += delta.durationMs ?? 0;
      c.usdMicros += delta.usdMicros ?? 0;
      if (delta.unknown === true) c.unknownCalls += 1;
      await writeAtomic(join(this.dir, COST_BUDGET_FILENAME), file);
      this.file = file;
      return this.view();
    });
  }
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, `${stableStringify(value)}\n`, "utf8");
  // `force` already tolerates a missing target; any OTHER failure (EPERM/EBUSY) is
  // real and must NOT be swallowed — it propagates so the atomic write fails closed.
  await rm(path, { force: true });
  await rename(tmp, path);
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
}): { provider: ModelProvider; stats: FormalBudgetStats } {
  const stats: FormalBudgetStats = {
    logicalCalls: 0,
    refusedCalls: 0,
    unknownCalls: 0,
    retries: 0,
    chargedInputTokens: 0,
    chargedOutputTokens: 0,
    chargedUsdMicros: 0,
  };

  const wrapped: ModelProvider = {
    id: opts.provider.id,
    async listModels() {
      return opts.provider.listModels();
    },
    createClient(model: ModelRef, config: ProviderConfig) {
      const inner = opts.provider.createClient(model, config);
      return {
        async *generate(request: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelEvent> {
          const cost = opts.costBudget.cannotAffordMore();
          if (cost.refused) {
            stats.refusedCalls += 1;
            throw new Error(`E4-N3: BUDGET_EXHAUSTED: ${cost.reason} — refusing to send a call the frozen budget cannot afford`);
          }
          const reserved = await opts.ledger.reserve(opts.arm, 1);
          if (!reserved.ok || reserved.reservationId === null) {
            stats.refusedCalls += 1;
            throw new Error(`E4-N3: BUDGET_EXHAUSTED: ${reserved.reason} — refusing to send an unbilled call`);
          }
          const reservationId = reserved.reservationId;
          stats.logicalCalls += 1;

          let entered = false;
          let completed = false;
          let inputTokens = 0;
          let outputTokens = 0;
          let usdMicros = 0;
          let retries = 0;
          let settleStarted = false;

          const settle = async (): Promise<void> => {
            if (settleStarted) return;
            settleStarted = true;
            if (!entered) {
              await opts.ledger.abandon(reservationId);
              return;
            }
            if (completed) {
              await opts.ledger.commit(reservationId, 1, retries);
            } else {
              await opts.ledger.markUnknown(reservationId);
              stats.unknownCalls += 1;
              // A dispatched call whose outcome nobody saw may already be
              // billed: charge the USD ceiling rather than refunding it.
              await opts.costBudget.charge({ usdMicros: opts.usdMicrosPerCall ?? 0, unknown: true });
              return;
            }
            const chargedMicros = Math.max(usdMicros, opts.usdMicrosPerCall ?? 0);
            const view = await opts.costBudget.charge({
              inputTokens,
              outputTokens,
              usdMicros: chargedMicros,
            });
            stats.chargedInputTokens += inputTokens;
            stats.chargedOutputTokens += outputTokens;
            stats.chargedUsdMicros += chargedMicros;
            void view;
          };

          try {
            const stream = inner.generate(request, signal);
            entered = true;
            for await (const ev of stream) {
              if (ev.type === "retry") {
                retries += 1;
                stats.retries += 1;
                // A retry is a NEW physical request that may be billed, so it
                // must take its OWN reservation immediately — and a refused
                // reservation must STOP the stream. Silently continuing would
                // let an unbilled request leave the process.
                const retryReservation = await opts.ledger.reserve(opts.arm, 1);
                if (!retryReservation.ok || retryReservation.reservationId === null) {
                  stats.refusedCalls += 1;
                  throw new Error(
                    `E4-N3: BUDGET_EXHAUSTED: retry reservation refused (${retryReservation.reason}) — refusing to continue an unbilled retry`,
                  );
                }
                await opts.ledger.commit(retryReservation.reservationId, 1, 1);
                stats.logicalCalls += 1;
              } else if (ev.type === "usage") {
                inputTokens = Math.max(inputTokens, ev.usage.inputTokens);
                outputTokens = Math.max(outputTokens, ev.usage.outputTokens);
                if (typeof ev.usage.estimatedCostUsd === "number" && ev.usage.estimatedCostUsd > 0) {
                  usdMicros = Math.round(ev.usage.estimatedCostUsd * 1_000_000);
                }
              } else if (ev.type === "completed") {
                completed = true;
              }
              yield ev;
            }
          } finally {
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

  // STEP 3b: `allowResume: false` is a REAL prohibition. A requested resume is
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
    costBudget = await CostBudget.open(opts.budgetDir, artifact, { allowCreate: ledger.mode !== "resume" });
  } catch (err) {
    return refusal("BUDGET_STATE_REJECTED", err instanceof Error ? err.message : String(err));
  }

  // STEP 6: ONLY NOW construct the provider.
  const provider = await opts.makeProvider();
  const plan = buildPairedPlan({
    suite: artifact.dataset.suiteId,
    cases: artifact.dataset.cases.map((c) => c.caseId),
    repetitions: artifact.schedule.repetitions,
    orderSeed: artifact.schedule.orderSeed,
  });
  const { provider: budgeted, stats } = createFormalBudgetedProvider({
    provider,
    ledger,
    costBudget,
    arm: TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
    usdMicrosPerCall,
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
  };
}

/** Digest helper so a caller can bind an approval to exact artifact bytes. */
export function preregistrationBytesDigest(json: string): string {
  return createHash("sha256").update(json, "utf8").digest("hex");
}

/** The schema this module consumes — exported so callers can assert quickly. */
export const FORMAL_RUN_PREREGISTRATION_SCHEMA = TOOL_CALL_EFFICIENCY_PREREGISTRATION_V2_SCHEMA;