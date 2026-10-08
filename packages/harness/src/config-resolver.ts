import type { HarnessConfig } from "./config.js";
import type { ConfigLayer, ConfigLayerSource, DeepPartial } from "./config-layers.js";
import { buildConfigLayers, hashOf, stableSerialize } from "./config-layers.js";
import { captureModelProviderConfigIdentity, type ModelProvider } from "@ar/contracts";

/**
 * PHASE 27 (P27-2) — effective config resolution with per-key origins.
 *
 * `resolveConfig` deep-merges an ordered layer stack (low → high precedence)
 * and records, for every leaf key, which layer supplied the winning value.
 * The resolved `fingerprint` is a stable hash of the whole effective config —
 * the input to the P27-4 drift policy.
 */

export interface ConfigOrigin {
  /** Dotted path of the leaf key, e.g. "sandboxPolicy.network". */
  readonly key: string;
  readonly source: ConfigLayerSource;
  readonly layerId: string;
}

export interface ResolvedConfig<T = HarnessConfig> {
  /** Effective value after merging all layers (low → high). */
  readonly value: T;
  /** The exact ordered stack that produced the value. */
  readonly layers: readonly ConfigLayer[];
  /** Per-leaf-key origin (only keys that carry a value). */
  readonly origins: ReadonlyMap<string, ConfigOrigin>;
  /** Stable hash of the entire effective config. */
  readonly fingerprint: string;
}

function isMergeableObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { then?: unknown }).then !== "function"
  );
}

interface MergeState {
  origins: Map<string, ConfigOrigin>;
}

function mergeInto(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceLayer: ConfigLayer,
  path: string[],
  state: MergeState,
): void {
  for (const [key, sourceValue] of Object.entries(source)) {
    let rawValue = sourceValue;
    if (rawValue === undefined) continue; // undefined = "not set", never overrides
    const fullPath = [...path, key];
    const dotPath = fullPath.join(".");
    // Only an explicit provider contract may distinguish immutable execution
    // configuration from mutable provider internals. Unknown implementations
    // retain the existing full enumerable-field comparison, never id-only.
    if (dotPath === "modelProvider" && isMergeableObject(rawValue)) {
      const provider = rawValue as unknown as ModelProvider;
      if (typeof provider.getConfigIdentity === "function") {
        const identity = provider.getConfigIdentity();
        if (identity !== undefined) {
          rawValue = { id: provider.id, configIdentity: captureModelProviderConfigIdentity(identity) };
          // A declared provider is a complete identity, not a partial patch
          // that inherits unrelated fields from a lower provider layer.
          target[key] = {};
        }
      }
    }
    if (isMergeableObject(rawValue)) {
      const existing = target[key];
      const childTarget: Record<string, unknown> =
        existing !== undefined && isMergeableObject(existing) ? existing : {};
      target[key] = childTarget;
      mergeInto(childTarget, rawValue, sourceLayer, fullPath, state);
    } else {
      target[key] = rawValue;
      state.origins.set(dotPath, { key: dotPath, source: sourceLayer.source, layerId: sourceLayer.id });
    }
  }
}

/** Detach every array/object before hashing and later durable serialization.
 * Functions retain the existing P27 name/normalization semantics. Freezing the
 * captured data must never freeze the original executable provider instance.
 */
function captureConfigValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(captureConfigValue));
  const captured: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) captured[key] = captureConfigValue(child);
  return Object.freeze(captured);
}

/** Resolve an ordered layer stack (first = lowest precedence) into the
 *  effective config, origins and fingerprint. */
export function resolveConfig(layers: readonly ConfigLayer[]): ResolvedConfig<HarnessConfig> {
  const value: Record<string, unknown> = {};
  const state: MergeState = { origins: new Map() };
  for (const layer of layers) {
    mergeInto(value, layer.values as Record<string, unknown>, layer, [], state);
  }
  const captured = captureConfigValue(value) as HarnessConfig;
  const fingerprint = hashOf(stableSerialize(captured));
  return {
    value: captured,
    layers: [...layers],
    origins: state.origins,
    fingerprint,
  };
}

/** Input shape for the harness composition root's own resolution. */
export interface ResolveHarnessConfigInput {
  profile: import("./config.js").HarnessProfile;
  /** The caller's effective config (createHarness's `config` argument) — the
   *  highest-precedence runtime overrides. */
  overrides: DeepPartial<HarnessConfig>;
  env?: Record<string, string | undefined>;
  sessionOverrides?: DeepPartial<HarnessConfig>;
}

/** Convenience: build the standard layer stack (defaults → profile →
 *  environment → session → runtime) and resolve it. */
export function resolveHarnessConfig(
  input: ResolveHarnessConfigInput,
): ResolvedConfig<HarnessConfig> {
  return resolveConfig(buildConfigLayers(input));
}

/** Walk the resolved value and return the ordered list of leaf keys (dotted)
 *  that carry a value. Useful for `agent config explain` (no key). */
export function leafKeysOf(value: unknown, prefix = ""): string[] {
  if (!isMergeableObject(value)) return prefix === "" ? [] : [prefix];
  const out: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const dot = prefix === "" ? key : `${prefix}.${key}`;
    if (isMergeableObject(child)) {
      out.push(...leafKeysOf(child, dot));
    } else {
      out.push(dot);
    }
  }
  return out.sort();
}

/** Walk a dotted path through a value (used by drift + explain). */
export function readPath(value: unknown, dotPath: string): unknown {
  let node: unknown = value;
  for (const seg of dotPath.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

/** Depth-compare two values; return dotted leaf keys whose values differ
 *  (stable-serialization comparison; missing vs present counts as changed). */
export function collectChangedKeys(prev: unknown, next: unknown, prefix = ""): string[] {
  const changed: string[] = [];
  if (isMergeableObject(prev) && isMergeableObject(next)) {
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    for (const key of keys) {
      const dot = prefix === "" ? key : `${prefix}.${key}`;
      if (!(key in prev)) {
        // introduced entirely — report only if the new value is defined
        const v = (next as Record<string, unknown>)[key];
        if (v !== undefined) changed.push(...leafKeysOf(v, dot));
      } else if (!(key in next)) {
        changed.push(dot);
      } else {
        changed.push(...collectChangedKeys(prev[key], next[key], dot));
      }
    }
    return changed;
  }
  if (stableSerialize(prev) !== stableSerialize(next)) {
    return prefix === "" ? ["(root)"] : [prefix];
  }
  return changed;
}
