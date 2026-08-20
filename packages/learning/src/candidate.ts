import type { HarnessScoreCard } from "./scorecard.js";

/**
 * §69 learning candidate types. A candidate is the unit the learning pipeline
 * proposes for promotion (trace → outcome → reflection → candidate →
 * evaluation → promotion); it is always produced by reflection/evaluation and
 * never written anywhere before the §147 promotion gate approves it.
 *
 * P0-5 adds the tuning kinds (context_policy / retry_policy /
 * scheduler_policy) with distinct holdout requirements in the paired gate.
 */
export type LearningCandidateKind =
  | "memory"
  | "skill"
  | "workflow"
  | "tool_preference"
  | "prompt_rule"
  | "context_policy"
  | "retry_policy"
  | "scheduler_policy";

/**
 * P0-5 rollback ledger (plan.md §790-797): everything that must be recorded
 * when a promotion happens, so a later re-evaluation can judge the promotion
 * against the same evidence and roll it back on regression. Fields the
 * evaluation stack cannot express are recorded as "(not recorded)" — never
 * fabricated.
 */
export interface PromotionRecord {
  /** Candidate version at promotion time (LearningCandidate.version). */
  candidateVersion: string;
  /** Median champion scorecard over the repeated runs before promotion. */
  beforeScorecard: HarnessScoreCard;
  /** Median challenger scorecard over the repeated runs at promotion. */
  afterScorecard: HarnessScoreCard;
  /** Evaluation configuration (runs, seeds, tolerances, budgets, ...). */
  evaluationConfig: string;
  /** Suite versions or identifiers the scorecards were computed from. */
  suiteVersions: string;
  /** Judge logic version used by the evaluation. */
  judgeVersion: string;
  /** Model / provider versions used by the evaluation. */
  modelProviderVersion: string;
}

export interface LearningCandidate {
  id: string;
  kind: LearningCandidateKind;
  content: string;
  /** Reflection output that produced this candidate, when known (§69 pipeline). */
  sourceReflectionId?: string;
  /**
   * Measured benchmark score before promotion. Recorded by the promoter on a
   * successful promotion; undefined means no baseline has been established.
   */
  benchmarkScoreBefore?: number;
  /** Measured benchmark score at promotion time (recorded by the promoter). */
  benchmarkScoreAfter?: number;
  /** Candidate version; recorded in the promotion ledger when promoted. */
  version?: string;
  /**
   * P0-5 promotion ledger. Set only by LearningPromoterV2 on a successful
   * champion/challenger promotion; consumed by reEvaluatePaired rollback.
   */
  promotionRecord?: PromotionRecord;
  proposedAt: number;
  securityChecked: boolean;
}