import type { ToolSpec } from "@ar/contracts";
import { estimateSpecTokens, estimateSpecsTokens } from "@ar/contracts";

/**
 * P18-2: deferred tool schemas only when needed.
 *
 * The built-in small tool set is always advertised in full. When MCP/plugin
 * servers push the schema set past a TOKEN budget (never a hardcoded tool
 * count), the bulk goes deferred: the model sees a name+description stub and
 * fetches the full input schema on demand via `tool_lookup`. This keeps the
 * per-request advertisement cost bounded without hiding tools entirely.
 */

/** P18-2 default inline advertisement budget (~24k schema tokens ≈ 96 KB of
 *  JSON schema). Small sets (12 built-ins) are far below this, so the default
 *  runtime path never changes. */
export const DEFAULT_MAX_INLINE_SCHEMA_TOKENS = 24_000;

/** Stub description length for a deferred tool — enough for the model to
 *  decide whether to call `tool_lookup`, short enough to stay cheap. */
export const DEFERRED_STUB_DESCRIPTION_MAX = 220;

export { estimateSpecTokens, estimateSpecsTokens };

/** P18-2: a deferred stub spec — the tool stays discoverable by name +
 *  description, but the full input schema is fetched on demand. */
export function stubSpec(spec: ToolSpec, descriptionMax = DEFERRED_STUB_DESCRIPTION_MAX): ToolSpec {
  const description =
    spec.description.length > descriptionMax
      ? `${spec.description.slice(0, descriptionMax)}… (full schema via tool_lookup)`
      : spec.description;
  return { name: spec.name, description, inputSchema: { type: "object" } };
}

export interface SchemaAdvertDecision {
  mode: "full" | "deferred";
  /** The specs actually advertised to the model. */
  advertised: ToolSpec[];
  /** Tools whose full schema was stubbed (fetchable via tool_lookup). */
  deferred: string[];
  /** Estimated advertisement tokens. */
  tokens: number;
}

export interface SchemaAdvertPolicy {
  /** Token budget for full inline advertisement. Default 24k. */
  maxInlineTokens?: number;
  /** Tools that must ALWAYS be advertised in full (the built-in small set).
   *  A predicate wins over a set when both are given. */
  keepFull?: ReadonlySet<string> | ((name: string) => boolean);
}

/** P18-2: decide full vs deferred advertisement purely from the schema token
 *  budget. Below the budget → full (unchanged behavior). Above → the non-core
 *  bulk is stubbed and advertised as discoverable-but-deferred. */
export function decideSchemaAdvert(
  specs: readonly ToolSpec[],
  policy: SchemaAdvertPolicy = {},
): SchemaAdvertDecision {
  const maxInlineTokens = policy.maxInlineTokens ?? DEFAULT_MAX_INLINE_SCHEMA_TOKENS;
  const tokens = estimateSpecsTokens(specs);
  if (tokens <= maxInlineTokens) {
    return { mode: "full", advertised: [...specs], deferred: [], tokens };
  }
  const keepFull = policy.keepFull;
  const keep =
    typeof keepFull === "function"
      ? keepFull
      : (name: string) => (keepFull as ReadonlySet<string> | undefined)?.has(name) ?? false;
  const advertised: ToolSpec[] = [];
  const deferred: string[] = [];
  for (const spec of specs) {
    if (keep(spec.name)) {
      advertised.push(spec);
    } else {
      advertised.push(stubSpec(spec));
      deferred.push(spec.name);
    }
  }
  return { mode: "deferred", advertised, deferred, tokens };
}
