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
export const PRICING_SNAPSHOT_V1 = {
  version: "pricing-snapshot-v2",
  source: "provider published rate card (list price, highest tier), recorded out of band in docs/evidence",
  invalidatedAtMs: 1_893_456_000_000, // 2030-01-01T00:00:00Z — after this the bound is void
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

export interface PriceQuery {
  /** The model the run will actually use; defaults to the first-party model. */
  modelId?: string;
  /** The explicit base URL, or `null`/absent for the provider default endpoint. */
  endpointBaseUrl?: string | null;
}

/**
 * The observed per-call price for a provider/model/endpoint, or `null` when it
 * cannot be established. The stub makes no externally-billed call, so its price
 * is a genuinely observable `0`. A real provider is priced ONLY when the
 * snapshot is current AND the request targets the FIRST-PARTY endpoint AND the
 * model has a published bound; a proxy endpoint or an unlisted model is `null`
 * (unknown), which the money-bounded gate refuses as `PRICING_UNKNOWN`.
 */
export function resolveUsdMicrosPerCall(providerId: string, query: PriceQuery = {}): number | null {
  if (providerId === STUB_PROVIDER_ID) return 0;
  if (providerId !== REAL_PROVIDER_ID) return null;
  if (!pricingSnapshotValid()) return null;
  const baseUrl = query.endpointBaseUrl ?? null;
  if (baseUrl !== null && baseUrl !== "") {
    // A proxy/gateway's billing terms are not this snapshot's to claim.
    return null;
  }
  const modelId = query.modelId ?? DEFAULT_REAL_MODEL_ID;
  const bound = PRICING_SNAPSHOT_V1.requestBoundByModel[modelId];
  return typeof bound === "number" ? bound : null;
}