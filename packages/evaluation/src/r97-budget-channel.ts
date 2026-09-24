/**
 * E4-R98-A — THE BUDGET CHANNEL: one reservation per REAL logical model call.
 *
 * WHY THIS MODULE EXISTS (plan T1 / finding N1, priority P0)
 * ---------------------------------------------------------
 * MEASURED DEFECT N1 (plan §0.2):
 *
 *   "`r97-arm-worker.mjs:731` 起，`reservationCount=1`、默认 `maxModelCalls=10`、
 *    dispatch 后固定 `consumed=1`；未读取实际 model_calls/retries" — "账本统计的是
 *    案例启动次数，不能证明模型调用上限."
 *
 * The campaign ledger was real and correct, but it was wired to the WRONG EVENT.
 * The worker reserved exactly one logical call per (case, arm) UNIT and then
 * committed `consumed = 1` after the child exited, so `campaignModelCalls`
 * bounded the number of case STARTS. A case that took five rounds was billed
 * once; the ledger could not, even in principle, prove a model-call ceiling.
 *
 * The plan's required replacement (§T1 怎么做 2) is explicit:
 *
 *   "选择最小 provider decorator/预算通道，遵循现有 createBudgetedProvider 的调用
 *    位置。在每次 generate 离开执行边界前，原子 reserve 一次；没有可靠预算通道就
 *    拒绝发送."
 *
 * This is that decorator, and it is deliberately the SMALLEST one that can be
 * correct: it wraps a `ModelProvider` (the same seam
 * `packages/evaluation/src/paired-executor.ts#createBudgetedProvider` already
 * uses) so that every layer which constructs a client from it — the runtime's
 * tool loop, sub-agents, and anything else — is charged. Wrapping a single
 * top-level call instead would leave every nested call unbilled, which is the
 * plan's §T1 怎么做 5 requirement:
 *
 *   "runtime、工具循环和子代理创建的 client 必须使用同一预算包装；不要仅包顶层一次
 *    调用."
 *
 * ORDER IS THE CONTRACT, and it is the whole point: the reservation is taken
 * BEFORE the inner `generate()` is entered. A refusal therefore happens before
 * any request can leave, and the provider's own call counter is the independent
 * evidence — a channel that reserved AFTER the call would still let the call
 * through, which is exactly what the acceptance test measures.
 *
 * THREE COUNTERS, KEPT APART (plan §T1 怎么做 2: "把逻辑调用、transport retries、
 * 已发送但结果未知分开记录"):
 *
 *   - `logicalCalls`   — admitted `generate()` invocations. What the grant bounds.
 *   - `transportRetries` — `retry` events INSIDE one logical call. Physical
 *     attempts, never billed as new logical calls (§T1 怎么做 5: "transport retry
 *     按已有协议单独计数，不把每次 HTTP retry 伪称新的逻辑 generate").
 *   - `unknownCalls`   — a request that WAS dispatched and whose outcome was
 *     never observed (an error event, a mid-stream throw, an incomplete stream).
 *     Its allowance is NOT returned: it may already have been billed, and only a
 *     human reconciliation may resolve it (§T1 怎么验收: "已发送后进程终止的
 *     reservation 保留 unknown 占用，不自动退款或重发").
 *
 * WHAT IS *NOT* HERE: no retry logic, no scheduling, no state file, no second
 * ledger. The ledger remains the single authority on the allowance, and this
 * module only translates "a call is about to happen" into the ledger's
 * reserve/commit protocol.
 */

import type { ModelEvent, ModelProvider, ModelRef, ProviderConfig, ModelRequest } from "@ar/contracts";
import type { R97BudgetLedger } from "./r97-budget-ledger.js";
import { R97_BUDGET_EXHAUSTED } from "./r97-budget-ledger.js";

/** The refusal code thrown when a call may not leave. It is the SAME string the
 *  ledger uses for an exhausted budget, so a caller sees one vocabulary rather
 *  than two names for one condition. */
export const R97_BUDGET_REFUSED = R97_BUDGET_EXHAUSTED;

/** The code naming a dispatched-but-unobserved outcome. */
export const R97_UNKNOWN_OUTCOME = "BUDGET_OUTCOME_UNKNOWN";

/**
 * The EXPLICIT per-call dispatch state of ONE admitted `generate()`.
 *
 * WHY THIS TYPE EXISTS (A1 / finding F1). The settlement used to be inferred
 * from "did the caller get a stats object back". That inference is wrong in
 * both directions: an exception after a real dispatch lost the stats (so a
 * dispatched call looked un-sent and was refunded), and an early return left
 * the reservation outstanding forever. The state below is a MEASUREMENT taken
 * as the call proceeds — not-entered / entered / completed-observed / settled —
 * and it lives on the LIVE `stats` object the caller already holds, so it is
 * readable even when the generator never returns.
 */
export interface R97BudgetDispatchRecord {
  reservationId: string;
  /** True once the inner provider's stream was actually going to be advanced.
   *  While false, the reservation is PROVABLY unused and may be abandoned. */
  entered: boolean;
  /** True once a `completed` event was observed. */
  completed: boolean;
  /** True once the ledger write that ends this reservation SUCCEEDED. A false
   *  value on a returned channel means the settlement failed and the ledger
   *  still shows the reservation as outstanding. */
  settled: boolean;
  /** How it was settled, or `null` while unsettled. */
  settlement: "committed" | "unknown" | "abandoned" | null;
}

/** Per-channel accounting. Every field is a MEASURED count, never a projection:
 *  `logicalCalls` is incremented only after the ledger admitted the call. */
export interface R97BudgetChannelStats {
  /** Logical calls the ledger admitted (the grant bounds this). */
  logicalCalls: number;
  /** `retry` events observed inside admitted calls. */
  transportRetries: number;
  /** Admitted calls whose outcome was never observed. */
  unknownCalls: number;
  /** Calls the ledger REFUSED. These never reached the provider. */
  refusedCalls: number;
  /** Reservation ids in the order they were taken, for cross-checking a report
   *  against the ledger's own entry list. */
  reservationIds: string[];
  /** The explicit dispatch state of every admitted call, in order. */
  dispatches: R97BudgetDispatchRecord[];
  /** Admitted calls whose terminal ledger write FAILED. Non-zero means the
   *  ledger still shows an outstanding reservation, so the unit must not be
   *  reported as a success; the entry stays recoverable through `recover()`. */
  settlementFailures: number;
  /** The last settlement failure message, so a verdict can name the cause
   *  instead of reporting a generic failure. */
  lastSettlementError: string | null;
}

export interface R97BudgetChannelOptions {
  /** The provider to wrap. Its `createClient` is called per client, exactly as
   *  the unwrapped provider would be. */
  provider: ModelProvider;
  /** The campaign ledger. This is the ONLY authority on the allowance. */
  ledger: R97BudgetLedger;
  /** The arm label recorded on each reservation, so the ledger shows which arm
   *  spent what (plan §R97: the budget is shared across both arms). */
  arm: string;
  /**
   * A reservation the CALLER already took, to be consumed by the FIRST admitted
   * call instead of a fresh one.
   *
   * WHY THIS EXISTS — the exec-state ordering problem. Plan §R98 requires
   * `running` to be persisted BEFORE a request may leave, and the execution
   * state's `running` record carries a `reservationId` that must be a REAL
   * ledger reservation (T2 validates that association). But the number of calls
   * a unit will make is not known until it has made them, so a worker cannot
   * reserve "however many are needed" up front.
   *
   * The resolution: the worker reserves exactly ONE call before `begin`, and the
   * channel spends that reservation on the first call, reserving fresh for every
   * subsequent one. The record's `reservationId` is therefore a genuine ledger
   * entry that precedes the dispatch, and every ADDITIONAL call still gets its
   * own reservation — which is what plan §T1 怎么验收 requires: "单案例需要多轮和
   * 子代理调用时，每一轮都有对应 reservation".
   */
  firstReservationId?: string;
}

/**
 * Wrap a provider so every logical `generate()` reserves first.
 *
 * The returned `provider` is a drop-in `ModelProvider`: same `id`, same
 * `listModels`, and a `createClient` whose client reserves per call. A caller
 * that constructs several clients (the runtime does, per agent) shares the ONE
 * ledger, so the grant is global rather than per client.
 */
export function createLedgerBudgetedProvider(opts: R97BudgetChannelOptions): {
  provider: ModelProvider;
  stats: R97BudgetChannelStats;
} {
  const stats: R97BudgetChannelStats = {
    logicalCalls: 0,
    transportRetries: 0,
    unknownCalls: 0,
    refusedCalls: 0,
    reservationIds: [],
    dispatches: [],
    settlementFailures: 0,
    lastSettlementError: null,
  };

  // The caller's pre-taken reservation, spent by the FIRST admitted call
  // whichever client makes it. Scoped to the PROVIDER (one unit = one provider),
  // never to a single client: the runtime builds a client per agent/turn, and a
  // per-client flag let each of them adopt the same ledger entry — one
  // reservation standing behind several real calls (measured).
  let pendingFirstReservation = opts.firstReservationId ?? null;

  const wrapped: ModelProvider = {
    id: opts.provider.id,
    async listModels() {
      return opts.provider.listModels();
    },
    createClient(model: ModelRef, config: ProviderConfig) {
      const inner = opts.provider.createClient(model, config);
      return {
        async *generate(request: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelEvent> {
          // ---- RESERVE FIRST. Nothing may leave before this succeeds. --------
          let reservationId: string;
          if (pendingFirstReservation !== null) {
            // Adopt the caller's pre-taken reservation: it was recorded BEFORE
            // `begin`, so the durable `running` record and the ledger agree.
            //
            // PER-PROVIDER, NOT PER-CLIENT, and that distinction is a MEASURED
            // correctness bug rather than a style choice. The arm's runtime
            // constructs a client per agent/turn, so a per-client flag let EVERY
            // client adopt the same pre-taken reservation: one ledger entry
            // stood behind several real calls, and the ledger silently
            // under-counted the spend. The unit's reservation belongs to the
            // UNIT, so exactly one call may consume it, whichever client makes
            // that call.
            reservationId = pendingFirstReservation;
            pendingFirstReservation = null;
          } else {
            try {
              const reserved = await opts.ledger.reserve(opts.arm, 1);
              if (reserved.ok !== true || reserved.reservationId === null) {
                stats.refusedCalls += 1;
                // A NAMED refusal, before the provider is entered: the caller can
                // assert on the code, and the provider's own counter proves the
                // call never happened.
                throw new Error(`E4-R98: ${R97_BUDGET_REFUSED}: ${reserved.reason}`);
              }
              reservationId = reserved.reservationId;
            } catch (err) {
              // A ledger that cannot be written must refuse the call rather than
              // let it through unbilled — "没有可靠预算通道就拒绝发送". The
              // exhausted-budget throw above already counted itself, so it is
              // re-thrown unchanged rather than double-counted.
              if (err instanceof Error && err.message.includes(R97_BUDGET_REFUSED)) throw err;
              stats.refusedCalls += 1;
              throw new Error(
                `E4-R98: ${R97_BUDGET_REFUSED}: the budget ledger could not reserve for this call, so it is refused rather than sent unbilled: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          }
          stats.reservationIds.push(reservationId);
          stats.logicalCalls += 1;

          // ---- THE EXPLICIT DISPATCH STATE (A1 / F1). ----------------------
          //
          // Settlement used to run AFTER the `for await` loop. A consumer
          // `break`, an explicit `iterator.return()`, or an exception all end
          // the generator with a completion that SKIPS code after the loop, so
          // the reservation stayed `reserved` and the worker refunded it. The
          // settlement now lives in the `finally` below and consults this
          // record instead of inferring anything from a missing return value.
          const dispatch: R97BudgetDispatchRecord = {
            reservationId,
            entered: false,
            completed: false,
            settled: false,
            settlement: null,
          };
          stats.dispatches.push(dispatch);

          // `retries` counts `retry` events; `completed` records whether the
          // stream ever reported a completion. Both decide how the reservation
          // is settled, and neither is guessed after the fact.
          let retries = 0;
          let completed = false;
          let bodyError: unknown = null;
          let settleStarted = false;

          /**
           * Settle the reservation EXACTLY ONCE, from measured state:
           *
           *   never entered the inner provider -> ABANDON (return the allowance;
           *     provably nothing left the process);
           *   entered + observed `completed`   -> COMMIT (consumed = 1, retries
           *     recorded separately);
           *   entered + anything else          -> UNKNOWN (the allowance is NOT
           *     returned: a dispatched request may already have been billed).
           *
           * A FAILED write is not swallowed: it propagates so the caller can
           * refuse to report a success, and `stats.settlementFailures` names it.
           */
          const settle = async (): Promise<void> => {
            if (settleStarted) return;
            settleStarted = true;
            if (!dispatch.entered) {
              await opts.ledger.abandon(reservationId);
              dispatch.settlement = "abandoned";
              dispatch.settled = true;
              return;
            }
            if (completed) {
              await opts.ledger.commit(reservationId, 1, retries);
              dispatch.settlement = "committed";
              dispatch.settled = true;
              return;
            }
            await opts.ledger.markUnknown(reservationId);
            stats.unknownCalls += 1;
            dispatch.settlement = "unknown";
            dispatch.settled = true;
          };

          try {
            // `inner.generate(...)` is called INSIDE the guarded region, and
            // `dispatch.entered` is set only once it returned an iterable: a
            // provider that throws before producing a stream was provably never
            // entered, so its reservation is returned rather than charged.
            const stream = inner.generate(request, signal);
            dispatch.entered = true;
            for await (const ev of stream) {
              if (ev.type === "retry") {
                retries += 1;
                stats.transportRetries += 1;
              } else if (ev.type === "completed") {
                completed = true;
                dispatch.completed = true;
              }
              yield ev;
            }
          } catch (err) {
            // Kept so a settlement failure can be reported WITHOUT erasing the
            // provider's own error.
            bodyError = err;
            throw err;
          } finally {
            try {
              await settle();
            } catch (settleErr) {
              stats.settlementFailures += 1;
              stats.lastSettlementError = settleErr instanceof Error ? settleErr.message : String(settleErr);
              if (bodyError !== null) {
                throw new AggregateError(
                  [bodyError, settleErr],
                  `E4-R98: ${R97_UNKNOWN_OUTCOME}: reservation ${reservationId} could not be settled AND the provider call failed`,
                );
              }
              // A call whose terminal ledger write failed is NOT a success: the
              // reservation is still outstanding and only `recover()` or a human
              // decision may resolve it. Reporting it as committed would hide a
              // real over-spend risk.
              throw new Error(
                `E4-R98: ${R97_UNKNOWN_OUTCOME}: reservation ${reservationId} could not be settled, so this call is NOT reported as a success (the ledger still shows it outstanding): ${stats.lastSettlementError}`,
              );
            }
          }
        },
      };
    },
  };

  return { provider: wrapped, stats };
}
