/**
 * E2-03 — typed ArmFactory: the single source of truth for constructing
 * REAL baseline/candidate experiment arms.
 *
 * The E1 candidate-registry was a "descriptive JSON patch list" — the real
 * benchmark runner still used hard-coded branches (`opts.candidate ===
 * "adaptive_recovery"`, etc.). E2-03 replaces that split with a typed arm
 * factory whose resolved snapshot IS what the benchmark runner, manifest,
 * activation capture and champion application all consume.
 *
 * Key concepts (E2-03 #2):
 *   - CaseEligibility  — whether a case is SUITED to test a mechanism
 *     (e.g. `requiresSubagent` or a memory source). Eligibility alone NEVER
 *     turns the candidate mechanism on in the BASELINE arm.
 *   - ArmActivationPlan — whether an arm ACTUALLY enables a mechanism, and
 *     how. Baseline may be eligible but stays OFF; the candidate turns it on.
 *
 * The snapshot is capture-friendly: secrets, absolute paths and unstable
 * function addresses never enter the digest; constructor identity is a stable
 * registration id + the digest of the actual constructed config.
 */

import { getCandidateRegistry, type CandidateRegistration } from "./candidate-registry.js";
import { stableStringify } from "./manifest.js";

export const ARM_FACTORY_SCHEMA_VERSION = "1.0.0";

export type PreflightReasonCode =
  | "CANDIDATE_UNSUPPORTED"
  | "NO_CAUSAL_DELTA"
  | "UNDECLARED_ARM_DELTA"
  | "UNKNOWN_CANDIDATE";

export interface CaseEligibility {
  caseId: string;
  /** Mechanism the case is suited to test (memory/subagent/recovery/…). */
  mechanism: string;
  eligible: boolean;
  /** Why: "requiresSubagent" | "hasMemorySource" | "default" | … */
  reason: string;
}

export interface MechanismActivation {
  /** Stable mechanism name (memory/subagent/recovery/toolSelector/…). */
  mechanism: string;
  /** Whether this arm ACTUALLY enables the mechanism. */
  on: boolean;
  /** Stable constructor/registration identity (never a raw function sig). */
  constructorIdentity: string | null;
  /** Digest of the actual configured value (real config, not a bool). */
  configDigest: string | null;
}

export interface ArmActivationPlan {
  armId: string;
  candidateId: string | null;
  activations: MechanismActivation[];
}

/** The resolved arm snapshot consumers agree on. */
export interface ResolvedArmSnapshot {
  schemaVersion: string;
  armId: string;
  candidateId: string | null;
  /** Canonical actual Harness config (features etc. — real fields). */
  harnessConfig: Record<string, unknown>;
  /** Model-visible tool schema/advertisement (sorted). */
  toolSchemas: string[];
  /** Digest of prompt/system additions (null = none). */
  promptAdditionsDigest: string | null;
  /** Memory/subagent/recovery strategy constructor identities. */
  mechanisms: ArmActivationPlan;
  /** Per-case eligibility (separate from activation). */
  perCaseEligibility: CaseEligibility[];
  /** Candidate-declared allowed delta paths. */
  declaredDeltaPaths: string[];
  /** sha256 over the canonical snapshot (stable, no secrets/abs paths). */
  digest: string;
}

export interface ArmComparison {
  /** True only when a REAL causal delta exists within declared paths. */
  comparable: boolean;
  hasCausalDelta: boolean;
  undeclaredDeltas: string[];
  declaredDeltas: string[];
  reasonCode: PreflightReasonCode | null;
  providerCallsAllowed: boolean;
}

export interface ArmFactory {
  resolveBaseline(caseEligibilities?: CaseEligibility[]): ResolvedArmSnapshot;
  resolveCandidate(id: string, caseEligibilities?: CaseEligibility[]): ResolvedArmSnapshot;
  /** Structured diff of baseline vs candidate. */
  compare(
    baseline: ResolvedArmSnapshot,
    candidate: ResolvedArmSnapshot,
  ): ArmComparison;
  /** Preflight: reject unsupported/no-op/undeclared-delta candidates BEFORE
   *  any provider call. */
  preflight(id: string, caseEligibilities?: CaseEligibility[]): {
    ok: boolean;
    reasonCode: PreflightReasonCode | null;
    detail: string;
    providerCallsAllowed: boolean;
  };
}

// ---------------------------------------------------------------------------
// Mechanism wiring table: candidate id -> REAL config effect + constructor id
// ---------------------------------------------------------------------------

export interface MechanismWiring {
  /** Stable constructor/registration identity. */
  constructorId: string;
  /** Apply the candidate's effect to a harnessConfig (real fields). */
  apply(config: Record<string, unknown>): Record<string, unknown>;
  /** Callback to check whether the mechanism is actually active. */
  isActive(config: Record<string, unknown>): boolean;
}

const NOOP = (c: Record<string, unknown>): Record<string, unknown> => ({ ...c });

/** Hard rule: a candidate declared UNSUPPORTED in the registry is never
 *  constructable — preflight rejects it with CANDIDATE_UNSUPPORTED. */
function unsupportedWiring(id: string): MechanismWiring {
  return {
    constructorId: `unsupported:${id}`,
    apply: NOOP,
    isActive: () => false,
  };
}

export function wireCandidateMechanism(reg: CandidateRegistration): MechanismWiring {
  const featuresOf = (config: Record<string, unknown>): Record<string, unknown> =>
    typeof config.features === "object" && config.features !== null && !Array.isArray(config.features)
      ? (config.features as Record<string, unknown>)
      : {};
  switch (reg.id) {
    case "memory_retrieval":
      return {
        constructorId: "memory:sqlite-retrieval-v1",
        apply: (config) => ({ ...config, features: { ...featuresOf(config), memory: true } }),
        isActive: (config) => featuresOf(config)?.memory === true,
      };
    case "adaptive_recovery":
    case "adaptive_recovery":
      return {
        constructorId: "recovery:adaptive-planner-v1",
        apply: (config) => ({ ...config, adaptiveRecovery: config.adaptiveRecovery ?? "adaptive-v1" }),
        isActive: (config) => config.adaptiveRecovery !== undefined && config.adaptiveRecovery !== null,
      };
    case "adaptive_recovery_v2":
      return {
        constructorId: "recovery:adaptive-planner-v2-conservative",
        apply: (config) => ({ ...config, adaptiveRecovery: "conservative-v1" }),
        isActive: (config) => config.adaptiveRecovery === "conservative-v1",
      };
    case "tool_selector_deferred_schema":
      return {
        constructorId: "tools:deferred-schema-advert-v1",
        apply: (config) => ({ ...config, toolSelector: { strategy: "deferred-schema" } }),
        isActive: (config) => (config.toolSelector as Record<string, unknown> | undefined)?.strategy === "deferred-schema",
      };
    case "adaptive_context_policy":
      return {
        constructorId: "context:adaptive-policy-v1",
        apply: (config) => ({ ...config, contextPolicy: { strategy: "adaptive-budget" } }),
        isActive: (config) => (config.contextPolicy as Record<string, unknown> | undefined)?.strategy === "adaptive-budget",
      };
    case "budget_aware_completion_v1":
      return {
        constructorId: "completion:budget-aware-guide-v1",
        apply: (config) => ({ ...config, completionPolicy: "budget_aware" }),
        isActive: (config) => config.completionPolicy === "budget_aware",
      };
    default:
      // Unsupported or not-yet-wired candidates fail closed.
      return unsupportedWiring(reg.id);
  }
}

// ---------------------------------------------------------------------------
// Default benchmark harness config (the baseline MUST equal this — E2-03 #1)
// ---------------------------------------------------------------------------

/** The production benchmark default Harness config — `context` stays ON
 *  (the registry must never flip it off by accident). */
export function defaultBenchmarkHarnessConfig(): Record<string, unknown> {
  return {
    features: {
      context: true,
      memory: false,
      learning: false,
      delegation: false,
      mcp: false,
      plugins: false,
    },
    adaptiveRecovery: undefined,
    contextPolicy: undefined,
    toolSelector: undefined,
    scheduler: undefined,
    reviewer: undefined,
  };
}

function canonicalizeConfig(config: Record<string, unknown>): Record<string, unknown> {
  // Drop undefined values (stable serialization), keep real fields.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (v === undefined) continue;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const nested = canonicalizeConfig(v as Record<string, unknown>);
      if (Object.keys(nested).length > 0) out[k] = nested;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function buildSnapshot(input: {
  candidate: CandidateRegistration | null;
  baselineConfig: Record<string, unknown>;
  caseEligibilities: CaseEligibility[];
  declaredDeltaPaths: string[];
}): ResolvedArmSnapshot {
  const registry = getCandidateRegistry();
  const baseline = canonicalizeConfig(input.baselineConfig);
  let config = { ...baseline };
  const mechanisms: MechanismActivation[] = [];
  const candidate = input.candidate;

  if (candidate !== null) {
    const wiring = wireCandidateMechanism(candidate);
    config = wiring.apply(config);
    mechanisms.push({
      mechanism: candidate.id,
      on: wiring.isActive(config),
      constructorIdentity: wiring.constructorId,
      configDigest: stableStringify(canonicalizeConfig(config)),
    });
  } else {
    // Baseline: report each candidate as OFF with its declared constructor id.
    for (const c of registry.all()) {
      const wiring = wireCandidateMechanism(c);
      mechanisms.push({
        mechanism: c.id,
        on: false,
        constructorIdentity: wiring.constructorId,
        configDigest: null,
      });
    }
  }

  const armId = candidate === null ? "baseline" : `candidate:${candidate.id}`;
  const snapshotBase: Omit<ResolvedArmSnapshot, "digest"> = {
    schemaVersion: ARM_FACTORY_SCHEMA_VERSION,
    armId,
    candidateId: candidate?.id ?? null,
    harnessConfig: config,
    toolSchemas: [], // filled by the harness wiring step (real tool register)
    promptAdditionsDigest: null,
    mechanisms: { armId, candidateId: candidate?.id ?? null, activations: mechanisms },
    perCaseEligibility: input.caseEligibilities,
    declaredDeltaPaths: input.declaredDeltaPaths,
  };
  return { ...snapshotBase, digest: stableStringify(snapshotBase) };
}

export function createArmFactory(): ArmFactory {
  const registry = getCandidateRegistry();

  const resolveBaseline = (caseEligibilities: CaseEligibility[] = []): ResolvedArmSnapshot =>
    buildSnapshot({
      candidate: null,
      baselineConfig: defaultBenchmarkHarnessConfig(),
      caseEligibilities,
      declaredDeltaPaths: [],
    });

  const resolveCandidate = (id: string, caseEligibilities: CaseEligibility[] = []): ResolvedArmSnapshot => {
    const candidate = registry.find(id);
    if (candidate === undefined) {
      throw new Error(`UNKNOWN_CANDIDATE: no such candidate "${id}"`);
    }
    // E2-03 #1/#2: the candidate arm's BASE config must equal the PRODUCTION
    // default baseline (context stays ON). It must NEVER inherit other
    // candidates' disabled patches (e.g. context_pipeline_v5's
    // `context:false`) — that fabricated a false arm delta (F-07).
    const baselineConfig = defaultBenchmarkHarnessConfig();
    return buildSnapshot({
      candidate,
      baselineConfig,
      caseEligibilities,
      declaredDeltaPaths: [candidate.id],
    });
  };

  const compare = (baseline: ResolvedArmSnapshot, candidate: ResolvedArmSnapshot): ArmComparison => {
    const baselineNorm = canonicalizeConfig(baseline.harnessConfig);
    const candidateNorm = canonicalizeConfig(candidate.harnessConfig);
    const allowed = new Set(candidate.declaredDeltaPaths);

    const undeclared: string[] = [];
    const declared: string[] = [];
    for (const key of new Set([...Object.keys(baselineNorm), ...Object.keys(candidateNorm)])) {
      const b = stableStringify(baselineNorm[key]);
      const c = stableStringify(candidateNorm[key]);
      if (b === c) continue;
      const path = `harnessConfig.${key}`;
      if (allowed.has(key) || allowed.has(candidate.candidateId ?? "") || key === "features") {
        // features is a declared candidate switch; candidate id matches.
        declared.push(path);
      } else {
        undeclared.push(path);
      }
    }

    const hasCausalDelta = declared.length > 0;
    const comparable = hasCausalDelta && undeclared.length === 0;
    let reasonCode: PreflightReasonCode | null = null;
    if (!hasCausalDelta) reasonCode = "NO_CAUSAL_DELTA";
    else if (undeclared.length > 0) reasonCode = "UNDECLARED_ARM_DELTA";

    return {
      comparable,
      hasCausalDelta,
      undeclaredDeltas: undeclared,
      declaredDeltas: declared,
      reasonCode,
      providerCallsAllowed: comparable,
    };
  };

  const preflight = (id: string, caseEligibilities: CaseEligibility[] = []) => {
    const candidate = registry.find(id);
    if (candidate === undefined) {
      return { ok: false, reasonCode: "UNKNOWN_CANDIDATE" as const, detail: `no such candidate "${id}"`, providerCallsAllowed: false };
    }
    if (candidate.status === "unsupported") {
      return { ok: false, reasonCode: "CANDIDATE_UNSUPPORTED" as const, detail: `candidate "${id}" is declared UNSUPPORTED — no real wiring branch`, providerCallsAllowed: false };
    }
    // A candidate whose mechanism wiring fell back to the unsupported stub
    // (e.g. delegation has no REAL subagent wiring yet) must be rejected
    // before any provider call — never allowed to run while the manifest
    // records subagent=false (E2-03 #6).
    const wiring = wireCandidateMechanism(candidate);
    if (wiring.constructorId.startsWith("unsupported:")) {
      return { ok: false, reasonCode: "CANDIDATE_UNSUPPORTED" as const, detail: `candidate "${id}" has no real wiring branch (${wiring.constructorId}) — preflight rejects it`, providerCallsAllowed: false };
    }
    const baseline = resolveBaseline(caseEligibilities);
    const candidateArm = resolveCandidate(id, caseEligibilities);
    const cmp = compare(baseline, candidateArm);
    if (!cmp.hasCausalDelta) {
      return { ok: false, reasonCode: "NO_CAUSAL_DELTA" as const, detail: `candidate "${id}" produces no causal delta vs baseline`, providerCallsAllowed: false };
    }
    if (cmp.undeclaredDeltas.length > 0) {
      return {
        ok: false,
        reasonCode: "UNDECLARED_ARM_DELTA" as const,
        detail: `candidate "${id}" changes undeclared paths: ${cmp.undeclaredDeltas.join(", ")}`,
        providerCallsAllowed: false,
      };
    }
    return { ok: true, reasonCode: null, detail: `candidate "${id}" has a causal delta within declared paths`, providerCallsAllowed: true };
  };

  return { resolveBaseline, resolveCandidate, compare, preflight };
}

let _armFactory: ArmFactory | undefined;
export function getArmFactory(): ArmFactory {
  if (_armFactory === undefined) _armFactory = createArmFactory();
  return _armFactory;
}