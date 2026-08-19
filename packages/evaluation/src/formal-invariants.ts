/**
 * P3-17 — Formal Invariants.
 *
 * The key security properties of the harness are written as INVARIANT tests:
 * pure, deterministic predicate checks over recorded/structural facts. They are
 * deliberately NOT effect models and do NOT fabricate behaviour — each check
 * inspects a concrete snapshot (state timeline, capability claims, tool calls,
 * verification results, memory writes, network decisions, delegation records,
 * replay plan) and reports pass/fail with a reason.
 *
 * Numbering follows plan.md P3-17 and stays stable for consumers:
 *
 *   INV-001 terminal state cannot transition
 *   INV-002 child cannot gain parent-unavailable capability
 *   INV-003 unsafe tool is never auto retried
 *   INV-004 completed verification cannot be fabricated
 *   INV-005 child context isolation
 *   INV-006 benchmark holdout judge secrecy
 *   INV-007 memory unsafe content cannot persist
 *   INV-008 network denied cannot execute
 *   INV-009 delegation bounded
 *   INV-010 replay cannot duplicate known completed unsafe side effect
 *
 * Every invariant is exposed as both a standalone predicate and part of
 * `checkInvariants`, so the runtime can gate a release/commit on all of them
 * passing and a failure can be traced back to the exact violating record.
 */

export type InvariantId =
  | "INV-001"
  | "INV-002"
  | "INV-003"
  | "INV-004"
  | "INV-005"
  | "INV-006"
  | "INV-007"
  | "INV-008"
  | "INV-009"
  | "INV-010";

export const ALL_INVARIANTS: readonly InvariantId[] = [
  "INV-001",
  "INV-002",
  "INV-003",
  "INV-004",
  "INV-005",
  "INV-006",
  "INV-007",
  "INV-008",
  "INV-009",
  "INV-010",
];

export interface Violation {
  /** Human-readable pointer to the record that violated the invariant. */
  at: string;
  detail: string;
}

export interface InvariantResult {
  invariant: InvariantId;
  label: string;
  ok: boolean;
  violations: Violation[];
}

function ok(invariant: InvariantId, label: string): InvariantResult {
  return { invariant, label, ok: true, violations: [] };
}

function bad(invariant: InvariantId, label: string, violations: Violation[]): InvariantResult {
  return { invariant, label, ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// INV-001 — terminal state cannot transition
// ---------------------------------------------------------------------------

/** Closed set of terminal run states; a run in any of these is done. */
export type TerminalState = "verified_complete" | "failed" | "cancelled" | "security_denied";

export const TERMINAL_STATES: readonly TerminalState[] = [
  "verified_complete",
  "failed",
  "cancelled",
  "security_denied",
];

export function isTerminalState(state: string): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export interface StateSnapshot {
  at: string;
  state: string;
}

/**
 * Given an ordered state timeline (oldest → newest) for one run/session, the
 * invariant holds iff no snapshot AFTER the first terminal snapshot differs
 * from it (i.e. a terminal state never transitions to another state).
 */
export function invTerminalStateCannotTransition(timeline: StateSnapshot[]): InvariantResult {
  const violations: Violation[] = [];
  let terminalSeen: StateSnapshot | undefined;
  for (const snap of timeline) {
    if (terminalSeen === undefined && isTerminalState(snap.state)) {
      terminalSeen = snap;
      continue;
    }
    if (terminalSeen !== undefined && snap.state !== terminalSeen.state) {
      violations.push({
        at: snap.at,
        detail: `run transitioned out of terminal state "${terminalSeen.state}" into "${snap.state}"`,
      });
    }
  }
  return bad("INV-001", "terminal state cannot transition", violations);
}

// ---------------------------------------------------------------------------
// INV-002 — child cannot gain parent-unavailable capability
// ---------------------------------------------------------------------------

export type CapabilityDimension = "tool" | "filesystem" | "network" | "process";

export const CAPABILITY_DIMENSIONS: readonly CapabilityDimension[] = [
  "tool",
  "filesystem",
  "network",
  "process",
];

export interface CapabilityClaim {
  /** Upper bound conferred by parent/host. */
  conferred: Partial<Record<CapabilityDimension, readonly string[]>>;
  /** What the child claims for itself; effectively an insist-at-least-this. */
  declared: Partial<Record<CapabilityDimension, readonly string[]>>;
}

function itemWithin(dimension: CapabilityDimension, bound: readonly string[] | undefined, needle: string): boolean {
  if (bound === undefined) return false; // none conferred ⇒ nothing allowed
  if (bound.includes("*")) return true;
  if (dimension === "filesystem") {
    return bound.some((root) => needle === root || needle.startsWith(root.endsWith("/") ? root : root + "/"));
  }
  return bound.includes(needle);
}

/**
 * The invariant holds iff for every dimension the child declared, every item it
 * declared is available to the parent (i.e. the child insists on nothing the
 * parent lacks). This is the no-escalation core of the capability boundary.
 */
export function invChildCapabilityIsConferredBound(claim: CapabilityClaim): InvariantResult {
  const violations: Violation[] = [];
  for (const dimension of CAPABILITY_DIMENSIONS) {
    const declared = claim.declared[dimension] ?? [];
    const conferred = claim.conferred[dimension];
    for (const item of declared) {
      if (!itemWithin(dimension, conferred, item)) {
        violations.push({
          at: `${dimension}:${item}`,
          detail: `child declared "${item}" in ${dimension} which the parent does not confer`,
        });
      }
    }
  }
  return bad("INV-002", "child cannot gain parent-unavailable capability", violations);
}

// ---------------------------------------------------------------------------
// INV-003 — unsafe tool is never auto retried
// ---------------------------------------------------------------------------

export interface ToolCallRecord {
  toolId: string;
  /** A tool whose side effect is irreversible/dangerous on repeated execution. */
  unsafe: boolean;
  /** Whether this occurrence was an automatic retry (vs manual/user-driven). */
  autoRetry: boolean;
  retryAttempt: number;
}

/**
 * The invariant holds iff no unsafe tool is ever re-invoked by an automatic
 * retry. Manual/user-driven re-execution is allowed (and audited), but the
 * harness must never auto-retry a tool marked unsafe.
 */
export function invUnsafeToolNeverAutoRetried(calls: ToolCallRecord[]): InvariantResult {
  const violations: Violation[] = [];
  for (const call of calls) {
    if (call.unsafe && call.autoRetry && call.retryAttempt > 0) {
      violations.push({
        at: call.toolId,
        detail: `unsafe tool auto-retried (attempt ${call.retryAttempt}); auto retry of an unsafe tool is forbidden`,
      });
    }
  }
  return bad("INV-003", "unsafe tool is never auto retried", violations);
}

// ---------------------------------------------------------------------------
// INV-004 — completed verification cannot be fabricated
// ---------------------------------------------------------------------------

export interface VerificationClaim {
  caseId: string;
  /** Reported outcome of the verification gate. */
  passed: boolean;
  /** Independent checks the gate actually ran (empty ⇒ no evidence). */
  checks: { id: string; passed: boolean }[];
  /** Discrete evidence artifacts produced by the verifier. */
  evidence: { id: string }[];
}

/**
 * The invariant holds iff a reported pass is backed by at least one passed
 * check and some evidence; claiming completion on no data — or on a fully
 * failed check set — is treated as fabrication.
 */
export function invVerificationCannotBeFabricated(claims: VerificationClaim[]): InvariantResult {
  const violations: Violation[] = [];
  for (const claim of claims) {
    if (!claim.passed) continue; // a failed gate is fine
    const passedChecks = claim.checks.filter((c) => c.passed);
    if (passedChecks.length === 0) {
      violations.push({
        at: claim.caseId,
        detail:
          claim.checks.length === 0
            ? "verification reported PASSED with zero checks (fabricated)"
            : "verification reported PASSED while every check failed (fabricated)",
      });
    } else if (claim.evidence.length === 0) {
      violations.push({
        at: claim.caseId,
        detail: "verification reported PASSED with checks but no evidence artifact",
      });
    }
  }
  return bad("INV-004", "completed verification cannot be fabricated", violations);
}

// ---------------------------------------------------------------------------
// INV-005 — child context isolation
// ---------------------------------------------------------------------------

export interface ContextAccess {
  /** Context the child is explicitly allowed to read (cwd, env keys, files,
   *  memory keys, etc.) by the parent. */
  granted: readonly string[];
  /** Keys the child actually read during the run. */
  observed: { key: string; at: string }[];
  /** Regular expression/prefix pattern marking parent-internal secrets. */
  internalPrefix?: string;
}

/**
 * The invariant holds iff the child never observes anything it was not granted
 * — and in particular never observes parent-internal keys. Gaps are flagged.
 */
export function invChildContextIsolation(access: ContextAccess): InvariantResult {
  const prefix = access.internalPrefix ?? "parent.";
  const violations: Violation[] = [];
  for (const obs of access.observed) {
    const granted = access.granted.includes(obs.key) || access.granted.includes("*");
    if (!granted) {
      violations.push({
        at: `${obs.at}:${obs.key}`,
        detail: `child observed context key "${obs.key}" that was not granted`,
      });
    }
    if (obs.key.startsWith(prefix)) {
      violations.push({
        at: `${obs.at}:${obs.key}`,
        detail: `child observed parent-internal context key "${obs.key}" (isolation breach)`,
      });
    }
  }
  return bad("INV-005", "child context isolation", violations);
}

// ---------------------------------------------------------------------------
// INV-006 — benchmark holdout judge secrecy
// ---------------------------------------------------------------------------

export interface ScoringRecord {
  caseId: string;
  /** Whether this case is a holdout (withheld until activation). */
  holdout: boolean;
  /** Whether the judge instance has been activated for this case. */
  activated: boolean;
  /** Whether the judge scored this case. */
  scored: boolean;
}

/**
 * The invariant holds iff no holdout case is ever scored by a judge that has
 * not been activated for it — the judge must not see/score holdout answers
 * before activation, else the benchmark leaks into the pipeline.
 */
export function invHoldoutJudgeSecrecy(records: ScoringRecord[]): InvariantResult {
  const violations: Violation[] = [];
  for (const record of records) {
    if (record.holdout && !record.activated && record.scored) {
      violations.push({
        at: record.caseId,
        detail: "holdout case scored before judge activation (holdout secrecy breached)",
      });
    }
  }
  return bad("INV-006", "benchmark holdout judge secrecy", violations);
}

// ---------------------------------------------------------------------------
// INV-007 — memory unsafe content cannot persist
// ---------------------------------------------------------------------------

export interface MemoryWrite {
  contentId: string;
  /** Content was classified unsafe (secret / injection / tracking / ...). */
  unsafe: boolean;
  /** Whether the write was actually persisted to memory. */
  persisted: boolean;
  /** Whether the write was rejected at the gate. */
  rejected: boolean;
}

/**
 * The invariant holds iff unsafe content is never persisted. A write may be
 * rejected (good) but never both persisted and unsafe.
 */
export function invMemoryUnsafeContentCannotPersist(writes: MemoryWrite[]): InvariantResult {
  const violations: Violation[] = [];
  for (const write of writes) {
    if (write.unsafe && write.persisted) {
      violations.push({
        at: write.contentId,
        detail: write.rejected
          ? "unsafe content was rejected yet still persisted (gate bypass)"
          : "unsafe content persisted to memory",
      });
    }
  }
  return bad("INV-007", "memory unsafe content cannot persist", violations);
}

// ---------------------------------------------------------------------------
// INV-008 — network denied cannot execute
// ---------------------------------------------------------------------------

export interface NetworkDecision {
  actionId: string;
  /** Network gate verdict for this action. */
  allowed: boolean;
  /** Whether the action actually executed (e.g. made the HTTP call). */
  executed: boolean;
}

/**
 * The invariant holds iff a denied network action never executes. Deny must be
 * fail-closed: `allowed=false ⇒ executed=false`.
 */
export function invNetworkDeniedCannotExecute(decisions: NetworkDecision[]): InvariantResult {
  const violations: Violation[] = [];
  for (const decision of decisions) {
    if (!decision.allowed && decision.executed) {
      violations.push({
        at: decision.actionId,
        detail: "network action executed despite being denied by the network gate",
      });
    }
  }
  return bad("INV-008", "network denied cannot execute", violations);
}

// ---------------------------------------------------------------------------
// INV-009 — delegation bounded
// ---------------------------------------------------------------------------

export interface DelegationRecord {
  delegateId: string;
  depth: number;
  maxDepth: number;
  /** Cumulative delegation count under this parent, for fan-out bounding. */
  count: number;
  maxCount: number;
  /** Whether the child's effective capability is a subset of the delegator's. */
  capabilityNarrowed: boolean;
}

/**
 * The invariant holds iff every delegation is within its depth bound, within
 * its fan-out count bound, and does not widen capability (subset/intersection).
 */
export function invDelegationBounded(records: DelegationRecord[]): InvariantResult {
  const violations: Violation[] = [];
  for (const record of records) {
    if (record.depth > record.maxDepth) {
      violations.push({
        at: record.delegateId,
        detail: `delegation depth ${record.depth} exceeds bound ${record.maxDepth}`,
      });
    }
    if (record.count > record.maxCount) {
      violations.push({
        at: record.delegateId,
        detail: `delegation fan-out ${record.count} exceeds bound ${record.maxCount}`,
      });
    }
    if (!record.capabilityNarrowed) {
      violations.push({
        at: record.delegateId,
        detail: "delegate effective capability is not a subset of the delegator's",
      });
    }
  }
  return bad("INV-009", "delegation bounded", violations);
}

// ---------------------------------------------------------------------------
// INV-010 — replay cannot duplicate known completed unsafe side effect
// ---------------------------------------------------------------------------

export interface SideEffectRecord {
  effectId: string;
  /** Side effect is irreversible/high-impact if repeated. */
  unsafe: boolean;
  /** Whether it has already been recorded as completed. */
  completed: boolean;
}

export interface ReplayExecution {
  effectId: string;
  /** Whether this replay run executed (or re-executed) the side effect. */
  executed: boolean;
}

/**
 * The invariant holds iff a replay never re-executes a side effect that is
 * already recorded as completed AND unsafe — such an effect must be replayed
 * as a no-op, not duplicated.
 */
export function invReplayNoDuplicateUnsafeSideEffect(
  known: SideEffectRecord[],
  replay: ReplayExecution[],
): InvariantResult {
  const completedUnsafe = new Set(known.filter((s) => s.completed && s.unsafe).map((s) => s.effectId));
  const violations: Violation[] = [];
  for (const exec of replay) {
    if (exec.executed && completedUnsafe.has(exec.effectId)) {
      violations.push({
        at: exec.effectId,
        detail: "replay duplicated a known completed unsafe side effect (must be a no-op)",
      });
    }
  }
  return bad("INV-010", "replay cannot duplicate known completed unsafe side effect", violations);
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

export interface InvariantRun {
  stateTimeline?: StateSnapshot[];
  capability?: CapabilityClaim;
  toolCalls?: ToolCallRecord[];
  verificationClaims?: VerificationClaim[];
  childContext?: ContextAccess;
  scoring?: ScoringRecord[];
  memoryWrites?: MemoryWrite[];
  networkDecisions?: NetworkDecision[];
  delegations?: DelegationRecord[];
  sideEffects?: { known: SideEffectRecord[]; replay: ReplayExecution[] };
}

/**
 * Run every invariant against one structural snapshot. Only provided sections
 * are checked; absent sections are treated as zero-violation (nothing to check,
 * which is a conservative "holds").
 */
const EMPTY_CAPABILITY_CLAIM: CapabilityClaim = { conferred: {}, declared: {} };

export function checkInvariants(run: InvariantRun): InvariantResult[] {
  const results: InvariantResult[] = [];
  results.push(invTerminalStateCannotTransition(run.stateTimeline ?? []));
  results.push(invChildCapabilityIsConferredBound(run.capability ?? EMPTY_CAPABILITY_CLAIM));
  results.push(invUnsafeToolNeverAutoRetried(run.toolCalls ?? []));
  results.push(invVerificationCannotBeFabricated(run.verificationClaims ?? []));
  results.push(invChildContextIsolation(run.childContext ?? { granted: [], observed: [] }));
  results.push(invHoldoutJudgeSecrecy(run.scoring ?? []));
  results.push(invMemoryUnsafeContentCannotPersist(run.memoryWrites ?? []));
  results.push(invNetworkDeniedCannotExecute(run.networkDecisions ?? []));
  results.push(invDelegationBounded(run.delegations ?? []));
  results.push(invReplayNoDuplicateUnsafeSideEffect(
    run.sideEffects?.known ?? [],
    run.sideEffects?.replay ?? [],
  ));
  return results;
}

export function allPass(results: InvariantResult[]): boolean {
  return results.every((r) => r.ok);
}

export function violated(results: InvariantResult[]): InvariantResult[] {
  return results.filter((r) => !r.ok);
}

/** Compact one-line-per-invariant rendering for gate summaries. */
export function renderInvariants(results: InvariantResult[]): string {
  return results
    .map((r) => {
      const status = r.ok ? "OK  " : "FAIL";
      const notes = r.ok ? "" : ` — ${r.violations.map((v) => v.at).join(", ")}`;
      return `${status} ${r.invariant} ${r.label}${notes}`;
    })
    .join("\n");
}