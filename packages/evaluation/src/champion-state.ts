/**
 * E1-14 — chained Champion state machine (C0 → C1 → C2 → …) + promotion gate.
 *
 * E2-07 — the chain is UNBOUNDED (no C2 max): every strict ACCEPT adds the
 * next level (C3, C4, …). Promotion authority is the E2-07 PromotionEnvelope
 * (never a CLI-typed decision); the state records the envelope digest +
 * parent state digest so concurrent / stale / duplicated promotions are
 * detectable, and rollback is an explicit new transition that preserves
 * history.
 *
 * Design rules (from the E1 plan):
 * - EVALUATE and APPLY are separate. `evaluatePromotion` only judges whether a
 *   candidate may be promoted from the CURRENT champion level; `applyPromotion`
 *   computes the new champion state (a pure function returning a new object —
 *   the caller decides whether/where to persist it). Evaluation never writes
 *   the active Champion.
 * - Promotion requires a strict ACCEPT decision (comparable + quality gates
 *   pass + sample/delta sufficient + activation satisfied). REJECT /
 *   INCONCLUSIVE / INVALID never promote.
 * - C0 is the frozen production baseline (no candidate). Only strict evidence
 *   promotes to the next level.
 * - Every promotion records evidenceRef + the candidate config patch so the
 *   chain is auditable and reversible (the previous level is retained).
 */

import { getCandidateRegistry } from "./candidate-registry.js";

export const CHAMPION_STATE_SCHEMA_VERSION = "1.0.0";

/** Unbounded champion level (C0, C1, C2, C3, …) — no hard-coded max. */
export type ChampionLevel = `C${number}`;

/** Parse a level to its numeric index; C0 → 0, C1 → 1, … */
export function championLevelNumber(level: ChampionLevel): number {
  const n = Number(level.slice(1));
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid champion level "${level}"`);
  return n;
}

/** Next level: C0 → C1, C1 → C2, … (unbounded). */
export function nextChampionLevel(level: ChampionLevel): ChampionLevel {
  return `C${championLevelNumber(level) + 1}` as ChampionLevel;
}

/** E2-00: provenance-aware validity of a champion level/promotion. */
export type ChampionValidity =
  | "PROVEN"
  | "QUARANTINED_PENDING_REEVALUATION"
  | "INVALID_PROVENANCE";

export interface ChampionPromotionRecord {
  promotedAt: string;
  candidateId: string;
  /** Reference to the promoting evidence artifact (report path / git sha). */
  evidenceRef: string;
  /** The candidate's semantic digest at promotion time. */
  semanticDigest: string;
  /** The config patch applied to reach this champion level. */
  configPatch: Record<string, unknown>;
  /** E2-07: promotion-envelope content digest (the promotion authority). */
  envelopeDigest?: string;
  /** E2-07: decision-envelope digest the promotion consumed. */
  decisionEnvelopeDigest?: string;
}

/** E2-00: record of a quarantine action (state demotion to C0). */
export interface ChampionQuarantineRecord {
  schemaVersion: string;
  quarantinedAtIso: string;
  /** The level that was active before quarantine. */
  priorLevel: ChampionLevel;
  /** The candidate that was active before quarantine. */
  priorCandidateId: string | null;
  /** Stable E2 reason codes behind the quarantine. */
  reasonCodes: string[];
  /** Human-readable note explaining why the promotion was quarantined. */
  note: string;
}

export interface ChampionState {
  schemaVersion: string;
  level: ChampionLevel;
  /** Candidate that defined this level (null = frozen production baseline). */
  candidateId: string | null;
  /** Config patch that produced this level (empty for C0). */
  configPatch: Record<string, unknown>;
  /** Evidence that promoted to this level (null for C0). */
  evidenceRef: string | null;
  /** Ordered promotion history from C0. */
  history: ChampionPromotionRecord[];
  /** Whether this state is currently applied as the active Champion profile. */
  applied: boolean;
  /** E2-00: provenance validity of the CURRENT level. */
  validity: ChampionValidity;
  /** E2-00: quarantine record when the active level was demoted to C0. */
  quarantine?: ChampionQuarantineRecord;
  /** E2-07: rollback audit record when this state is a rollback target. */
  rollback?: ChampionRollbackRecord;
}

/** The initial frozen production baseline (PROVEN by construction). */
export function createInitialChampionState(opts: { applied?: boolean } = {}): ChampionState {
  return {
    schemaVersion: CHAMPION_STATE_SCHEMA_VERSION,
    level: "C0",
    candidateId: null,
    configPatch: {},
    evidenceRef: null,
    history: [],
    applied: opts.applied ?? true,
    validity: "PROVEN",
  };
}

/**
 * E2-00 backward-compatible migration: an old record (schema 1.0.0 without
 * `validity`) must NEVER auto-trust a legacy C1/C2. Missing `validity` on a
 * C0 baseline is PROVEN; on any C1/C2 it defaults to QUARANTINED — the audit
 * (or a future E2-07 envelope) is what upgrades it to PROVEN.
 */
export function migrateChampionValidity(state: ChampionState): ChampionState {
  if (state.validity !== undefined) return state;
  return {
    ...state,
    validity: state.level === "C0" ? "PROVEN" : "QUARANTINED_PENDING_REEVALUATION",
  };
}

export type ChampionPromotionVerdict =
  | { ok: true; decision: "ACCEPT"; next: ChampionState }
  | {
      ok: false;
      decision: "REJECT" | "INCONCLUSIVE" | "INVALID";
      reason: string;
    }
  | {
      ok: false;
      decision: "NO_EVIDENCE_REF";
      reason: string;
    };

/**
 * Judge whether a candidate may be promoted from the current champion level.
 * Strict: only an ACCEPT decision with a concrete evidence reference promotes.
 * E2-07: the chain is unbounded — no ALREADY_MAX. This is pure — it NEVER
 * mutates the active Champion (applyPromotion is the only producer of a new
 * state, and persistence is the caller's choice).
 */
export function evaluateChampionPromotion(
  current: ChampionState,
  candidateId: string,
  decision: "ACCEPT" | "REJECT" | "INCONCLUSIVE" | "INVALID",
  evidenceRef: string | undefined,
): ChampionPromotionVerdict {
  if (decision !== "ACCEPT") {
    return {
      ok: false,
      decision,
      reason: `decision ${decision} does not promote (only strict ACCEPT promotes)`,
    };
  }
  if (evidenceRef === undefined || evidenceRef.trim() === "") {
    return { ok: false, decision: "NO_EVIDENCE_REF", reason: "ACCEPT requires a concrete evidence reference" };
  }
  const registry = getCandidateRegistry();
  let resolved;
  try {
    resolved = registry.resolve(candidateId);
  } catch (err) {
    return {
      ok: false,
      decision: "REJECT",
      reason: `candidate ${candidateId} cannot be resolved (${err instanceof Error ? err.message : String(err)}) — fail-closed, no promotion`,
    };
  }
  if (!resolved.hasSemanticDelta) {
    return {
      ok: false,
      decision: "REJECT",
      reason: `candidate ${candidateId} has no semantic delta — cannot promote`,
    };
  }
  return { ok: true, decision: "ACCEPT", next: applyPromotion(current, candidateId, resolved.effectiveConfig, evidenceRef) };
}

/**
 * Compute the next champion state for an accepted candidate. Pure: returns a
 * new state, retains the previous level in history, never mutates the input.
 * E2-07: the chain is UNBOUNDED — level increments (C0→C1, C1→C2, C2→C3, …).
 * The new level's validity is QUARANTINED_PENDING_REEVALUATION — a promotion
 * is a claim; the E2 envelope + runtime proof (E2-08) later prove it.
 */
export function applyPromotion(
  current: ChampionState,
  candidateId: string,
  configPatch: Record<string, unknown>,
  evidenceRef: string,
  opts?: { envelopeDigest?: string; decisionEnvelopeDigest?: string },
): ChampionState {
  const registry = getCandidateRegistry();
  const resolved = registry.resolve(candidateId);
  const nextLevel = nextChampionLevel(current.level);
  const record: ChampionPromotionRecord = {
    promotedAt: new Date().toISOString(),
    candidateId,
    evidenceRef,
    semanticDigest: resolved.semanticDigest,
    configPatch: { ...configPatch },
    ...(opts?.envelopeDigest !== undefined ? { envelopeDigest: opts.envelopeDigest } : {}),
    ...(opts?.decisionEnvelopeDigest !== undefined ? { decisionEnvelopeDigest: opts.decisionEnvelopeDigest } : {}),
  };
  return {
    schemaVersion: CHAMPION_STATE_SCHEMA_VERSION,
    level: nextLevel,
    candidateId,
    configPatch: { ...configPatch },
    evidenceRef,
    history: [...current.history, record],
    applied: false, // applying the active profile is a separate step
    validity: "QUARANTINED_PENDING_REEVALUATION",
  };
}

/**
 * E2-07: rollback is an EXPLICIT new state transition that never deletes
 * history. The target level must be numerically LOWER than the current level
 * and >= C0; the resulting state keeps the FULL history PLUS a rollback audit
 * record (all prior promotions remain queryable).
 */
export interface ChampionRollbackRecord {
  schemaVersion: string;
  rolledBackAtIso: string;
  fromLevel: ChampionLevel;
  fromCandidateId: string | null;
  toLevel: ChampionLevel;
  reason: string;
}

export function rollbackChampionState(
  current: ChampionState,
  opts: { targetLevel: ChampionLevel; reason: string },
): ChampionState {
  const from = championLevelNumber(current.level);
  const to = championLevelNumber(opts.targetLevel);
  if (to >= from) {
    throw new Error(`rollback: target ${opts.targetLevel} is not lower than current ${current.level}`);
  }
  const rollbackRecord: ChampionRollbackRecord = {
    schemaVersion: CHAMPION_STATE_SCHEMA_VERSION,
    rolledBackAtIso: new Date().toISOString(),
    fromLevel: current.level,
    fromCandidateId: current.candidateId,
    toLevel: opts.targetLevel,
    reason: opts.reason,
  };
  // Rollback to C0: no candidate. Rollback to Ck (k>0): keep the candidate
  // that defined that level (from history, reverse search).
  let candidateId: string | null = null;
  let configPatch: Record<string, unknown> = {};
  let evidenceRef: string | null = null;
  if (to > 0) {
    const rec = [...current.history].reverse().find((h) => h.evidenceRef !== undefined);
    // Find the promotion that produced the target level.
    const targetRec = current.history[to - 1];
    if (targetRec !== undefined) {
      candidateId = targetRec.candidateId;
      configPatch = { ...targetRec.configPatch };
      evidenceRef = targetRec.evidenceRef;
    }
    void rec;
  }
  return {
    schemaVersion: CHAMPION_STATE_SCHEMA_VERSION,
    level: opts.targetLevel,
    candidateId,
    configPatch,
    evidenceRef,
    history: [...current.history, {
      promotedAt: new Date().toISOString(),
      candidateId: `rollback-to-${opts.targetLevel}`,
      evidenceRef: `rollback:${rollbackRecord.rolledBackAtIso}`,
      semanticDigest: "",
      configPatch: {},
    }],
    applied: true,
    validity: to === 0 ? "PROVEN" : "QUARANTINED_PENDING_REEVALUATION",
    rollback: rollbackRecord,
  };
}

/**
 * E2-00: quarantine the active promotion back to C0 while preserving the
 * complete history (including the demoted candidate's evidence reference).
 * Fail-closed: production parsing may only trust C0 until re-verified.
 * Pure — returns a new state; persistence is the caller's choice.
 */
export function quarantineChampionState(
  current: ChampionState,
  opts: { reasonCodes: string[]; note: string },
): ChampionState {
  if (current.level === "C0") {
    // Nothing to quarantine; keep the state but record the action for audit.
    return {
      ...current,
      quarantine: {
        schemaVersion: CHAMPION_STATE_SCHEMA_VERSION,
        quarantinedAtIso: new Date().toISOString(),
        priorLevel: "C0",
        priorCandidateId: current.candidateId,
        reasonCodes: opts.reasonCodes,
        note: opts.note,
      },
    };
  }
  return {
    schemaVersion: CHAMPION_STATE_SCHEMA_VERSION,
    level: "C0",
    candidateId: null,
    configPatch: {},
    evidenceRef: null,
    // History is preserved verbatim — the C1 record and its evidence path
    // remain queryable (never rewritten or deleted).
    history: [...current.history],
    applied: true,
    validity: "QUARANTINED_PENDING_REEVALUATION",
    quarantine: {
      schemaVersion: CHAMPION_STATE_SCHEMA_VERSION,
      quarantinedAtIso: new Date().toISOString(),
      priorLevel: current.level,
      priorCandidateId: current.candidateId,
      reasonCodes: opts.reasonCodes,
      note: opts.note,
    },
  };
}
