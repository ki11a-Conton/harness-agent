/**
 * N4 — pricing expiry must gate EVERY physical send and retry.
 * plan(20260930-061557).md §7 (F30-5).
 *
 * WHY THIS FILE EXISTS (read this before judging the tests)
 * ---------------------------------------------------------
 * S5/R4 separated PARSING a price from being ELIGIBLE to EXECUTE it, and added
 * `decidePhysicalSend`. That is a pure function. The plan names the exact failure
 * mode this task exists to prevent: "a test of `decidePhysicalSend`'s return
 * object alone does NOT satisfy this task".
 *
 * So EVERY test here drives the REAL production wrapper
 * `createFormalBudgetedProvider(...).provider.createClient(...).generate(...)`.
 * Assertions are on OBSERVABLE behaviour of that path:
 *   - how many times the fake transport was ENTERED (a real send),
 *   - what the cost budget actually reserved/charged,
 *   - what the call ledger recorded,
 *   - which error type escaped.
 *
 * The production wrapper is called with the SAME frozen, re-observed basis that
 * admission would pass (`pricingGuard`), and a fake clock that advances between
 * attempts — the "valid at admission, expired at the second send or retry"
 * scenario, expressed on the real send chokepoint.
 *
 * SAFETY: zero network. The transport is an in-process async generator; no key is
 * read, no endpoint is contacted, no paid request exists.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelEvent, ModelProvider, ModelRequest, ProviderConfig, ModelRef } from "@ar/contracts";
import { DEFAULT_DECISION_POLICY_V3 } from "./decision-policy-v3.js";
import {
  TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
  buildToolCallEfficiencyPreregistrationV2,
  type PreregCatalogEntryV2,
  type PreregistrationV2Options,
} from "./tool-call-efficiency-preregistration-v2.js";
import {
  PRICING_WINDOW_EXPIRED,
  CostBudget,
  createFormalBudgetedProvider,
  type FormalBudgetStats,
  type PricingExecutionGuard,
} from "./tool-call-efficiency-formal-run.js";
import { openR97BudgetLedger } from "./r97-budget-ledger.js";

const SHA_A = "a".repeat(40);
const CASE_IDS = ["reg-01", "reg-02", "reg-06", "reg-08", "adv-03", "adv-07", "st-02", "st-05"];
const REQUEST_PROFILE = { budgetTokens: 32000, stallPolicy: "default" };

const CATALOG: PreregCatalogEntryV2[] = CASE_IDS.map((caseId) => ({
  caseId,
  suite: "regression",
  contentDigest: `content-${caseId}`,
  eligibilityDigest: `elig-${caseId}`,
  holdout: false,
  eligible: true,
}));

function preregOptions(): PreregistrationV2Options {
  return {
    subject: {
      candidateSourceSha: SHA_A,
      baselineArmDigest: "baseline-arm-digest",
      candidateArmDigest: "candidate-arm-digest",
      cleanTreePolicy: "require-clean",
      runtimeConfigDigest: "runtime-config-digest",
    },
    candidateId: TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
    provider: {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      endpointBaseUrl: "https://api.example.com/v1",
      requestProfile: REQUEST_PROFILE,
    },
    catalog: CATALOG,
    schedule: { repetitions: 2, orderSeed: 7 },
    selection: {
      caseIds: [...CASE_IDS],
      selectionRule: "R87 frozen dev-set selection",
      selectionProvenanceDigest: "r87-selection-digest",
      holdoutPolicy: "holdout is never read",
    },
    suiteId: "tool-call-efficiency",
    suiteVersion: "1.0.0",
    evaluation: {
      judgeId: "judge-1",
      judgeDigest: "judge-digest",
      verifierDigest: "verifier-digest",
      scorerDigest: "scorer-digest",
      decisionPolicy: { ...DEFAULT_DECISION_POLICY_V3 },
    },
    budget: {
      maxModelCallsPerRun: 30,
      maxToolCalls: 100,
      maxDurationMs: 600_000,
      maxInputTokens: 320_000,
      maxOutputTokens: 64_000,
      maxTotalTokens: 384_000,
      maxUsdMicros: 5_000_000,
      pricingUnknownPolicy: "refuse",
    },
    isolation: {
      driverSchema: "r97-driver-v1",
      workerSchema: "r97-worker-v1",
      isolationBackendId: "process-exec",
      isolationStrength: "process",
      resumeStateSchema: "r97-execution-state-v1",
    },
  };
}

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "n4-price-send-"));
  dirs.push(d);
  return d;
}

const PREVIOUS_CLAIMS_DIR = process.env["R97_CAMPAIGN_CLAIMS_DIR"];
beforeEach(async () => {
  process.env["R97_CAMPAIGN_CLAIMS_DIR"] = await mkdtemp(join(tmpdir(), "n4-claims-"));
});
afterEach(async () => {
  if (PREVIOUS_CLAIMS_DIR === undefined) delete process.env["R97_CAMPAIGN_CLAIMS_DIR"];
  else process.env["R97_CAMPAIGN_CLAIMS_DIR"] = PREVIOUS_CLAIMS_DIR;
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

/** The envelope the operator's price must cover for one physical attempt. */
const ENVELOPE = { inputTokens: 32_000, outputTokens: 32_000 };
const AMOUNT = 1_000_000;

/** Iterate an array index with a `null` (absent) guard. */
function at<T>(xs: readonly T[], i: number): T {
  const v = xs[i];
  if (v === undefined) throw new Error(`fixture has no element ${i}`);
  return v;
}

/**
 * A frozen, re-observed pricing basis presented as the production execution
 * guard. It is deliberately a FLAT value object: it is captured ONCE (at
 * admission) and never re-resolved from the environment, so an expiry cannot be
 * "refreshed" by a later read.
 */
function guard(over: Partial<PricingExecutionGuard> = {}): PricingExecutionGuard {
  return {
    amountUsdMicros: AMOUNT,
    basisDigest: "d".repeat(64),
    sourceKind: "operator_declared",
    currency: "USD",
    issuedAtMs: Date.parse("2026-09-01T00:00:00.000Z"),
    expiresAtMs: Date.parse("2026-09-02T00:00:00.000Z"),
    coveredTokenCeiling: 64_000,
    requiredTokenCeiling: ENVELOPE.inputTokens + ENVELOPE.outputTokens,
    ...over,
  };
}

/**
 * A real in-process transport that COUNTS entries. `entered` is the number of
 * physical sends that actually left — the load-bearing counter for this task.
 *
 * `scripts` is consumed by call order: each entry is one `generate()` invocation
 * (the initial request or a resumed new request). Within one invocation the
 * generator may emit `retry` events, which are the wrapper's own retry path.
 */
function countingTransport(
  scripts: Array<{ retries: number; usageUsd?: number }>,
  onRetry?: () => void,
): {
  provider: ModelProvider;
  sends: number;
  attempts: number;
} {
  const state = { sends: 0, attempts: 0 };
  const provider: ModelProvider = {
    id: "n4-price-fake",
    async listModels() {
      return [];
    },
    createClient() {
      return {
        async *generate(): AsyncGenerator<ModelEvent> {
          // A physical send: count it the instant the transport is entered, so a
          // refusal that happens BEFORE this line is provably "0 sends".
          state.sends += 1;
          const callIndex = state.sends - 1;
          state.attempts += 1;
          const script = scripts[callIndex] ?? { retries: 0 };
          for (let r = 0; r < script.retries; r += 1) {
            // The client emits `retry` immediately BEFORE the next fetch, exactly
            // as the real clients do; the wrapper must decide whether it may leave.
            // `onRetry` is where a test advances the fake clock, so the price can
            // expire BETWEEN the initial send and this retry.
            if (onRetry) onRetry();
            yield { type: "retry", attempt: r + 1, reason: "transport" } as never;
          }
          const usd = script.usageUsd ?? 0;
          if (usd > 0) {
            yield { type: "usage", usage: { inputTokens: 10, outputTokens: 10, estimatedCostUsd: usd } } as never;
          }
          yield { type: "completed", result: { finishReason: "stop" } as never, timestamp: 0 };
        },
      };
    },
  };
  return {
    provider,
    get sends() {
      return state.sends;
    },
    get attempts() {
      return state.attempts;
    },
  };
}

interface DrainResult {
  stats: FormalBudgetStats;
  error: unknown;
  budget: CostBudget;
  sends: number;
}

/**
 * N4 — EVERY independent drain gets its own authorization identity.
 *
 * The R97 ledger deliberately refuses to let ONE authorization establish two live
 * campaigns (`BUDGET_CAMPAIGN_DIR_DUPLICATE`), because that would grant a second
 * allowance for one approval. That is a production guarantee, so tests must not
 * "fix" it by reusing a digest across unrelated observations: each drain below is
 * a separate admission and therefore carries its own plan digest. A test that
 * genuinely wants to model a RESUME passes the SAME dir and `mode: "resume"`.
 */
let authorizationCounter = 0;
function nextPlanDigest(): string {
  authorizationCounter += 1;
  return authorizationCounter.toString(16).padStart(64, "0");
}

/**
 * Drive the REAL production wrapper once. `now` is a fake clock so a test can
 * advance time BETWEEN attempts.
 */
async function drain(
  transport: { provider: ModelProvider },
  opts: {
    dir: string;
    now: () => number;
    pricingGuard?: PricingExecutionGuard | null;
    usdMicrosPerCall?: number | null;
    deadlineAtMs?: number | null;
    mode?: "first-run" | "resume" | "auto";
    /** Reuse a prior drain's authorization identity ⇒ a genuine RESUME. */
    planDigest?: string;
  },
): Promise<DrainResult> {
  const artifact = buildToolCallEfficiencyPreregistrationV2(preregOptions());
  const planDigest = opts.planDigest ?? nextPlanDigest();
  const budget = await CostBudget.open(opts.dir, artifact, {
    allowCreate: (opts.mode ?? "first-run") !== "resume",
  });
  const ledger = await openR97BudgetLedger(opts.dir, {
    planDigest,
    campaignModelCalls: 100,
    mode: opts.mode ?? "first-run",
  });
  const { provider: wrapped, stats } = createFormalBudgetedProvider({
    provider: transport.provider,
    ledger,
    costBudget: budget,
    arm: "candidate",
    usdMicrosPerCall: opts.usdMicrosPerCall ?? AMOUNT,
    deadlineAtMs: opts.deadlineAtMs ?? null,
    now: opts.now,
    pricingGuard: opts.pricingGuard ?? null,
  });
  const client = wrapped.createClient(
    { providerId: "n4-price-fake", modelId: "m" } as ModelRef,
    {} as ProviderConfig,
  );
  let error: unknown = null;
  try {
    for await (const _ev of client.generate({} as ModelRequest, new AbortController().signal)) {
      // drain
    }
  } catch (err) {
    error = err;
  }
  return { stats, error, budget, sends: (transport as { sends?: number }).sends ?? 0 };
}

describe("N4/F30-5 — a price VALID at admission that EXPIRES before a send", () => {
  it("N4.1 the first physical send is REFUSED when the price is already expired at send time", async () => {
    const dir = await tempDir();
    const t = countingTransport([{ retries: 0 }]);
    const nowMs = Date.parse("2026-09-03T00:00:00.000Z"); // past expiresAt
    const { error, stats, budget } = await drain(t, { dir, now: () => nowMs, pricingGuard: guard() });

    expect(t.sends).toBe(0); // no physical send left the process
    expect(stats.logicalCalls).toBe(0);
    expect(String(error)).toContain(PRICING_WINDOW_EXPIRED);
    expect(budget.view().reserved.usdMicros).toBe(0);
  });

  it("N4.2 valid at admission, EXPIRED when the retry is about to leave: the retry never becomes a second send", async () => {
    const dir = await tempDir();
    // The transport emits ONE retry. The clock is INSIDE the window while the
    // initial send happens and only crosses expiry when that retry is emitted —
    // the exact "valid at admission, expired at the retry" trigger.
    const expiresAtMs = Date.parse("2026-09-01T13:00:00.000Z");
    const clock = { ms: Date.parse("2026-09-01T12:00:00.000Z") };
    // The clock crosses expiry EXACTLY when the retry is emitted — i.e. the price
    // was valid while the initial send was in flight and is not valid any more by
    // the time the retry would leave.
    const t = countingTransport([{ retries: 1 }], () => {
      clock.ms = Date.parse("2026-09-01T13:00:00.000Z");
    });
    const { error, stats, budget } = await drain(t, {
      dir,
      now: () => clock.ms,
      pricingGuard: guard({ expiresAtMs }),
    });

    // Exactly ONE physical send happened: the retry was refused before it left.
    expect(t.sends).toBe(1);
    expect(String(error)).toContain(PRICING_WINDOW_EXPIRED);
    // The refusal is classified as PRICING, not as a provider/transport error, so
    // it can never be swallowed and re-driven by an outer retry loop.
    expect(String(error)).toContain("E4-N4");
    expect(stats.pricingRefusedCalls).toBe(1);
    // No SECOND call-ledger reservation was taken for the refused retry: the
    // reservation count stayed at the single dispatched attempt.
    expect(stats.logicalCalls).toBe(1);
    // The FIRST attempt was dispatched ⇒ settled conservatively, never refunded.
    expect(budget.view().charged.usdMicros).toBeGreaterThan(0);
  });

  it("N4.3 a price that expires BEFORE admission is refused and never reaches the wrapper", async () => {
    const dir = await tempDir();
    const t = countingTransport([{ retries: 0 }]);
    const { error } = await drain(t, {
      dir,
      now: () => Date.parse("2026-09-05T00:00:00.000Z"),
      pricingGuard: guard({ expiresAtMs: Date.parse("2026-09-02T00:00:00.000Z") }),
    });
    expect(t.sends).toBe(0);
    expect(String(error)).toContain(PRICING_WINDOW_EXPIRED);
  });

  it("N4.4 a price whose coverage is BELOW the request envelope is refused with its own code", async () => {
    const dir = await tempDir();
    const t = countingTransport([{ retries: 0 }]);
    const nowMs = Date.parse("2026-09-01T12:00:00.000Z");
    const { error } = await drain(t, {
      dir,
      now: () => nowMs,
      pricingGuard: guard({ coveredTokenCeiling: 1_000, requiredTokenCeiling: 64_000 }),
    });
    expect(t.sends).toBe(0);
    expect(String(error)).toContain("PRICING_COVERAGE_INSUFFICIENT");
  });

  it("N4.5 a price with NO windowed validity (legacy) is refused, not silently accepted", async () => {
    const dir = await tempDir();
    const t = countingTransport([{ retries: 0 }]);
    const { error } = await drain(t, {
      dir,
      now: () => Date.parse("2026-09-01T12:00:00.000Z"),
      pricingGuard: guard({ issuedAtMs: null, expiresAtMs: null }),
    });
    expect(t.sends).toBe(0);
    expect(String(error)).toContain("PRICING_NOT_EXECUTABLE");
  });

  it("N4.6 a basisDigest that does NOT match the reservation is identity drift, not a provider error", async () => {
    const dir = await tempDir();
    const t = countingTransport([{ retries: 0 }]);
    const nowMs = Date.parse("2026-09-01T12:00:00.000Z");
    const { error } = await drain(t, {
      dir,
      now: () => nowMs,
      pricingGuard: guard({ expectedBasisDigest: "e".repeat(64) }),
    });
    expect(t.sends).toBe(0);
    expect(String(error)).toContain("PRICING_BASIS_DRIFT");
  });

  it("N4.7 CONTROL: a valid unexpired window with sufficient coverage SENDS normally", async () => {
    const dir = await tempDir();
    const t = countingTransport([{ retries: 0, usageUsd: 0.0005 }]);
    const nowMs = Date.parse("2026-09-01T12:00:00.000Z");
    const { error, stats } = await drain(t, { dir, now: () => nowMs, pricingGuard: guard() });

    expect(error).toBeNull();
    expect(t.sends).toBe(1); // the control group really does send
    expect(stats.logicalCalls).toBe(1);
    expect(stats.chargedUsdMicros).toBeGreaterThan(0);
  });

  it("N4.8 boundary: valid 1 ms before expiry, refused exactly AT expiresAtMs", async () => {
    const expiresAtMs = Date.parse("2026-09-01T13:00:00.000Z");

    // Each arm of the boundary gets its OWN campaign directory: the R97 ledger
    // keys a campaign by its authorization, so two independent observations of the
    // same artifact may not share one durable budget unless the second RESUMES.
    const justBefore = countingTransport([{ retries: 0 }]);
    const ok = await drain(justBefore, {
      dir: await tempDir(),
      now: () => expiresAtMs - 1,
      pricingGuard: guard({ expiresAtMs }),
    });
    expect(ok.error).toBeNull();
    expect(justBefore.sends).toBe(1); // 1 ms before expiry is still executable

    const atExpiry = countingTransport([{ retries: 0 }]);
    const refused = await drain(atExpiry, {
      dir: await tempDir(),
      now: () => expiresAtMs,
      pricingGuard: guard({ expiresAtMs }),
    });
    expect(atExpiry.sends).toBe(0); // the expiry instant itself is NOT valid
    expect(String(refused.error)).toContain(PRICING_WINDOW_EXPIRED);
  });

  it("N4.9 a resumed NEW request after expiry is refused (the guard is re-checked, not cached)", async () => {
    const dir = await tempDir();
    const clock = { ms: Date.parse("2026-09-01T12:00:00.000Z") };
    const g = guard({ expiresAtMs: Date.parse("2026-09-01T13:00:00.000Z") });

    const first = countingTransport([{ retries: 0 }]);
    const planDigest = "a".repeat(64);
    const r1 = await drain(first, { dir, now: () => clock.ms, pricingGuard: g, planDigest });
    expect(r1.error).toBeNull();
    expect(first.sends).toBe(1);

    // The SAME durable campaign directory and the SAME authorization, resumed.
    // The clock has moved past expiry, so the resumed run's first physical send
    // must be refused. This is the case a value cached at admission would let
    // through.
    clock.ms = Date.parse("2026-09-01T14:00:00.000Z");
    const second = countingTransport([{ retries: 0 }]);
    const r2 = await drain(second, {
      dir,
      now: () => clock.ms,
      pricingGuard: g,
      mode: "resume",
      planDigest,
    });
    expect(second.sends).toBe(0);
    expect(r2.stats.logicalCalls).toBe(0);
    expect(String(r2.error)).toContain(PRICING_WINDOW_EXPIRED);
  });
});
