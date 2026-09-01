/**
 * E1-14 — chained Champion state machine (C0 → C1 → C2) + promotion gate.
 *
 * Design rules (from the E1 plan):
 * - EVALUATE and APPLY are separate. `evaluatePromotion` only judges whether a
 *   candidate may be promoted from the CURRENT champion level; `applyPromotion`
 *   computes the new champion state (a pure function returning a new object —
 *   the caller decides whether/where to persist it). Evaluation never writes
 *   the active Champion.
 * - Promotion requires a strict E1-08 ACCEPT decision (comparable + quality
 *   gates pass + sample/delta sufficient + activation satisfied). REJECT /
 *   INCONCLUSIVE / INVALID never promote.
 * - C0 is the frozen production baseline (no candidate). Only strict evidence
 *   promotes to C1; only strict evidence on top of C1 promotes to C2.
 * - Every promotion records evidenceRef + the candidate config patch so the
 *   chain is auditable and reversible (the previous level is retained).
 *
 * E2-00 — provenance-aware validity:
 * - A promotion record is a CLAIM, not a proof. `validity` records whether the
 *   promotion is currently trustworthy for production semantics:
 *     * `PROVEN`                          — supported by reproducible evidence
 *       (only C0 is PROVEN by construction today);
 *     * `QUARANTINED_PENDING_REEVALUATION` — promoted historically, but not
 *       re-verified under the E2 protocol (default for any legacy C1/C2);
 *     * `INVALID_PROVENANCE`               — the E2 baseline audit found
 *       concrete provenance failures.
 * - `quarantineChampionState` demotes the ACTIVE level back to C0 while
 *   PRESERVING the full promotion history and artifact references (fail-closed:
 *   never auto-trust a promotion that lacks machine-verifiable provenance).
 */

import { getCandidateRegistry } from "./candidate-registry.js";

export const CHAMPION_STATE_SCHEMA_VERSION = "1.0.0";

export type ChampionLevel = "C0" | "C1" | "C2";

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
      decision: "ALREADY_MAX";
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
 * This is pure — it NEVER mutates the active Champion (applyPromotion is the
 * only producer of a new state, and persistence is the caller's choice).
 */
export function evaluateChampionPromotion(
  current: ChampionState,
  candidateId: string,
  decision: "ACCEPT" | "REJECT" | "INCONCLUSIVE" | "INVALID",
  evidenceRef: string | undefined,
): ChampionPromotionVerdict {
  if (current.level === "C2") {
    return { ok: false, decision: "ALREADY_MAX", reason: "C2 is the highest supported champion level" };
  }
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
 * E2-00: the new level's validity is QUARANTINED_PENDING_REEVALUATION — a
 * promotion is a claim; the E2 audit/envelope is what later proves it.
 */
export function applyPromotion(
  current: ChampionState,
  candidateId: string,
  configPatch: Record<string, unknown>,
  evidenceRef: string,
): ChampionState {
  const registry = getCandidateRegistry();
  const resolved = registry.resolve(candidateId);
  const nextLevel: ChampionLevel = current.level === "C0" ? "C1" : "C2";
  const record: ChampionPromotionRecord = {
    promotedAt: new Date().toISOString(),
    candidateId,
    evidenceRef,
    semanticDigest: resolved.semanticDigest,
    configPatch: { ...configPatch },
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
