/**
 * A2 — the read-only FORMAL EXECUTION IDENTITY source.
 *
 * WHY THIS EXISTS
 * ---------------
 * The v2 observer reported `runtimeConfigDigest` / `requestProfileDigest` as
 * `UNOBSERVABLE` and the price as `null`, so NO artifact could ever be
 * certified: the fail-closed gate could only ever REFUSE, never admit a legal
 * frozen experiment (F1 / plan.md A2). Filling those fields by echoing the
 * artifact's own claims would be the very defect the gate exists to prevent.
 *
 * This module derives them from the SAME sources the execution path uses, so
 * `prereg build` and the production observer agree by construction:
 *
 *   runtimeConfigDigest   `computeRuntimeConfigHash` over the pinned harness
 *                         wiring for `tool_call_efficiency_v1` (the exact
 *                         `runtimeConfigForHash` body, minus the per-case
 *                         `suite` label — a run variant, not a wiring fact)
 *   requestProfileDigest  `sha256(stableStringify(requestProfile))` where
 *                         `requestProfile` is the benchmark's effective model
 *                         params (`budgetTokens`, `BENCHMARK_STALL_POLICY`) —
 *                         the SAME object the plan digest binds
 *   providerId/modelId/   the SAME precedence `resolveModelProvider` +
 *   endpointDigest        `runtimeConfigForHash` apply: OPENAI_API_KEY /
 *                         OPENAI_MODEL select the real provider, OPENAI_MODEL
 *                         overrides the default model, OPENAI_BASE_URL is the
 *                         endpoint (normalized to a digest; never raw)
 *   usdMicrosPerCall      a VERSIONED per-call USD ceiling. `0` ONLY for the
 *                         genuinely-unbilled stub; a provider whose price is
 *                         unknown resolves to `null` (= unknown → the gate
 *                         refuses `PRICING_UNKNOWN`), never to a silent zero.
 *
 * PURE / OFFLINE: no provider, no key material, no network. Reads env + the
 * committed production constants only.
 */

import { createHash } from "node:crypto";
import { budgetForCapabilities, resolveCapabilities } from "@ar/model";
import {
  TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
  computeRuntimeConfigHash,
  stableStringify,
} from "@ar/evaluation";
import {
  BENCHMARK_STALL_POLICY,
  runtimeConfigForHash,
  type BenchmarkCommandOptions,
} from "./benchmark-command.js";
import {
  DEFAULT_REAL_MODEL_ID,
  REAL_PROVIDER_ID,
  STUB_MODEL_ID,
  STUB_PROVIDER_ID,
} from "./provider.js";

/** The `agent benchmark --budget` default (documented default; a case.json may
 *  still override per case). Used when the resolved model publishes no context
 *  window — exactly the fallback `resolveExecutionPlan` applies. */
export const FORMAL_EXECUTION_DEFAULT_BUDGET_TOKENS = 32_000;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface ProviderIdentity {
  providerId: string;
  modelId: string;
  /** The explicit base URL, or `null` for the provider default endpoint. */
  endpointBaseUrl: string | null;
}

/**
 * The provider/model/endpoint the execution path WILL resolve from `env`.
 *
 * Precedence mirrors `resolveModelProvider` (a key is what makes a real,
 * billable provider possible) and `runtimeConfigForHash`'s planned identity:
 * `OPENAI_MODEL` or `OPENAI_API_KEY` selects the real provider; `OPENAI_MODEL`
 * overrides `DEFAULT_REAL_MODEL_ID`; a keyless run is the stub. `--provider` /
 * `--model` overrides do NOT exist on the prereg chain (A3).
 */
export function resolveProviderIdentity(env: NodeJS.ProcessEnv = process.env): ProviderIdentity {
  const hasKey = (env["OPENAI_API_KEY"] ?? "") !== "";
  const model = env["OPENAI_MODEL"] ?? "";
  const real = hasKey || model !== "";
  return {
    providerId: real ? REAL_PROVIDER_ID : STUB_PROVIDER_ID,
    modelId: real ? model || DEFAULT_REAL_MODEL_ID : STUB_MODEL_ID,
    endpointBaseUrl: real ? (env["OPENAI_BASE_URL"] ?? "") || null : null,
  };
}

/**
 * The pinned harness wiring for `tool_call_efficiency_v1`. Delegates to
 * `runtimeConfigForHash` so every wiring field (prompt bytes, permissions,
 * sandbox, tools, limits, stall policy, judge version, mechanism flags) stays
 * bound to the ONE production definition — the `suite` label is dropped
 * because a campaign spans suites (regression/adversarial/stress) and a
 * per-case label is not a wiring fact.
 */
export function pinnedFormalRuntimeWiring(budgetTokens: number): Record<string, unknown> {
  const { suite: _suite, ...wiring } = runtimeConfigForHash(
    { suite: "regression", candidate: TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2 } as BenchmarkCommandOptions,
    budgetTokens,
  );
  void _suite;
  return wiring;
}

export interface FormalExecutionProfile {
  budgetTokens: number;
  /** The effective model params the plan digest binds (`effectiveModelParams`). */
  requestProfile: { budgetTokens: number; stallPolicy: typeof BENCHMARK_STALL_POLICY };
  runtimeConfigDigest: string;
  requestProfileDigest: string;
  provider: ProviderIdentity;
}

/**
 * The full, re-derivable execution profile: provider identity, effective
 * request profile and the two digests. Shared by `prereg build` (the writer)
 * and `observeExecutionIdentity` (the certifier).
 */
export function formalExecutionProfile(env: NodeJS.ProcessEnv = process.env): FormalExecutionProfile {
  const provider = resolveProviderIdentity(env);
  const budgetTokens =
    budgetForCapabilities(resolveCapabilities({ providerId: provider.providerId, modelId: provider.modelId })) ??
    FORMAL_EXECUTION_DEFAULT_BUDGET_TOKENS;
  const requestProfile = { budgetTokens, stallPolicy: BENCHMARK_STALL_POLICY };
  return {
    budgetTokens,
    requestProfile,
    runtimeConfigDigest: computeRuntimeConfigHash(pinnedFormalRuntimeWiring(budgetTokens)),
    requestProfileDigest: sha256Hex(stableStringify(requestProfile)),
    provider,
  };
}

/**
 * B2 — a VERSIONED, TRACEABLE per-model / per-endpoint per-call USD bound.
 *
 * The previous version was ONE scalar read from the benchmark preflight's
 * `PREFLIGHT_ESTIMATE.costPerCallUsd` — a PLANNING number applied to every real
 * provider, model and endpoint alike. A planning estimate is not a billing fact:
 * it cannot bound a given model's worst case, it is blind to a proxy/gateway
 * endpoint's own markup, and it can silently go stale. The paid gate must not
 * claim a USD bound on that basis.
 *
 * This snapshot instead binds:
 *   - `version`               the snapshot revision (bump on any change);
 *   - `source`                an external, traceable rate source (not the planner);
 *   - `invalidatedAtMs`       the wall-clock after which the bound is VOID (a
 *                             stale snapshot resolves to `null` → PRICING_UNKNOWN);
 *   - `requestBoundByModel`   the worst-case USD micros ONE request may cost for
 *                             a KNOWN model on the FIRST-PARTY endpoint. It must
 *                             dominate the per-call token ceilings at published
 *                             rates (see `FORMAL_PER_CALL_*_TOKEN_CEILING`).
 *
 * A custom `OPENAI_BASE_URL` (a proxy) and an unlisted model both resolve to
 * `null`: unknown billing is a refusal, never the first-party price.
 */
/**
 * R4/F5 — WHERE a price comes from, as an explicit LEVEL rather than a string.
 *
 * `operator_declared`  an operator states a rate for one endpoint. It is a
 *                      CONSERVATIVE UPPER BOUND used to bound spend; it is NOT
 *                      a provider invoice and must never be presented as a real
 *                      USD actual.
 * `provider_verified`  a rate published by the provider (the committed
 *                      first-party rate card). This level can NEVER be reached
 *                      from an operator-supplied JSON string: an operator
 *                      cannot certify a provider's price.
 */
export type PricingSourceKind = "operator_declared" | "provider_verified";

/** ISO-4217. Only USD is supported; anything else is refused (fail closed). */
export type PricingCurrency = "USD";

export const SUPPORTED_PRICING_CURRENCY: PricingCurrency = "USD";

export const PRICING_SNAPSHOT_V1 = {
  version: "pricing-snapshot-v2",
  source: "provider published rate card (list price, highest tier), recorded out of band in docs/evidence",
  invalidatedAtMs: 1_893_456_000_000, // 2030-01-01T00:00:00Z — after this the bound is void
  /** R4/F5: the level of this source. A committed provider rate card is
   *  provider-published, so it is the ONLY `provider_verified` basis. */
  sourceKind: "provider_verified" as PricingSourceKind,
  currency: "USD" as PricingCurrency,
  /** When the published rate card was recorded (2025-01-01T00:00:00Z). */
  issuedAtMs: 1_735_689_600_000,
  /** The per-call token envelope the per-call bound below was computed for. */
  coveredTokenCeiling: 33_000,
  requestBoundByModel: {
    [DEFAULT_REAL_MODEL_ID]: 2_500_000,
  } as Readonly<Record<string, number>>,
  /** The default model's per-call bound (kept as a scalar for simple readers). */
  usdMicrosPerCall: 2_500_000,
} as const;

/** TRUE while the snapshot is inside its validity window. */
export function pricingSnapshotValid(nowMs: number = Date.now()): boolean {
  return nowMs < PRICING_SNAPSHOT_V1.invalidatedAtMs;
}

/**
 * A pricing declaration the OPERATOR makes for one endpoint the snapshot cannot
 * price (a relay, gateway or self-hosted endpoint), supplied as one JSON value in
 * `PREREG_PRICING_JSON`.
 *
 * WHY THIS EXISTS (measured): `PRICING_SNAPSHOT_V1` prices only a known model on
 * the FIRST-PARTY endpoint. Every other combination used to resolve to `null`, so
 * a custom `OPENAI_BASE_URL` or an unlisted model was refused as `PRICING_UNKNOWN`
 * before any provider was constructed. That refusal is correct when nobody has
 * said what a call costs — but it also meant a correctly-authorized run against a
 * known relay could never start. This declaration is how an operator states the
 * rate, so the money bound still exists instead of being waived.
 *
 * It stays EXPLICIT on purpose: there is no default, no fallback and no
 * "assume unlimited" mode. An absent, malformed, untraceable or non-positive
 * declaration resolves to `null`, which is still a refusal. The plan's
 * prohibition on a default paid path (`禁止真实 API key、默认付费路径`) is
 * untouched: nothing here authorizes a run on its own, and the caller's own
 * `RUN_PAID_BENCHMARKS` / approval gates still apply.
 */
/** R4/F5: which supported declaration MODE produced a parsed view. */
export type DeclaredPricingMode = "legacy_ephemeral" | "v2_windowed";

/** Distinct, machine-readable reasons a declaration or basis was refused. Kept
 *  distinct so a caller/log can tell WHICH rule failed, not merely "invalid". */
export type PricingRejectionReason =
  | "absent"
  | "malformed_json"
  | "duplicate_key"
  | "not_an_object"
  | "unknown_field"
  | "missing_field"
  | "missing_base_url"
  | "empty_source"
  | "illegal_numeric"
  | "empty_bounds"
  | "self_declared_provider_verified"
  | "unsupported_currency"
  | "invalid_validity_window"
  | "expired"
  | "not_yet_valid"
  | "insufficient_token_coverage"
  | "endpoint_mismatch"
  | "model_not_declared"
  | "snapshot_expired"
  | "provider_unknown";

export interface PricingRejection {
  ok: false;
  reason: PricingRejectionReason;
  detail: string;
}

export interface DeclaredPricing {
  /** The NORMALIZED base URL this declaration covers. Never empty: a declaration
   *  may not target the first-party default endpoint (the rate card already
   *  covers it, and `""` is no longer a way to claim it). */
  baseUrl: string;
  /** A traceable rate source. Required — an untraceable rate is not a rate. */
  source: string;
  /** model id → worst-case USD micros ONE request may cost. Positive integers. */
  boundByModel: Readonly<Record<string, number>>;
  /** Which supported mode produced this view. */
  mode: DeclaredPricingMode;
  /** Always `operator_declared`: an operator-supplied string can never certify a
   *  provider's price, so `provider_verified` is unreachable from this env var. */
  sourceKind: PricingSourceKind;
  currency: PricingCurrency;
  /** The token envelope the ceilings cover; `null` = unspecified (legacy mode). */
  coveredTokenCeiling: number | null;
  /** Per-class rates in µUSD per 1,000,000 tokens, when declared. */
  perClassRates: { input: number; output: number } | null;
  issuedAt: string | null;
  expiresAt: string | null;
  /** Canonical digest over this declaration's WHOLE basis. */
  digest: string;
}

/** The single environment variable that carries a pricing declaration JSON value. */
export const DECLARED_PRICING_ENV = "PREREG_PRICING_JSON";

const V2_PRICING_SCHEMA = "prereg-pricing-v2";
const LEGACY_DECLARATION_KEYS = ["baseUrl", "source", "boundByModel"] as const;
const V2_DECLARATION_KEYS = [
  "schema",
  "sourceKind",
  "source",
  "baseUrl",
  "currency",
  "issuedAt",
  "expiresAt",
  "coveredTokenCeiling",
  "rates",
  "ceilingByModel",
] as const;

/**
 * The endpoint rule of the REAL transport (`packages/model/src/openai.ts`):
 * `baseUrl.replace(/\/+$/, "")` and then `${baseUrl}/chat/completions`. A
 * declaration must therefore be matched on the SAME normalized form, or a rate
 * recorded for `…/v1/` would silently not cover the endpoint actually used.
 * `null`/`""` normalizes to `null` (the provider's default endpoint).
 */
export function normalizeEndpointBaseUrl(baseUrl: string | null | undefined): string | null {
  if (baseUrl === null || baseUrl === undefined) return null;
  const stripped = baseUrl.replace(/\/+$/, "");
  return stripped === "" ? null : stripped;
}

/** Read one JSON string token starting at its opening quote. */
function readJsonStringToken(raw: string, start: number): { value: string; next: number } {
  let i = start + 1;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') break;
    i += 1;
  }
  return { value: JSON.parse(raw.slice(start, i + 1)) as string, next: i + 1 };
}

/**
 * The FIRST duplicate object key in `raw`, or `null`.
 *
 * `JSON.parse` silently keeps the LAST duplicate, so
 * `{"baseUrl":"a","baseUrl":"b"}` would price an endpoint the operator may not
 * have meant. Rejected rather than guessed.
 */
export function findDuplicateJsonKey(raw: string): string | null {
  const stack: Array<{ kind: "object" | "array"; keys: Set<string> }> = [];
  let lastSig = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === '"') {
      let token: { value: string; next: number };
      try {
        token = readJsonStringToken(raw, i);
      } catch {
        return null; // unterminated string: the JSON.parse caller rejects it
      }
      const frame = stack[stack.length - 1];
      if (frame?.kind === "object" && (lastSig === "{" || lastSig === ",")) {
        if (frame.keys.has(token.value)) return token.value;
        frame.keys.add(token.value);
      }
      lastSig = "v";
      i = token.next;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "{") {
      stack.push({ kind: "object", keys: new Set() });
      lastSig = "{";
      i += 1;
      continue;
    }
    if (ch === "[") {
      stack.push({ kind: "array", keys: new Set() });
      lastSig = "[";
      i += 1;
      continue;
    }
    if (ch === "}") {
      stack.pop();
      lastSig = "}";
      i += 1;
      continue;
    }
    if (ch === "]") {
      stack.pop();
      lastSig = "]";
      i += 1;
      continue;
    }
    if (ch === ",") {
      lastSig = ",";
      i += 1;
      continue;
    }
    if (ch === ":") {
      lastSig = ":";
      i += 1;
      continue;
    }
    lastSig = "v";
    i += 1;
  }
  return null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Worst-case µUSD ONE call may cost under `declared` for `modelId`, or `null`
 *  when the model is not covered. Conservative: the LARGER of the declared
 *  per-call ceiling and the rate-derived ceiling for the covered token envelope. */
export function effectivePerCallCeiling(modelId: string, declared: DeclaredPricing): number | null {
  const explicit = declared.boundByModel[modelId];
  const rateCeiling =
    declared.perClassRates !== null && declared.coveredTokenCeiling !== null
      ? Math.ceil(
          (Math.max(declared.perClassRates.input, declared.perClassRates.output) * declared.coveredTokenCeiling) /
            1_000_000,
        )
      : 0;
  const best = Math.max(typeof explicit === "number" ? explicit : 0, rateCeiling);
  return best > 0 ? best : null;
}

/** Canonical digest over a DECLARATION's whole basis (identity of the basis,
 *  independent of when it was checked). */
export function declaredPricingDigest(value: Omit<DeclaredPricing, "digest">): string {
  return sha256Hex(
    stableStringify({
      schema: "ar.declared-pricing.v1",
      baseUrl: value.baseUrl,
      source: value.source,
      sourceKind: value.sourceKind,
      currency: value.currency,
      mode: value.mode,
      coveredTokenCeiling: value.coveredTokenCeiling,
      perClassRates: value.perClassRates,
      issuedAt: value.issuedAt,
      expiresAt: value.expiresAt,
      boundByModel: value.boundByModel,
    }),
  );
}

/**
 * Strictly parse a pricing declaration, with a DISTINCT reason for every
 * rejection. Accepted shapes:
 *
 *   legacy  `{ baseUrl, source, boundByModel }` — the historical form, now an
 *           explicitly-labelled `legacy_ephemeral` + `operator_declared` mode
 *           with an UNSPECIFIED validity window (no expiry claim is made).
 *   v2      `{ schema:"prereg-pricing-v2", sourceKind:"operator_declared",
 *             source, baseUrl, currency:"USD", issuedAt, expiresAt,
 *             coveredTokenCeiling, rates|ceilingByModel }`
 *
 * Rejected: duplicate keys, unknown fields, an absent/empty baseUrl, an empty
 * source, illegal numerics (0/negative/fractional/non-number, including ONE bad
 * entry in an otherwise valid map), a non-USD currency, a malformed or
 * non-advancing validity window, bounds that name no model, and any attempt to
 * self-declare `provider_verified`.
 */
export function parseDeclaredPricingStrict(
  raw: string | undefined | null,
): { ok: true; value: DeclaredPricing } | PricingRejection {
  if (raw === undefined || raw === null || raw.trim() === "") {
    return { ok: false, reason: "absent", detail: `${DECLARED_PRICING_ENV} is not set` };
  }
  const duplicate = findDuplicateJsonKey(raw);
  if (duplicate !== null) {
    return {
      ok: false,
      reason: "duplicate_key",
      detail: `duplicate JSON key ${JSON.stringify(duplicate)}: which value was meant is ambiguous`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed_json", detail: "not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "not_an_object", detail: "the declaration must be a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  const isV2 = obj["schema"] === V2_PRICING_SCHEMA;
  if ("schema" in obj && !isV2) {
    return {
      ok: false,
      reason: "unknown_field",
      detail: `unsupported schema ${JSON.stringify(obj["schema"])} (supported: ${JSON.stringify(V2_PRICING_SCHEMA)})`,
    };
  }
  const allowed: readonly string[] = isV2 ? V2_DECLARATION_KEYS : LEGACY_DECLARATION_KEYS;
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      return { ok: false, reason: "unknown_field", detail: `unknown field ${JSON.stringify(key)}` };
    }
  }
  const source = typeof obj["source"] === "string" ? obj["source"].trim() : "";
  if (source === "") {
    return { ok: false, reason: "empty_source", detail: "`source` must be a non-empty, traceable rate source" };
  }
  const rawBaseUrl = obj["baseUrl"];
  if (typeof rawBaseUrl !== "string" || rawBaseUrl.trim() === "") {
    return { ok: false, reason: "missing_base_url", detail: "`baseUrl` is required and must be a non-empty string" };
  }
  const baseUrl = normalizeEndpointBaseUrl(rawBaseUrl);
  if (baseUrl === null) {
    return {
      ok: false,
      reason: "missing_base_url",
      detail: "`baseUrl` normalizes to the provider default endpoint, which a declaration may not cover",
    };
  }

  if (isV2) {
    if (obj["sourceKind"] !== "operator_declared") {
      return {
        ok: false,
        reason: "self_declared_provider_verified",
        detail: `sourceKind ${JSON.stringify(obj["sourceKind"])}: an operator declaration can never be provider_verified — that level requires a provider-published rate`,
      };
    }
    if (obj["currency"] !== SUPPORTED_PRICING_CURRENCY) {
      return {
        ok: false,
        reason: "unsupported_currency",
        detail: `currency ${JSON.stringify(obj["currency"])} is not ${SUPPORTED_PRICING_CURRENCY}`,
      };
    }
    const issuedAt = typeof obj["issuedAt"] === "string" ? obj["issuedAt"] : null;
    const expiresAt = typeof obj["expiresAt"] === "string" ? obj["expiresAt"] : null;
    if (issuedAt === null || expiresAt === null) {
      return { ok: false, reason: "missing_field", detail: "`issuedAt` and `expiresAt` are both required" };
    }
    const issuedMs = Date.parse(issuedAt);
    const expiresMs = Date.parse(expiresAt);
    if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs) || !(expiresMs > issuedMs)) {
      return {
        ok: false,
        reason: "invalid_validity_window",
        detail: `invalid validity window ${JSON.stringify(issuedAt)} → ${JSON.stringify(expiresAt)} (both must be ISO-8601 and expiresAt must be later)`,
      };
    }
    const coveredTokenCeiling = obj["coveredTokenCeiling"];
    if (!isPositiveSafeInteger(coveredTokenCeiling)) {
      return {
        ok: false,
        reason: "illegal_numeric",
        detail: "`coveredTokenCeiling` must be a positive safe integer (the token envelope the ceiling covers)",
      };
    }
    let perClassRates: { input: number; output: number } | null = null;
    const rawRates = obj["rates"];
    if (rawRates !== undefined) {
      if (typeof rawRates !== "object" || rawRates === null || Array.isArray(rawRates)) {
        return { ok: false, reason: "illegal_numeric", detail: "`rates` must be an object with `input`/`output`" };
      }
      for (const key of Object.keys(rawRates)) {
        if (key !== "input" && key !== "output") {
          return { ok: false, reason: "unknown_field", detail: `unknown field "rates.${key}"` };
        }
      }
      const input = (rawRates as Record<string, unknown>)["input"];
      const output = (rawRates as Record<string, unknown>)["output"];
      if (!isPositiveSafeInteger(input) || !isPositiveSafeInteger(output)) {
        return {
          ok: false,
          reason: "illegal_numeric",
          detail: "`rates.input`/`rates.output` must be positive safe integers (µUSD per 1,000,000 tokens)",
        };
      }
      perClassRates = { input, output };
    }
    const boundByModel: Record<string, number> = {};
    const rawCeilings = obj["ceilingByModel"];
    if (rawCeilings !== undefined) {
      if (typeof rawCeilings !== "object" || rawCeilings === null || Array.isArray(rawCeilings)) {
        return { ok: false, reason: "illegal_numeric", detail: "`ceilingByModel` must be an object" };
      }
      for (const [modelId, value] of Object.entries(rawCeilings as Record<string, unknown>)) {
        if (modelId.trim() === "") {
          return { ok: false, reason: "missing_field", detail: "`ceilingByModel` contains an empty model id" };
        }
        if (!isPositiveSafeInteger(value)) {
          return {
            ok: false,
            reason: "illegal_numeric",
            detail: `ceilingByModel[${JSON.stringify(modelId)}] must be a positive safe integer (µUSD per call)`,
          };
        }
        boundByModel[modelId] = value;
      }
    }
    if (perClassRates === null && Object.keys(boundByModel).length === 0) {
      return {
        ok: false,
        reason: "empty_bounds",
        detail: "a v2 declaration needs `rates` and/or `ceilingByModel` — a price with no bounding value is not a bound",
      };
    }
    const bare = {
      baseUrl,
      source,
      boundByModel,
      mode: "v2_windowed" as const,
      sourceKind: "operator_declared" as const,
      currency: SUPPORTED_PRICING_CURRENCY,
      coveredTokenCeiling,
      perClassRates,
      issuedAt,
      expiresAt,
    };
    return { ok: true, value: { ...bare, digest: declaredPricingDigest(bare) } };
  }

  const rawBounds = obj["boundByModel"];
  if (typeof rawBounds !== "object" || rawBounds === null || Array.isArray(rawBounds)) {
    return { ok: false, reason: "missing_field", detail: "`boundByModel` is required" };
  }
  const boundByModel: Record<string, number> = {};
  for (const [modelId, value] of Object.entries(rawBounds as Record<string, unknown>)) {
    if (modelId.trim() === "") {
      return { ok: false, reason: "missing_field", detail: "`boundByModel` contains an empty model id" };
    }
    if (!isPositiveSafeInteger(value)) {
      return {
        ok: false,
        reason: "illegal_numeric",
        detail: `boundByModel[${JSON.stringify(modelId)}] must be a positive safe integer (µUSD per call)`,
      };
    }
    boundByModel[modelId] = value;
  }
  if (Object.keys(boundByModel).length === 0) {
    return { ok: false, reason: "empty_bounds", detail: "`boundByModel` names no model" };
  }
  const bare = {
    baseUrl,
    source,
    boundByModel,
    mode: "legacy_ephemeral" as const,
    sourceKind: "operator_declared" as const,
    currency: SUPPORTED_PRICING_CURRENCY,
    coveredTokenCeiling: null,
    perClassRates: null,
    issuedAt: null,
    expiresAt: null,
  };
  return { ok: true, value: { ...bare, digest: declaredPricingDigest(bare) } };
}

/** The legacy view of a declaration, or `null`. */
export function parseDeclaredPricing(raw: string | undefined | null): DeclaredPricing | null {
  const parsed = parseDeclaredPricingStrict(raw);
  return parsed.ok ? parsed.value : null;
}

/**
 * R4/F5 — the FULL pricing basis of a run: the amount AND the level, source,
 * currency, coverage, validity and model/endpoint it is bound to.
 *
 * `env` is REQUIRED: the price must come from the SAME injected environment as
 * the provider/model/endpoint identity, or two different environments can
 * cross-contaminate (the F5 defect: `observe(..., env)` reading the declaration
 * from the global `process.env`).
 *
 * `nowMs` is injectable so the validity window is testable without sleeping.
 */
export interface ResolvedPricingBasis {
  /** `unbilled_stub` is the genuinely free stub (no external billing). It is NOT
   *  a declared rate and NOT a provider-verified price. */
  basisKind: "unbilled_stub" | PricingSourceKind;
  usdMicrosPerCall: number;
  /** `null` only for the unbilled stub. */
  sourceKind: PricingSourceKind | null;
  /** Whether the basis came from an INJECTED env or (legacy call shape) from the
   *  process environment. A `process_env` basis is the F5 inconsistency made
   *  VISIBLE instead of silent; the identity path always injects. */
  envSource: "injected" | "process_env";
  source: string;
  currency: PricingCurrency;
  /** TRUE for every operator-declared value: it BOUNDS spend, it is not an invoice. */
  isConservativeUpperBound: boolean;
  providerId: string;
  modelId: string;
  endpointBaseUrl: string | null;
  coverage: {
    coveredTokenCeiling: number | null;
    requiredTokenCeiling: number | null;
    perClassRates: { input: number; output: number } | null;
  };
  validity: {
    kind: "unspecified" | "windowed" | "snapshot";
    issuedAt: string | null;
    expiresAt: string | null;
    checkedAtMs: number;
  };
  /** Canonical digest over the whole basis, stable across runs. */
  pricingDigest: string;
}

export type PricingResolution = { ok: true; basis: ResolvedPricingBasis } | PricingRejection;

/** Canonical digest over a RESOLVED basis. Excludes the (wall-clock) observation
 *  instant and the digest itself, so it is stable for the same basis. */
export function pricingBasisDigest(basis: Omit<ResolvedPricingBasis, "pricingDigest">): string {
  return sha256Hex(
    stableStringify({
      schema: "ar.pricing-basis.v1",
      basisKind: basis.basisKind,
      usdMicrosPerCall: basis.usdMicrosPerCall,
      sourceKind: basis.sourceKind,
      source: basis.source,
      currency: basis.currency,
      isConservativeUpperBound: basis.isConservativeUpperBound,
      providerId: basis.providerId,
      modelId: basis.modelId,
      endpointBaseUrl: basis.endpointBaseUrl,
      coverage: {
        coveredTokenCeiling: basis.coverage.coveredTokenCeiling,
        perClassRates: basis.coverage.perClassRates,
      },
      validity: { kind: basis.validity.kind, issuedAt: basis.validity.issuedAt, expiresAt: basis.validity.expiresAt },
    }),
  );
}

export interface PriceQuery {
  /** The model the run will actually use; defaults to the first-party model. */
  modelId?: string;
  /** The explicit base URL, or `null`/absent for the provider default endpoint. */
  endpointBaseUrl?: string | null;
  /** R4/F5: the request's own token envelope, so a declaration too small to
   *  cover the run is refused rather than silently under-bounding it. */
  requiredTokenCeiling?: number | null;
}

function withDigest(basis: Omit<ResolvedPricingBasis, "pricingDigest">): ResolvedPricingBasis {
  return { ...basis, pricingDigest: pricingBasisDigest(basis) };
}

/**
 * Resolve the pricing basis from ONE injected environment.
 *
 * Order: an operator declaration for exactly this endpoint+model; else the
 * committed provider rate card, which covers ONLY the first-party default
 * endpoint and the models it lists. A declaration that is PRESENT but invalid is
 * returned as its own rejection — it never silently falls through to the rate
 * card, which would price the endpoint with a basis the operator did not declare.
 */
export function resolvePricingBasis(
  providerId: string,
  query: PriceQuery,
  env: Record<string, string | undefined>,
  nowMs: number = Date.now(),
  envSource: "injected" | "process_env" = "injected",
): PricingResolution {
  const modelId = query.modelId ?? DEFAULT_REAL_MODEL_ID;
  const endpointBaseUrl = normalizeEndpointBaseUrl(query.endpointBaseUrl ?? null);
  const requiredTokenCeiling = query.requiredTokenCeiling ?? null;

  if (providerId === STUB_PROVIDER_ID) {
    return {
      ok: true,
      basis: withDigest({
        basisKind: "unbilled_stub",
        usdMicrosPerCall: 0,
        sourceKind: null,
        envSource,
        source: "stub provider: no externally-billed call is made",
        currency: SUPPORTED_PRICING_CURRENCY,
        isConservativeUpperBound: false,
        providerId,
        modelId,
        endpointBaseUrl,
        coverage: { coveredTokenCeiling: null, requiredTokenCeiling, perClassRates: null },
        validity: { kind: "unspecified", issuedAt: null, expiresAt: null, checkedAtMs: nowMs },
      }),
    };
  }
  if (providerId !== REAL_PROVIDER_ID) {
    return { ok: false, reason: "provider_unknown", detail: `provider ${JSON.stringify(providerId)} has no pricing basis` };
  }

  const parsed = parseDeclaredPricingStrict(env[DECLARED_PRICING_ENV]);
  if (parsed.ok) {
    const declared = parsed.value;
    const ceiling = declared.baseUrl === endpointBaseUrl ? effectivePerCallCeiling(modelId, declared) : null;
    // A VALID declaration that does not cover THIS endpoint+model is not a verdict
    // about the run — it simply does not apply — so resolution continues with the
    // provider rate card. A declaration that DOES cover the query is authoritative
    // for it: expired, not-yet-valid or too-small is a refusal, never a silent
    // fallback to a basis the operator did not declare.
    if (ceiling !== null) {
      if (declared.coveredTokenCeiling !== null && requiredTokenCeiling !== null && requiredTokenCeiling > declared.coveredTokenCeiling) {
        return {
          ok: false,
          reason: "insufficient_token_coverage",
          detail: `the declaration covers ${declared.coveredTokenCeiling} tokens but the request ceiling is ${requiredTokenCeiling}`,
        };
      }
      if (declared.issuedAt !== null && declared.expiresAt !== null) {
        const issuedMs = Date.parse(declared.issuedAt);
        const expiresMs = Date.parse(declared.expiresAt);
        if (nowMs >= expiresMs) {
          return {
            ok: false,
            reason: "expired",
            detail: `the declaration expired at ${declared.expiresAt} (checked at ${new Date(nowMs).toISOString()})`,
          };
        }
        if (nowMs < issuedMs) {
          return {
            ok: false,
            reason: "not_yet_valid",
            detail: `the declaration is not valid until ${declared.issuedAt} (checked at ${new Date(nowMs).toISOString()})`,
          };
        }
      }
      return {
        ok: true,
        basis: withDigest({
          basisKind: "operator_declared",
          usdMicrosPerCall: ceiling,
          sourceKind: "operator_declared",
          envSource,
          source: declared.source,
          currency: declared.currency,
          isConservativeUpperBound: true,
          providerId,
          modelId,
          endpointBaseUrl,
          coverage: {
            coveredTokenCeiling: declared.coveredTokenCeiling,
            requiredTokenCeiling,
            perClassRates: declared.perClassRates,
          },
          validity: {
            kind: declared.mode === "v2_windowed" ? "windowed" : "unspecified",
            issuedAt: declared.issuedAt,
            expiresAt: declared.expiresAt,
            checkedAtMs: nowMs,
          },
        }),
      };
    }
  }
  if (!parsed.ok && parsed.reason !== "absent") return parsed;

  // No declaration: the provider's own published rate card, first-party only.
  if (endpointBaseUrl !== null) {
    return {
      ok: false,
      reason: "endpoint_mismatch",
      detail: `the provider rate card covers only the first-party endpoint; ${JSON.stringify(endpointBaseUrl)} must be declared in ${DECLARED_PRICING_ENV}`,
    };
  }
  if (nowMs >= PRICING_SNAPSHOT_V1.invalidatedAtMs) {
    return {
      ok: false,
      reason: "snapshot_expired",
      detail: `the provider rate card was void after ${new Date(PRICING_SNAPSHOT_V1.invalidatedAtMs).toISOString()}`,
    };
  }
  const bound = PRICING_SNAPSHOT_V1.requestBoundByModel[modelId];
  if (typeof bound !== "number") {
    return { ok: false, reason: "model_not_declared", detail: `the provider rate card does not list model ${JSON.stringify(modelId)}` };
  }
  if (requiredTokenCeiling !== null && requiredTokenCeiling > PRICING_SNAPSHOT_V1.coveredTokenCeiling) {
    return {
      ok: false,
      reason: "insufficient_token_coverage",
      detail: `the rate card covers ${PRICING_SNAPSHOT_V1.coveredTokenCeiling} tokens but the request ceiling is ${requiredTokenCeiling}`,
    };
  }
  return {
    ok: true,
    basis: withDigest({
      basisKind: "provider_verified",
      usdMicrosPerCall: bound,
      sourceKind: "provider_verified",
      envSource,
      source: PRICING_SNAPSHOT_V1.source,
      currency: PRICING_SNAPSHOT_V1.currency,
      isConservativeUpperBound: false,
      providerId,
      modelId,
      endpointBaseUrl,
      coverage: {
        coveredTokenCeiling: PRICING_SNAPSHOT_V1.coveredTokenCeiling,
        requiredTokenCeiling,
        perClassRates: null,
      },
      validity: {
        kind: "snapshot",
        issuedAt: new Date(PRICING_SNAPSHOT_V1.issuedAtMs).toISOString(),
        expiresAt: new Date(PRICING_SNAPSHOT_V1.invalidatedAtMs).toISOString(),
        checkedAtMs: nowMs,
      },
    }),
  };
}

/**
 * The declared bound for THIS query, or `null` (legacy surface).
 *
 * `env` is an explicit parameter — the declaration is never read from the global
 * `process.env` behind an injected-identity caller's back. The default exists
 * only so pre-R4 callers keep compiling.
 */
export function resolveDeclaredUsdMicrosPerCall(
  query: PriceQuery = {},
  env: Record<string, string | undefined> = process.env,
  nowMs: number = Date.now(),
): number | null {
  const parsed = parseDeclaredPricingStrict(env[DECLARED_PRICING_ENV]);
  if (!parsed.ok) return null;
  const declared = parsed.value;
  if (declared.baseUrl !== normalizeEndpointBaseUrl(query.endpointBaseUrl ?? null)) return null;
  if (declared.issuedAt !== null && declared.expiresAt !== null && nowMs >= Date.parse(declared.expiresAt)) return null;
  const modelId = query.modelId ?? DEFAULT_REAL_MODEL_ID;
  return effectivePerCallCeiling(modelId, declared);
}

/**
 * The observed per-call price for a provider/model/endpoint, or `null` when it
 * cannot be established. The stub makes no externally-billed call, so its price
 * is a genuinely observable `0`.
 *
 * `env` is an explicit parameter (R4/F5): the price must be resolved from the
 * SAME environment as the rest of the execution identity. The default preserves
 * the pre-R4 call shape; the production identity path passes its injected env.
 */
export function resolveUsdMicrosPerCall(
  providerId: string,
  query: PriceQuery = {},
  env?: Record<string, string | undefined>,
  nowMs: number = Date.now(),
): number | null {
  const resolved = resolvePricingBasis(
    providerId,
    query,
    env ?? process.env,
    nowMs,
    env === undefined ? "process_env" : "injected",
  );
  return resolved.ok ? resolved.basis.usdMicrosPerCall : null;
}

/* ── R4/F5: the pricing DIGEST bound by prereg / authorization / journal ──── */

export interface PricingDrift {
  drifted: boolean;
  code: "NONE" | "PRICING_UNKNOWN" | "PRICING_DIGEST_DRIFT";
  detail: string;
  boundPricingDigest: string;
  observedPricingDigest: string | null;
}

/**
 * Compare the `pricingDigest` a pre-registration/authorization/journal bound
 * against the basis observed NOW.
 *
 * This is the check that `maxUsdMicros` alone cannot make: two bases with the
 * SAME amount but a different source, model, endpoint, currency, ceiling or
 * validity window produce different digests, so swapping the pricing basis
 * invalidates the old approval instead of inheriting it. An unpriceable run is
 * `PRICING_UNKNOWN` (the caller must construct no provider: providerFactory = 0).
 */
export function detectPricingDrift(
  boundPricingDigest: string | null | undefined,
  current: PricingResolution,
): PricingDrift {
  const bound = boundPricingDigest ?? "";
  if (!current.ok) {
    return {
      drifted: true,
      code: "PRICING_UNKNOWN",
      detail: `the run cannot be priced (${current.reason}): ${current.detail}`,
      boundPricingDigest: bound,
      observedPricingDigest: null,
    };
  }
  if (bound === "") {
    return {
      drifted: true,
      code: "PRICING_UNKNOWN",
      detail: "no pricing basis was bound by the pre-registration",
      boundPricingDigest: "",
      observedPricingDigest: current.basis.pricingDigest,
    };
  }
  if (bound !== current.basis.pricingDigest) {
    return {
      drifted: true,
      code: "PRICING_DIGEST_DRIFT",
      detail: `the pricing basis changed (amount/source/model/endpoint/currency/ceiling/validity): bound ${bound} != observed ${current.basis.pricingDigest}`,
      boundPricingDigest: bound,
      observedPricingDigest: current.basis.pricingDigest,
    };
  }
  return {
    drifted: false,
    code: "NONE",
    detail: "the pricing basis is unchanged",
    boundPricingDigest: bound,
    observedPricingDigest: current.basis.pricingDigest,
  };
}

/* ── R4/F5: read-only inspection (credentials redacted, budget SHOWN) ─────── */

/** Redact an endpoint for display: strip userinfo and mask credential-shaped
 *  query parameters. The raw endpoint is never printed by the inspector. */
export function redactEndpointForDisplay(baseUrl: string | null | undefined): string {
  if (baseUrl === null || baseUrl === undefined || baseUrl.trim() === "") return "(provider default endpoint)";
  const withoutUserInfo = baseUrl.replace(/\/\/[^/@\s]*@/g, "//");
  return withoutUserInfo.replace(
    /([?&](?:api[-_]?key|key|token|access[-_]?token|secret|password)=)[^&#\s]*/gi,
    "$1<redacted>",
  );
}

const microsToUsd = (micros: number): string => (micros / 1_000_000).toFixed(6);

export interface PricingInspectionInput {
  providerId: string;
  query?: PriceQuery;
  /** The SAME injected environment the identity used. */
  env: Record<string, string | undefined>;
  nowMs?: number;
  /** The campaign's model-call allowance, for the worst-case budget line. */
  maxModelCalls?: number | null;
  /** The digest bound by the pre-registration, when one exists. */
  boundPricingDigest?: string | null;
}

/**
 * The read-only pricing inspection: source LEVEL, the budget computation and the
 * digest — with credentials redacted and the actual provider cost explicitly
 * `NOT_OBSERVED` for a declared basis (a declared ceiling is not an invoice).
 */
export function describePricingInspection(input: PricingInspectionInput): string[] {
  const query = input.query ?? {};
  const nowMs = input.nowMs ?? Date.now();
  const resolution = resolvePricingBasis(input.providerId, query, input.env, nowMs);
  const drift = detectPricingDrift(input.boundPricingDigest ?? null, resolution);

  if (!resolution.ok) {
    return [
      "pricing source level: NONE (no reviewable source) — the run cannot be priced",
      `pricing rejection: ${resolution.reason}`,
      `  ${resolution.detail}`,
      `endpoint: ${redactEndpointForDisplay(query.endpointBaseUrl ?? null)}`,
      `model: ${query.modelId ?? DEFAULT_REAL_MODEL_ID}`,
      `pricing drift: ${drift.code} — ${drift.detail}`,
      "provider calls: 0 (refused before any provider construction)",
      "actual provider cost: NOT_OBSERVED",
    ];
  }

  const basis = resolution.basis;
  const level =
    basis.basisKind === "unbilled_stub"
      ? "unbilled_stub (no externally-billed call)"
      : basis.sourceKind === "operator_declared"
        ? "operator_declared (CONSERVATIVE UPPER BOUND — not a provider invoice)"
        : "provider_verified (provider-published rate card)";
  const lines = [
    `pricing source level: ${level}`,
    `endpoint: ${redactEndpointForDisplay(query.endpointBaseUrl ?? null)}`,
    `model: ${basis.modelId}`,
    `currency: ${basis.currency}`,
    `per-call bound: ${microsToUsd(basis.usdMicrosPerCall)} USD (${basis.usdMicrosPerCall} µUSD)`,
    `covered token ceiling: ${basis.coverage.coveredTokenCeiling ?? "unspecified"}${
      basis.coverage.requiredTokenCeiling !== null ? ` (request ceiling ${basis.coverage.requiredTokenCeiling})` : ""
    }`,
  ];
  if (input.maxModelCalls !== null && input.maxModelCalls !== undefined) {
    const worstCase = basis.usdMicrosPerCall * input.maxModelCalls;
    lines.push(
      `budget computation: ${input.maxModelCalls} model calls x ${microsToUsd(basis.usdMicrosPerCall)} USD = ${microsToUsd(worstCase)} USD ${
        basis.isConservativeUpperBound ? "(operator-declared CEILING — an upper bound, not an observed actual)" : "(provider rate-card bound)"
      }`,
    );
  }
  lines.push(
    `validity: ${basis.validity.kind}${
      basis.validity.issuedAt !== null ? ` ${basis.validity.issuedAt} → ${basis.validity.expiresAt}` : " (no expiry claimed)"
    }, checked at ${new Date(nowMs).toISOString()}`,
    `pricingDigest: ${basis.pricingDigest}`,
    `bound pricingDigest: ${input.boundPricingDigest ?? "(none)"}`,
    `pricing drift: ${drift.code} — ${drift.detail}`,
    "actual provider cost: NOT_OBSERVED",
  );
  return lines;
}