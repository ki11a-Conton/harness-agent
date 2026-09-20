/**
 * E4-R98-A (plan T1 / findings N1, N2) — THE BUDGET CHANNEL.
 *
 * MEASURED DEFECT N1 (plan §0.2, P0):
 *
 *   "`r97-arm-worker.mjs:731` 起，`reservationCount=1`、默认 `maxModelCalls=10`、
 *    dispatch 后固定 `consumed=1`；未读取实际 model_calls/retries"
 *
 * The worker charged ONE logical call per (case, arm) UNIT, no matter how many
 * times the arm's own executor actually called `generate()`. A case that needed
 * five rounds was billed once, so `campaignModelCalls` bounded the number of
 * CASE STARTS and never the number of MODEL CALLS. The plan states the required
 * replacement (§T1 怎么做 2):
 *
 *   "在每次 generate 离开执行边界前，原子 reserve 一次；没有可靠预算通道就拒绝发送."
 *
 * WHAT MAKES THESE TESTS NON-VACUOUS
 * ----------------------------------
 * Every assertion counts calls that ACTUALLY ENTERED the wrapped provider's
 * `generate()` — a real counter on a real provider object — and cross-checks it
 * against the REAL ledger file on disk. Nothing here reads a `model_calls`
 * field the executor reports about itself: a forged self-report is exactly the
 * artefact this defect produced, so trusting it would test nothing.
 *
 * The plan is explicit (§T1 怎么做 1):
 *
 *   "新增测试必须计数真正进入 fake ModelClient.generate 的次数，不只看伪造的
 *    model_calls 字段."
 *
 * ZERO external requests: the wrapped provider is a local scripted object.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelProvider } from "@ar/model";
import {
  createLedgerBudgetedProvider,
  R97_BUDGET_REFUSED,
  R97_UNKNOWN_OUTCOME,
} from "./r97-budget-channel.js";
import { openR97BudgetLedger, viewOfR97Ledger, R97_CAMPAIGN_CLAIMS_DIR_ENV } from "./r97-budget-ledger.js";

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "r97-channel-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
});

/**
 * The per-authorization CLAIM anchor lives OUTSIDE any single campaign
 * directory, so pointing several temp directories at the same plan digest would
 * otherwise trip the cross-directory double-spend guard — which is the guard
 * working correctly, not a budget-channel failure. Redirect it at a scratch
 * directory for this file, exactly as `r97-budget-ledger.test.ts` does, so each
 * test's fresh directory is a legitimate first run.
 */
const CLAIMS_DIR = await mkdtemp(join(tmpdir(), "r97-channel-claims-"));
process.env[R97_CAMPAIGN_CLAIMS_DIR_ENV] = CLAIMS_DIR;
afterAll(async () => {
  delete process.env[R97_CAMPAIGN_CLAIMS_DIR_ENV];
  await rm(CLAIMS_DIR, { recursive: true, force: true }).catch(() => {});
});

/**
 * A UNIQUE authorization per test.
 *
 * The campaign identity is derived from `(planDigest, grant)` alone, and a
 * second directory claiming the SAME authorization is a deliberate conflict
 * (`BUDGET_CAMPAIGN_DIR_DUPLICATE`). Each test below is a separate campaign, so
 * each one gets its own digest — otherwise the cross-directory double-spend
 * guard (correctly) refuses the second test's fresh directory.
 */
let planSeq = 0;
function freshPlan(): string {
  planSeq += 1;
  return `${planSeq.toString(16).padStart(2, "0")}${"c".repeat(62)}`;
}


/**
 * A provider that COUNTS every `generate()` that reaches it, and whose script
 * for call N is supplied by the caller. The count is the ground truth: a
 * budget channel that lets a fourth call through is proven wrong by this
 * counter even if the ledger's own numbers looked right.
 */
function countingProvider(scripts: Array<Array<unknown>>) {
  const inner = new ScriptedModelProvider(scripts as never);
  return inner;
}

/** Drain one generate() and return the event types it yielded. */
async function drain(client: { generate: (r: unknown, s: AbortSignal) => AsyncIterable<{ type: string }> }): Promise<string[]> {
  const types: string[] = [];
  for await (const ev of client.generate({ messages: [{ role: "user", content: "x" }] }, new AbortController().signal)) {
    types.push(ev.type);
  }
  return types;
}

const TEXT = ScriptedModelProvider.text("done");

describe("R98-A C1: every logical generate() reserves BEFORE the call leaves", () => {
  it("with a grant of 1, a second generate() is refused BEFORE the provider is entered", async () => {
    const dir = await tempDir();
    const ledger = await openR97BudgetLedger(dir, { planDigest: freshPlan(), campaignModelCalls: 1, mode: "first-run" });
    const inner = countingProvider([TEXT, TEXT, TEXT]);

    const { provider, stats } = createLedgerBudgetedProvider({ provider: inner, ledger, arm: "baseline" });
    const client = provider.createClient({ providerId: "scripted", modelId: "m" }, {});

    // Call 1 is admitted and reaches the provider.
    await drain(client as never);
    expect(inner.calls, "the first call must reach the provider").toHaveLength(1);

    // Calls 2 and 3 must be refused. THE DISCRIMINATOR: the provider's own
    // counter must stay at 1 — a channel that reserved only AFTER the call
    // would still show 3 here.
    await expect(drain(client as never)).rejects.toThrow(new RegExp(R97_BUDGET_REFUSED));
    await expect(drain(client as never)).rejects.toThrow(new RegExp(R97_BUDGET_REFUSED));
    expect(inner.calls, "a refused call must NOT reach the provider").toHaveLength(1);

    // The channel's own accounting agrees with the provider's.
    expect(stats.logicalCalls).toBe(1);
    expect(stats.refusedCalls).toBe(2);

    // And the LEDGER on disk shows exactly one logical call consumed — not
    // "one unit", and not zero.
    const view = viewOfR97Ledger(await ledger.read());
    expect(view.granted).toBe(1);
    expect(view.committed).toBe(1);
    expect(view.remaining).toBe(0);
  });

  it("a grant of 3 admits exactly three calls across the SAME channel", async () => {
    const dir = await tempDir();
    const ledger = await openR97BudgetLedger(dir, { planDigest: freshPlan(), campaignModelCalls: 3, mode: "first-run" });
    const inner = countingProvider([TEXT, TEXT, TEXT, TEXT]);
    const { provider, stats } = createLedgerBudgetedProvider({ provider: inner, ledger, arm: "baseline" });
    const client = provider.createClient({ providerId: "scripted", modelId: "m" }, {});

    await drain(client as never);
    await drain(client as never);
    await drain(client as never);
    await expect(drain(client as never)).rejects.toThrow(new RegExp(R97_BUDGET_REFUSED));

    expect(inner.calls).toHaveLength(3);
    expect(stats.logicalCalls).toBe(3);
    expect(stats.refusedCalls).toBe(1);
    expect(viewOfR97Ledger(await ledger.read()).remaining).toBe(0);
  });

  it("the budget is shared with a SECOND channel on the same ledger (the two-arm case)", async () => {
    // Plan §T1 怎么验收: "campaign grant=3；baseline 某案例调用两轮，candidate 只剩一轮."
    const dir = await tempDir();
    const ledger = await openR97BudgetLedger(dir, { planDigest: freshPlan(), campaignModelCalls: 3, mode: "first-run" });

    const a = createLedgerBudgetedProvider({
      provider: countingProvider([TEXT, TEXT, TEXT]),
      ledger,
      arm: "baseline",
    });
    const b = createLedgerBudgetedProvider({
      provider: countingProvider([TEXT, TEXT, TEXT]),
      ledger,
      arm: "candidate",
    });

    const ca = a.provider.createClient({ providerId: "scripted", modelId: "m" }, {});
    const cb = b.provider.createClient({ providerId: "scripted", modelId: "m" }, {});
    await drain(ca as never);
    await drain(ca as never);
    // The candidate arm may use the ONE remaining call, and no more.
    await drain(cb as never);
    await expect(drain(cb as never)).rejects.toThrow(new RegExp(R97_BUDGET_REFUSED));

    expect(a.stats.logicalCalls).toBe(2);
    expect(b.stats.logicalCalls).toBe(1);
    expect(b.stats.refusedCalls).toBe(1);
  });
});

describe("R98-A C2: logical calls, transport retries and unknown outcomes are separate", () => {
  it("counts transport retry events WITHOUT billing them as new logical calls", async () => {
    const dir = await tempDir();
    const ledger = await openR97BudgetLedger(dir, { planDigest: freshPlan(), campaignModelCalls: 1, mode: "first-run" });
    // One logical call that internally retries twice, then completes.
    const retrying = [
      { type: "started", timestamp: 0 },
      { type: "retry", timestamp: 0 },
      { type: "retry", timestamp: 0 },
      { type: "text_delta", text: "ok", timestamp: 0 },
      { type: "completed", result: { finishReason: "stop", text: "ok" }, timestamp: 0 },
    ];
    const inner = countingProvider([retrying]);
    const { provider, stats } = createLedgerBudgetedProvider({ provider: inner, ledger, arm: "baseline" });
    await drain(provider.createClient({ providerId: "scripted", modelId: "m" }, {}) as never);

    // ONE logical call, TWO physical retries — the plan's separation.
    expect(stats.logicalCalls).toBe(1);
    expect(stats.transportRetries).toBe(2);
    const view = viewOfR97Ledger(await ledger.read());
    expect(view.committed).toBe(1);
    expect(view.transportRetries).toBe(2);
  });

  it("a call that was SENT and then failed keeps its allowance and is recorded as unknown", async () => {
    // Plan §T1 怎么验收: "已发送后进程终止的 reservation 保留 unknown 占用，不自动退款或重发."
    const dir = await tempDir();
    const ledger = await openR97BudgetLedger(dir, { planDigest: freshPlan(), campaignModelCalls: 1, mode: "first-run" });
    const inner = countingProvider([[{ type: "error", error: { code: "MODEL_ERROR", message: "boom" }, timestamp: 0 }]]);
    const { provider, stats } = createLedgerBudgetedProvider({ provider: inner, ledger, arm: "baseline" });

    await drain(provider.createClient({ providerId: "scripted", modelId: "m" }, {}) as never);

    // The request WAS dispatched, so it may have been billed: the allowance is
    // NOT returned, and the outcome is named `unknown` rather than assumed.
    expect(inner.calls).toHaveLength(1);
    expect(stats.logicalCalls).toBe(1);
    expect(stats.unknownCalls).toBe(1);
    const view = viewOfR97Ledger(await ledger.read());
    expect(view.unknown).toBe(1);
    expect(view.committed).toBe(0);
    expect(view.remaining).toBe(0);
  });

  it("a generate() that THROWS mid-stream also keeps its allowance as unknown", async () => {
    const dir = await tempDir();
    const ledger = await openR97BudgetLedger(dir, { planDigest: freshPlan(), campaignModelCalls: 2, mode: "first-run" });
    const throwing = (async function* () {
      yield { type: "started", timestamp: 0 };
      throw new Error("transport died after the request was sent");
    })();
    const inner = countingProvider([throwing as never]);
    const { provider, stats } = createLedgerBudgetedProvider({ provider: inner, ledger, arm: "baseline" });

    await expect(drain(provider.createClient({ providerId: "scripted", modelId: "m" }, {}) as never)).rejects.toThrow(/transport died/);

    expect(stats.unknownCalls).toBe(1);
    const view = viewOfR97Ledger(await ledger.read());
    expect(view.unknown).toBe(1);
    expect(view.remaining).toBe(1);
  });

  it("exposes the unknown-outcome code so a caller can name the state", () => {
    expect(R97_UNKNOWN_OUTCOME).toBe("BUDGET_OUTCOME_UNKNOWN");
    expect(R97_BUDGET_REFUSED).toBe("BUDGET_EXHAUSTED");
  });
});

describe("R98-A C3: a PRE-TAKEN reservation is adopted, not double-charged", () => {
  it("spends the caller's reservation on the first call and reserves fresh afterwards", async () => {
    // The worker must persist `running` (carrying a REAL reservationId) BEFORE a
    // request may leave, but it cannot know how many calls a unit will make. It
    // therefore reserves ONE call, hands that id to the channel, and the channel
    // adopts it for the first call while reserving fresh for the rest.
    const dir = await tempDir();
    const ledger = await openR97BudgetLedger(dir, { planDigest: freshPlan(), campaignModelCalls: 2, mode: "first-run" });
    const first = await ledger.reserve("baseline", 1);
    expect(first.ok).toBe(true);

    const inner = countingProvider([TEXT, TEXT, TEXT]);
    const { provider, stats } = createLedgerBudgetedProvider({
      provider: inner,
      ledger,
      arm: "baseline",
      firstReservationId: first.reservationId!,
    });
    const client = provider.createClient({ providerId: "scripted", modelId: "m" }, {});

    // Call 1 uses the PRE-TAKEN reservation — no second entry is created for it.
    await drain(client as never);
    let entries = (await ledger.read()).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.reservationId).toBe(first.reservationId);
    expect(stats.reservationIds[0]).toBe(first.reservationId);

    // Call 2 reserves fresh, because the grant allows it.
    await drain(client as never);
    entries = (await ledger.read()).entries;
    expect(entries).toHaveLength(2);
    expect(stats.reservationIds[1]).not.toBe(first.reservationId);

    // Call 3 is refused: the pre-taken reservation did not grant a free extra.
    await expect(drain(client as never)).rejects.toThrow(new RegExp(R97_BUDGET_REFUSED));
    expect(inner.calls).toHaveLength(2);
    expect(viewOfR97Ledger(await ledger.read()).remaining).toBe(0);
  });

  it("REGRESSION: the pre-taken reservation is spent by ONE client only", async () => {
    // MEASURED BUG. The arm's runtime constructs a client per agent/turn. When
    // the pre-taken reservation was tracked per-CLIENT, every client adopted the
    // same ledger entry, so several real calls shared one reservation and the
    // ledger silently under-counted the campaign's spend. The reservation
    // belongs to the UNIT, so exactly one call — from whichever client — may
    // consume it.
    const dir = await tempDir();
    const ledger = await openR97BudgetLedger(dir, { planDigest: freshPlan(), campaignModelCalls: 2, mode: "first-run" });
    const first = await ledger.reserve("baseline", 1);

    const inner = countingProvider([TEXT, TEXT, TEXT]);
    const { provider, stats } = createLedgerBudgetedProvider({
      provider: inner,
      ledger,
      arm: "baseline",
      firstReservationId: first.reservationId!,
    });

    // TWO clients, as the runtime really builds them.
    const c1 = provider.createClient({ providerId: "scripted", modelId: "m" }, {});
    const c2 = provider.createClient({ providerId: "scripted", modelId: "m" }, {});

    await drain(c1 as never); // spends the pre-taken reservation
    await drain(c2 as never); // must reserve FRESH, not re-adopt it

    expect(inner.calls).toHaveLength(2);
    expect(new Set(stats.reservationIds).size, "one reservation per real call").toBe(2);
    expect((await ledger.read()).entries).toHaveLength(2);
    expect(viewOfR97Ledger(await ledger.read()).remaining).toBe(0);
  });
});
