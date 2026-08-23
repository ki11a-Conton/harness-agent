import type { HarnessConfig, HarnessProfile } from "./config.js";
import { DEFAULT_CONTEXT_BUDGET, DEFAULT_FEATURE_FLAGS } from "./config.js";
import { resolveProfile } from "./profiles.js";

/**
 * PHASE 27 (P27-1) — Config layer stack.
 *
 * The important concept is layering/origin, not file syntax. Every config
 * value that reaches the harness carries its origin (which layer, in which
 * order). Precedence low → high:
 *
 *   defaults → profile → system → user → project → environment →
 *   session overrides → explicit runtime overrides
 *
 * This module defines the layer contract, per-layer factories for the layers
 * the harness actually composes today (defaults / profile / environment /
 * runtime), and P27-3 lifecycle classification metadata for every config key.
 */

export type ConfigLayerSource =
  | "defaults"
  | "profile"
  | "system"
  | "user"
  | "project"
  | "environment"
  | "session"
  | "runtime";

/** Recursive partial: functions/arrays are opaque leaves, never recursed. */
export type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? T
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

export interface ConfigLayer {
  readonly id: string;
  readonly source: ConfigLayerSource;
  readonly values: DeepPartial<HarnessConfig>;
  readonly fingerprint: string;
}

/** Stable serialization: sorted keys, JSON. Deterministic across platforms.
 *  Functions serialize to their name so the full effective config (which
 *  contains callbacks) can be snapshotted for P27-4 drift comparison. */
export function stableSerialize(value: unknown): string {
  if (typeof value === "function") return `[fn:${(value as { name?: string }).name ?? "anon"}]`;
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableSerialize(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableSerialize(obj[k])}`).join(",")}}`;
}

/** djb2 — deterministic, dependency-free, good enough for config fingerprints. */
export function hashOf(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function configLayerFingerprint(values: DeepPartial<HarnessConfig>): string {
  return hashOf(stableSerialize(values));
}

/** Lowest layer: built-in defaults (plan.md P0-3 DEFAULT_FEATURE_FLAGS etc). */
export function defaultsLayer(): ConfigLayer {
  const values: DeepPartial<HarnessConfig> = {
    featureFlags: DEFAULT_FEATURE_FLAGS,
    contextBudget: DEFAULT_CONTEXT_BUDGET,
  };
  return {
    id: "defaults",
    source: "defaults",
    values,
    fingerprint: configLayerFingerprint(values),
  };
}

/** Profile preset layer: the profile's default sandbox + feature flags. */
export function profileLayer(profile: HarnessProfile): ConfigLayer {
  const preset = resolveProfile(profile);
  const values: DeepPartial<HarnessConfig> = {
    sandboxPolicy: preset.sandbox,
    featureFlags: preset.defaultFeatureFlags,
  };
  return {
    id: `profile:${profile}`,
    source: "profile",
    values,
    fingerprint: configLayerFingerprint(values),
  };
}

/**
 * Environment layer (P27-1 "environment"). Flat `AGENT_` prefixed variables
 * map onto dotted config keys; `__` separates path segments so nested keys
 * stay expressible (e.g. `AGENT_SANDBOX_POLICY__NETWORK` →
 * `sandboxPolicy.network`). No secrets are ever read by this layer — API
 * keys stay in the provider's own env contract (OPENAI_API_KEY etc).
 */
export function environmentLayer(env: Record<string, string | undefined>): ConfigLayer | undefined {
  const values: DeepPartial<HarnessConfig> = {};
  let any = false;
  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith("AGENT_") || raw === undefined || raw === "") continue;
    // AGENT_SANDBOX_POLICY__NETWORK → ["SANDBOX_POLICY", "NETWORK"] →
    // ["sandboxPolicy", "network"]  (layer separator "__", word separator "_")
    const path = name
      .slice("AGENT_".length)
      .split("__")
      .map((seg) => seg.toLowerCase().replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase()));
    if (path.length === 0 || path.some((seg) => seg === "")) continue;
    let node: Record<string, unknown> = values as unknown as Record<string, unknown>;
    for (let i = 0; i < path.length; i++) {
      const seg = path[i]!;
      if (i === path.length - 1) {
        node[seg] = coerceEnvValue(raw);
      } else {
        const existing = node[seg];
        if (existing === undefined || typeof existing !== "object" || Array.isArray(existing)) {
          node[seg] = {};
        }
        node = node[seg] as Record<string, unknown>;
      }
    }
    any = true;
  }
  if (!any) return undefined;
  return {
    id: "environment",
    source: "environment",
    values,
    fingerprint: configLayerFingerprint(values),
  };
}

function coerceEnvValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (raw === "null") return null;
  return raw;
}

/** Session-level overrides (frozen at session creation, P27-3 session_frozen). */
export function sessionOverridesLayer(overrides: DeepPartial<HarnessConfig>): ConfigLayer {
  return {
    id: "session",
    source: "session",
    values: overrides,
    fingerprint: configLayerFingerprint(overrides),
  };
}

/** Highest layer: explicit runtime overrides (what the caller passes to
 *  createHarness — treated as authoritative, P27-1 "explicit runtime
 *  overrides"). */
export function runtimeLayer(overrides: DeepPartial<HarnessConfig>): ConfigLayer {
  return {
    id: "runtime",
    source: "runtime",
    values: overrides,
    fingerprint: configLayerFingerprint(overrides),
  };
}

/** Ordered layer stack builder for the harness composition root. */
export function buildConfigLayers(input: {
  profile: HarnessProfile;
  overrides: DeepPartial<HarnessConfig>;
  env?: Record<string, string | undefined>;
  sessionOverrides?: DeepPartial<HarnessConfig>;
}): ConfigLayer[] {
  const layers: ConfigLayer[] = [defaultsLayer(), profileLayer(input.profile)];
  const envLayer = environmentLayer(input.env ?? {});
  if (envLayer !== undefined) layers.push(envLayer);
  if (input.sessionOverrides !== undefined && Object.keys(input.sessionOverrides).length > 0) {
    layers.push(sessionOverridesLayer(input.sessionOverrides));
  }
  layers.push(runtimeLayer(input.overrides));
  return layers;
}

// ---------------------------------------------------------------------------
// P27-3 — config lifecycle classification
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a config key:
 * - process_static: fixed for the whole process; a change requires restart.
 * - session_frozen: fixed when a session is created; a change cannot apply
 *   to an existing session silently.
 * - turn_dynamic: can vary per turn (task inputs / verification plan).
 * - step_dynamic: may be re-selected per step (model binding, MCP binding,
 *   tool exposure).
 */
export type ConfigLifecycle = "process_static" | "session_frozen" | "turn_dynamic" | "step_dynamic";

/** Explicit per-key classification. Exact key wins; `prefix.*` matches any
 *  descendant. Order matters: earlier entries take precedence. */
const LIFECYCLE_RULES: ReadonlyArray<{ match: string; lifecycle: ConfigLifecycle }> = [
  // process_static — restart required on change
  { match: "cwd", lifecycle: "process_static" },
  { match: "dataDir", lifecycle: "process_static" },
  { match: "dataStore", lifecycle: "process_static" },
  { match: "now", lifecycle: "process_static" },
  // session_frozen — fixed at session creation
  { match: "profile", lifecycle: "session_frozen" },
  { match: "modelProvider", lifecycle: "session_frozen" },
  { match: "model", lifecycle: "session_frozen" },
  { match: "featureFlags", lifecycle: "session_frozen" },
  { match: "sandboxPolicy", lifecycle: "session_frozen" },
  { match: "limits", lifecycle: "session_frozen" },
  { match: "contextBudget", lifecycle: "session_frozen" },
  { match: "memory", lifecycle: "session_frozen" },
  { match: "delegation", lifecycle: "session_frozen" },
  { match: "skillSelector", lifecycle: "session_frozen" },
  { match: "toolSelector", lifecycle: "session_frozen" },
  // turn_dynamic — per-turn task/verification inputs
  { match: "task", lifecycle: "turn_dynamic" },
  { match: "verification", lifecycle: "turn_dynamic" },
  // step_dynamic — per-step binding selection
  { match: "mcp", lifecycle: "step_dynamic" },
];

/** Default for unmatched keys: session_frozen (fail closed — assume fixed
 *  for a session unless explicitly classified). */
const DEFAULT_LIFECYCLE: ConfigLifecycle = "session_frozen";

export function lifecycleOf(key: string): ConfigLifecycle {
  for (const rule of LIFECYCLE_RULES) {
    if (rule.match === key || key.startsWith(`${rule.match}.`)) return rule.lifecycle;
  }
  return DEFAULT_LIFECYCLE;
}

export interface ConfigFieldDoc {
  lifecycle: ConfigLifecycle;
  doc: string;
}

/** Documented metadata for every config field (P27-3 "Document every config
 *  field"). Exposed so `agent config explain` can render lifecycle + doc. */
export const CONFIG_FIELD_DOCS: Readonly<Record<string, ConfigFieldDoc>> = {
  cwd: { lifecycle: "process_static", doc: "workspace root the harness operates in" },
  dataDir: { lifecycle: "process_static", doc: "persistent store directory (JSONL/SQLite/checkpoint)" },
  dataStore: { lifecycle: "process_static", doc: "store backend: jsonl | sqlite" },
  now: { lifecycle: "process_static", doc: "injected wall clock (deterministic tests)" },
  profile: { lifecycle: "session_frozen", doc: "harness profile preset (interactive/batch/benchmark/test/ephemeral/champion)" },
  modelProvider: { lifecycle: "session_frozen", doc: "model provider implementation" },
  model: { lifecycle: "session_frozen", doc: "default model reference (providerId/modelId)" },
  "featureFlags.*": { lifecycle: "session_frozen", doc: "mechanism toggles (context/checkpoint/artifacts/memory/learning/skills/delegation/mcp/plugins/observability)" },
  "sandboxPolicy.*": { lifecycle: "session_frozen", doc: "filesystem/network/process sandbox policy" },
  "limits.*": { lifecycle: "session_frozen", doc: "run limits (turns/tool calls/duration/output/retries/subagents/cost)" },
  "contextBudget.*": { lifecycle: "session_frozen", doc: "context window token budget" },
  "memory.*": { lifecycle: "session_frozen", doc: "memory store config (enabled/dbPath/scope/topK)" },
  "delegation.*": { lifecycle: "session_frozen", doc: "subagent delegation caps" },
  skillSelector: { lifecycle: "session_frozen", doc: "skill index pruning callback" },
  toolSelector: { lifecycle: "session_frozen", doc: "progressive tool disclosure callback" },
  task: { lifecycle: "turn_dynamic", doc: "task whose verification specs gate completion" },
  "verification.*": { lifecycle: "turn_dynamic", doc: "verification plan builder / verifier overrides" },
  "mcp.*": { lifecycle: "step_dynamic", doc: "MCP server catalog — binding selection happens per step" },
};

export function fieldDocOf(key: string): ConfigFieldDoc | undefined {
  if (key in CONFIG_FIELD_DOCS) return CONFIG_FIELD_DOCS[key];
  for (const [pattern, doc] of Object.entries(CONFIG_FIELD_DOCS)) {
    if (pattern.endsWith(".*") && key.startsWith(pattern.slice(0, -1))) return doc;
  }
  return undefined;
}
