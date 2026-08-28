/**
 * E1-03 — Candidate Registry: the single source of truth for all challenger
 * candidates. Every consumer (CLI list, benchmark wiring, effective config,
 * manifest, champion eval, capability audit) reads from this registry.
 *
 * A candidate's semantic digest comes from its RESOLVED mechanism config, not
 * from its name or a boolean flag. No-op / unregistered candidates produce
 * `NO_SEMANTIC_DELTA` and are rejected before any provider call.
 */

import { stableStringify } from "./manifest.js";

export type CandidateStatus = "implemented" | "experimental" | "unsupported";
export type CandidateLayer = "agent-strategy" | "harness-profile" | "benchmark-fixture";

export interface CandidateRegistration {
  /** Stable candidate id (the single-variable switch name). */
  id: string;
  description: string;
  status: CandidateStatus;
  layer: CandidateLayer;
  /**
   * Config patch applied when the candidate is on. Keys should match the
   * actual HarnessConfig shape (not a boolean flag that doesn't exist).
   */
  enabledPatch: Record<string, unknown>;
  /**
   * Config patch applied when the candidate is off (baseline). Every
   * candidate starts disabled — the baseline applies ALL disabled patches.
   */
  disabledPatch: Record<string, unknown>;
}

export interface CandidateResolved {
  id: string;
  /** The resolved effective config snapshot (baseline + all disabled +
   *  candidate's enabled patch). */
  effectiveConfig: Record<string, unknown>;
  /** Stable digest of the resolved config. Changing any semantic field
   *  changes the digest; changing the candidate name alone does not. */
  semanticDigest: string;
  /** Whether this resolved config differs from the resolved baseline. */
  hasSemanticDelta: boolean;
}

export interface CandidateRegistry {
  /** All registered candidates. */
  all(): CandidateRegistration[];
  /** Look up a candidate by id. */
  find(id: string): CandidateRegistration | undefined;
  /** Resolve a candidate to its effective config + digest. */
  resolve(id: string | null): CandidateResolved;
  /** Resolve the baseline (all candidates disabled). */
  resolveBaseline(): CandidateResolved;
  /** Validate that a candidate id is known and has a real mechanism branch.
   *  Throws a descriptive error for unsupported/no-op candidates. */
  validateActive(id: string): void;
}

// ---------------------------------------------------------------------------
// The nine candidates from plan.md P21-2, mapped to their REAL mechanism
// config fields (not boolean flags that don't exist in HarnessConfig).
// ---------------------------------------------------------------------------

// Baseline / champion preset: all features at their production defaults.
// The disabled patches below are the "off" state for each mechanism.
const BASELINE_CONFIG: Record<string, unknown> = {
  features: { context: true, memory: false, learning: false, delegation: false, mcp: false, plugins: false },
  adaptiveRecovery: undefined,
  contextPolicy: undefined,
  toolSelector: undefined,
  scheduler: undefined,
  reviewer: undefined,
};

const CANDIDATES: CandidateRegistration[] = [
  {
    id: "context_pipeline_v5",
    description: "context pipeline V5 (budget + instruction discovery + compaction)",
    status: "unsupported",
    layer: "harness-profile",
    enabledPatch: { features: { context: true } },
    disabledPatch: { features: { context: false } },
  },
  {
    id: "tool_selector_deferred_schema",
    description: "tool selector / deferred schema advertisement (P18-2)",
    status: "experimental",
    layer: "agent-strategy",
    // Benchmark wiring: registers tool_lookup + sets schemaAdvert policy.
    // The real config effect is deferredSchema: true in the benchmark runner.
    // The config field "toolSelector" is a ToolSelector interface, not a bool.
    enabledPatch: { toolSelector: true },
    disabledPatch: { toolSelector: undefined },
  },
  {
    id: "memory_retrieval",
    description: "pre-turn memory retrieval into context (P2-2)",
    status: "experimental",
    layer: "agent-strategy",
    enabledPatch: { features: { memory: true } },
    disabledPatch: { features: { memory: false } },
  },
  {
    id: "memory_write_learning",
    description: "post-turn reflection + procedural memory write gate (P2-5)",
    status: "unsupported",
    layer: "agent-strategy",
    enabledPatch: { features: { learning: true } },
    disabledPatch: { features: { learning: false } },
  },
  {
    id: "adaptive_recovery",
    description: "bounded recovery taxonomy planner (P19-3)",
    status: "experimental",
    layer: "agent-strategy",
    enabledPatch: { adaptiveRecovery: true },
    disabledPatch: { adaptiveRecovery: undefined },
  },
  {
    id: "independent_reviewer",
    description: "read-only independent reviewer candidate (P19-2, not default)",
    status: "unsupported",
    layer: "agent-strategy",
    enabledPatch: { reviewer: true },
    disabledPatch: { reviewer: undefined },
  },
  {
    id: "delegation",
    description: "subagent delegation (worker/explore/batch)",
    status: "experimental",
    layer: "harness-profile",
    enabledPatch: { features: { delegation: true } },
    disabledPatch: { features: { delegation: false } },
  },
  {
    id: "adaptive_context_policy",
    description: "adaptive context budget policy (evaluation/context-policy)",
    status: "experimental",
    layer: "agent-strategy",
    enabledPatch: { contextPolicy: true },
    disabledPatch: { contextPolicy: undefined },
  },
  {
    id: "adaptive_scheduler",
    description: "adaptive tree scheduler with per-agent budgets",
    status: "unsupported",
    layer: "agent-strategy",
    enabledPatch: { scheduler: true },
    disabledPatch: { scheduler: undefined },
  },
  {
    id: "budget_aware_completion_v1",
    description: "step-budget aware completion strategy — system prompt instructs the agent to converge and verify before exhausting its iteration budget (E1-13)",
    status: "experimental",
    layer: "agent-strategy",
    // Agent-strategy layer: the real effect is a systemPrompt injection in the
    // benchmark runner (budget-aware completion guidance). The config field
    // marks the semantic switch; the digest changes so a baseline run and a
    // candidate run are never the same configuration.
    enabledPatch: { completionPolicy: "budget_aware" },
    disabledPatch: { completionPolicy: undefined },
  },
];

// ---------------------------------------------------------------------------
// Registry implementation
// ---------------------------------------------------------------------------

function deepMerge(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  if (patch === undefined) return target;
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete out[key];
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const existing = typeof out[key] === "object" && out[key] !== null && !Array.isArray(out[key])
        ? (out[key] as Record<string, unknown>)
        : {};
      out[key] = deepMerge(existing, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function buildBaseline(): Record<string, unknown> {
  let config = { ...BASELINE_CONFIG };
  for (const c of CANDIDATES) {
    config = deepMerge(config, c.disabledPatch);
  }
  return config;
}

function buildCandidateConfig(id: string | null): Record<string, unknown> {
  if (id === null) return buildBaseline();
  const candidate = CANDIDATES.find((c) => c.id === id);
  if (candidate === undefined) {
    throw new Error(`CANDIDATE_NOT_FOUND: unknown candidate "${id}"`);
  }
  let config = buildBaseline();
  config = deepMerge(config, candidate.enabledPatch);
  return config;
}

export function createCandidateRegistry(): CandidateRegistry {
  return {
    all(): CandidateRegistration[] {
      return [...CANDIDATES];
    },

    find(id: string): CandidateRegistration | undefined {
      return CANDIDATES.find((c) => c.id === id);
    },

    resolve(id: string | null): CandidateResolved {
      const effectiveConfig = buildCandidateConfig(id);
      const semanticDigest = stableStringify(effectiveConfig);
      const baselineConfig = buildBaseline();
      const hasSemanticDelta = stableStringify(baselineConfig) !== semanticDigest;
      return { id: id ?? "baseline", effectiveConfig, semanticDigest, hasSemanticDelta };
    },

    resolveBaseline(): CandidateResolved {
      return this.resolve(null);
    },

    validateActive(id: string): void {
      const candidate = this.find(id);
      if (candidate === undefined) {
        throw new Error(`CANDIDATE_NOT_FOUND: unknown candidate "${id}". Valid candidates: ${CANDIDATES.map((c) => c.id).join(", ")}`);
      }
      if (candidate.status === "unsupported") {
        throw new Error(`CANDIDATE_UNSUPPORTED: "${id}" is declared but NOT implemented (wiring branch missing). Resolve the candidate wiring or remove it from the registry.`);
      }
      // Check that the resolved config actually differs from baseline.
      const resolved = this.resolve(id);
      if (!resolved.hasSemanticDelta) {
        throw new Error(`NO_SEMANTIC_DELTA: candidate "${id}" resolves to an identical config as baseline. No mechanism was activated — aborting to avoid wasting API calls.`);
      }
    },
  };
}

/** Singleton registry (lazy). */
let _registry: CandidateRegistry | undefined;
export function getCandidateRegistry(): CandidateRegistry {
  if (_registry === undefined) _registry = createCandidateRegistry();
  return _registry;
}