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
  PREFLIGHT_ESTIMATE,
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
 * A VERSIONED per-call USD ceiling. The single source is the benchmark
 * preflight's conservative `costPerCallUsd` (a worst-case planning ceiling, not
 * a claim) — see `PREFLIGHT_ESTIMATE`. Rounding to micro-USD keeps the value an
 * integer, as the observation type requires.
 *
 * A2 — `usdMicrosPerCall` is read LAZILY (a getter) rather than at module-eval
 * time: `benchmark-command.ts` and this module sit on a module cycle (the CLI
 * entry point imports the prereg command, which imports the benchmark factory),
 * so a top-level `PREFLIGHT_ESTIMATE` read would hit the temporal dead zone and
 * crash every entry that loads `main`. The getter defers the read until after
 * all modules are initialized.
 */
export const PRICING_SNAPSHOT_V1 = {
  version: "pricing-snapshot-v1",
  source: "apps/cli/src/benchmark-command.ts PREFLIGHT_ESTIMATE.costPerCallUsd (conservative per-call planning ceiling)",
  get usdMicrosPerCall(): number {
    return Math.round(PREFLIGHT_ESTIMATE.costPerCallUsd * 1_000_000);
  },
} as const;

/**
 * The observed per-call price for a provider, or `null` when it cannot be
 * established. The stub makes no externally-billed call, so its price is a
 * genuinely observable `0`; any other provider without a snapshot entry is
 * `null` (unknown), which the money-bounded gate refuses as `PRICING_UNKNOWN`.
 */
export function resolveUsdMicrosPerCall(providerId: string): number | null {
  if (providerId === STUB_PROVIDER_ID) return 0;
  if (providerId === REAL_PROVIDER_ID) return PRICING_SNAPSHOT_V1.usdMicrosPerCall;
  return null;
}