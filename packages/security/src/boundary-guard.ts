import type {
  CapabilityViolation,
  DeclaredCapability,
  EventSink,
  SessionId,
  TurnId,
} from "@ar/contracts";
import { AgentError, errorInfo } from "@ar/contracts";
import {
  composeChildCapability,
  type ComposeChildCapabilityOptions,
  type GrantedCapability,
  type NarrowedCapability,
} from "./capability-guard.js";
import { emitSecurityDenial } from "./denial.js";

/**
 * P14-4 — capability monotonicity at EVERY extension boundary.
 *
 * Every surface that extends the agent — child agent, MCP tool/server, plugin,
 * hook, skill declared tools — must compose its effective capability through
 * the SAME rule:
 *
 *   EffectiveCapability = ConferredCapability ∩ DeclaredCapability
 *
 * A subordinate may omit a dimension (inherit the conferred bound unchanged)
 * or narrow it, but NEVER widen it. Widening is a typed denial
 * ({@link BoundaryCapabilityError}) plus a `security.capability_denied` event
 * when a session-scoped event sink is available — never a comment asking the
 * extension to behave, and never a silent widening.
 *
 * This module is the single composition entry point for all boundaries; the
 * pure intersection semantics remain those of `composeCapabilities`
 * (@ar/contracts) and the canonicalisation semantics remain those of
 * `composeChildCapability` (capability-guard) — no second source of truth.
 */

/** The extension boundaries audited by P14-4. */
export const CAPABILITY_BOUNDARIES = [
  "child-agent",
  "mcp",
  "plugin",
  "hook",
  "skill",
] as const;

export type CapabilityBoundary = (typeof CAPABILITY_BOUNDARIES)[number];

/** P14-4 typed denial: a boundary attempted to widen its conferred capability. */
export class BoundaryCapabilityError extends AgentError {
  readonly boundary: CapabilityBoundary;
  readonly violations: readonly CapabilityViolation[];

  constructor(boundary: CapabilityBoundary, violations: readonly CapabilityViolation[]) {
    super(
      errorInfo(
        "SECURITY_DENIED",
        `${boundary} boundary denied: capability escalation attempted (${violations
          .map((v) => v.kind)
          .join(", ")})`,
        {
          evidence: JSON.stringify(
            violations.map((v) => ({
              kind: v.kind,
              declared: v.declared,
              conferred: v.conferred,
            })),
          ),
        },
      ),
    );
    this.name = "BoundaryCapabilityError";
    this.boundary = boundary;
    this.violations = violations;
  }
}

/** Composition deps shared by every boundary call site. */
export interface BoundaryCapabilityDeps extends ComposeChildCapabilityOptions {
  /** Event sink for the security.capability_denied denial (runtime boundaries). */
  events?: EventSink;
  /** Session the boundary extension happens in (required to emit). */
  sessionId?: SessionId;
  turnId?: TurnId;
  /** Which subsystem surfaced the denial (defaults to `boundary:<name>`). */
  source?: string;
}

/**
 * Sync compose for boundaries with synchronous lifecycles (e.g. plugin
 * registration). Same rule, same typed error — but no event emission (the
 * caller may surface the denial through its own channel). Use the async
 * {@link composeBoundaryCapability} when an EventSink is available.
 */
export function composeBoundaryCapabilitySync(
  boundary: CapabilityBoundary,
  grant: GrantedCapability,
  declared: DeclaredCapability,
  deps?: BoundaryCapabilityDeps,
): NarrowedCapability {
  try {
    return composeChildCapability(grant, declared, deps);
  } catch (err) {
    if (
      err instanceof Error &&
      err.name === "CapabilityEscalationError" &&
      "violations" in err &&
      Array.isArray((err as { violations?: unknown }).violations)
    ) {
      throw new BoundaryCapabilityError(
        boundary,
        (err as unknown as { violations: readonly CapabilityViolation[] }).violations,
      );
    }
    throw err;
  }
}

/**
 * Compose the effective capability for an extension boundary — the ONE
 * composition rule every boundary shares.
 *
 * Returns the narrowed capability on success. On any widening attempt:
 *   - when `events` + `sessionId` are provided, awaits the
 *     `security.capability_denied` event BEFORE throwing (the denial is on the
 *     audit stream, never silent; an emit failure propagates because security
 *     gates must not silently degrade — P14-6);
 *   - throws {@link BoundaryCapabilityError} (typed, fail-closed).
 */
export async function composeBoundaryCapability(
  boundary: CapabilityBoundary,
  grant: GrantedCapability,
  declared: DeclaredCapability,
  deps?: BoundaryCapabilityDeps,
): Promise<NarrowedCapability> {
  let violations: readonly CapabilityViolation[];
  try {
    return composeBoundaryCapabilitySync(boundary, grant, declared, deps);
  } catch (err) {
    if (err instanceof BoundaryCapabilityError) {
      violations = err.violations;
    } else {
      throw err;
    }
  }
  if (deps?.events !== undefined && deps?.sessionId !== undefined) {
    await emitSecurityDenial(deps.events, deps.sessionId, {
      dimension: "capability",
      reason: `${boundary} boundary attempted to widen its conferred capability (${violations
        .map((v) => v.kind)
        .join(", ")})`,
      source: deps.source ?? `boundary:${boundary}`,
      code: "SECURITY_DENIED",
      details: violations.flatMap((v) =>
        v.declared.map((item) => `${v.kind}: ${item}`),
      ),
    }, deps.turnId);
  }
  throw new BoundaryCapabilityError(boundary, violations);
}
