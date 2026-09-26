/**
 * B0 — RED counterexamples for the NEXT round's gaps (G1, G4, G7), CLI side.
 *
 * WHY THIS FILE EXISTS (plan(20260926-070459).md §B0)
 * ---------------------------------------------------
 * B0 turns each remaining gap into an OFFLINE, INDIVIDUALLY RUNNABLE
 * counterexample that FAILS on the audited HEAD (3ff8946) and becomes GREEN only
 * when its task (B2/B3/B5) actually closes it. This file is NOT part of the
 * green regression: it is EXCLUDED from the root vitest `include` and selected
 * by `apps/cli/test-infra/red-next-gaps-vitest.config.ts`, so `pnpm test` keeps
 * passing while the counterexamples stay individually runnable.
 *
 * SAFETY: zero network, zero provider, zero cost. G4 is a pure price/resolution
 * computation; G1/G7 are structural contract pins over the shipped sources —
 * they read bytes, they never run a child process or touch a key.
 *
 *   G1  the arm executor computes two checkout digests and then runs the DRIVER
 *       process's `runOneCase` with a `candidate` flag; the arm's own frozen
 *       build is never executed. Post-B3 an isolated stdio/IPC worker must run
 *       the arm build, and the synthetic `export {};` checkout must leave the
 *       production-ready path.
 *   G4  `usdMicrosPerCall` is ONE planning scalar (`PREFLIGHT_ESTIMATE`) applied
 *       to EVERY real provider/model/endpoint; it is not a versioned, traceable,
 *       per-model/endpoint bound with an invalidation window.
 *   G7  the full forward schedule in the production E2E is in-process with a
 *       fake provider; the release CLI subprocess only proves refusals and
 *       build/validate. The aggregate is fed injected fake counts and the
 *       INITIAL worst-case budget as if they were the durable ledger.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FORMAL_PER_CALL_INPUT_TOKEN_CEILING } from "@ar/evaluation";
import {
  PRICING_SNAPSHOT_V1,
  resolveUsdMicrosPerCall,
} from "./prereg-execution-identity.js";
import { observeExecutionIdentity } from "./prereg-production-runner.js";
import { REAL_PROVIDER_ID, STUB_PROVIDER_ID, DEFAULT_REAL_MODEL_ID } from "./provider.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function readSource(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

// ---------------------------------------------------------------------------
// G1 — the arms must execute their OWN frozen builds
// ---------------------------------------------------------------------------

describe("B0 RED — G1: the arms never run their own frozen builds", () => {
  it("[G1/B3] the arm executor must launch the arm's own build as an isolated worker (stdio/IPC child)", () => {
    // B3: "选一个 Windows/Ubuntu 均可运行的隔离 worker 协议（stdio/IPC）".
    // The executor today imports NO child-process/worker seam at all — it runs
    // the driver's `runOneCase` in-process. A build that is never launched is
    // not proven to have run.
    const src = readSource("apps/cli/src/prereg-arm-executor.ts");
    expect(/from "node:child_process"|from "node:worker_threads"|require\("node:child_process"\)/.test(src)).toBe(true);
  });

  it("[G1/B3] the production E2E must not synthesize an arm build from `export {}` stubs", () => {
    // B3: "不能再用 export {}; // arm:* 合成 checkout 证明双构建已运行".
    const src = readSource("scripts/e4/prereg-production-e2e.mjs");
    expect(src).not.toMatch(/export \{\}; \/\/ arm:/);
  });
});

// ---------------------------------------------------------------------------
// G4 — pricing must be a versioned, model/endpoint-bound bound, not one scalar
// ---------------------------------------------------------------------------

describe("B0 RED — G4: the per-call USD ceiling is one planning scalar, not a bound", () => {
  it("[G4/B2] the pricing snapshot must be a versioned per-model/endpoint source with an invalidation window", () => {
    const snapshot = PRICING_SNAPSHOT_V1 as unknown as Record<string, unknown>;
    // B2: "按 provider、model、端点与计费类别建立版本化、可追溯的实际最高费率/请求上界与失效条件".
    expect(Object.keys(snapshot)).toEqual(
      expect.arrayContaining(["invalidatedAtMs", "requestBoundByModel"]),
    );
    // ...and it must be an EXTERNAL, traceable price source, not the local planner.
    expect(String(snapshot.source)).not.toMatch(/planning|estimate/i);
  });

  it("[G4/B2] the per-call USD ceiling must dominate the worst case implied by the per-call token ceilings", () => {
    // Computable counterexample: the reservation ceiling is per-call tokens, so a
    // worst-case call is formattable from the per-call token ceiling and a
    // published per-million-token rate. The fixed scalar cannot cover the model
    // it is supposed to bound.
    const perCallTokens = FORMAL_PER_CALL_INPUT_TOKEN_CEILING * 2; // input + output ceiling
    const ratePerMillionUsd = 15; // a published frontier-model order of magnitude
    const worstCaseUsd = (perCallTokens / 1_000_000) * ratePerMillionUsd;
    const boundUsd = PRICING_SNAPSHOT_V1.usdMicrosPerCall / 1_000_000;
    expect(boundUsd).toBeGreaterThanOrEqual(worstCaseUsd);
  });

  it("[G4/B2] an unknown (proxy) endpoint must not be priced as if it were the default endpoint", () => {
    // The unbilled stub is a genuinely observable 0.
    expect(resolveUsdMicrosPerCall(STUB_PROVIDER_ID)).toBe(0);
    // B2: the price must be bound to provider/model/ENDPOINT. The counterexample
    // holds the model fixed and varies ONLY the endpoint, so today's single
    // scalar (which ignores the endpoint entirely) returns the SAME value for
    // both — a paid path cannot claim a USD bound on a proxy whose billing terms
    // it never observed.
    const withProxy = observeExecutionIdentity(REPO_ROOT, {
      OPENAI_API_KEY: "TEST_ONLY-not-a-real-key",
      OPENAI_MODEL: DEFAULT_REAL_MODEL_ID,
      OPENAI_BASE_URL: "https://proxy.example.com/v1",
    });
    const withoutProxy = observeExecutionIdentity(REPO_ROOT, {
      OPENAI_API_KEY: "TEST_ONLY-not-a-real-key",
      OPENAI_MODEL: DEFAULT_REAL_MODEL_ID,
    });
    expect(withoutProxy.usdMicrosPerCall).not.toBeNull();
    expect(withProxy.usdMicrosPerCall).toBeNull();
    // An unlisted model is equally unknown (no arbitrary-model pricing).
    const unknownModel = observeExecutionIdentity(REPO_ROOT, {
      OPENAI_API_KEY: "TEST_ONLY-not-a-real-key",
      OPENAI_MODEL: "arbitrary-unlisted-model",
    });
    expect(unknownModel.usdMicrosPerCall).toBeNull();
    expect(resolveUsdMicrosPerCall(REAL_PROVIDER_ID)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// G7 — the release CLI subprocess must run the forward schedule; the aggregate
//      must read the durable ledger, not injected counts
// ---------------------------------------------------------------------------

describe("B0 RED — G7: the release CLI subprocess never runs the forward schedule", () => {
  it("[G7/B5] the forward execution must record its transport so in-process ≠ release-subprocess", () => {
    const src = readSource("scripts/e4/prereg-production-e2e.mjs");
    // B5: "另增 release CLI child process 的完整正向测试". A reader must be able to
    // tell the in-process fake from a real `node apps/cli/dist/main.js prereg run`
    // subprocess; today the positive execution has no transport/backend field.
    expect(/transport:\s*["']release-cli/.test(src) || /executionBackend:\s*["']release-cli/.test(src)).toBe(true);
  });

  it("[G7/B5] the aggregate must not be fed injected fake counts / the initial budget as the ledger", () => {
    // B5: "不向 aggregate 注入 fake.entered() 或初始 campaignWorstCaseModelCalls 当真实账本数".
    const src = readSource("scripts/e4/prereg-production-e2e.mjs");
    expect(src).not.toMatch(/providerCalls:\s*fake\.entered\(\)/);
    expect(src).not.toMatch(/budgetRemaining:\s*artifact\.budget\.campaignWorstCaseModelCalls/);
  });

  it("[G7/B6] productionOfflineReady must not claim the full forward schedule is proven by the in-process fake", () => {
    // B6: "把当前 productionOfflineReady=PASS 明确拆成：…当前进程 adapter 124-arm
    // fake 正向已证明；release CLI 正向双 worker 待 B3/B5 结果".
    const src = readSource("scripts/e4/prereg-production-e2e.mjs");
    expect(src).not.toMatch(/executes the full paired schedule through the shipped observer\+executor with a counting fake transport/);
  });
});