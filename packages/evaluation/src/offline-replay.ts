import type { EvalOutcome } from "./runner.js";
import { attributeRegression, tallyEvents, type EventTally, type RegressionAttribution } from "./attribution.js";

/**
 * P3-15 — Offline Trace Replay.
 *
 * A mechanism-CANDIDATE experiment (no main-runtime refactor). Historical
 * event/trace recordings can drive the evaluator without ever calling a real
 * model:
 *
 *   re-run evaluator        replayEvaluator over recorded outcomes
 *   test new judge          testNewJudge — differential re-judgement
 *   test new memory ranker  replayMemoryRanker
 *   test new attribution    replayAttribution
 *
 * The point is to cut iteration cost: a new judge / memory ranker / attribution
 * can be validated offline on a fixed corpus. Everything here is deterministic
 * and never fabricates model behaviour.
 */

export interface TraceRecord {
  caseId: string;
  outcome: EvalOutcome;
}

export type OfflineJudge = (o: EvalOutcome) => boolean;
export type MemoryRanker = (items: { id: string; score: number }[], topK: number) => string[];

/** A recorded memory retrieve set, as stored in a trace's events. */
export interface MemoryRetrievalRecord {
  caseId: string;
  candidates: { id: string; score: number }[];
  relevantId: string;
}

// ---------------------- Re-run the evaluator -------------------------------

export interface ReplayScore {
  passRate: number;
  passed: number;
  failed: number;
  totalTokens: number;
}

/** Re-run the evaluator over a recorded corpus with a judge, offline. */
export function replayEvaluator(records: TraceRecord[], judge: OfflineJudge, score = scorePass): ReplayScore {
  const passed = records.filter((r) => judge(r.outcome)).length;
  return score(records, passed);
}

function scorePass(records: TraceRecord[], passed: number): ReplayScore {
  const totalTokens = records.reduce((s, r) => s + r.outcome.metrics.tokens_input + r.outcome.metrics.tokens_output, 0);
  return {
    passRate: records.length === 0 ? 0 : passed / records.length,
    passed,
    failed: records.length - passed,
    totalTokens,
  };
}

// ---------------------- Test a new judge -----------------------------------

export interface JudgeDiff {
  changedCases: string[];
  newFailures: string[];
  currentPassRate: number;
  newPassRate: number;
}

/** Differentially test a new judge against the current verdicts offline. */
export function testNewJudge(
  records: TraceRecord[],
  currentVerdicts: (o: EvalOutcome) => boolean,
  newJudge: OfflineJudge,
): JudgeDiff {
  const changedCases: string[] = [];
  const newFailures: string[] = [];
  let currentPass = 0;
  let newPass = 0;
  for (const r of records) {
    const cur = currentVerdicts(r.outcome);
    const neu = newJudge(r.outcome);
    if (cur) currentPass++;
    if (neu) newPass++;
    if (cur !== neu) changedCases.push(r.caseId);
    if (cur && !neu) newFailures.push(r.caseId);
  }
  return {
    changedCases,
    newFailures,
    currentPassRate: records.length === 0 ? 0 : currentPass / records.length,
    newPassRate: records.length === 0 ? 0 : newPass / records.length,
  };
}

// ---------------------- Test a new memory ranker ---------------------------

export interface RankerResult {
  caseId: string;
  retrieved: string[];
  topK: number;
  hit: boolean;
}

/** Apply a memory ranker to a recorded retrieval; hit = the relevant item is
 *  retrieved within top-k. Deterministic, no model calls. */
export function replayMemoryRanker(
  retrievals: MemoryRetrievalRecord[],
  ranker: MemoryRanker,
  topK: number,
): RankerResult[] {
  return retrievals.map((rec) => {
    const retrieved = ranker(rec.candidates, topK);
    return {
      caseId: rec.caseId,
      retrieved,
      topK,
      hit: retrieved.includes(rec.relevantId),
    };
  });
}

export function rankerHitRate(results: RankerResult[]): number {
  if (results.length === 0) return 0;
  return results.filter((r) => r.hit).length / results.length;
}

// ---------------------- Test a new attribution -----------------------------

export interface AttributionReplayInput {
  baseline: { caseId: string; events: EvalOutcome["events"] }[];
  challenger: { caseId: string; events: EvalOutcome["events"] }[];
}

/** Re-run regression attribution over recorded event traces, offline. */
export function replayAttribution(input: AttributionReplayInput): RegressionAttribution {
  const tally = (cix: AttributionReplayInput["baseline"]): { caseId: string; tally: EventTally }[] =>
    cix.map((c) => ({ caseId: c.caseId, tally: tallyEvents(c.events) }));
  return attributeRegression(tally(input.baseline), tally(input.challenger));
}