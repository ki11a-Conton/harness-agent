import type { AgentId, ApprovalId, SessionId, TurnId } from "./ids.js";

/**
 * P2-44 — decision scope.
 *
 * An approval request must state exactly what the decision binds, so a host can
 * (a) grant a single call, (b) grant a single tool invocation pattern, or
 * (c) expand to "everything matching for the rest of the session". Scope is a
 * closed taxonomy; anything not listed below is a compile error.
 */
export type ApprovalScope = "one_call" | "one_tool" | "session";

export const APPROVAL_SCOPES = [
  "one_call",
  "one_tool",
  "session",
] as const satisfies readonly ApprovalScope[];

export function isApprovalScope(value: unknown): value is ApprovalScope {
  return (
    typeof value === "string" && (APPROVAL_SCOPES as readonly string[]).includes(value)
  );
}

export interface ApprovalRequest {
  id: ApprovalId;
  sessionId: SessionId;
  turnId?: TurnId;
  agentId: AgentId;
  action: string;
  target: string;
  reason: string;
  policyRule?: string;
  /**
   * P28-1 — typed capability identity. Optional for backward compatibility
   * with legacy string-only approvals; when present the machine-readable
   * identity of this request (its {@link CapabilityRequest}) supersedes the
   * display projection `action`/`target`. The durable store persists it
   * verbatim, and the fingerprint logic keys on it.
   */
  capability?: CapabilityRequest;
  /**
   * Decision scope (P2-44). Optional on the wire for backward compatibility;
   * the resolver normalizes it to "one_call" when absent, and the resulting
   * ApprovalDecisionRecord always carries an explicit scope.
   */
  scope?: ApprovalScope;
  createdAt: number;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// P28 — Typed Capability Approval V3
//
// The legacy string `action`/`target` pair remains as a human-readable display
// projection. The machine-readable identity of a request is a typed
// `CapabilityRequest`: a closed union over the capability kinds the host can
// actually execute (exec, file, network, mcp, permission escalation).
//
// Grants remember what was approved by fingerprint (P28-2). A later request is
// covered by a grant only when {@link grantCoversRequest} returns true —
// same-or-narrower semantics identity, never a wildcard widening (P28-3/4).
// ---------------------------------------------------------------------------

/** Alpha/beta/substep — a permission delta the exec may request. */
export interface PermissionDelta {
  [dimension: string]: number;
}

/** The kinds of capability an agent may ask to exercise. */
export type CapabilityKind = "exec" | "file" | "network" | "mcp" | "tool";

export const CAPABILITY_KINDS = [
  "exec",
  "file",
  "network",
  "mcp",
  "tool",
] as const satisfies readonly CapabilityKind[];

export function isCapabilityKind(value: unknown): value is CapabilityKind {
  return (
    typeof value === "string" && (CAPABILITY_KINDS as readonly string[]).includes(value)
  );
}

/** Exec: run a command in a working directory, possibly on a TTY. */
export interface ExecCapability {
  kind: "exec";
  environmentId: string;
  cwd: string;
  argv: readonly string[];
  tty: boolean;
  /** Nullable — when present, this exec *also* requests a permission delta. */
  permissionDelta?: PermissionDelta;
}

/** File: mutate or relocate paths. */
export interface FileCapability {
  kind: "file";
  operation: "write" | "delete" | "move";
  canonicalPaths: readonly string[];
}

/** Network: connect to an origin. */
export interface NetworkCapability {
  kind: "network";
  protocol: "http" | "https" | "tcp";
  hostname: string;
  port?: number;
}

/** MCP: call a tool on a server generation. */
export interface McpCapability {
  kind: "mcp";
  serverId: string;
  generation: string;
  tool: string;
  argsHash: string;
}

/** Tool: a local tool binding by name (distinct from the ToolCapability
 *  projection in `tool.ts`). */
export interface NamedToolCapability {
  kind: "tool";
  toolId: string;
  argsHash: string;
}

export type CapabilityRequest =
  | ExecCapability
  | FileCapability
  | NetworkCapability
  | McpCapability
  | NamedToolCapability;

export function isCapabilityRequest(value: unknown): value is CapabilityRequest {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return isCapabilityKind(kind);
}

/**
 * A grant records a previously-approved capability (P28-4). `scope` defines how
 * broadly the grant may be reused:
 *   - "session"  — same session, exact or narrower request (P28-3);
 *   - "one_tool" — same semantic tool/capability pattern, equal-or-narrower authority;
 *   - "one_call" — the exact request/call only (never reused by default).
 */
export interface CapabilityGrant {
  sessionId: SessionId;
  /** Fingerprint of the approved capability (P28-2). */
  fingerprint: string;
  /** The semantic capability that was approved. */
  capability: CapabilityRequest;
  /** Effective authority granted (equal-or-narrower allowed). */
  authority?: unknown;
  scope: Exclude<ApprovalScope, "one_call">;
  createdAt: number;
  /** Approver identity; optional (undefined = system grant). */
  decidedBy?: string;
}

export type ApprovalDecisionValue = "allow" | "deny" | "expired" | "cancelled";

export interface ApprovalResolver {
  resolve(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}

/** A pending approval's host-visible surface: the request plus a waiter that
 *  settles on decision/expiry/abort. */
export interface PendingApproval {
  request: ApprovalRequest;
  /** Resolves when the store decides, the entry expires, or the signal aborts. */
  wait(signal: AbortSignal): Promise<ApprovalDecision>;
}

export interface ApprovalDecision {
  id: ApprovalId;
  value: ApprovalDecisionValue;
  decidedAt: number;
  decidedBy?: string;
}

/**
 * Durable, auditable decision record (P2-44). Every resolved approval produces
 * exactly one record capturing WHO decided, WHEN, AT what scope, and for WHICH
 * action/target. Records are append-only: they are never deleted, so a decision
 * can be audited long after the process that made it has gone away.
 */
export interface ApprovalDecisionRecord extends ApprovalDecision {
  sessionId: SessionId;
  turnId?: TurnId;
  agentId: AgentId;
  action: string;
  target: string;
  /** Always explicit — resolved from `request.scope ?? "one_call"`. */
  scope: ApprovalScope;
  /** True when the outcome is "expired" (late allow ⇒ expired). */
  expired: boolean;
}

/**
 * Pure projection of a settled decision into its auditable record. No storage
 * side effects, so it is unit-testable and usable by any host/UI auditing an
 * approval stream.
 */
export function approvalDecisionRecord(
  request: ApprovalRequest,
  decision: ApprovalDecision,
): ApprovalDecisionRecord {
  return {
    id: decision.id,
    sessionId: request.sessionId,
    ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
    agentId: request.agentId,
    action: request.action,
    target: request.target,
    scope: isApprovalScope(request.scope) ? request.scope : "one_call",
    value: decision.value,
    decidedAt: decision.decidedAt,
    ...(decision.decidedBy !== undefined ? { decidedBy: decision.decidedBy } : {}),
    expired: decision.value === "expired",
  };
}

/**
 * Persistence seam for approvals (P2-44). A durable implementation keeps a
 * pending request re-enumerable and resolvable after a process restart, and
 * keeps the decision audit log append-only so it survives restarts unchanged.
 *
 * A live waiter waiting on a promise cannot be re-hydrated across a restart
 * (that is the job of the host), but the request itself is NOT lost: the host
 * re-surfaces it from {@link listPending} and resolves it as normal.
 */
export interface ApprovalStore {
  /** Registers a pending request and returns a waiter for its decision. */
  create(request: ApprovalRequest): PendingApproval;
  resolve(id: ApprovalId, value: ApprovalDecisionValue, decidedBy?: string): ApprovalDecision;
  cancelAll(sessionId: SessionId): void;
  listPending(sessionId?: SessionId): ApprovalRequest[];
  /** Append-only audit log of every decision (never deleted). */
  listDecisions(sessionId?: SessionId): ApprovalDecisionRecord[];
}

// ---------------------------------------------------------------------------
// P28 — canonical fingerprint + grant coverage (pure, secret-free)
// ---------------------------------------------------------------------------

/**
 * Stable, order-independent canonical serialization for capability identity
 * fields. Never includes raw secret values (argsHash is already a hash).
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  // Primitives: stringify strings/numbers/booleans/null deterministically.
  return JSON.stringify(value);
}

/**
 * P28-2 — semantic approval fingerprint.
 *
 * The fingerprint is the identity of a capability for reuse purposes: two
 * requests compare equal iff their capability identity is semantically
 * identical (same command, same cwd, same allowed paths, etc.) regardless of
 * how the arguments were spelled.
 *
 * Raw secrets (args that are hashed, auth headers, tokens) are NEVER part of
 * the fingerprint — only their hashes are, so revoking or approving a
 * capability never leaks a secret into the audit stream.
 */
export function approvalFingerprint(capability: CapabilityRequest): string {
  switch (capability.kind) {
    case "exec":
      return `exec:${canonicalJson({
        environmentId: capability.environmentId,
        cwd: capability.cwd,
        argv: capability.argv,
        tty: capability.tty,
        permissionDelta: capability.permissionDelta ?? null,
      })}`;
    case "file":
      return `file:${canonicalJson({
        operation: capability.operation,
        // Paths are a set — canonical order makes the fingerprint
        // order-independent (P28-2 stable identity).
        canonicalPaths: [...capability.canonicalPaths].sort(),
      })}`;
    case "network":
      return `network:${canonicalJson({
        protocol: capability.protocol,
        hostname: capability.hostname,
        port: capability.port ?? null,
      })}`;
    case "mcp":
      return `mcp:${canonicalJson({
        serverId: capability.serverId,
        generation: capability.generation,
        tool: capability.tool,
        argsHash: capability.argsHash,
      })}`;
    case "tool":
      return `tool:${canonicalJson({
        toolId: capability.toolId,
        argsHash: capability.argsHash,
      })}`;
  }
}

/**
 * Compare two permission deltas: a request's delta is "within" a grant's delta
 * only when every dimension it requests is present in the grant with an
 * equal-or-higher bound. Missing dimension in the grant, or a request asking
 * for a dimension the grant did not cover, means NOT covered (fail closed).
 */
export function isDeltaWithin(request: PermissionDelta, grant: PermissionDelta): boolean {
  for (const [dim, value] of Object.entries(request)) {
    const granted = grant[dim];
    if (granted === undefined || granted < value) return false;
  }
  return true;
}

/**
 * P28-4 — does a remembered grant cover this request?
 *
 * Coverage semantics are defined per capability kind:
 *   - exec    : same environment + cwd + canonical argv; permissionDelta must be
 *               equal-or-narrower. Different cwd/argv/env → NOT covered.
 *   - file    : same operation + every requested canonical path must be within a
 *               granted path (containment, not equality).
 *   - network : same protocol + host; port must be equal-or-absent.
 *   - mcp     : same server + generation + tool + argsHash. Different server or
 *               generation with changed schema/authority → NOT covered.
 *   - tool    : same tool + argsHash.
 *
 * A widener request (more argv, more paths, more ports, higher delta) is NEVER
 * covered by a narrower grant: approving "exec npm test" must not approve
 * "exec npm run children --all", and "approve file write /a" must not approve
 * "delete /a".
 *
 * Any unknown shape — unknown kind, malformed request, malformed grant — fails
 * closed (returns false).
 */
export function grantCoversRequest(request: CapabilityRequest, grant: CapabilityGrant): boolean {
  if (!isCapabilityRequest(grant.capability)) return false;
  // P28-3: one_call is never reused (runtime guard for legacy/tampered input).
  if ((grant.scope as string) === "one_call") return false;

  const g = grant.capability;
  switch (request.kind) {
    case "exec": {
      if (g.kind !== "exec") return false;
      if (request.environmentId !== g.environmentId) return false;
      if (request.cwd !== g.cwd) return false;
      // P28-4 authority-subset: a request is covered when its argv is a
      // PREFIX of the granted argv (equal or narrower), so approving
      // `npm test --coverage` also covers `npm test`, but never a command
      // that adds extra arguments.
      if (!isArgvPrefix(request.argv, g.argv)) return false;
      if (request.tty !== g.tty) return false;
      // Delta: request must be within grant, and grant must have it.
      if (request.permissionDelta !== undefined && g.permissionDelta === undefined) return false;
      if (
        request.permissionDelta !== undefined &&
        g.permissionDelta !== undefined &&
        !isDeltaWithin(request.permissionDelta, g.permissionDelta)
      ) {
        return false;
      }
      return true;
    }
    case "file": {
      if (g.kind !== "file") return false;
      if (request.operation !== g.operation) return false;
      // Every requested path must be within some granted path.
      return request.canonicalPaths.every((p) =>
        g.canonicalPaths.some((granted) => pathIsWithin(p, granted)),
      );
    }
    case "network": {
      if (g.kind !== "network") return false;
      if (request.protocol !== g.protocol) return false;
      if (request.hostname !== g.hostname) return false;
      if (g.port !== undefined && request.port !== g.port) return false;
      // Request without explicit port covers grant's port? No — fail closed.
      if (request.port === undefined && g.port !== undefined) return false;
      return true;
    }
    case "mcp": {
      if (g.kind !== "mcp") return false;
      if (request.serverId !== g.serverId) return false;
      if (request.generation !== g.generation) return false;
      // Same server + generation, different tool = different capability scope.
      // Same server + different generation with changed schema/authority = not covered.
      if (request.tool !== g.tool) return false;
      return true;
    }
    case "tool": {
      if (g.kind !== "tool") return false;
      if (request.toolId !== g.toolId) return false;
      return true;
    }
    default:
      return false;
  }
}

/** True when `request` argv is a strict prefix (equal-or-narrower) of `grant`. */
function isArgvPrefix(request: readonly string[], grant: readonly string[]): boolean {
  if (request.length > grant.length) return false;
  for (let i = 0; i < request.length; i++) {
    if (request[i] !== grant[i]) return false;
  }
  return true;
}

// Local minimal path containment (avoids pulling node:path into contracts)
function pathIsWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + "/");
}