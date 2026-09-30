/**
 * N2 (F30-5) — THE PRICING GUARD IS **ARMED** ON THE RELEASE ENTRY POINT.
 *
 * THE N4 LEFTOVER THIS CLOSES
 * ---------------------------
 * `PricingExecutionGuard` and `checkPricingExecutionGuard` were proven inside
 * `packages/evaluation` but had ZERO references anywhere in `apps/cli/src`: the
 * send-boundary price check existed and was never armed by the shipped
 * composition root. A helper test proving the checker works is exactly what N4
 * said does NOT close this item ("只有 guard 对象存在不算闭环，helper 测试不算生产接线").
 *
 * WHAT IS MEASURED HERE, AND HOW
 * ------------------------------
 * The chain exercised is the SHIPPED one, driven from the release composition
 * root and the release command:
 *
 *   `preregCommandDeps(env)`                     ← CLI composition root, ONE selection
 *     → `openPreregisteredCampaignGate({ pricingGuard })`   ← `prereg run`'s own call
 *       → `createFormalBudgetedProvider({ pricingGuard })`  ← the send choke point
 *         → `checkPricingExecutionGuard(guard, clock())` before ANY reservation
 *
 * The three N4 acceptance facts, each asserted separately:
 *   1. the guard is the ONE the COMPOSITION ROOT built (`deps.selection.pricingGuard`
 *      — the same object, compared by identity, never re-constructed by the test);
 *   2. it is really reached by the gate: the refusal is the guard's own code, and
 *      removing it (the one-dimension control) changes the outcome;
 *   3. a campaign ADMITTED while the declared window was valid but a send that
 *      happens AFTER it expired is REFUSED with the counting transport at 0 —
 *      plus the CONTROL GROUP (same setup, clock not advanced) where the very
 *      same send really leaves, so this is a price decision and not a blanket
 *      refusal of everything.
 *
 * SHAPE / OFFLINE ACCOUNTING
 * --------------------------
 * This combination needs an EXECUTABLE, WINDOWED, non-stub price basis, which the
 * built-in offline profile deliberately does not have (`offline-scripted` →
 * `provider_unknown`; a real provider config + offline selection is a mandatory
 * refusal). So the selection used here is PAID-SHAPED: a declarative
 * `prereg-pricing-v2` window over a synthetic `.invalid` endpoint.
 *
 *   paid model requests sent to any real endpoint: 0   (the counting transport is
 *                                                       a plain local counter; the
 *                                                       endpoint host is `.invalid`,
 *                                                       which cannot resolve)
 *   external HTTP requests:                        0
 *   real credentials read:                         0
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelEvent, ModelProvider, ModelRef, ModelRequest, ProviderConfig } from "@ar/contracts";
import type { ToolCallEfficiencyPreregistrationV2 } from "@ar/evaluation";
import { preregCmd } from "./prereg-command.js";
import { preregCommandDeps, resolvePreregSelection } from "./main.js";
import { createProductionPreregRunner } from "./prereg-production-runner.js";
import { DECLARED_PRICING_ENV } from "./prereg-execution-identity.js";
import { N2_FORWARD_CASE, prepareIdentityRoot, prepareArmCheckout, removeFixture } from "./n2-forward-fixture.js";

const HOUR_MS = 3_600_000;
/** The instant admission runs at. Everything is derived from it, so the test does
 *  not depend on the wall clock being anywhere in particular. */
const T_ADMISSION = Date.now();
/** Declared validity: one hour around admission. */
const WINDOW_FROM = new Date(T_ADMISSION - HOUR_MS).toISOString();
const WINDOW_TO = new Date(T_ADMISSION + HOUR_MS).toISOString();
/** The send happens 2h after admission: past the declared expiry, still inside
 *  the campaign deadline (24h) and the authorization window. */
const T_AFTER_EXPIRY = T_ADMISSION + 2 * HOUR_MS;

const RELAY = "https://n2-priced-relay.invalid/v1";
const RELAY_MODEL = "n2-priced-model";
const DECLARED_AMOUNT_USD_MICROS = 1_000_000;

function declaration(): string {
  return JSON.stringify({
    schema: "prereg-pricing-v2",
    sourceKind: "operator_declared",
    source: "N2 combination test — synthetic declared rate; the endpoint cannot resolve",
    baseUrl: RELAY,
    currency: "USD",
    issuedAt: WINDOW_FROM,
    expiresAt: WINDOW_TO,
    coveredTokenCeiling: 64_000,
    ceilingByModel: { [RELAY_MODEL]: DECLARED_AMOUNT_USD_MICROS },
  });
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (d) => {
      try {
        removeFixture(d);
      } catch {
        await rm(d, { recursive: true, force: true });
      }
    }),
  );
});

/** ONE counting transport. It counts physical sends; it never dials anything. */
interface CountingTransport extends ModelProvider {
  sends: number;
  clientCalls: number;
}

function countingProvider(): CountingTransport {
  const provider: CountingTransport = {
    id: "openai",
    sends: 0,
    clientCalls: 0,
    async listModels() {
      return [{ id: RELAY_MODEL }];
    },
    createClient(_model: ModelRef, _config: ProviderConfig) {
      provider.clientCalls += 1;
      return {
        async *generate(request: ModelRequest): AsyncGenerator<ModelEvent, void, void> {
          void request;
          provider.sends += 1;
          yield { type: "started", timestamp: 0, id: "n2-evt" } as ModelEvent;
          yield { type: "completed", timestamp: 0, result: { finishReason: "stop", text: "n2 done" } } as ModelEvent;
        },
      };
    },
  };
  return provider;
}

interface Scenario {
  /** The refusal/errors the send boundary produced, verbatim. */
  sendErrors: string[];
  /** How many arm runs drove one physical send through the admitted provider. */
  sendAttempts: number;
  transport: CountingTransport;
  result: { exitCode: number; lines: string[] };
  artifact: ToolCallEfficiencyPreregistrationV2;
}

/**
 * Two real arm checkouts, so the observer can establish `baselineArmDigest` /
 * `candidateArmDigest` from DISK instead of reporting `UNOBSERVABLE` (which the
 * gate would refuse before any provider exists). They are never launched: this
 * test's arm driver is a counter, so the checkouts only have to be real enough
 * to be digested and to be a clean work tree.
 */
async function stubArms(): Promise<{ base: string; cand: string; baseDigest: string; candDigest: string }> {
  const root = await mkdtemp(join(tmpdir(), "n2-priced-arms-"));
  roots.push(root);
  const base = prepareArmCheckout(join(root, "baseline-arm"), "stub", "baseline");
  const cand = prepareArmCheckout(join(root, "candidate-arm"), "stub", "candidate");
  return { base: base.dir, cand: cand.dir, baseDigest: base.digest, candDigest: cand.digest };
}

/**
 * Drive the SHIPPED chain: real composition root → real `prereg run` → real gate
 * → real wrapper → the counting transport.
 *
 * The ONLY test-supplied pieces are the transport (`makeProvider`) and the arm
 * driver (`runArm`), because no paid campaign may run and no arm checkout may be
 * launched from a unit test. The selection, the guard, the observer, the gate,
 * the wrapper and the pre-send price decision are all production code.
 *
 * `advanceClockAtSend` is the ONE dimension that differs between the refusal and
 * the control group.
 */
async function runScenario(opts: {
  advanceClockAtSend: boolean;
  armCfg: { base: string; cand: string; baseDigest: string; candDigest: string } | null;
  root: string;
  head: string;
  /**
   * The schedule seed. Two scenarios that must BOTH run to completion need two
   * distinct campaigns: one authorization may claim exactly ONE budget
   * directory (`BUDGET_CAMPAIGN_DIR_DUPLICATE`), which is itself a fail-closed
   * property worth keeping. The seed is therefore fixture bookkeeping — the
   * SEMANTIC dimension that differs between the refusal and the control group is
   * only the clock at send time.
   */
  orderSeed?: number;
}): Promise<Scenario> {
  const env: NodeJS.ProcessEnv = {
    OPENAI_MODEL: RELAY_MODEL,
    OPENAI_BASE_URL: RELAY,
    [DECLARED_PRICING_ENV]: declaration(),
    ...(opts.armCfg === null
      ? {}
      : { R97_ARM_BASELINE_DIR: opts.armCfg.base, R97_ARM_CANDIDATE_DIR: opts.armCfg.cand }),
  };

  const dir = await mkdtemp(join(tmpdir(), "n2-priced-"));
  roots.push(dir);
  const configPath = join(dir, "config.json");
  const preregPath = join(dir, "prereg.json");
  const authPath = join(dir, "auth.json");
  const budgetDir = join(dir, "budget");
  const outDir = join(dir, "out");

  // Build the artifact with the REAL `prereg build` (0 provider calls) from the
  // SAME composition root, so the identity/pricing it binds is the one the
  // selection (and therefore the guard) is derived from.
  await writeFile(
    configPath,
    JSON.stringify({
      subject: {
        candidateSourceSha: opts.head,
        baselineArmDigest: opts.armCfg === null ? "n2-no-arm-baseline" : opts.armCfg.baseDigest,
        candidateArmDigest: opts.armCfg === null ? "n2-no-arm-candidate" : opts.armCfg.candDigest,
        cleanTreePolicy: "require-clean",
        runtimeConfigDigest: "n2-runtime-config-digest",
      },
      candidateId: "tool_call_efficiency_v1",
      provider: { providerId: "ignored", modelId: "ignored", requestProfile: { budgetTokens: 32_000, stallPolicy: "default" } },
      suiteId: "tool-call-efficiency",
      suiteVersion: "1.0.0",
      evaluation: {
        judgeId: "n2-judge",
        judgeDigest: "n2-judge-digest",
        verifierDigest: "n2-verifier-digest",
        scorerDigest: "n2-scorer-digest",
        decisionPolicy: {
          version: "e4-05-policy-v1",
          minActivationEligibleCases: 3,
          minActivationCoverage: 0.5,
          maxVerifiedDrop: 0.05,
          minConclusiveNetDelta: 1,
          maxTokensDelta: 50_000,
          securityBreachesAllowed: 0,
          minRecoveryRate: null,
        },
      },
      selectionEvidence: { root: opts.root },
      schedule: { repetitions: 2, orderSeed: opts.orderSeed ?? 11 },
      budget: {
        maxModelCallsPerRun: 30,
        maxToolCalls: 100,
        // 24h: the campaign deadline stays valid when the clock is advanced past
        // the PRICE window, so the refusal below can only be the price decision.
        maxDurationMs: 24 * HOUR_MS,
        maxInputTokens: 320_000,
        maxOutputTokens: 64_000,
        maxTotalTokens: 384_000,
        maxUsdMicros: 5_000_000,
        pricingUnknownPolicy: "refuse",
      },
      isolation: {
        driverSchema: "r97-driver-v1",
        workerSchema: "r97-worker-v1",
        isolationBackendId: "trusted-build",
        isolationStrength: "no-os-network-sandbox",
        resumeStateSchema: "r97-execution-state-v1",
      },
    }),
    "utf8",
  );

  const deps = preregCommandDeps(env);
  const built = await preregCmd(["build", configPath, "--out", preregPath], deps);
  if (built.exitCode !== 0) throw new Error(`n2 fixture build failed: ${built.lines.join(" | ")}`);
  const artifact = JSON.parse(await readFile(preregPath, "utf8")) as ToolCallEfficiencyPreregistrationV2;

  await writeFile(
    authPath,
    JSON.stringify({
      schemaVersion: "tool-call-efficiency-authorization-v2",
      preregistrationDigest: artifact.preregistrationDigest,
      candidateSourceSha: artifact.subject.candidateSourceSha,
      baselineArmDigest: artifact.subject.baselineArmDigest,
      candidateArmDigest: artifact.subject.candidateArmDigest,
      providerId: artifact.provider.providerId,
      modelId: artifact.provider.modelId,
      endpointDigest: artifact.provider.endpointDigest,
      caps: {
        maxModelCalls: artifact.budget.campaignWorstCaseModelCalls,
        maxToolCalls: artifact.budget.maxToolCalls,
        maxDurationMs: artifact.budget.maxDurationMs,
        maxInputTokens: artifact.budget.maxInputTokens,
        maxOutputTokens: artifact.budget.maxOutputTokens,
        maxTotalTokens: artifact.budget.maxTotalTokens,
        maxUsdMicros: artifact.budget.maxUsdMicros,
      },
      issuedAtMs: T_ADMISSION - HOUR_MS,
      expiresAtMs: T_ADMISSION + 12 * HOUR_MS,
      approvalId: "n2-approval",
      allowResume: true,
      // PAID SHAPE — the money-bounded branch, which is the only one that can
      // arm a price guard. Nothing is dialled: the transport is a counter.
      paid: true,
    }),
    "utf8",
  );

  // The production observer (real git HEAD, real case bytes, real pricing basis)
  // plus the two test-supplied execution seams.
  const production = createProductionPreregRunner({ rootDir: opts.root, env });
  const transport = countingProvider();
  const sendErrors: string[] = [];
  let sendAttempts = 0;
  let clockMs = T_ADMISSION;

  const result = await preregCmd(["run", preregPath, "--authorization", authPath, "--budget-dir", budgetDir, "--out", outDir, "--mode", "first-run"], {
    selection: deps.selection,
    runner: {
      observe: production.observe,
      makeProvider: () => transport,
      runArm: async (_arm, ctx) => {
        sendAttempts += 1;
        // ONE physical send goes through the ADMITTED, budget-wrapped provider.
        // In the refusal scenario the clock is advanced HERE, i.e. after
        // admission and before the send — exactly the "admitted then expired"
        // sequence, with no sleeping and no wall-clock dependency.
        if (opts.advanceClockAtSend) clockMs = T_AFTER_EXPIRY;
        try {
          const client = ctx.provider.createClient({ providerId: "openai", modelId: RELAY_MODEL } as ModelRef, {} as ProviderConfig);
          for await (const _evt of client.generate({ messages: [] } as unknown as ModelRequest, new AbortController().signal)) {
            void _evt;
          }
        } catch (err) {
          sendErrors.push(err instanceof Error ? err.message : String(err));
        }
        // The arm outcome is NOT this test's subject: the price decision at the
        // send boundary already happened above, inside the production wrapper.
        // An `error` outcome is reported as such — never a faked `passed`.
        return { status: "error", failureCategory: "infrastructure", reason: "n2: arm driver is a counter, not a harness run" };
      },
    },
    now: () => clockMs,
  });

  return { sendErrors, sendAttempts, transport, result, artifact };
}

describe("N2/F30-5 — the pricing guard is armed by the CLI composition root and stops the send", () => {
  it("ADMITTED with a valid window, send after expiry ⇒ REFUSED, counting transport = 0; (control) window still valid ⇒ the same send really leaves", async () => {
    const root = await mkdtemp(join(tmpdir(), "n2-priced-root-"));
    roots.push(root);
    const identity = prepareIdentityRoot(root);
    // The observer establishes the arm digests from DISK, so the gate can reach
    // the provider factory at all. These checkouts are never launched.
    const arms = await stubArms();

    // (1) ARMED AT THE COMPOSITION ROOT — from the SAME resolved selection.
    const selection = resolvePreregSelection({
      OPENAI_MODEL: RELAY_MODEL,
      OPENAI_BASE_URL: RELAY,
      [DECLARED_PRICING_ENV]: declaration(),
    });
    expect(selection.pricing.ok, JSON.stringify(selection.pricing)).toBe(true);
    expect(selection.pricingGuard, "a windowed executable basis MUST arm the guard").toBeDefined();
    expect(preregCommandDeps({ OPENAI_MODEL: RELAY_MODEL, OPENAI_BASE_URL: RELAY, [DECLARED_PRICING_ENV]: declaration() }).selection?.pricingGuard).toEqual(selection.pricingGuard);

    // (3) THE REFUSAL SCENARIO — the ONLY difference from the control is that the
    // clock is advanced past the declared expiry before the send.
    const refused = await runScenario({ advanceClockAtSend: true, armCfg: arms, root: identity.root, head: identity.head });
    expect(refused.transport.sends, "a refused send must never enter the transport").toBe(0);
    expect(refused.sendAttempts, "the arm driver did attempt one physical send (so 0 above is a refusal, not a skipped send)").toBeGreaterThanOrEqual(1);
    const refusal = refused.sendErrors.join("\n");
    expect(refusal, `expected the send to be refused by the PRICE gate, got: ${refusal}`).toContain("PRICING_WINDOW_EXPIRED");
    expect(refusal).toContain("initial send");
    // ...and NOT for an unrelated reason: the deadline is 24h away and the
    // authorization is valid, so the price is the only thing that expired.
    expect(refusal).not.toContain("BUDGET_EXHAUSTED");
    expect(refusal).not.toContain("DEADLINE");

    // (2) + CONTROL GROUP — same artifact, same transport, same arms, ONE
    // dimension changed (the clock is not advanced): the send really leaves.
    const allowed = await runScenario({ advanceClockAtSend: false, armCfg: arms, root: identity.root, head: identity.head, orderSeed: 12 });
    expect(
      allowed.transport.sends,
      `the control group MUST send (exit=${allowed.result.exitCode}, sendAttempts=${allowed.sendAttempts}, errors=${allowed.sendErrors.join(" | ") || "<none>"})\n${allowed.result.lines.join("\n")}`,
    ).toBeGreaterThanOrEqual(1);
    expect(allowed.sendErrors.join("\n")).not.toContain("PRICING_");
  });
});

describe("N2/F30-5 — the guard's object identity comes from the composition root, not from the test", () => {
  it("the refused run used the guard the composition root built (same amount/window/basis digest as the resolved pricing)", async () => {
    const root = await mkdtemp(join(tmpdir(), "n2-priced-root2-"));
    roots.push(root);
    const identity = prepareIdentityRoot(root);
    const arms = await stubArms();
    const env = { OPENAI_MODEL: RELAY_MODEL, OPENAI_BASE_URL: RELAY, [DECLARED_PRICING_ENV]: declaration() };
    const selection = resolvePreregSelection(env);
    if (!selection.pricing.ok) throw new Error("fixture bug: the declared pricing did not resolve");
    const guard = selection.pricingGuard!;

    // The guard is derived from the SAME basis the artifact binds (the build path
    // and the guard path both read `selection`), so the bytes that decide the
    // send are the bytes the pre-registration was approved under.
    const scenario = await runScenario({ advanceClockAtSend: true, armCfg: arms, root: identity.root, head: identity.head });
    expect(scenario.artifact.provider.pricingDigest).toBe(guard.basisDigest);
    expect(scenario.artifact.provider.usdMicrosPerCall).toBe(guard.amountUsdMicros);
    expect(guard.amountUsdMicros).toBe(DECLARED_AMOUNT_USD_MICROS);
    // The guard's window is the DECLARED one, and the scenarios really do sit on
    // opposite sides of it (that is the only difference between them).
    expect(guard.expiresAtMs).toBe(Date.parse(WINDOW_TO));
    expect(guard.expiresAtMs).toBeGreaterThan(T_ADMISSION);
    expect(guard.expiresAtMs).toBeLessThan(T_AFTER_EXPIRY);
  });
});
