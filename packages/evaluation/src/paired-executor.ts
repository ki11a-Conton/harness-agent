/**
 * E3-02 — PairedExperimentExecutor: schedules baseline/candidate arms of every
 * pair in plan order, runs each through a real arm runner, records three
 * distinct counters (logical runs, model-call attempts, transport retries),
 * journals per arm atomically, and supports resume with plan-digest
 * verification.
 *
 * The executor is PURE in its scheduling logic (no provider calls of its own).
 * It takes an injected `runArm` callback that the CLI wires to the real
 * harness (runOneCase). The counting/limit ModelClient wrapper is the single
 * point where budget enforcement happens.
 *
 * Key invariants:
 *   - repeat=N → exactly N independent repetitions per case per arm.
 *   - Promotion decisions consume ONLY finalizedPairs (both arms valid).
 *   - A half pair (one arm only) is never scored.
 *   - Resume with a different plan digest is rejected.
 *   - Randomized order is controlled ONLY by orderSeed; modelSeed is stored
 *     separately and never affects the schedule.
 *   - max-model-calls stops immediately and produces a partial invalid artifact.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelProvider, ModelRequest, ProviderConfig, ModelRef } from "@ar/contracts";
import type { RunMetrics } from "@ar/observability";
import { computePairedPlanDigest, type ArmName, type ArmOrder, type ArmRunRef, type PairedExperimentPlan, type PairedPair } from "./paired-plan.js";
import {
  computeExecutionIdentityDigestV1,
  executionIdentityViolationsV1,
  PAIRED_EXECUTION_IDENTITY_SCHEMA_VERSION,
  type PairedExecutionIdentityV1,
} from "./paired-execution-identity.js";
import type { EvalOutcome } from "./runner.js";
import type { BenchmarkCase } from "./baseline.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const PAIRED_EXECUTOR_SCHEMA_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

export interface PairedCounters {
  /** Number of independent logical arm runs scheduled (1 per arm, never
   *  incremented by retries). */
  logicalRuns: number;
  /** Every ModelClient.generate() invocation (model call attempt). */
  modelCallAttempts: number;
  /** Every transport-level retry event within generate() (attempt, not a
   *  new sample). */
  transportRetries: number;
  /** Hard cap on modelCallAttempts (0 = unlimited). */
  maxModelCalls: number;
}

/** Mutable working budget the executor and the counting provider share. */
export interface PairedBudget extends PairedCounters {
  /** Set by the budgeted provider when a generate() is refused due to cap. */
  hitCap: boolean;
  exhausted(): boolean;
}

/** Create the shared mutable budget. */
function createBudget(maxModelCalls: number): PairedBudget {
  return {
    logicalRuns: 0,
    modelCallAttempts: 0,
    transportRetries: 0,
    maxModelCalls,
    hitCap: false,
    exhausted() {
      return this.maxModelCalls > 0 && this.modelCallAttempts >= this.maxModelCalls;
    },
  };
}

// ---------------------------------------------------------------------------
// Arm run identity
// ---------------------------------------------------------------------------

/** Stable, filesystem-safe arm run id. */
export function armRunIdOf(pairId: string, armId: string): string {
  return `${pairId}-${armId}`;
}

// ---------------------------------------------------------------------------
// Arm strict validity
// ---------------------------------------------------------------------------

const INVALID_FAILURE_CATEGORIES = new Set(["infrastructure", "harness", "judge", "model"]);

/** An arm is "strict-valid" when it represents a genuine measurement (not an
 *  infrastructure/harness/judge/model-provider failure). A clean task failure
 *  (model stopped without completing) IS valid — it is a real behavioral
 *  outcome. */
export function isStrictValidArm(outcome: EvalOutcome): boolean {
  if (outcome.status === "error") return false;
  if (outcome.failureCategory !== undefined && INVALID_FAILURE_CATEGORIES.has(outcome.failureCategory)) return false;
  if (outcome.terminationReason === "model_error") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Budgeted ModelClient wrapper
// ---------------------------------------------------------------------------

/** Wrap a ModelProvider so every generate() increments modelCallAttempts,
 *  counts retry transport events, and throws when the budget is exhausted.
 *  The wrapper is a SINGLE overall budget — shared across all arms. */
export function createBudgetedProvider(provider: ModelProvider, budget: PairedBudget): ModelProvider {
  return {
    id: provider.id,
    async listModels() {
      return provider.listModels();
    },
    createClient(model: ModelRef, config: ProviderConfig) {
      const inner = provider.createClient(model, config);
      return {
        async *generate(request: ModelRequest, signal: AbortSignal) {
          if (budget.exhausted()) {
            budget.hitCap = true;
            throw new Error(
              `PairedExperimentExecutor: model-call budget exhausted (${budget.modelCallAttempts} >= ${budget.maxModelCalls})`,
            );
          }
          budget.modelCallAttempts += 1;
          for await (const ev of inner.generate(request, signal)) {
            if (ev.type === "retry") {
              budget.transportRetries += 1;
            }
            yield ev;
          }
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Ordered run list
// ---------------------------------------------------------------------------

export interface OrderedArmRun {
  orderIndex: number;
  pairId: string;
  armId: ArmName;
  caseId: string;
  repetition: number;
}

/** Build the flat ordered list of arm runs, sorted by global orderIndex. The
 *  orderIndex on each arm ref already reflects the pair's AB/BA order, so
 *  sorting by orderIndex gives the true execution sequence. */
export function orderedArmRuns(plan: PairedExperimentPlan): Array<{ pair: PairedPair; arm: ArmRunRef }> {
  const runs: Array<{ pair: PairedPair; arm: ArmRunRef }> = [];
  for (const pair of plan.pairs) {
    runs.push({ pair, arm: pair.baseline });
    runs.push({ pair, arm: pair.candidate });
  }
  runs.sort((a, b) => a.arm.orderIndex - b.arm.orderIndex);
  return runs;
}

export function orderedArmRunsFlat(plan: PairedExperimentPlan): OrderedArmRun[] {
  return orderedArmRuns(plan).map((run) => ({
    orderIndex: run.arm.orderIndex,
    pairId: run.pair.pairId,
    armId: run.arm.armId,
    caseId: run.arm.caseId,
    repetition: run.arm.repetition,
  }));
}

// ---------------------------------------------------------------------------
// Helper: empty metrics
// ---------------------------------------------------------------------------

function emptyRunMetrics(): RunMetrics {
  return {
    turn_count: 0,
    tool_call_count: 0,
    tokens_input: 0,
    tokens_output: 0,
    context_tokens: 0,
    compaction_count: 0,
    duration_ms: 0,
    retry_count: 0,
    verification_failures: 0,
    human_interventions: 0,
    estimated_cost: 0,
    usage_unknown: 0,
    cache_tokens_read: 0,
    cache_tokens_created: 0,
    model_call_count: 0,
  };
}

function infraOutcome(arm: ArmRunRef, err: unknown): EvalOutcome {
  return {
    caseId: arm.caseId,
    status: "error",
    actualStatus: "error",
    events: [],
    metrics: emptyRunMetrics(),
    violations: [],
    reason: err instanceof Error ? err.message : String(err),
    failureCategory: "infrastructure",
    suite: "regression",
    judgeVersion: "1.0.0",
  };
}

// ---------------------------------------------------------------------------
// Arm runner
// ---------------------------------------------------------------------------

export interface PairedArmContext {
  /** The budgeted/counting provider — use this for the arm's harness. */
  provider: ModelProvider;
  /** The shared execution budget. */
  budget: PairedBudget;
  /** Stable arm run id (shared by transport retries within the same arm). */
  armRunId: string;
}

export type PairedArmRunner = (
  arm: ArmRunRef,
  caseDef: BenchmarkCase,
  ctx: PairedArmContext,
) => Promise<EvalOutcome>;

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

export interface PairedJournalEntry {
  schemaVersion: string;
  planDigest: string;
  armRunId: string;
  pairId: string;
  arm: ArmRunRef;
  outcome: EvalOutcome;
  valid: boolean;
  modelCallAttempts: number;
  transportRetries: number;
  completedAt: number;
}

async function loadJournal(dir: string): Promise<{
  planDigest: string | null;
  entries: Map<string, PairedJournalEntry>;
}> {
  const entries = new Map<string, PairedJournalEntry>();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return { planDigest: null, entries };
  }
  let planDigest: string | null = null;
  for (const f of files) {
    if (!f.endsWith(".json") || f.startsWith(".tmp-")) continue;
    try {
      const raw = await readFile(join(dir, f), "utf8");
      const entry = JSON.parse(raw) as PairedJournalEntry;
      if (typeof entry.planDigest === "string") planDigest = entry.planDigest;
      if (entry.armRunId) entries.set(entry.armRunId, entry);
    } catch (err) {
      process.stderr.write(`[degraded] paired-executor.journal.corrupt: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return { planDigest, entries };
}

// ---------------------------------------------------------------------------
// E4-R01 — journal identity header
//
// A journal directory is only valid for the exact experiment that wrote it. The
// header records that experiment's full execution identity; a resume verifies it
// BEFORE any provider is created or called. A journal with no header (written
// before this fix, or partially written) is refused and left on disk for
// diagnosis rather than trusted.
// ---------------------------------------------------------------------------

const IDENTITY_HEADER_FILE = "identity.json";

interface JournalIdentityHeaderV1 {
  schemaVersion: typeof PAIRED_EXECUTION_IDENTITY_SCHEMA_VERSION;
  identity: PairedExecutionIdentityV1;
  identityDigest: string;
  writtenAt: number;
}

async function readJournalIdentityHeader(dir: string): Promise<JournalIdentityHeaderV1 | null> {
  let raw: string;
  try {
    raw = await readFile(join(dir, IDENTITY_HEADER_FILE), "utf8");
  } catch (err) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") return null;
    process.stderr.write(
      `[degraded] paired-executor.journal.identity-unreadable: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
  try {
    return JSON.parse(raw) as JournalIdentityHeaderV1;
  } catch (err) {
    process.stderr.write(
      `[degraded] paired-executor.journal.identity-malformed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

async function writeJournalIdentityHeader(dir: string, header: JournalIdentityHeaderV1): Promise<void> {
  const target = join(dir, IDENTITY_HEADER_FILE);
  const tmp = join(dir, `.tmp-identity-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  await writeFile(tmp, JSON.stringify(header, null, 2) + "\n", "utf8");
  await rm(target, { force: true }).catch((err: unknown) => {
    process.stderr.write(`[degraded] paired-executor.journal.identity-cleanup: ${String(err)}\n`);
  });
  await rename(tmp, target);
}

async function writeJournalEntry(dir: string, entry: PairedJournalEntry): Promise<void> {
  const target = join(dir, `${entry.armRunId}.json`);
  // Atomic write: write to temp then rename. On Windows, rename over existing
  // fails, so remove the target first (best-effort).
  const tmp = join(dir, `.tmp-${entry.armRunId}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  await writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  await rm(target, { force: true }).catch((err: unknown) => {
    process.stderr.write(`[degraded] paired-executor.journal.cleanup: ${err instanceof Error ? err.message : String(err)}\n`);
  });
  await rename(tmp, target);
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface PairedArmRecord {
  arm: ArmRunRef;
  valid: boolean;
  outcome: EvalOutcome;
  modelCallAttempts: number;
  transportRetries: number;
}

export interface PairedFinalizedPair {
  pairId: string;
  caseId: string;
  repetition: number;
  order: ArmOrder;
  baseline: PairedArmRecord;
  candidate: PairedArmRecord;
}

export interface PairedPartialPair {
  pairId: string;
  caseId: string;
  repetition: number;
  order: ArmOrder;
  baseline: PairedArmRecord | null;
  candidate: PairedArmRecord | null;
  /** Why this pair is partial: "half-pair" (one arm only) or "invalid-arm"
   *  (both present but not both valid). */
  reason: "half-pair" | "invalid-arm";
}

export type PairedExperimentRunResult =
  | {
      status: "ok";
      schemaVersion: string;
      plan: PairedExperimentPlan;
      planDigest: string;
      counters: PairedCounters;
      orderedRuns: OrderedArmRun[];
      finalizedPairs: PairedFinalizedPair[];
      partialPairs: PairedPartialPair[];
      haltedByBudget: boolean;
      interrupted: boolean;
      resumed: boolean;
      complete: boolean;
      modelSeed: number | null;
    }
  | {
      status: "resume-rejected";
      reason: string;
      planDigest: string;
      /** E4-R01: which identity fields differed (never secret material). */
      violations?: string[];
    };

// ---------------------------------------------------------------------------
// Pair finalization
// ---------------------------------------------------------------------------

function finalizePairs(
  plan: PairedExperimentPlan,
  completed: Map<string, { outcome: EvalOutcome; valid: boolean; modelCallAttempts: number; transportRetries: number }>,
): { finalizedPairs: PairedFinalizedPair[]; partialPairs: PairedPartialPair[] } {
  const finalizedPairs: PairedFinalizedPair[] = [];
  const partialPairs: PairedPartialPair[] = [];

  for (const pair of plan.pairs) {
    const bKey = armRunIdOf(pair.pairId, "baseline");
    const cKey = armRunIdOf(pair.pairId, "candidate");
    const b = completed.get(bKey);
    const c = completed.get(cKey);

    // Both arms present and both valid → finalized.
    if (b !== undefined && c !== undefined && b.valid && c.valid) {
      finalizedPairs.push({
        pairId: pair.pairId,
        caseId: pair.caseId,
        repetition: pair.repetition,
        order: pair.order,
        baseline: { arm: pair.baseline, valid: true, outcome: b.outcome, modelCallAttempts: b.modelCallAttempts, transportRetries: b.transportRetries },
        candidate: { arm: pair.candidate, valid: true, outcome: c.outcome, modelCallAttempts: c.modelCallAttempts, transportRetries: c.transportRetries },
      });
      continue;
    }

    // Check if either arm is present at all.
    const hasB = b !== undefined;
    const hasC = c !== undefined;
    if (!hasB && !hasC) continue; // unrun pair — not reported

    // Partial: at least one arm present, but not both valid.
    partialPairs.push({
      pairId: pair.pairId,
      caseId: pair.caseId,
      repetition: pair.repetition,
      order: pair.order,
      baseline: hasB ? { arm: pair.baseline, valid: b!.valid, outcome: b!.outcome, modelCallAttempts: b!.modelCallAttempts, transportRetries: b!.transportRetries } : null,
      candidate: hasC ? { arm: pair.candidate, valid: c!.valid, outcome: c!.outcome, modelCallAttempts: c!.modelCallAttempts, transportRetries: c!.transportRetries } : null,
      reason: (hasB && hasC) ? "invalid-arm" : "half-pair",
    });
  }

  return { finalizedPairs, partialPairs };
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

export interface PairedExecutorOptions {
  /** The deterministic plan. */
  plan: PairedExperimentPlan;
  /** Benchmark case definitions (indexed by id). */
  cases: BenchmarkCase[];
  /** The real model provider (will be wrapped with a budgeted layer). */
  provider: ModelProvider;
  /** How to run one arm of a pair. */
  runArm: PairedArmRunner;
  /** Hard cap on model call attempts (0 = unlimited). */
  maxModelCalls?: number;
  /** Directory for atomic per-arm journal entries. Default: no journaling. */
  journalDir?: string;
  /** Model seed — stored separately from orderSeed; never affects schedule. */
  modelSeed?: number | null;
  /** Observability hook fired after each arm completes. Throw from this hook
   *  to simulate a crash (journal entries persist, executor stops). */
  onArmCompleted?: (info: { armRunId: string; arm: ArmRunRef; pairId: string; logicalRuns: number }) => void | Promise<void>;
  /**
   * E4-R01: the full execution identity of THIS experiment. When a journalDir is
   * used, it is recorded in the journal header and verified field-by-field
   * before any provider is created or called, so a journal from a different
   * candidate / model / case content / source / policy / isolation posture can
   * never be resumed into this experiment.
   */
  identity?: PairedExecutionIdentityV1;
}

export async function runPairedExperiment(opts: PairedExecutorOptions): Promise<PairedExperimentRunResult> {
  const { plan, cases, runArm, provider, maxModelCalls = 0, journalDir, modelSeed = null, onArmCompleted, identity } = opts;
  const planDigest = computePairedPlanDigest(plan);
  const caseById = new Map(cases.map((c) => [c.id, c]));
  const budget = createBudget(maxModelCalls);

  // ---- E4-R01: verify the journal's execution identity BEFORE any provider ----
  // The provider must not be created (let alone called) for an experiment whose
  // journal turns out to belong to a different run.
  let journal = new Map<string, PairedJournalEntry>();
  let resumed = false;
  const identityDigest = identity !== undefined ? computeExecutionIdentityDigestV1(identity) : null;
  if (journalDir !== undefined) {
    await mkdir(journalDir, { recursive: true });
    const header = await readJournalIdentityHeader(journalDir);
    const loaded = await loadJournal(journalDir);
    if (loaded.entries.size > 0 || header !== null) {
      if (identity === undefined || identityDigest === null) {
        return {
          status: "resume-rejected",
          reason: "journal exists but this run supplied no execution identity — refusing to resume without identity verification",
          planDigest,
          violations: ["identity not supplied"],
        };
      }
      const violations = executionIdentityViolationsV1(header?.identity, identity);
      if (violations.length > 0) {
        return {
          status: "resume-rejected",
          reason: `journal execution identity does not match this experiment (${String(violations.length)} field(s)) — refusing to mix journals; the existing journal is left untouched for diagnosis`,
          planDigest,
          violations,
        };
      }
      // Belt and braces: the schedule digest is one identity component, so a
      // header match implies it, but keep the cheap independent check.
      if (loaded.planDigest !== null && loaded.planDigest !== planDigest) {
        return {
          status: "resume-rejected",
          reason: `journal plan digest (${loaded.planDigest}) does not match current plan digest (${planDigest}) — refusing to resume a different experiment`,
          planDigest,
          violations: ["scheduleDigest"],
        };
      }
      if (header !== null && identityDigest !== null && header.identityDigest !== identityDigest) {
        return {
          status: "resume-rejected",
          reason: "journal identity digest does not match this experiment's computed identity digest",
          planDigest,
          violations: ["identityDigest mismatch"],
        };
      }
      journal = loaded.entries;
      resumed = journal.size > 0;
      // Budget is CUMULATIVE across resumes: previously consumed calls are
      // re-counted here so a new process cannot re-spend an already-granted
      // allowance. Extra budget requires a deliberately new authorized plan.
      for (const e of journal.values()) {
        budget.logicalRuns += 1;
        budget.modelCallAttempts += e.modelCallAttempts;
        budget.transportRetries += e.transportRetries;
      }
    } else if (identity !== undefined && identityDigest !== null) {
      await writeJournalIdentityHeader(journalDir, {
        schemaVersion: PAIRED_EXECUTION_IDENTITY_SCHEMA_VERSION,
        identity,
        identityDigest,
        writtenAt: Date.now(),
      });
    }
  }

  const budgetedProvider = createBudgetedProvider(provider, budget);

  // ---- Ordered execution ----
  const ordered = orderedArmRuns(plan);
  const completed = new Map<string, { outcome: EvalOutcome; valid: boolean; modelCallAttempts: number; transportRetries: number }>();
  let haltedByBudget = false;
  let interrupted = false;

  for (const run of ordered) {
    const { pair, arm } = run;
    const armRunId = armRunIdOf(pair.pairId, arm.armId);

    // Skip already-journaled valid arms.
    const existing = journal.get(armRunId);
    if (existing !== undefined) {
      completed.set(armRunId, {
        outcome: existing.outcome,
        valid: existing.valid,
        modelCallAttempts: existing.modelCallAttempts,
        transportRetries: existing.transportRetries,
      });
      continue;
    }

    // Check budget before starting a new arm.
    if (budget.exhausted()) {
      haltedByBudget = true;
      interrupted = true;
      break;
    }

    const caseDef = caseById.get(arm.caseId);
    if (caseDef === undefined) {
      // Unknown case in the plan — mark arm invalid, continue.
      const outcome = infraOutcome(arm, new Error(`no case def for "${arm.caseId}"`));
      completed.set(armRunId, { outcome, valid: false, modelCallAttempts: 0, transportRetries: 0 });
      if (journalDir !== undefined) {
        await writeJournalEntry(journalDir, {
          schemaVersion: PAIRED_EXECUTOR_SCHEMA_VERSION,
          planDigest,
          armRunId,
          pairId: pair.pairId,
          arm,
          outcome,
          valid: false,
          modelCallAttempts: 0,
          transportRetries: 0,
          completedAt: Date.now(),
        });
      }
      continue;
    }

    // Run the arm.
    const before = { modelCallAttempts: budget.modelCallAttempts, transportRetries: budget.transportRetries };
    budget.hitCap = false;
    let outcome: EvalOutcome;
    try {
      outcome = await runArm(arm, caseDef, { provider: budgetedProvider, budget, armRunId });
    } catch (err) {
      outcome = infraOutcome(arm, err);
    }
    const modelCallsDelta = budget.modelCallAttempts - before.modelCallAttempts;
    const retriesDelta = budget.transportRetries - before.transportRetries;
    const armHaltedByBudget = budget.hitCap;
    const valid = !armHaltedByBudget && isStrictValidArm(outcome);
    budget.logicalRuns += 1;
    completed.set(armRunId, { outcome, valid, modelCallAttempts: modelCallsDelta, transportRetries: retriesDelta });

    // Write journal entry (atomic).
    if (journalDir !== undefined) {
      await writeJournalEntry(journalDir, {
        schemaVersion: PAIRED_EXECUTOR_SCHEMA_VERSION,
        planDigest,
        armRunId,
        pairId: pair.pairId,
        arm,
        outcome,
        valid,
        modelCallAttempts: modelCallsDelta,
        transportRetries: retriesDelta,
        completedAt: Date.now(),
      });
    }

    // Observability hook (throw to simulate a crash).
    if (onArmCompleted !== undefined) {
      await onArmCompleted({ armRunId, arm, pairId: pair.pairId, logicalRuns: budget.logicalRuns });
    }

    // Check budget after the arm.
    if (budget.exhausted() || budget.hitCap) {
      haltedByBudget = true;
      interrupted = true;
      break;
    }
  }

  // ---- Finalize pairs ----
  const { finalizedPairs, partialPairs } = finalizePairs(plan, completed);

  return {
    status: "ok",
    schemaVersion: PAIRED_EXECUTOR_SCHEMA_VERSION,
    plan,
    planDigest,
    counters: {
      logicalRuns: budget.logicalRuns,
      modelCallAttempts: budget.modelCallAttempts,
      transportRetries: budget.transportRetries,
      maxModelCalls: budget.maxModelCalls,
    },
    orderedRuns: orderedArmRunsFlat(plan),
    finalizedPairs,
    partialPairs,
    haltedByBudget,
    interrupted,
    resumed,
    complete: !interrupted && finalizedPairs.length === plan.pairs.length && partialPairs.length === 0,
    modelSeed,
  };
}