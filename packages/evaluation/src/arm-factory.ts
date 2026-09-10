/**
 * E2-03 / E3-03 — typed ArmFactory: the single source of truth for constructing
 * REAL baseline/candidate experiment arms.
 *
 * The E1 candidate-registry was a "descriptive JSON patch list" — the real
 * benchmark runner still used hard-coded branches (`opts.candidate ===
 * "adaptive_recovery"`, etc.). E2-03 replaces that split with a typed arm
 * factory whose resolved snapshot IS what the benchmark runner, manifest,
 * activation capture and champion application all consume.
 *
 * E3-03 closes the remaining gap: the snapshot's `harnessConfig` was a
 * `Record<string, unknown>` that a runner still had to interpret through
 * hard-coded candidate-id branches. The factory now exposes a typed
 * `ResolvedExperimentArm` whose `runtimeMechanisms` describes each REAL
 * runtime injection point (recovery planner, memory retrieval, deferred
 * schema, adaptive context budget, budget-aware completion guidance) in a way
 * a runner consumes directly — no `opts.candidate === "…"` branches.
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

import { createHash } from "node:crypto";
import { getCandidateRegistry, type CandidateRegistration } from "./candidate-registry.js";
import { stableStringify } from "./manifest.js";
import { budgetAwareCompletionGuidanceDigest } from "./mechanism-guidance.js";

export const ARM_FACTORY_SCHEMA_VERSION = "1.0.0";
export const ARM_FACTORY_POLICY_VERSION = "e3-03-arm-v1";

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
  /** Declared paths that did NOT actually change (declared-but-absent). */
  missingDeclaredDeltas: string[];
  reasonCode: PreflightReasonCode | null;
  providerCallsAllowed: boolean;
}

/**
 * E3-03 — typed runtime mechanism injection points a real runner consumes
 * directly (NO `opts.candidate === "…"` branches). Each field maps to a REAL
 * runtime/runtime-dep wiring decision, and `digest` covers all of them so any
 * change to a mechanism changes the arm digest.
 */
export interface RuntimeMechanisms {
  /** Recovery planner to wire into the runtime (null = champion default). */
  recoveryPlanner: "adaptive-v1" | "adaptive-v2-conservative" | null;
  /** Pre-turn memory retrieval provider wired (candidate memory on). */
  memoryRetrieval: boolean;
  /** Deferred schema advertisement policy active (tool_lookup + stub bulk). */
  deferredSchema: boolean;
  /** Adaptive context budget dynamic headroom in tokens (0 = baseline). */
  adaptiveContextDynamic: number;
  /** Budget-aware completion guidance injected into the system prompt. */
  budgetAwareCompletion: boolean;
  /** Digest of prompt/system additions (null = none). */
  promptAdditionsDigest: string | null;
  /** Policy version that produced these mechanisms. */
  policyVersion: string;
}

/** E3-03 — the typed resolved arm a runner consumes end-to-end. */
export interface ResolvedExperimentArm extends ResolvedArmSnapshot {
  /** Real runtime injection points (the source the runner reads). */
  runtimeMechanisms: RuntimeMechanisms;
  /** Policy version (distinct from schema version). */
  policyVersion: string;
}

export interface ArmFactory {
  resolveBaseline(caseEligibilities?: CaseEligibility[]): ResolvedArmSnapshot;
  resolveCandidate(id: string, caseEligibilities?: CaseEligibility[]): ResolvedArmSnapshot;
  /** E3-03: resolve the typed arm (runtime mechanisms + snapshot). */
  resolveArm(id: string | null, caseEligibilities?: CaseEligibility[]): ResolvedExperimentArm;
  /** E3-03: resolve ONLY the typed runtime mechanism injection points. */
  resolveRuntimeMechanisms(id: string | null): RuntimeMechanisms;
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
  /** E3-03: apply the candidate's effect to the typed RuntimeMechanisms. */
  applyRuntime(base: RuntimeMechanisms): RuntimeMechanisms;
  /** E3-03: exact JSON-pointer paths (harnessConfig.*) this candidate may
   *  change. ANY change outside these paths is an UNDECLARED_ARM_DELTA; a
   *  declared path that does NOT actually change is a missing causal delta. */
  declaredPaths: string[];
}

const NOOP = (c: Record<string, unknown>): Record<string, unknown> => ({ ...c });

const BASELINE_RUNTIME_MECHANISMS: RuntimeMechanisms = {
  recoveryPlanner: null,
  memoryRetrieval: false,
  deferredSchema: false,
  adaptiveContextDynamic: 0,
  budgetAwareCompletion: false,
  promptAdditionsDigest: null,
  policyVersion: ARM_FACTORY_POLICY_VERSION,
};

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Hard rule: a candidate declared UNSUPPORTED in the registry is never
 *  constructable — preflight rejects it with CANDIDATE_UNSUPPORTED. */
function unsupportedWiring(id: string): MechanismWiring {
  return {
    constructorId: `unsupported:${id}`,
    apply: NOOP,
    isActive: () => false,
    applyRuntime: (base) => base,
    declaredPaths: [],
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
        applyRuntime: (base) => ({ ...base, memoryRetrieval: true }),
        declaredPaths: ["harnessConfig.features.memory"],
      };
    case "adaptive_recovery":
      return {
        constructorId: "recovery:adaptive-planner-v1",
        apply: (config) => ({ ...config, adaptiveRecovery: config.adaptiveRecovery ?? "adaptive-v1" }),
        isActive: (config) => config.adaptiveRecovery !== undefined && config.adaptiveRecovery !== null,
        applyRuntime: (base) => ({ ...base, recoveryPlanner: "adaptive-v1" }),
        declaredPaths: ["harnessConfig.adaptiveRecovery"],
      };
    case "adaptive_recovery_v2":
      return {
        constructorId: "recovery:adaptive-planner-v2-conservative",
        apply: (config) => ({ ...config, adaptiveRecovery: "conservative-v1" }),
        isActive: (config) => config.adaptiveRecovery === "conservative-v1",
        applyRuntime: (base) => ({ ...base, recoveryPlanner: "adaptive-v2-conservative" }),
        declaredPaths: ["harnessConfig.adaptiveRecovery"],
      };
    case "tool_selector_deferred_schema":
      return {
        constructorId: "tools:deferred-schema-advert-v1",
        apply: (config) => ({ ...config, toolSelector: { strategy: "deferred-schema" } }),
        isActive: (config) => (config.toolSelector as Record<string, unknown> | undefined)?.strategy === "deferred-schema",
        applyRuntime: (base) => ({
          ...base,
          deferredSchema: true,
          promptAdditionsDigest: sha256Hex("tool-selector-deferred-schema:v1"),
        }),
        declaredPaths: ["harnessConfig.toolSelector"],
      };
    case "adaptive_context_policy":
      return {
        constructorId: "context:adaptive-policy-v1",
        apply: (config) => ({ ...config, contextPolicy: { strategy: "adaptive-budget" } }),
        isActive: (config) => (config.contextPolicy as Record<string, unknown> | undefined)?.strategy === "adaptive-budget",
        applyRuntime: (base) => ({ ...base, adaptiveContextDynamic: 4096 }),
        declaredPaths: ["harnessConfig.contextPolicy"],
      };
    case "budget_aware_completion_v1":
      return {
        constructorId: "completion:budget-aware-guide-v1",
        apply: (config) => ({ ...config, completionPolicy: "budget_aware" }),
        isActive: (config) => config.completionPolicy === "budget_aware",
        applyRuntime: (base) => ({
          ...base,
          budgetAwareCompletion: true,
          // E4-R16 (N12): the digest binds the ACTUAL strategy text (the shared,
          // versioned mechanism definition) — a rewritten guidance changes the
          // arm digest, the R13 execution identity and the R15 promotion target.
          promptAdditionsDigest: budgetAwareCompletionGuidanceDigest(),
        }),
        declaredPaths: ["harnessConfig.completionPolicy"],
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
}): ResolvedExperimentArm {
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

  // E3-03: compute typed runtime mechanisms from the candidate wiring.
  let runtimeMechanisms: RuntimeMechanisms = { ...BASELINE_RUNTIME_MECHANISMS };
  if (candidate !== null) {
    runtimeMechanisms = wireCandidateMechanism(candidate).applyRuntime(runtimeMechanisms);
  }
  const promptFromRuntime = runtimeMechanisms.promptAdditionsDigest;

  const armId = candidate === null ? "baseline" : `candidate:${candidate.id}`;
  const experimentBase: Omit<ResolvedExperimentArm, "digest"> = {
    schemaVersion: ARM_FACTORY_SCHEMA_VERSION,
    policyVersion: ARM_FACTORY_POLICY_VERSION,
    armId,
    candidateId: candidate?.id ?? null,
    harnessConfig: config,
    toolSchemas: [], // filled by the harness wiring step (real tool register)
    promptAdditionsDigest: promptFromRuntime,
    mechanisms: { armId, candidateId: candidate?.id ?? null, activations: mechanisms },
    perCaseEligibility: input.caseEligibilities,
    declaredDeltaPaths: input.declaredDeltaPaths,
    runtimeMechanisms: {
      ...runtimeMechanisms,
      promptAdditionsDigest: promptFromRuntime,
    },
  };
  // Compact content-addressed digest (sha256 over the canonical snapshot),
  // NOT the raw stable string — consumers get a short, comparable token.
  const digest = computeSnapshotDigest(experimentBase);
  return { ...experimentBase, digest };
}

/** sha256 (hex) over the canonical snapshot (stable key order). */
export function computeSnapshotDigest(snapshot: Omit<ResolvedArmSnapshot, "digest">): string {
  return createHash("sha256").update(stableStringify(snapshot), "utf8").digest("hex");
}

export function createArmFactory(): ArmFactory {
  const registry = getCandidateRegistry();

  const resolveBaseline = (caseEligibilities: CaseEligibility[] = []): ResolvedExperimentArm =>
    buildSnapshot({
      candidate: null,
      baselineConfig: defaultBenchmarkHarnessConfig(),
      caseEligibilities,
      declaredDeltaPaths: [],
    });

  const resolveCandidate = (id: string, caseEligibilities: CaseEligibility[] = []): ResolvedExperimentArm => {
    const candidate = registry.find(id);
    if (candidate === undefined) {
      throw new Error(`UNKNOWN_CANDIDATE: no such candidate "${id}"`);
    }
    const baselineConfig = defaultBenchmarkHarnessConfig();
    return buildSnapshot({
      candidate,
      baselineConfig,
      caseEligibilities,
      declaredDeltaPaths: wireCandidateMechanism(candidate).declaredPaths,
    });
  };

  /**
   * E3-03 — recursive path diff. Returns every changed JSON-pointer path
   * between two canonicalized configs (harnessConfig.*). A path whose value is
   * identical (deep) is not reported. Used by compare() so the declared-path
   * allowlist is precise — no `key === "features"` wildcard, no candidate-id
   * shortcut.
   */
  function configPathDiff(a: Record<string, unknown>, b: Record<string, unknown>, prefix = "harnessConfig"): string[] {
    const out: string[] = [];
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const path = `${prefix}.${key}`;
      const av = a[key];
      const bv = b[key];
      const bothObjects = typeof av === "object" && av !== null && !Array.isArray(av)
        && typeof bv === "object" && bv !== null && !Array.isArray(bv);
      if (bothObjects) {
        out.push(...configPathDiff(av as Record<string, unknown>, bv as Record<string, unknown>, path));
        continue;
      }
      if (stableStringify(av) === stableStringify(bv)) continue;
      out.push(path);
    }
    return out;
  }

  const compare = (baseline: ResolvedArmSnapshot, candidate: ResolvedArmSnapshot): ArmComparison => {
    const baselineNorm = canonicalizeConfig(baseline.harnessConfig);
    const candidateNorm = canonicalizeConfig(candidate.harnessConfig);
    const allowed = new Set(candidate.declaredDeltaPaths);

    const changed = configPathDiff(baselineNorm, candidateNorm);
    const undeclared = changed.filter((p) => !allowed.has(p));
    const declared = changed.filter((p) => allowed.has(p));
    const missingDeclared = [...allowed].filter((p) => !changed.includes(p));

    const hasCausalDelta = declared.length > 0;
    const comparable = hasCausalDelta && undeclared.length === 0 && missingDeclared.length === 0;
    let reasonCode: PreflightReasonCode | null = null;
    if (!hasCausalDelta || missingDeclared.length > 0) reasonCode = "NO_CAUSAL_DELTA";
    else if (undeclared.length > 0) reasonCode = "UNDECLARED_ARM_DELTA";

    return {
      comparable,
      hasCausalDelta,
      undeclaredDeltas: undeclared,
      declaredDeltas: declared,
      missingDeclaredDeltas: missingDeclared,
      reasonCode,
      providerCallsAllowed: comparable,
    };
  };

  const resolveArm = (id: string | null, caseEligibilities: CaseEligibility[] = []): ResolvedExperimentArm =>
    id === null ? resolveBaseline(caseEligibilities) : resolveCandidate(id, caseEligibilities);

  const resolveRuntimeMechanisms = (id: string | null): RuntimeMechanisms =>
    resolveArm(id).runtimeMechanisms;

  const preflight = (id: string, caseEligibilities: CaseEligibility[] = []) => {
    const candidate = registry.find(id);
    if (candidate === undefined) {
      return { ok: false, reasonCode: "UNKNOWN_CANDIDATE" as const, detail: `no such candidate "${id}"`, providerCallsAllowed: false };
    }
    if (candidate.status === "unsupported") {
      return { ok: false, reasonCode: "CANDIDATE_UNSUPPORTED" as const, detail: `candidate "${id}" is declared UNSUPPORTED — no real wiring branch`, providerCallsAllowed: false };
    }
    const wiring = wireCandidateMechanism(candidate);
    if (wiring.constructorId.startsWith("unsupported:")) {
      return { ok: false, reasonCode: "CANDIDATE_UNSUPPORTED" as const, detail: `candidate "${id}" has no real wiring branch (${wiring.constructorId}) — preflight rejects it`, providerCallsAllowed: false };
    }
    const baseline = resolveBaseline(caseEligibilities);
    const candidateArm = resolveCandidate(id, caseEligibilities);
    const cmp = compare(baseline, candidateArm);
    if (!cmp.hasCausalDelta || cmp.missingDeclaredDeltas.length > 0) {
      const detail = cmp.missingDeclaredDeltas.length > 0
        ? `candidate "${id}" declares delta paths that did NOT change: ${cmp.missingDeclaredDeltas.join(", ")}`
        : `candidate "${id}" produces no causal delta vs baseline`;
      return { ok: false, reasonCode: "NO_CAUSAL_DELTA" as const, detail, providerCallsAllowed: false };
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

  return { resolveBaseline, resolveCandidate, resolveArm, resolveRuntimeMechanisms, compare, preflight };
}

let _armFactory: ArmFactory | undefined;
export function getArmFactory(): ArmFactory {
  if (_armFactory === undefined) _armFactory = createArmFactory();
  return _armFactory;
}