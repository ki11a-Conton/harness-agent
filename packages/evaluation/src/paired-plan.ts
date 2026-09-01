/**
 * E2-05 — PairedExperimentPlan: deterministic AB/BA paired scheduler.
 *
 * Fixes the E1-11 `--repeat N` semantics: the historical
 * `runBaseline() + N extra runs` produced N+1 executions and was never a true
 * interleaved pair. Here:
 *
 *   - one plan holds EVERY logical sample: (caseId × repetition) × 2 arms;
 *   - `--repeat N` means EXACTLY N repetitions per arm per case
 *     (total logical runs = 2 × N × cases — never N+1, never 14 when 12 is
 *     expected);
 *   - each pair gets a stable, digest-derived `pairId` and a deterministic
 *     AB/BA order driven by an orderSeed that is SEPARATE from any model seed
 *     (provenance must keep them apart);
 *   - AB/BA balances across even repetition counts (same sample count per arm
 *     order);
 *   - preflight happens BEFORE the first provider call: candidate/arm
 *     validity, case set, budget, provider-call ceiling, paid guard; a
 *     failing preflight means providerCalls = 0.
 *
 * This module is pure + deterministic (no provider, no I/O) so exact
 * call-count assertions are testable with a counting fake provider.
 */

import { createHash } from "node:crypto";
import { stableStringify } from "./manifest.js";

export const PAIRED_PLAN_SCHEMA_VERSION = "1.0.0";

export type ArmName = "baseline" | "candidate";
export type ArmOrder = "AB" | "BA";

export interface ArmRunRef {
  armId: ArmName;
  caseId: string;
  repetition: number;
  orderIndex: number;
}

export interface PairedPair {
  /** Stable pair identity: sha256(suite/case/repetition/orderSeed). */
  pairId: string;
  caseId: string;
  repetition: number;
  /** AB = baseline first; BA = candidate first (deterministic per seed). */
  order: ArmOrder;
  baseline: ArmRunRef;
  candidate: ArmRunRef;
  /** Whether this pair is finalized (both arms have valid outcomes). */
  finalized: boolean;
}

export interface PairedExperimentPlan {
  schemaVersion: string;
  suite: string;
  cases: string[];
  repetitions: number;
  orderSeed: number | null;
  pairs: PairedPair[];
  /** Total logical arm runs (must be 2 × repetitions × cases). */
  totalLogicalRuns: number;
  /** Max provider calls (one per arm run; transport retries add attempts,
   *  never independent samples). */
  maxProviderCalls: number;
}

export interface PairPlanOptions {
  suite: string;
  cases: string[];
  repetitions: number;
  /** Order seed ONLY controls AB/BA + pair ordering. It is NOT a model seed. */
  orderSeed?: number | null;
}

/** Deterministic pair id from suite/case/repetition/orderSeed. */
export function derivePairId(opts: { suite: string; caseId: string; repetition: number; orderSeed: number | null }): string {
  return createHash("sha256")
    .update(stableStringify({ suite: opts.suite, caseId: opts.caseId, repetition: opts.repetition, orderSeed: opts.orderSeed }), "utf8")
    .digest("hex")
    .slice(0, 24);
}

/** Simple deterministic PRNG (mulberry32) — drives only ORDER decisions. */
export function pairedSeededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build the deterministic paired plan. Pure — same inputs, same plan. */
export function buildPairedPlan(opts: PairPlanOptions): PairedExperimentPlan {
  const repetitions = Math.max(1, Math.floor(opts.repetitions));
  const orderSeed = opts.orderSeed ?? 0;
  const rng = pairedSeededRandom(orderSeed);
  // ONE seed-derived global flip (0/1), computed once: different seeds flip
  // the whole AB/BA pattern, while strict alternation below guarantees exact
  // balance for even pair counts.
  const globalFlip = rng() < 0.5 ? 1 : 0;
  const pairs: PairedPair[] = [];
  let orderIndex = 0;

  for (let rep = 0; rep < repetitions; rep++) {
    for (const caseId of opts.cases) {
      const order: ArmOrder = (orderIndex / 2 + globalFlip) % 2 === 0 ? "AB" : "BA";
      const pairId = derivePairId({ suite: opts.suite, caseId, repetition: rep, orderSeed });
      const baseline: ArmRunRef = { armId: "baseline", caseId, repetition: rep, orderIndex };
      const candidate: ArmRunRef = { armId: "candidate", caseId, repetition: rep, orderIndex: orderIndex + 1 };
      pairs.push({
        pairId,
        caseId,
        repetition: rep,
        order,
        baseline,
        candidate,
        finalized: false,
      });
      orderIndex += 2;
    }
  }

  return {
    schemaVersion: PAIRED_PLAN_SCHEMA_VERSION,
    suite: opts.suite,
    cases: [...opts.cases],
    repetitions,
    orderSeed,
    pairs,
    totalLogicalRuns: repetitions * opts.cases.length * 2,
    maxProviderCalls: repetitions * opts.cases.length * 2,
  };
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export type PreflightCheck =
  | "ARMS_VALID"
  | "CASE_SET_NONEMPTY"
  | "PAID_GUARD"
  | "BUDGET";
export type PreflightResult =
  | { ok: true; checks: PreflightCheck[]; providerCallsAllowed: true; maxProviderCalls: number }
  | { ok: false; checks: PreflightCheck[]; providerCallsAllowed: false; reason: string };

export interface PreflightOptions {
  plan: PairedExperimentPlan;
  /** Whether the real provider requires the paid guard (provider kind). */
  providerKind: "fake" | "real";
  /** Whether RUN_PAID_BENCHMARKS=1 was set (real provider only). */
  paidAuthorized: boolean;
  /** Estimated calls per arm run (>=1). */
  callsPerArmRun?: number;
  maxEstimatedCostUsd?: number;
  estimatedCostUsd?: number;
}

/** Run ALL preflight checks BEFORE the first provider call. Any failure -> 0 calls. */
export function preflightPairedPlan(opts: PreflightOptions): PreflightResult {
  const checks: PreflightCheck[] = [];

  // 1. Case set must be non-empty.
  if (opts.plan.cases.length === 0) {
    return { ok: false, checks, providerCallsAllowed: false, reason: "case set is empty — no experiment to run" };
  }
  checks.push("CASE_SET_NONEMPTY");

  // 2. Arms must be valid (each pair has exactly baseline + candidate).
  const armsValid = opts.plan.pairs.every(
    (p) => p.baseline.armId === "baseline" && p.candidate.armId === "candidate",
  );
  if (!armsValid) {
    return { ok: false, checks, providerCallsAllowed: false, reason: "plan contains invalid arm refs" };
  }
  checks.push("ARMS_VALID");

  // 3. Paid guard: a real provider demands explicit authorization.
  if (opts.providerKind === "real" && !opts.paidAuthorized) {
    return {
      ok: false,
      checks,
      providerCallsAllowed: false,
      reason: "RUN_PAID_BENCHMARKS=1 is required for a real provider — refusing to spend before authorization",
    };
  }
  checks.push("PAID_GUARD");

  // 4. Budget: estimated cost/calls must be under configured ceilings.
  const callsPerArm = opts.callsPerArmRun ?? 1;
  const estimatedCalls = opts.plan.maxProviderCalls * callsPerArm;
  if (opts.maxEstimatedCostUsd !== undefined && opts.estimatedCostUsd !== undefined
    && opts.estimatedCostUsd > opts.maxEstimatedCostUsd) {
    return {
      ok: false,
      checks,
      providerCallsAllowed: false,
      reason: `estimated cost $${opts.estimatedCostUsd.toFixed(4)} exceeds ceiling $${opts.maxEstimatedCostUsd.toFixed(4)}`,
    };
  }
  checks.push("BUDGET");

  return { ok: true, checks, providerCallsAllowed: true, maxProviderCalls: estimatedCalls };
}

// ---------------------------------------------------------------------------
// Dry-run
// ---------------------------------------------------------------------------

export interface DryRunReport {
  schemaVersion: string;
  plan: PairedExperimentPlan;
  providerKind: string;
  estimatedProviderCalls: number;
  estimatedCostUsd: number | null;
  paidAuthorizationRequired: boolean;
  abBalance: { ab: number; ba: number };
}

/** Produce the dry-run report WITHOUT executing anything. */
export function dryRunPairedPlan(opts: {
  plan: PairedExperimentPlan;
  providerKind: "fake" | "real";
  callsPerArmRun?: number;
  costPerCallUsd?: number;
}): DryRunReport {
  const callsPerArm = opts.callsPerArmRun ?? 1;
  const totalCalls = opts.plan.maxProviderCalls * callsPerArm;
  const ab = opts.plan.pairs.filter((p) => p.order === "AB").length;
  const ba = opts.plan.pairs.filter((p) => p.order === "BA").length;
  return {
    schemaVersion: PAIRED_PLAN_SCHEMA_VERSION,
    plan: opts.plan,
    providerKind: opts.providerKind,
    estimatedProviderCalls: totalCalls,
    estimatedCostUsd: opts.costPerCallUsd === undefined ? null : totalCalls * opts.costPerCallUsd,
    paidAuthorizationRequired: opts.providerKind === "real",
    abBalance: { ab, ba },
  };
}

// ---------------------------------------------------------------------------
// Resume / partial Pada semantics
// ---------------------------------------------------------------------------

export interface FinalizedPairRecord {
  pairId: string;
  baseline: { valid: boolean; outcomeRef: string } | null;
  candidate: { valid: boolean; outcomeRef: string } | null;
  /** True only when BOTH arms are present and valid. */
  finalized: boolean;
}

/**
 * Resume decision per E2-05 #9: a pair is finalized only when BOTH arms hold a
 * valid outcome. Half pairs are NOT usable — they must be completed or voided,
 * never admitted as asymmetric samples.
 */
export function finalizePairState(records: FinalizedPairRecord[]): {
  finalized: FinalizedPairRecord[];
  partial: FinalizedPairRecord[];
  voided: FinalizedPairRecord[];
} {
  const finalized: FinalizedPairRecord[] = [];
  const partial: FinalizedPairRecord[] = [];
  const voided: FinalizedPairRecord[] = [];
  for (const r of records) {
    const bOk = r.baseline?.valid === true;
    const cOk = r.candidate?.valid === true;
    if (bOk && cOk) {
      finalized.push({ ...r, finalized: true });
    } else if (!bOk && !cOk) {
      voided.push(r);
    } else {
      partial.push(r);
    }
  }
  return { finalized, partial, voided };
}