import type { LearningCandidate } from "./candidate.js";
import type { PairedComparisonReport, PairedGateOptions } from "./paired.js";
/**
 * P10-3: real paired benchmark — the same case set run N times per side
 * (champion profile vs challenger profile), identical seed/fixture/judge,
 * summarized by the PairedComparisonReport gate (P0-5). The runner is
 * injected so tests use fakes and the CLI uses the real harness.
 */
export interface PairedRunResult {
    success: boolean;
    /** Number of security violations observed on this run (P10-5 hard gate). */
    securityViolations: number;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    toolCalls: number;
}
export interface PairedRunSide {
    /** P10-2: frozen config fingerprint (champion/challenger must be pinned). */
    configHash: string;
    /** One run of one case; runs must be seed-deterministic per side. */
    run: (caseId: string) => Promise<PairedRunResult>;
}
export interface PairedBenchmarkInput {
    cases: readonly string[];
    champion: PairedRunSide;
    challenger: PairedRunSide;
    /** Runs per case per side (paired seed). */
    repeats?: number;
    options?: PairedGateOptions;
}
export interface PairedBenchmarkOutput {
    report: PairedComparisonReport;
    championHashes: string[];
    challengerHashes: string[];
}
/** Run the same cases N times per side and compare through the gate. */
export declare function runPairedBenchmark(input: PairedBenchmarkInput): Promise<PairedBenchmarkOutput>;
/**
 * P10-4: regression attribution for a candidate report — where the challenger
 * improved and where it regressed, plus cost deltas. Feeds the candidate
 * report automatically.
 */
export declare function buildAttributionReport(report: PairedComparisonReport, candidate: LearningCandidate): {
    candidateId: string;
    improved: string[];
    regressed: string[];
    summary: string;
};
//# sourceMappingURL=paired-evaluation.d.ts.map