import type { LearningCandidate } from "./candidate.js";
import type {
  PairedComparisonReport,
  PairedGateOptions,
} from "./paired.js";
import { comparePaired, compareVsReference, HOLD_OUT_REQUIREMENT_BY_KIND, medianCard, MIN_REPEATED_RUNS } from "./paired.js";
import type { HarnessScoreCard } from "./scorecard.js";

export interface PromotionDecision {
  action: "promoted" | "rejected" | "rolled_back";
  reason: string;
}

export interface PromoteDeps {
  securityCheck: (c: LearningCandidate) => Promise<{ ok: boolean; reason?: string }>;
  benchmarkBefore: () => Promise<number>;
  benchmarkAfter: () => Promise<number>;
  /** Minimum required gain; boundary inclusive (after == before + threshold rejects). */
  threshold?: number;
  persist: (c: LearningCandidate) => Promise<void>;
}

export interface ReEvaluateDeps {
  benchmarkCurrent: () => Promise<number>;
}

const DEFAULT_THRESHOLD = 0;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * §147/§194 promotion gate for learning candidates (§69 pipeline:
 * trace → outcome → reflection → candidate → evaluation → promotion).
 *
 * Nothing is persisted before this gate approves. A candidate must pass a
 * security check AND show a benchmark improvement over a recorded baseline;
 * §194 forbids auto-promotion on score alone, and §147 requires repeated
 * evidence — a single sample is rejected by design ("one accidental success
 * is insufficient"). A missing baseline (benchmarkBefore returning a
 * non-finite value or throwing) rejects without ever measuring the "after"
 * score; the error message is preserved in the reason rather than swallowed.
 * Security-check failures are always decisive and short-circuit before any
 * benchmark runs.
 *
 * The §70 rollback path is `evaluateAfter`: after a successful promotion the
 * post-promotion score is recorded on the candidate, and a later
 * re-measurement below that score returns `rolled_back` (nothing is written
 * on rollback — undoing the live change is the caller's action).
 *
 * All side effects flow through the injected deps; there is no filesystem,
 * store, or network access here.
 */
export class LearningPromoter {
  async promote(
    c: LearningCandidate,
    deps: PromoteDeps,
  ): Promise<PromotionDecision> {
    const threshold = deps.threshold ?? DEFAULT_THRESHOLD;

    const security = await deps.securityCheck(c);
    if (!security.ok) {
      return {
        action: "rejected",
        reason: `security check failed${
          security.reason ? `: ${security.reason}` : ""
        }`,
      };
    }

    let before: number;
    try {
      before = await deps.benchmarkBefore();
    } catch (e) {
      return {
        action: "rejected",
        reason: `no benchmark baseline (benchmarkBefore failed: ${errorMessage(e)}); repeated evidence requires a measurable baseline`,
      };
    }
    if (!Number.isFinite(before)) {
      return {
        action: "rejected",
        reason: `no benchmark baseline (benchmarkBefore returned ${String(before)}); repeated evidence requires a measurable baseline`,
      };
    }

    const after = await deps.benchmarkAfter();
    if (!Number.isFinite(after)) {
      return {
        action: "rejected",
        reason: `benchmark result not measurable (benchmarkAfter returned ${String(after)}); cannot confirm improvement`,
      };
    }
    if (after <= before + threshold) {
      return {
        action: "rejected",
        reason: `benchmark did not improve: before ${before}, after ${after}, threshold ${threshold}; one accidental success is insufficient`,
      };
    }

    c.benchmarkScoreBefore = before;
    c.benchmarkScoreAfter = after;
    await deps.persist(c);
    return {
      action: "promoted",
      reason: `benchmark improved from ${before} to ${after} (+${after - before}) and security check passed`,
    };
  }

  /**
   * §70 post-promotion re-evaluation. A current score below the recorded
   * post-promotion score rolls the promotion back; an unmeasurable current
   * score also rolls back (fail-closed: the promotion can no longer be
   * confirmed healthy). Never calls persist.
   */
  async evaluateAfter(
    c: LearningCandidate,
    deps: ReEvaluateDeps,
  ): Promise<PromotionDecision> {
    if (c.benchmarkScoreAfter === undefined) {
      return {
        action: "rejected",
        reason: "no recorded post-promotion score; candidate was never promoted",
      };
    }

    const current = await deps.benchmarkCurrent();
    if (!Number.isFinite(current)) {
      return {
        action: "rolled_back",
        reason: `current score not measurable (${String(current)}); cannot confirm the promotion holds`,
      };
    }
    if (current < c.benchmarkScoreAfter) {
      return {
        action: "rolled_back",
        reason: `score regressed from ${c.benchmarkScoreAfter} to ${current} after promotion`,
      };
    }
    return {
      action: "promoted",
      reason: `current score ${current} still at or above the recorded post-promotion score ${c.benchmarkScoreAfter}`,
    };
  }
}

/**
 * P0-5 LearningPromoter V2: Champion → Candidate → Challenger → repeated
 * paired evaluations → Promotion Gate (plan.md P0-5).
 *
 * Unlike the single-score LearningPromoter (§194: one accidental success is
 * insufficient), V2 compares N paired repeated runs (same seed / comparable
 * configuration per index) through the HarnessScoreCard gate: no significant
 * regression, holdout benefit per candidate kind, no new security violations
 * (hard gate, not tradable), no raised false-complete rate, latency and token
 * use within configured budgets.
 *
 * Nothing is persisted before the gate approves; the security check runs
 * first and short-circuits benchmarks on failure (same contract as V1). On
 * approval the full promotion ledger (§790-797) is written to
 * `candidate.promotionRecord` and `persist` is called once.
 *
 * The §70 rollback path is `reEvaluate`: the current repeated runs are
 * compared against the frozen post-promotion scorecard; any regressed pair or
 * budget breach rolls the promotion back (fail-closed when runs cannot be
 * collected). Rollback never calls persist — undoing the live change is the
 * caller's action, exactly like V1.
 *
 * All side effects flow through the injected deps; there is no filesystem,
 * store, or network access here.
 */
export interface PairedPromotionDecision {
  action: "promoted" | "rejected" | "rolled_back";
  reason: string;
  /** Present whenever a paired evaluation ran (gate details, per metric). */
  report?: PairedComparisonReport;
}

/** Version metadata recorded verbatim into the promotion ledger. */
export interface RecordMeta {
  /** Free-form evaluation configuration (runs, seeds, tolerances, budgets). */
  evaluationConfig?: string;
  /** Suite versions or identifiers of the evaluation. */
  suiteVersions?: string;
  /** Judge logic version of the evaluation. */
  judgeVersion?: string;
  /** Model / provider versions of the evaluation. */
  modelProviderVersion?: string;
}

export interface PairedPromoteDeps {
  securityCheck: (c: LearningCandidate) => Promise<{ ok: boolean; reason?: string }>;
  /** Champion run i (paired seed / comparable configuration per index). */
  championRuns: (runIndex: number) => Promise<HarnessScoreCard>;
  /** Challenger run i — same seed / configuration as champion run i. */
  challengerRuns: (runIndex: number) => Promise<HarnessScoreCard>;
  /** Number of repeated paired runs (must be ≥ MIN_REPEATED_RUNS). */
  runs: number;
  options?: PairedGateOptions;
  /** Version metadata for the promotion ledger (absent → "(not recorded)"). */
  meta?: RecordMeta;
  persist: (c: LearningCandidate) => Promise<void>;
}

export interface PairedReEvaluateDeps {
  /** Current run i of the post-promotion state, N repeated runs. */
  currentRuns: (runIndex: number) => Promise<HarnessScoreCard>;
  /** Number of repeated current runs (must be ≥ MIN_REPEATED_RUNS). */
  runs: number;
  options?: PairedGateOptions;
}

export class LearningPromoterV2 {
  private resolveHoldout(
    kind: LearningCandidate["kind"],
    options: PairedGateOptions | undefined,
  ): "improve" | "no-regress" {
    return options?.holdoutRequirement?.[kind] ?? HOLD_OUT_REQUIREMENT_BY_KIND[kind];
  }

  private collect(
    produce: (runIndex: number) => Promise<HarnessScoreCard>,
    runs: number,
  ): Promise<HarnessScoreCard[]> {
    const cards: Promise<HarnessScoreCard>[] = [];
    for (let i = 0; i < runs; i++) cards.push(produce(i));
    return Promise.all(cards);
  }

  /**
   * Champion/Challenger promotion gate over N paired repeated runs. Runs are
   * only collected after the security check passes; any collection failure
   * rejects (fail-closed) without persisting.
   */
  async promote(
    c: LearningCandidate,
    deps: PairedPromoteDeps,
  ): Promise<PairedPromotionDecision> {
    const security = await deps.securityCheck(c);
    if (!security.ok) {
      return {
        action: "rejected",
        reason: `security check failed${
          security.reason ? `: ${security.reason}` : ""
        }`,
      };
    }

    if (deps.runs < MIN_REPEATED_RUNS) {
      return {
        action: "rejected",
        reason: `repeated paired evaluations require at least ${MIN_REPEATED_RUNS} runs (got ${deps.runs}); one sample is insufficient`,
      };
    }

    let champion: HarnessScoreCard[];
    try {
      champion = await this.collect(deps.championRuns, deps.runs);
    } catch (e) {
      return {
        action: "rejected",
        reason: `champion evaluation failed (${errorMessage(e)}); no baseline established`,
      };
    }
    let challenger: HarnessScoreCard[];
    try {
      challenger = await this.collect(deps.challengerRuns, deps.runs);
    } catch (e) {
      return {
        action: "rejected",
        reason: `challenger evaluation failed (${errorMessage(e)}); cannot confirm improvement`,
      };
    }

    const report = comparePaired(champion, challenger, {
      ...deps.options,
      holdout: this.resolveHoldout(c.kind, deps.options),
    });

    if (report.overall === "reject") {
      return {
        action: "rejected",
        reason: `promotion gate rejected: ${report.reasons.join("; ")}`,
        report,
      };
    }

    const before = medianCard(champion);
    const after = medianCard(challenger);
    c.promotionRecord = {
      candidateVersion: c.version ?? "unversioned",
      beforeScorecard: before,
      afterScorecard: after,
      evaluationConfig: deps.meta?.evaluationConfig ?? "(not recorded)",
      suiteVersions: deps.meta?.suiteVersions ?? "(not recorded)",
      judgeVersion: deps.meta?.judgeVersion ?? "(not recorded)",
      modelProviderVersion: deps.meta?.modelProviderVersion ?? "(not recorded)",
    };
    await deps.persist(c);
    return {
      action: "promoted",
      reason: `promotion gate passed over ${deps.runs} paired runs (holdout ${this.resolveHoldout(c.kind, deps.options)}): regression held, no new security violations, budgets respected`,
      report,
    };
  }

  /**
   * §70/§777-797 periodic rollback re-evaluation: the current repeated runs
   * must still hold against the frozen post-promotion scorecard. Any run
   * pair with more security violations or a raised false-complete rate, any
   * median regression beyond tolerance, or any budget breach rolls the
   * promotion back. Unmeasurable current runs also roll back (fail-closed:
   * the promotion can no longer be confirmed healthy). Never calls persist.
   */
  async reEvaluate(
    c: LearningCandidate,
    deps: PairedReEvaluateDeps,
  ): Promise<PairedPromotionDecision> {
    if (c.promotionRecord === undefined) {
      return {
        action: "rejected",
        reason: "no promotion record; candidate was never promoted",
      };
    }

    if (deps.runs < MIN_REPEATED_RUNS) {
      return {
        action: "rolled_back",
        reason: `repeated re-evaluation requires at least ${MIN_REPEATED_RUNS} runs (got ${deps.runs}); cannot confirm the promotion holds`,
      };
    }

    let current: HarnessScoreCard[];
    try {
      current = await this.collect(deps.currentRuns, deps.runs);
    } catch (e) {
      return {
        action: "rolled_back",
        reason: `current evaluation failed (${errorMessage(e)}); cannot confirm the promotion holds`,
      };
    }

    const report = compareVsReference(c.promotionRecord.afterScorecard, current, {
      ...deps.options,
      // Rollback re-checks whether the promotion HOLDS: the current scorecard
      // must not regress below the recorded post-promotion one. The positive
      // holdout requirement applies at promotion time, never here — a
      // promotion can only hold or fail to hold.
      holdout: "no-regress",
    });

    if (report.overall === "reject") {
      return {
        action: "rolled_back",
        reason: `regression detected after promotion: ${report.reasons.join("; ")}`,
        report,
      };
    }
    return {
      action: "promoted",
      reason: `current scorecard still holds the promotion over ${deps.runs} repeated runs`,
      report,
    };
  }
}
