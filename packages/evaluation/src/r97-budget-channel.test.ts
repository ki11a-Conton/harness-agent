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

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelProvider } from "@ar/model";
import {
  createLedgerBudgetedProvider,
  R97_BUDGET_REFUSED,
  R97_UNKNOWN_OUTCOME,
} from "./r97-budget-channel.js";
import {
  openR97BudgetLedger,
  viewOfR97Ledger,
  R97_CAMPAIGN_CLAIMS_DIR_ENV,
  R97_LEDGER_FILENAME,
} from "./r97-budget-ledger.js";

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

/**
 * Begin ONE generate() and hand back the raw async iterator, so a test can
 * drive the stream by hand — `next()` / `return()` / `break` at an exact point.
 * The request is a loose `unknown`: the channel's request typing is exercised
 * through `drain`, and these tests are about the SETTLEMENT, not the payload.
 */
function beginStream(client: unknown, signal?: AbortSignal): AsyncGenerator<{ type: string }> {
  const loose = client as { generate: (r: unknown, s: AbortSignal) => AsyncGenerator<{ type: string }> };
  return loose.generate({ messages: [{ role: "user", content: "x" }] }, signal ?? new AbortController().signal);
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

/**
 * E4-R98-A / A1 (finding F1) — AN EARLY CLOSE OR AN EXCEPTION MUST STILL SETTLE.
 *
 * MEASURED DEFECT F1 (plan §0.2, P0):
 *
 *   "inner generator 已进入 1 次；消费者读一个事件后 break，CLI 再抛错；worker
 *    consumed=0，reservation=`abandoned`，grant=1 时另一次 reserve 仍成功"
 *
 * The settlement used to live AFTER the `for await` loop. A consumer `break`,
 * an explicit `iterator.return()`, or an exception after the reservation was
 * taken all produce a completion that SKIPS the code after the loop, so the
 * ledger entry stayed `reserved` — and the worker, seeing no stats, refunded it.
 *
 * These tests are the CHANNEL half of the fix, deliberately separate from the
 * worker half: they distinguish "the generator never settled" from "the worker
 * mis-refunded a settled entry". Every assertion counts calls that ACTUALLY
 * entered the wrapped provider and cross-checks the REAL ledger file on disk.
 */
describe("R98-A C4: an early close or an exception after dispatch still settles exactly once", () => {
  it("a consumer that BREAKS after a non-terminal event keeps the allowance (unknown) and never refunds it", async () => {
    const dir = await tempDir();
    const ledger = await openR97BudgetLedger(dir, { planDigest: freshPlan(), campaignModelCalls: 1, mode: "first-run" });
    const inner = countingProvider([TEXT]);
    const { provider, stats } = createLedgerBudgetedProvider({ provider: inner, ledger, arm: "baseline" });
    const client = provider.createClient({ providerId: "scripted", modelId: "m" }, {});

    const seen: string[] = [];
    for await (const ev of beginStream(client)) {
      seen.push(ev.type);
      // The consumer stops reading mid-stream, exactly as the arm CLI does when
      // its own code throws after the request has left.
      break;
    }
    expect(seen, "the consumer really stopped after ONE non-terminal event").toEqual(["started"]);
    expect(inner.calls, "the request really entered the inner provider").toHaveLength(1);

    const view = viewOfR97Ledger(await ledger.read());
    expect(view.unknown, "an entered call whose outcome nobody saw is UNKNOWN, not refunded").toBe(1);
    expect(view.outstanding, "the reservation may not be left dangling").toBe(0);
    expect(view.committed).toBe(0);
    expect(view.remaining).toBe(0);
    expect(stats.unknownCalls).toBe(1);

    const second = await ledger.reserve("baseline", 1);
    expect(second.ok, "a spent allowance must not be re-granted").toBe(false);
  });

  it("an explicit iterator.return() after a non-terminal event settles as unknown, exactly once", async () => {
    const dir = await tempDir();
    const ledger = await openR97BudgetLedger(dir, { planDigest: freshPlan(), campaignModelCalls: 1, mode: "first-run" });
    const inner = countingProvider([TEXT]);
    const { provider } = createLedgerBudgetedProvider({ provider: inner, ledger, arm: "baseline" });
    const it = beginStream(provider.createClient({ providerId: "scripted", modelId: "m" }, {}));

    const first = await it.next();
    expect(first.value!.type).toBe("started");
    await it.return(undefined);

    const entries = (await ledger.read()).entries;
    expect(entries, "exactly ONE ledger entry per real call").toHaveLength(1);
    expect(entries[0]!.status, "the entered call is settled as unknown").toBe("unknown");
    expect(entries[0]!.consumed).toBeNull();
    expect(viewOfR97Ledger(await ledger.read()).remaining).toBe(0);

    // Closing again must not write a second terminal record.
    await it.return(undefined);
    expect((await ledger.read()).entries).toHaveLength(1);
    expect(inner.calls).toHaveLength(1);
  });

  it("stopping right after the COMPLETED event commits exactly once and leaves nothing dangling", async () => {
    const dir = await tempDir();
    const ledger = await openR97BudgetLedger(dir, { planDigest: freshPlan(), campaignModelCalls: 1, mode: "first-run" });
    const inner = countingProvider([TEXT]);
    const { provider, stats } = createLedgerBudgetedProvider({ provider: inner, ledger, arm: "baseline" });

    const seen: string[] = [];
    for await (const ev of beginStream(provider.createClient({ providerId: "scripted", modelId: "m" }, {}))) {
      seen.push(ev.type);
      if (ev.type === "completed") break;
    }
    expect(seen).toEqual(["started", "text_delta", "completed"]);

    const view = viewOfR97Ledger(await ledger.read());
    expect(view.committed, "an observed terminal event commits the reservation").toBe(1);
    expect(view.outstanding, "nothing is left dangling").toBe(0);
    expect(view.unknown).toBe(0);
    expect(view.remaining).toBe(0);
    expect(stats.unknownCalls).toBe(0);
    expect((await ledger.read()).entries).toHaveLength(1);
  });

  it("a CONSUMER that throws while reading settles the reservation as unknown, exactly once", async () => {
    const dir = await tempDir();
    const ledger = await openR97BudgetLedger(dir, { planDigest: freshPlan(), campaignModelCalls: 1, mode: "first-run" });
    const inner = countingProvider([TEXT]);
    const { provider, stats } = createLedgerBudgetedProvider({ provider: inner, ledger, arm: "baseline" });

    // The consumer's own body throws after ONE non-terminal event, so the
    // `for await` closes the channel with a throw completion.
    await expect(
      (async () => {
        for await (const ev of beginStream(provider.createClient({ providerId: "scripted", modelId: "m" }, {}))) {
          if (ev.type === "started") throw new Error("the consumer died mid-stream");
        }
      })(),
    ).rejects.toThrow(/consumer died mid-stream/);

    expect(inner.calls, "the request really entered the inner provider").toHaveLength(1);
    const view = viewOfR97Ledger(await ledger.read());
    expect(view.unknown).toBe(1);
    expect(view.outstanding).toBe(0);
    expect(view.remaining).toBe(0);
    expect(stats.unknownCalls).toBe(1);
    expect((await ledger.read()).entries).toHaveLength(1);
  });

  it("a CANCEL that aborts the signal mid-stream settles as unknown and is not refunded", async () => {
    const dir = await tempDir();
    const ledger = await openR97BudgetLedger(dir, { planDigest: freshPlan(), campaignModelCalls: 1, mode: "first-run" });
    // The CONSUMER's own controller. It is handed to the channel explicitly
    // below, so the signal the provider receives is the very one this test
    // aborts — aborting any other object would prove nothing.
    const controller = new AbortController();
    let signalReachedProvider: AbortSignal | null = null;
    // A provider that honours the signal it was GIVEN: it emits `started`,
    // cancels that same signal, and then refuses to continue.
    const cancelled = {
      id: "scripted",
      async listModels() {
        return [];
      },
      createClient() {
        return {
          async *generate(_request: unknown, signal: AbortSignal): AsyncGenerator<{ type: string }> {
            signalReachedProvider = signal;
            yield { type: "started" };
            controller.abort();
            if (signal.aborted) throw new DOMException("aborted", "AbortError");
            yield { type: "completed" };
          },
        };
      },
    };
    const { provider, stats } = createLedgerBudgetedProvider({ provider: cancelled as never, ledger, arm: "baseline" });

    // Drive the stream by hand with the consumer's own signal and collect the
    // rejection ourselves, so the assertion below cannot be satisfied by a
    // stream that merely ended.
    const it = beginStream(provider.createClient({ providerId: "scripted", modelId: "m" }, {}), controller.signal);
    const seen: string[] = [];
    let failure: unknown = null;
    try {
      for (;;) {
        const step = await it.next();
        if (step.done === true) break;
        seen.push(step.value.type);
      }
    } catch (err) {
      failure = err;
    }

    expect(signalReachedProvider, "the provider was handed a signal at all").not.toBeNull();
    expect(signalReachedProvider!.aborted, "the provider was handed the CONSUMER's own signal").toBe(true);
    expect(seen, "the call was cancelled before any terminal event").toEqual(["started"]);
    expect(String(failure), "the cancelled call rejects rather than completing").toMatch(/aborted/);

    const entries = (await ledger.read()).entries;
    expect(entries, "one reservation per real call").toHaveLength(1);
    const view = viewOfR97Ledger(await ledger.read());
    expect(view.unknown, "a cancelled in-flight call keeps its allowance").toBe(1);
    expect(view.committed).toBe(0);
    expect(view.outstanding).toBe(0);
    expect(view.remaining, "the allowance is NOT refunded").toBe(0);
    expect(entries[0]!.status).toBe("unknown");
    expect(entries[0]!.consumed).toBeNull();
    expect(stats.unknownCalls).toBe(1);
  });

  it("a stream that ends with NO terminal event is unknown, never committed", async () => {
    const dir = await tempDir();
    const ledger = await openR97BudgetLedger(dir, { planDigest: freshPlan(), campaignModelCalls: 1, mode: "first-run" });
    const inner = countingProvider([[{ type: "started", timestamp: 0 }, { type: "text_delta", text: "x", timestamp: 0 }]]);
    const { provider, stats } = createLedgerBudgetedProvider({ provider: inner, ledger, arm: "baseline" });

    await drain(provider.createClient({ providerId: "scripted", modelId: "m" }, {}) as never);

    const view = viewOfR97Ledger(await ledger.read());
    expect(view.unknown).toBe(1);
    expect(view.committed).toBe(0);
    expect(view.remaining).toBe(0);
    expect(stats.unknownCalls).toBe(1);
  });

  it("a call whose inner provider was PROVABLY never entered RETURNS its reservation", async () => {
    // The other half of the contract (plan §A1 怎么做 7): a failure that never
    // reached the inner provider must NOT be charged. The provider here throws
    // from `generate()` itself, so no iterator was ever advanced.
    const dir = await tempDir();
    const ledger = await openR97BudgetLedger(dir, { planDigest: freshPlan(), campaignModelCalls: 1, mode: "first-run" });
    const neverEntered = {
      id: "scripted",
      async listModels() {
        return [];
      },
      createClient() {
        return {
          generate(): AsyncGenerator<never> {
            throw new Error("the inner provider refused to start");
          },
        };
      },
    };
    const { provider, stats } = createLedgerBudgetedProvider({ provider: neverEntered as never, ledger, arm: "baseline" });

    await expect(
      drain(provider.createClient({ providerId: "scripted", modelId: "m" }, {}) as never),
    ).rejects.toThrow(/refused to start/);

    const entries = (await ledger.read()).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status, "nothing entered the provider, so the reservation is returned").toBe("abandoned");
    expect(viewOfR97Ledger(await ledger.read()).remaining, "the unused allowance comes back").toBe(1);
    expect(stats.unknownCalls, "an un-entered call is NOT an unknown outcome").toBe(0);
  });

  it("a SETTLEMENT write failure is reported, not swallowed, and leaves a recoverable state", async () => {
    const dir = await tempDir();
    const FIXED_NOW = 1_700_000_000_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
    try {
      const ledger = await openR97BudgetLedger(dir, { planDigest: freshPlan(), campaignModelCalls: 1, mode: "first-run" });
      const inner = countingProvider([TEXT]);
      const { provider, stats } = createLedgerBudgetedProvider({ provider: inner, ledger, arm: "baseline" });
      const it = beginStream(provider.createClient({ providerId: "scripted", modelId: "m" }, {}));

      // Drive to the reserve: the ledger write SUCCEEDS and the entry exists.
      await it.next();
      // ...then occupy the atomic-write temp path, so the NEXT write (the
      // commit) fails with a real errno while the ledger stays readable.
      await mkdir(join(dir, `${R97_LEDGER_FILENAME}.tmp-${process.pid}-${FIXED_NOW}`));
      await it.next(); // text_delta
      await it.next(); // completed

      await expect(it.next()).rejects.toThrow(/EISDIR|EPERM|EACCES/);

      // The failure is NAMED, not swallowed: the channel reports it and the
      // ledger keeps the reservation outstanding so `recover()` can resolve it.
      expect(stats.settlementFailures, "the settlement failure is counted").toBe(1);
      expect(String(stats.lastSettlementError)).toMatch(/EISDIR|EPERM|EACCES/);
      const entries = (await ledger.read()).entries;
      expect(entries).toHaveLength(1);
      expect(entries[0]!.status, "a failed settlement leaves a RECOVERABLE outstanding reservation").toBe("reserved");
    } finally {
      spy.mockRestore();
    }
  });
});
