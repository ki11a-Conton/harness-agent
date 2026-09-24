import type { ResolvedConfig } from "./config-resolver.js";
import { collectChangedKeys, readPath } from "./config-resolver.js";
import type { ConfigLifecycle } from "./config-layers.js";
import { lifecycleOf } from "./config-layers.js";

/**
 * PHASE 27 (P27-4) — lifecycle-aware drift policy.
 *
 * When the resolved config fingerprint changes between two points in time
 * (e.g. session creation vs resume), every changed key is classified by its
 * lifecycle (P27-3) and the process decides:
 *
 *   process_static        → restart required
 *   session_frozen widen  → reject (or require a new session)
 *   session_frozen narrow → emergency revocation policy
 *   turn_dynamic          → next turn only
 *   step_dynamic          → next step only
 *
 * A current step snapshot is NEVER silently mutated (P27-4 hard rule).
 */

export type DriftDirection = "widen" | "narrow" | "unknown";

export type DriftSeverity =
  | "restart_required"
  | "reject"
  | "emergency_revocation"
  | "next_step"
  | "none";

export interface ChangedConfigKey {
  key: string;
  lifecycle: ConfigLifecycle;
  direction: DriftDirection;
  prev: unknown;
  next: unknown;
}

export interface DriftDecision {
  severity: DriftSeverity;
  changed: ChangedConfigKey[];
  /** True when any session_frozen key changed — the step snapshot is stale. */
  frozenChanged: boolean;
  fingerprint: { prev: string; next: string };
}

const SEVERITY_RANK: Record<DriftSeverity, number> = {
  restart_required: 4,
  reject: 3,
  emergency_revocation: 2,
  next_step: 1,
  none: 0,
};

/**
 * Direction of a single key change. Fail-closed: anything we cannot classify
 * as a clear widening or narrowing is "unknown" — callers treat unknown as
 * reject (never silently accept a changed frozen key).
 */
export function driftDirectionOf(
  key: string,
  prevValue: unknown,
  nextValue: unknown,
): DriftDirection {
  // boolean toggles: false → true widens (unlocks a capability)
  if (typeof prevValue === "boolean" && typeof nextValue === "boolean") {
    return prevValue === nextValue ? "unknown" : nextValue ? "widen" : "narrow";
  }
  // numeric ceilings (limits/budget): larger = wider budget
  if (typeof prevValue === "number" && typeof nextValue === "number") {
    if (prevValue === nextValue) return "unknown";
    return nextValue > prevValue ? "widen" : "narrow";
  }
  // permission effects: allow/ask → deny is narrowing; deny → allow/ask widens
  if (
    typeof prevValue === "string" &&
    typeof nextValue === "string" &&
    ["allow", "deny", "ask"].includes(prevValue) &&
    ["allow", "deny", "ask"].includes(nextValue)
  ) {
    const rank = { deny: 0, ask: 1, allow: 2 } as const;
    if (rank[prevValue as keyof typeof rank] === rank[nextValue as keyof typeof rank]) return "unknown";
    return rank[nextValue as keyof typeof rank] > rank[prevValue as keyof typeof rank] ? "widen" : "narrow";
  }
  return "unknown";
}

/** Normalize a config value for comparison: functions (which carry no
 *  comparable identity across processes) become the constant placeholder
 *  string so drift detection never reports spurious changes on callbacks. */
export function normalizeForComparison(value: unknown): unknown {
  if (typeof value === "function") return "[[function]]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => normalizeForComparison(v));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = normalizeForComparison(v);
  }
  return out;
}

export function evaluateConfigDrift(
  prev: ResolvedConfig,
  next: ResolvedConfig,
): DriftDecision {
  if (prev.fingerprint === next.fingerprint) {
    return {
      severity: "none",
      changed: [],
      frozenChanged: false,
      fingerprint: { prev: prev.fingerprint, next: next.fingerprint },
    };
  }
  const changedKeys = collectChangedKeys(
    normalizeForComparison(prev.value),
    normalizeForComparison(next.value),
  );
  const changed: ChangedConfigKey[] = changedKeys.map((key) => {
    const prevValue = readPath(prev.value, key);
    const nextValue = readPath(next.value, key);
    return {
      key,
      lifecycle: lifecycleOf(key),
      direction: driftDirectionOf(key, prevValue, nextValue),
      prev: prevValue,
      next: nextValue,
    };
  });

  let severity: DriftSeverity = "none";
  for (const item of changed) {
    const s = severityFor(item);
    if (SEVERITY_RANK[s] > SEVERITY_RANK[severity]) severity = s;
  }
  return {
    severity,
    changed,
    frozenChanged: changed.some((c) => c.lifecycle === "session_frozen"),
    fingerprint: { prev: prev.fingerprint, next: next.fingerprint },
  };
}

function severityFor(item: ChangedConfigKey): DriftSeverity {
  switch (item.lifecycle) {
    case "process_static":
      return "restart_required";
    case "session_frozen":
      // fail-closed: unknown direction on a frozen key → reject
      if (item.direction === "widen" || item.direction === "unknown") return "reject";
      return "emergency_revocation";
    case "turn_dynamic":
    case "step_dynamic":
      return "next_step";
  }
}

// ---------------------------------------------------------------------------
// P27-5 — secret redaction (shared by CLI + any config surface)
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_PATTERN =
  /api[_-]?key|token|secret|password|authorization|credential|auth[_-]?header|bearer/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

export const REDACTED = "***redacted***";

/** Deep-redact a config value by key path (P27-5: API keys, auth headers,
 *  tokens — never printed). Arrays/objects are recursed; the parent key is
 *  also considered (e.g. "mcp.servers[0].headers" is caught via its key). */
export function redactConfigValue(key: string, value: unknown): unknown {
  if (isSensitiveKey(key)) return REDACTED;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item, i) => redactConfigValue(`${key}[${i}]`, item));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactConfigValue(k, v);
  }
  return out;
}

/** Render a value for CLI output: redacted, JSON-ish, length-capped. */
export function renderConfigValue(key: string, value: unknown): string {
  const redacted = redactConfigValue(key, value);
  let text: string;
  if (typeof redacted === "string") text = redacted;
  else if (redacted === null) text = "null";
  else if (redacted === undefined) text = "undefined";
  else if (typeof redacted === "function") text = "[function]";
  else text = JSON.stringify(redacted) ?? String(redacted);
  if (text.length > 200) text = `${text.slice(0, 197)}...`;
  return text;
}
