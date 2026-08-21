import type { EvalOutcome } from "./runner.js";
import { type RegressionAttribution } from "./attribution.js";
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
export type MemoryRanker = (items: {
    id: string;
    score: number;
}[], topK: number) => string[];
/** A recorded memory retrieve set, as stored in a trace's events. */
export interface MemoryRetrievalRecord {
    caseId: string;
    candidates: {
        id: string;
        score: number;
    }[];
    relevantId: string;
}
export interface ReplayScore {
    passRate: number;
    passed: number;
    failed: number;
    totalTokens: number;
}
/** Re-run the evaluator over a recorded corpus with a judge, offline. */
export declare function replayEvaluator(records: TraceRecord[], judge: OfflineJudge, score?: typeof scorePass): ReplayScore;
declare function scorePass(records: TraceRecord[], passed: number): ReplayScore;
export interface JudgeDiff {
    changedCases: string[];
    newFailures: string[];
    currentPassRate: number;
    newPassRate: number;
}
/** Differentially test a new judge against the current verdicts offline. */
export declare function testNewJudge(records: TraceRecord[], currentVerdicts: (o: EvalOutcome) => boolean, newJudge: OfflineJudge): JudgeDiff;
export interface RankerResult {
    caseId: string;
    retrieved: string[];
    topK: number;
    hit: boolean;
}
/** Apply a memory ranker to a recorded retrieval; hit = the relevant item is
 *  retrieved within top-k. Deterministic, no model calls. */
export declare function replayMemoryRanker(retrievals: MemoryRetrievalRecord[], ranker: MemoryRanker, topK: number): RankerResult[];
export declare function rankerHitRate(results: RankerResult[]): number;
export interface AttributionReplayInput {
    baseline: {
        caseId: string;
        events: EvalOutcome["events"];
    }[];
    challenger: {
        caseId: string;
        events: EvalOutcome["events"];
    }[];
}
/** Re-run regression attribution over recorded event traces, offline. */
export declare function replayAttribution(input: AttributionReplayInput): RegressionAttribution;
export {};
//# sourceMappingURL=offline-replay.d.ts.map