/**
 * P3-12 — Scheduler Policy Learning.
 *
 * A mechanism-CANDIDATE experiment (no main-runtime refactor). A scheduler
 * policy tunes (plan.md P3-12):
 *
 *   maxConcurrent          how many children run at once
 *   childBudgetAllocation  how the token/effort budget is split among children
 *   queueFairness          whether pending children are served fairly
 *
 * A policy may be promoted ONLY after the STRESS suite proves it stable: the
 * adversarial/stress split must not regress (no new security violations, no
 * raised false-complete, bounded latency/tokens). A policy that improves
 * throughput but destabilises the stress suite is rejected.
 *
 * The challenger is a deterministic, seeded effect model over measured
 * outcomes — nothing is fabricated.
 */

export interface SchedulerPolicy {
  name: string;
  maxConcurrent: number;
  childBudgetAllocation: "equal" | "priority" | "greedy";
  queueFairness: boolean;
}

/** Outcome of running a policy over the stress suite. */
export interface ScheduleStressResult {
  policyName: string;
  /** Pass rate on the stress split. */
  stressPassRate: number;
  securityViolations: number;
  falseCompletes: number;
  p95LatencyMs: number;
  totalTokens: number;
}

export interface SchedulerDecision {
  promotedName: string | null;
  keepChampion: boolean;
  reasons: string[];
}

export interface SchedulerGateOptions {
  maxSecurityViolations?: number;
  maxFalseCompletes?: number;
  p95LatencyMsBudget?: number;
  tokenBudget?: number;
  minimumStressLift?: number;
}

/** Pre-promotion stress gate: a policy must keep the stress suite stable. A
 *  policy that spikes security violations / false-completes / latency / tokens
 *  is never promoted, even if its nominal pass rate looks good. */
export function stressStable(
  r: ScheduleStressResult,
  budgets: SchedulerGateOptions = {},
): { stable: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const maxSec = budgets.maxSecurityViolations ?? 0;
  const maxFalse = budgets.maxFalseCompletes ?? 0;
  const latBudget = budgets.p95LatencyMsBudget ?? Infinity;
  const tokBudget = budgets.tokenBudget ?? Infinity;
  if (r.securityViolations > maxSec) reasons.push(`security violations ${r.securityViolations} > ${maxSec}`);
  if (r.falseCompletes > maxFalse) reasons.push(`false completes ${r.falseCompletes} > ${maxFalse}`);
  if (r.p95LatencyMs > latBudget) reasons.push(`p95 latency ${r.p95LatencyMs}ms > ${latBudget}ms`);
  if (r.totalTokens > tokBudget) reasons.push(`tokens ${r.totalTokens} > ${tokBudget}`);
  return { stable: reasons.length === 0, reasons };
}

/** Choose the best scheduler policy: it must clear the stress-stability gate
 *  AND beat the champion's stress pass rate by the minimum lift. No instability
 *  → no promotion, regardless of throughput. */
export function chooseBestSchedulerPolicy(
  champion: ScheduleStressResult,
  candidates: ScheduleStressResult[],
  budgets: SchedulerGateOptions = {},
): SchedulerDecision {
  const minLift = budgets.minimumStressLift ?? 0;
  const reasons: string[] = [];
  const eligible: ScheduleStressResult[] = [];
  for (const c of candidates) {
    const { stable, reasons: why } = stressStable(c, budgets);
    if (!stable) {
      reasons.push(`${c.policyName} unstable: ${why.join(", ")}`);
      continue;
    }
    // Must STRICTLY beat the champion: an equal stress pass rate is never enough.
    if (c.stressPassRate <= champion.stressPassRate || c.stressPassRate - champion.stressPassRate < minLift) {
      reasons.push(`${c.policyName} does not lift stress pass rate above the champion`);
      continue;
    }
    eligible.push(c);
  }
  if (eligible.length === 0) {
    reasons.push("no scheduler policy is stress-stable and beats the champion; champion kept");
    return { promotedName: null, keepChampion: true, reasons };
  }
  let best = eligible[0]!;
  for (const c of eligible.slice(1)) {
    if (c.stressPassRate > best.stressPassRate) best = c;
    else if (c.stressPassRate === best.stressPassRate && c.totalTokens < best.totalTokens) best = c;
  }
  reasons.push(`promoted stress-stable scheduler policy: ${best.policyName}`);
  return { promotedName: best.policyName, keepChampion: false, reasons };
}

export function renderSchedulerDecision(
  results: ScheduleStressResult[],
  decision: SchedulerDecision,
): string {
  const lines = ["Scheduler Policy Learning", `promoted: ${decision.promotedName ?? "champion kept"}`];
  for (const r of results) {
    lines.push(
      `  ${r.policyName}  stressPass=${round(r.stressPassRate, 3)}  sec=${r.securityViolations}  fc=${r.falseCompletes}  p95=${r.p95LatencyMs}ms`,
    );
  }
  lines.push(`  reasons  ${decision.reasons.join("; ")}`);
  return lines.join("\n");
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}