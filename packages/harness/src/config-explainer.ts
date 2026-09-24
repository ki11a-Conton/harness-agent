import type { ResolvedConfig } from "./config-resolver.js";
import { leafKeysOf, readPath } from "./config-resolver.js";
import type { ConfigLifecycle } from "./config-layers.js";
import { fieldDocOf, lifecycleOf } from "./config-layers.js";
import { redactConfigValue } from "./config-drift.js";
import type { HarnessConfig } from "./config.js";

/**
 * PHASE 27 (P27-5) — config explain surface.
 * Pure projection of a ResolvedConfig for CLI rendering: per-key origin,
 * lifecycle, doc, and a redacted value (API keys / auth headers / tokens are
 * never exposed).
 */

export interface ConfigExplainEntry {
  key: string;
  /** Redacted value — secrets replaced with "***redacted***". */
  value: unknown;
  origin?: { source: string; layerId: string };
  lifecycle: ConfigLifecycle;
  doc?: string;
}

export interface ConfigExplainResult {
  fingerprint: string;
  /** When a single dotted key was requested. */
  key?: string;
  entries: ConfigExplainEntry[];
}

export function explainConfig(
  resolved: ResolvedConfig<HarnessConfig>,
  key?: string,
): ConfigExplainResult {
  if (key !== undefined) {
    const raw = readPath(resolved.value, key);
    const origin = resolved.origins.get(key);
    const lifecycle = lifecycleOf(key);
    return {
      fingerprint: resolved.fingerprint,
      key,
      entries: [
        {
          key,
          value: redactConfigValue(key, raw),
          ...(origin !== undefined ? { origin: { source: origin.source, layerId: origin.layerId } } : {}),
          lifecycle,
          ...(fieldDocOf(key) !== undefined ? { doc: fieldDocOf(key)!.doc } : {}),
        },
      ],
    };
  }
  const keys = leafKeysOf(resolved.value);
  const entries: ConfigExplainEntry[] = keys.map((k) => {
    const raw = readPath(resolved.value, k);
    const origin = resolved.origins.get(k);
    const lifecycle = lifecycleOf(k);
    return {
      key: k,
      value: redactConfigValue(k, raw),
      ...(origin !== undefined ? { origin: { source: origin.source, layerId: origin.layerId } } : {}),
      lifecycle,
      ...(fieldDocOf(k) !== undefined ? { doc: fieldDocOf(k)!.doc } : {}),
    };
  });
  return { fingerprint: resolved.fingerprint, entries };
}
