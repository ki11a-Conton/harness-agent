/**
 * E4-R22 (F02) — the shared, versioned, runtime-parseable execution-plan
 * protocol.
 *
 * The confirmed execution plan was previously TYPED and BUILT only in the CLI
 * (BenchmarkExecutionPlan) while every evaluation-side consumer checked
 * `typeof plan === "object" && plan !== null && !Array.isArray(plan)` — so an
 * empty `{}` (or any lossy object) satisfied the "full confirmed plan" contract
 * and could still ACCEPT / promote. The protocol now lives HERE (evaluation is
 * the consumer; the CLI depends on evaluation, never the reverse) and every
 * promotion-grade boundary — the V3 artifact writer, the evaluator, and the
 * promotion loader — parses and cross-binds the SAME structure.
 *
 * The digest protocol is unchanged from the CLI's computeBenchmarkPlanDigest:
 * sha256 over stableStringify(plan), so existing confirmed plans keep their
 * digests.
 */

import { computeRuntimeConfigHash } from "./manifest.js";

export const EXECUTION_PLAN_SCHEMA_VERSION = "e4-01";

/** E4-R28 (G02): the documented PRODUCT cap on a plan's sample grid
 *  (repeat × caseCount). Independent of the per-experiment budget fields
 *  (maxLogicalRuns etc.), this bounds the ARRAYS the grid contract allocates
 *  (`expectedSampleKeysFromExecutionPlan`, evaluator/writer sets) so a
 *  pathological plan is rejected with a structured error BEFORE any huge loop.
 *  A paired benchmark is 2× this many logical arm runs and still must satisfy
 *  maxLogicalRuns. 1_000_000 planned samples is far above any real
 *  offline/small experiment yet keeps every grid consumer bounded. */
export const EXECUTION_PLAN_MAX_PLANNED_SAMPLES = 1_000_000;

export type ExecutionPlanIsolationStrength = "strong" | "insecure-local" | "none";

/**
 * The complete e4-01 execution plan. Mirrors the CLI's
 * BenchmarkExecutionPlan field-for-field (the CLI type is now an alias of
 * this one) so digests computed on either side agree.
 */
export interface ExecutionPlanV1 {
  schemaVersion: typeof EXECUTION_PLAN_SCHEMA_VERSION;
  suite: string;
  caseIds: string[];
  /** E4-R13 (N03): per-case INPUT fingerprint — editing a case file without
   *  changing its id still invalidates the confirmed plan. */
  caseFingerprints: Readonly<Record<string, string>>;
  /** Maximum number of planned cases (a positive integer cap on the FIRST n
   *  of caseIds); `null` = no case-count cap — ALL planned cases run. The CLI's
   *  `--limit 0`-means-all convention maps to null; a literal 0 is rejected. */
  limit: number | null;
  repeat: number;
  interleave: boolean;
  shuffle: boolean;
  seed: number;
  candidate: string | null;
  billingClass: string;
  /** `null` = unlimited, `0` = forbid, positive = the cap. */
  maxLogicalRuns: number | null;
  maxModelCalls: number | null;
  maxEstimatedTokens: number | null;
  maxEstimatedCostUsd: number | null;
  estimateStatus: "bounded" | "unknown";
  isolationBackendId: string;
  isolationStrength: ExecutionPlanIsolationStrength;
  promotionEligible: boolean;
  /** The FULL authorization surface, folded into the plan digest so a
   *  --plan-digest confirmation covers exactly what will execute. Secrets
   *  never enter the plan. */
  providerId: string;
  modelId: string;
  judgeVersion: string;
  sourceSha: string | null;
  treeFingerprint: string | null;
  decisionPolicy: Readonly<object>;
  thresholdDigest: string;
  /** Effective model parameters bound into the plan (e.g. budgetTokens). */
  effectiveModelParams: Readonly<Record<string, unknown>>;
}

export interface ParsedExecutionPlan {
  /** The validated plan, or null when ANY protocol issue was found. */
  plan: ExecutionPlanV1 | null;
  issues: string[];
}

const hex64 = (v: unknown): boolean => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const hex40 = (v: unknown): boolean => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);

/**
 * Strictly parse an execution plan record. Unknown schema versions,
 * missing/ mistyped fields, non-unique case ids, fingerprint maps that do not
 * cover the planned cases, and out-of-range numbers are ALL rejected — the
 * caller treats a null plan as "no confirmed plan" (promotion-ineligible),
 * never as a best-effort partial plan.
 */
export function parseExecutionPlan(value: unknown): ParsedExecutionPlan {
  const issues: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { plan: null, issues: ["executionPlan must be a non-null object (got null/array/non-object)"] };
  }
  const r = value as Record<string, unknown>;

  if (r["schemaVersion"] !== EXECUTION_PLAN_SCHEMA_VERSION) {
    issues.push(`executionPlan.schemaVersion ${JSON.stringify(r["schemaVersion"])} != supported ${EXECUTION_PLAN_SCHEMA_VERSION} (unknown protocol version)`);
  }

  const str = (field: string): string | null => {
    const v = r[field];
    if (typeof v !== "string" || v.length === 0) {
      issues.push(`executionPlan.${field} must be a non-empty string`);
      return null;
    }
    return v;
  };
  const num = (field: string, min: number, max = Number.POSITIVE_INFINITY): number | null => {
    const v = r[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
      issues.push(`executionPlan.${field} must be a finite number in [${min}, ${max}]`);
      return null;
    }
    return v;
  };
  /** E4-R28 (G02): COUNT-like fields require a SAFE INTEGER (a fractional
   *  repeat/limit/cap would silently change the grid or the budget). */
  const safeCount = (field: string, min: number, max = Number.MAX_SAFE_INTEGER): number | null => {
    const v = r[field];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
      issues.push(`executionPlan.${field} must be a safe integer in [${min}, ${max}] (fractional/unsafe values would change the grid or budget)`);
      return null;
    }
    return v;
  };
  /** E4-R28 (G02): nullable COUNT-like budget field — null = unlimited, 0 =
   *  FORBID, positive = the cap. The field MUST be present (an omitted field is
   *  NOT silently treated as unlimited; a missing key is a protocol error that
   *  says "I do not know the budget", which fail-closes). */
  const nullableCount = (field: string): number | null | undefined => {
    const v = r[field];
    if (v === null) return null;
    if (v === undefined) {
      issues.push(`executionPlan.${field} key is missing (use null for unlimited, 0 to forbid)`);
      return undefined;
    }
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
      issues.push(`executionPlan.${field} must be null, a non-negative safe integer (0 = forbid, positive = the cap), or a finite number of the field's unit`);
      return undefined;
    }
    return v;
  };
  /** E4-R28 (G02): nullable COST-like field — null = unlimited, 0 = FORBID,
   *  positive = the cap. Cost allows REASONABLE finite decimals (a fractional
   *  dollar cap is legal); NaN/Infinity and negatives are rejected. */
  const nullableCost = (field: string): number | null | undefined => {
    const v = r[field];
    if (v === null) return null;
    if (v === undefined) {
      issues.push(`executionPlan.${field} key is missing (use null for unlimited, 0 to forbid)`);
      return undefined;
    }
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      issues.push(`executionPlan.${field} must be null or a finite non-negative number (0 = forbid, positive = the cap)`);
      return undefined;
    }
    return v;
  };
  const bool = (field: string): boolean | null => {
    const v = r[field];
    if (typeof v !== "boolean") {
      issues.push(`executionPlan.${field} must be a boolean`);
      return null;
    }
    return v;
  };

  str("suite");
  str("judgeVersion");
  str("billingClass");
  str("isolationBackendId");
  str("providerId");
  str("modelId");
  // limit: null = no case-count cap; otherwise a positive SAFE integer.
  if (r["limit"] === null) {
    // unlimited — the planned case set is caseIds itself
  } else {
    safeCount("limit", 1);
  }
  safeCount("repeat", 1); // E4-R28: fractional repeat (2.5) is rejected
  safeCount("seed", 0); // E4-R28: seed must agree with CLI's non-negative integer PRNG contract
  bool("interleave");
  bool("shuffle");
  bool("promotionEligible");

  // E4-R28 (G02): the four budget fields MUST actually be validated — the
  // pre-R28 parser defined `nullableNum` but never called it, so a negative
  // maxModelCalls, a deleted maxLogicalRuns key, and a string
  // maxEstimatedCostUsd all sailed through as "accepted". Interger-count
  // fields use safe-count semantics; the USD cap allows finite decimals.
  nullableCount("maxLogicalRuns");
  nullableCount("maxModelCalls");
  nullableCount("maxEstimatedTokens");
  nullableCost("maxEstimatedCostUsd");

  if (r["candidate"] !== null && typeof r["candidate"] !== "string") {
    issues.push("executionPlan.candidate must be a string or null");
  }
  if (r["estimateStatus"] !== "bounded" && r["estimateStatus"] !== "unknown") {
    issues.push(`executionPlan.estimateStatus must be "bounded" or "unknown" (got ${JSON.stringify(r["estimateStatus"])})`);
  }
  if (r["isolationStrength"] !== "strong" && r["isolationStrength"] !== "insecure-local" && r["isolationStrength"] !== "none") {
    issues.push(`executionPlan.isolationStrength must be strong|insecure-local|none (got ${JSON.stringify(r["isolationStrength"])})`);
  }
  if (r["sourceSha"] !== null && !hex40(r["sourceSha"])) {
    issues.push("executionPlan.sourceSha must be null or 40-hex");
  }
  if (r["treeFingerprint"] !== null && !hex64(r["treeFingerprint"])) {
    issues.push("executionPlan.treeFingerprint must be null or 64-hex");
  }
  if (!hex64(r["thresholdDigest"])) {
    issues.push("executionPlan.thresholdDigest must be 64-hex");
  }

  // caseIds: non-empty, unique, non-empty strings.
  const caseIdsRaw = r["caseIds"];
  const caseIds: string[] = [];
  if (!Array.isArray(caseIdsRaw) || caseIdsRaw.length === 0) {
    issues.push("executionPlan.caseIds must be a non-empty array");
  } else {
    let idsOk = true;
    const seen = new Set<string>();
    for (const c of caseIdsRaw) {
      if (typeof c !== "string" || c.length === 0 || seen.has(c)) {
        issues.push("executionPlan.caseIds must contain unique non-empty strings");
        idsOk = false;
        break;
      }
      seen.add(c);
    }
    if (idsOk) caseIds.push(...(caseIdsRaw as string[]));
  }

  // caseFingerprints: a 64-hex entry for EVERY planned case — exactly.
  const fpRaw = r["caseFingerprints"];
  if (typeof fpRaw !== "object" || fpRaw === null || Array.isArray(fpRaw)) {
    issues.push("executionPlan.caseFingerprints must be an object mapping caseId -> 64-hex fingerprint");
  } else {
    const fp = fpRaw as Record<string, unknown>;
    const fpKeys = new Set(Object.keys(fp));
    for (const c of caseIds) {
      if (!fpKeys.has(c) || !hex64(fp[c])) {
        issues.push(`executionPlan.caseFingerprints must carry a 64-hex fingerprint for planned case ${JSON.stringify(c)}`);
      }
    }
    for (const k of fpKeys) {
      if (!caseIds.includes(k)) {
        issues.push(`executionPlan.caseFingerprints carries fingerprint for UNPLANNED case ${JSON.stringify(k)}`);
      }
    }
  }

  if (typeof r["decisionPolicy"] !== "object" || r["decisionPolicy"] === null || Array.isArray(r["decisionPolicy"])) {
    issues.push("executionPlan.decisionPolicy must be a non-null object (the pre-registered policy)");
  }
  if (typeof r["effectiveModelParams"] !== "object" || r["effectiveModelParams"] === null || Array.isArray(r["effectiveModelParams"])) {
    issues.push("executionPlan.effectiveModelParams must be a non-null object");
  }

  // E4-R28 (G02): grid-scale guard BEFORE any expansion loop. Independent of
  // the per-field checks above, a plan whose repeat × caseCount would consume
  // an unbounded array (expectedSampleKeysFromExecutionPlan / the evaluator /
  // the writer) is rejected HERE with a structured error so no caller ever
  // runs a huge loop. The cap is a documented product limit (repeat × case
  // count); paired benchmarks then run 2× that many logical arm runs — the
  // plan's own maxLogicalRuns budget is the second, per-experiment gate.
  if (issues.length === 0 && caseIds.length > 0) {
    const repRaw = r["repeat"];
    if (typeof repRaw === "number" && Number.isSafeInteger(repRaw) && repRaw >= 1) {
      const product = repRaw * caseIds.length;
      if (!Number.isSafeInteger(product)) {
        issues.push(`executionPlan grid size repeat(${repRaw}) × caseCount(${caseIds.length}) overflows a safe integer`);
      } else if (product > EXECUTION_PLAN_MAX_PLANNED_SAMPLES) {
        issues.push(
          `executionPlan grid size repeat(${repRaw}) × caseCount(${caseIds.length}) = ${product} > the documented ${EXECUTION_PLAN_MAX_PLANNED_SAMPLES} planned-sample cap (refuse before expansion)`,
        );
      }
    }
    // E4-R28 (G02): LIMIT is the confirmed plan's cap on "the first N of
    // caseIds" (CLI: `--limit` non-negative, 0 = all → null). The CLI slices
    // the case set BEFORE building the plan, so a non-null limit that is
    // SMALLER than the number of caseIds contradicts itself: the plan claims
    // to cap at N but lists more cases than N. Reject here (both the CLI and
    // the grid generator use caseIds as the actual selected set).
    const limitRaw = r["limit"];
    if (typeof limitRaw === "number" && Number.isSafeInteger(limitRaw) && limitRaw >= 1 && limitRaw < caseIds.length) {
      issues.push(
        `executionPlan.limit ${limitRaw} < caseIds.length ${caseIds.length} — the plan caps the first N cases but lists more than N (CLI slices before planning; the grid derives from caseIds)`,
      );
    }
  }

  if (issues.length > 0) return { plan: null, issues };
  return { plan: value as unknown as ExecutionPlanV1, issues: [] };
}

/**
 * sha256 over the plan's canonical stable serialization — the SAME digest
 * protocol as the CLI's computeBenchmarkPlanDigest (computeRuntimeConfigHash),
 * so a plan confirmed in the CLI re-derives the same digest here.
 */
export function computeExecutionPlanDigest(plan: ExecutionPlanV1): string {
  return computeRuntimeConfigHash(plan);
}

/** Stable codes for the promotion-ELIGIBILITY semantics (E4-R27 / G01). These
 *  are NOT field-shape errors (those are `executionPlan.*` parse issues) — they
 *  are requests that are internally consistent yet semantically impossible:
 *  the fields agree with each other but the combination cannot promote. */
export type PromotionEligibilityCode =
  | "ELIGIBILITY_ISOLATION_NOT_STRONG"
  | "ELIGIBILITY_ISOLATION_BACKEND_UNKNOWN"
  | "ELIGIBILITY_SOURCE_SHA_MISSING"
  | "ELIGIBILITY_SOURCE_TREE_DIRTY"
  | "ELIGIBILITY_CANDIDATE_MISSING";

export interface PromotionEligibilityViolation {
  code: PromotionEligibilityCode;
  detail: string;
}

/**
 * E4-R27 (G01) — the MINIMUM semantic conditions for `promotionEligible=true`.
 *
 * Field consistency is one condition, not a legal combination. The confirmed
 * plan, the artifact manifest, the V3 writer and the promotion loader all agree
 * on `promotionEligible=true` + `isolationStrength="insecure-local"` when both
 * were written that way — and that pair IS internally consistent, so every
 * existing check passes while the protocol contradicts itself. This function is
 * the shared authority that decides whether a promotion-eligible CLAIM is
 * backed by the facts a promotion-grade experiment must carry.
 *
 * The contract (fail-closed — an unknown/absent required fact is a violation):
 *
 *   1. `isolationStrength === "strong"` — OS-level confinement actually
 *      available. `insecure-local` and `none` are NEVER promotion-grade, no
 *      matter how consistent the rest of the record is (mirrors
 *      benchmark-isolation.promotionEligible for the runtime backend probe).
 *   2. the isolation backend is a KNOWN, non-empty id — "not-probed" /
 *      "unknown" cannot back a strong claim.
 *   3. `sourceSha` is a KNOWN 40-hex commit — a promotion whose source is
 *      unknown cannot be reproduced or attributed.
 *   4. `treeFingerprint` is NULL — the plan was confirmed on a CLEAN tree. The
 *      CLI records a CONTENT fingerprint only when `git status --porcelain` is
 *      non-empty (`probeSourceSnapshot` returns `treeFingerprint: null` for a
 *      clean tree), so a non-null fingerprint MEANS the confirmed plan was
 *      bound to a dirty tree — which the CLI refuses at execution time
 *      ("the confirmed plan was made against a dirty tree"). Both the plan
 *      protocol and the CLI therefore agree that a dirty-source plan cannot
 *      promote.
 *   5. `candidate` names the challenger — a candidateless pair promotes
 *      nothing.
 *
 * A plan with `promotionEligible=false` is a DIAGNOSTIC record: it may carry
 * any isolation posture and is never rejected here. Callers treat violations
 * as "not promotion-grade" (ACCEL/ACCEPT must not follow), never as a
 * best-effort partial promotion.
 */
export function validatePromotionEligibility(plan: ExecutionPlanV1): PromotionEligibilityViolation[] {
  const violations: PromotionEligibilityViolation[] = [];
  if (plan.promotionEligible !== true) return violations; // diagnostics are exempt

  if (plan.isolationStrength !== "strong") {
    violations.push({
      code: "ELIGIBILITY_ISOLATION_NOT_STRONG",
      detail: `promotionEligible=true requires isolationStrength="strong" (got ${JSON.stringify(plan.isolationStrength)}) — insecure/none isolation is NEVER promotion-grade`,
    });
  }
  const backend = plan.isolationBackendId;
  if (typeof backend !== "string" || backend.length === 0 || backend === "not-probed" || backend === "unknown") {
    violations.push({
      code: "ELIGIBILITY_ISOLATION_BACKEND_UNKNOWN",
      detail: `promotionEligible=true requires a KNOWN isolation backend id (got ${JSON.stringify(backend)}) — an unprobed/unknown backend cannot back a strong-isolation claim`,
    });
  }
  if (plan.sourceSha === null) {
    violations.push({
      code: "ELIGIBILITY_SOURCE_SHA_MISSING",
      detail: "promotionEligible=true requires a known sourceSha (40-hex) — an unknown source cannot promote",
    });
  }
  if (plan.treeFingerprint !== null) {
    violations.push({
      code: "ELIGIBILITY_SOURCE_TREE_DIRTY",
      detail:
        "promotionEligible=true requires a plan confirmed on a CLEAN source tree, but executionPlan.treeFingerprint is set — the CLI records a tree fingerprint ONLY for a dirty tree (probeSourceSnapshot), so this plan would be refused at execution time",
    });
  }
  if (plan.candidate === null) {
    violations.push({
      code: "ELIGIBILITY_CANDIDATE_MISSING",
      detail: "promotionEligible=true requires the plan to NAME the challenger it promotes (plan.candidate is null)",
    });
  }
  return violations;
}

/**
 * Derive the expected sample grid from the CONFIRMED plan: exactly one key
 * `${suite}\0${caseId}\0${repetition}` for every (caseId × repetition in
 * 1..repeat) — repetition-major order is canonical but callers compare as
 * sets. The manifest's expectedSampleKeys is now CORROBORATION, never the
 * authority: when present it must equal this derived grid exactly.
 */
export function expectedSampleKeysFromExecutionPlan(plan: ExecutionPlanV1): string[] {
  const keys: string[] = [];
  for (let rep = 1; rep <= plan.repeat; rep += 1) {
    for (const caseId of plan.caseIds) {
      keys.push(`${plan.suite}\u0000${caseId}\u0000${rep}`);
    }
  }
  return keys;
}

/** Set equality over string arrays (the grid is a SET of planned samples;
 *  key order is not semantically meaningful). */
export function stringSetEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  if (sa.size !== a.length || new Set(b).size !== b.length) return false; // duplicates disqualify
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}

/** Facts the plan is cross-bound against. All of them are available at BOTH
 *  the evaluator boundary and the promotion-loader boundary. */
export interface ExecutionPlanBindingContext {
  /** Manifest of the artifact that carries the plan (the promotion target). */
  manifest: Readonly<Record<string, unknown>>;
  /** Provenance of the same artifact (identity facts recorded at run time). */
  provenance: Readonly<{ provider?: string | null; model?: string | null; gitSha?: string | null }>;
  /** The OTHER arm's manifest.planDigest (evaluator path): both arms ran the
   *  SAME confirmed plan. */
  otherArmPlanDigest?: unknown;
  /** The applied decision-policy digest (evaluator path): the plan's
   *  pre-registered policy must BE the policy the evaluator applied. */
  appliedThresholdDigest?: string;
  /** The candidate artifact's arm.candidateId (the promotion target): the
   *  confirmed plan must NAME the challenger it promotes (E4-R22). */
  candidateId?: string | null;
}

/**
 * Cross-bind a parsed plan to the artifact facts around it. Returns stable,
 * human-readable violations (empty = bound). Checks:
 *
 *   - manifest.planDigest equals the RECOMPUTED plan digest (and the other
 *     arm's planDigest agrees — one experiment, one plan);
 *   - manifest.expectedSampleKeys equals the grid DERIVED from the plan;
 *   - plan.thresholdDigest equals the applied policy digest (when known) and
 *     the manifest's recorded thresholdDigest (when present);
 *   - plan.decisionPolicy hashes to plan.thresholdDigest (the recorded policy
 *     IS the pre-registered policy);
 *   - plan.judgeVersion / isolationStrength / promotionEligible equal the
 *     manifest's recorded values;
 *   - plan.providerId / modelId equal the artifact's run-time provenance;
 *   - plan.sourceSha (when non-null) equals the manifest's gitSha;
 *   - plan.candidate equals the candidate artifact's candidateId (the plan
 *     NAMES the challenger it promotes).
 */
export function crossBindExecutionPlan(plan: ExecutionPlanV1, ctx: ExecutionPlanBindingContext): string[] {
  const violations: string[] = [];
  const m = ctx.manifest;

  // 1. Digest binding: the recorded planDigest IS this plan's content digest.
  const recomputed = computeExecutionPlanDigest(plan);
  const manifestPlanDigest = m["planDigest"];
  if (typeof manifestPlanDigest !== "string" || manifestPlanDigest !== recomputed) {
    violations.push(
      `manifest.planDigest ${String(manifestPlanDigest)} != recomputed execution plan digest ${recomputed} (plan content does not match the confirmed digest)`,
    );
  }
  if (typeof ctx.otherArmPlanDigest === "string" && ctx.otherArmPlanDigest !== recomputed) {
    violations.push(
      `baseline manifest.planDigest ${ctx.otherArmPlanDigest} != candidate recomputed plan digest ${recomputed} (arms disagree on the confirmed plan)`,
    );
  }

  // 2. Grid binding: the manifest grid is derived FROM the plan (corroboration).
  const derivedGrid = expectedSampleKeysFromExecutionPlan(plan);
  const expectedRaw = m["expectedSampleKeys"];
  if (!Array.isArray(expectedRaw) || !stringSetEqual(expectedRaw as string[], derivedGrid)) {
    violations.push(
      `manifest.expectedSampleKeys does not equal the grid derived from the confirmed plan (${derivedGrid.length} planned samples)`,
    );
  }

  // 3. Policy binding.
  if (ctx.appliedThresholdDigest !== undefined && plan.thresholdDigest !== ctx.appliedThresholdDigest) {
    violations.push(
      `executionPlan.thresholdDigest ${plan.thresholdDigest} != applied policy digest ${ctx.appliedThresholdDigest} (the plan pre-registered a different policy than the one applied)`,
    );
  }
  const manifestThreshold = m["thresholdDigest"];
  if (typeof manifestThreshold === "string" && manifestThreshold !== plan.thresholdDigest) {
    violations.push(
      `manifest.thresholdDigest ${manifestThreshold} != executionPlan.thresholdDigest ${plan.thresholdDigest}`,
    );
  }
  const policyDigest = computeRuntimeConfigHash(plan.decisionPolicy);
  if (policyDigest !== plan.thresholdDigest) {
    violations.push(
      `executionPlan.decisionPolicy hashes to ${policyDigest} but executionPlan.thresholdDigest is ${plan.thresholdDigest} (recorded policy is not the pre-registered policy)`,
    );
  }

  // 4. Manifest fact binding.
  if (typeof m["judgeVersion"] === "string" && m["judgeVersion"] !== plan.judgeVersion) {
    violations.push(`manifest.judgeVersion ${String(m["judgeVersion"])} != plan.judgeVersion ${plan.judgeVersion}`);
  }
  if (typeof m["isolationStrength"] === "string" && m["isolationStrength"] !== plan.isolationStrength) {
    violations.push(`manifest.isolationStrength ${String(m["isolationStrength"])} != plan.isolationStrength ${plan.isolationStrength}`);
  }
  if (m["promotionEligible"] !== undefined && m["promotionEligible"] !== plan.promotionEligible) {
    violations.push(`manifest.promotionEligible ${String(m["promotionEligible"])} != plan.promotionEligible ${String(plan.promotionEligible)}`);
  }

  // 5. Provenance identity binding (recorded at run time, not self-declared).
  if (typeof ctx.provenance.provider === "string" && ctx.provenance.provider !== plan.providerId) {
    violations.push(`provenance.provider ${ctx.provenance.provider} != plan.providerId ${plan.providerId}`);
  }
  if (typeof ctx.provenance.model === "string" && ctx.provenance.model !== plan.modelId) {
    violations.push(`provenance.model ${ctx.provenance.model} != plan.modelId ${plan.modelId}`);
  }
  if (plan.sourceSha !== null && typeof m["gitSha"] === "string" && m["gitSha"] !== plan.sourceSha) {
    violations.push(`manifest.gitSha ${String(m["gitSha"])} != plan.sourceSha ${plan.sourceSha}`);
  }

  // 6. Candidate binding: the confirmed plan NAMES the challenger it promotes.
  //    A promotion-eligible plan whose candidate does not match the candidate
  //    artifact's own candidateId is an experiment about SOMETHING ELSE. Both
  //    null (a candidateless pair) agrees; any other disagreement is a
  //    violation.
  if (ctx.candidateId !== undefined && (plan.candidate !== null || ctx.candidateId !== null)) {
    if (plan.candidate !== ctx.candidateId) {
      violations.push(
        `executionPlan.candidate ${JSON.stringify(plan.candidate)} != candidate artifact candidateId ${JSON.stringify(ctx.candidateId)} (the plan authorized a different challenger)`,
      );
    }
  }

  return violations;
}
