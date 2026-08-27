import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { DEFAULT_JUDGE_VERSION } from "./baseline.js";

/**
 * Benchmark run manifest (plan.md P0-6). Every benchmark run records enough
 * identity that a reported result can be reproduced and attributed:
 *
 * - gitSha / dirty: the harness source revision the run executed against.
 *   `null` means the information was not available (e.g. not a git checkout);
 *   `dirty: false` is a real answer, `dirty: null` means unknown.
 * - model / provider / temperature: the exact model invocation. `temperature`
 *   is `null` when the run did not set one explicitly (provider default).
 * - suiteVersion: the version of the benchmark suite definitions.
 * - judgeVersion: the judge logic version (the case's own judgeVersion wins;
 *   the manifest records the version the harness defaulted to).
 * - runtimeConfigHash: sha256 over the stable-serialized harness runtime
 *   configuration — two runs with the same hash executed the same runtime
 *   wiring (permissions / sandbox / context budget / tool set / limits).
 * - timestamp / platform / nodeVersion: when and where the run happened.
 */
export interface RunManifest {
  gitSha: string | null;
  dirty: boolean | null;
  model: string;
  provider: string;
  temperature: number | null;
  suiteVersion: string;
  judgeVersion: string;
  runtimeConfigHash: string;
  timestamp: string;
  platform: string;
  nodeVersion: string;
  /** P21-1: harness profile the run executed under (interactive / batch /
   *  benchmark / champion …) — two runs under DIFFERENT profiles are never
   *  compared as if the harness were the same. */
  profile: string;
  /** P21-1: effective feature-flag snapshot (context/memory/delegation/…).
   *  A baseline vs candidate comparison is only valid when features differ
   *  BY DESIGN (the candidate under test), never by accident. */
  features: Record<string, boolean>;
  /** P21-1: context budget (tokens) the run used; null = not pinned. */
  contextBudgetTokens: number | null;
  /** P21-1: the task suites this run executed (regression/holdout/…). */
  taskSuites: string[];
  /** P21-1: PRNG seed when the run fixed one (provider/order reproducible);
   *  null = not seeded. */
  randomSeed: number | null;
  /** P38.3-10: challenger candidate id (undefined/null = champion baseline).
   *  Recorded in provenance so a baseline vs candidate comparison can never
   *  be mistaken for two identical runs. */
  candidate: string | null;
  /** P38.3-10: effective wiring manifest — the ACTUAL runtime configuration
   *  this run executed (candidate, mechanisms, tool set, hashes). Optional
   *  for backward compatibility with older reports. */
  effectiveConfig?: BenchmarkEffectiveConfig;
}

/** Suite definition version. P0-6 adds the integrity layer (manifest, failure
 *  classification, ordered execution) on top of the Phase 6.5 four-suite split;
 *  bump when the suite definitions or their judging semantics change. */
export const BENCHMARK_SUITE_VERSION = "2.1.0";

/**
 * P38.3-10 — effective wiring manifest. The benchmark runner dynamically
 * changes runtime wiring per case (mechanisms turned on only when a case
 * requires them) and per candidate (challenger features). This object records
 * the ACTUAL configuration a run executed, so a reviewer can reproduce or
 * reject a comparison from the manifest alone.
 */
export interface BenchmarkEffectiveConfig {
  /** Challenger candidate id; null = champion baseline. */
  candidate: string | null;
  provider: string;
  model: string;
  temperature: number | null;
  context: {
    maxTokens: number;
    /** P38-EVOLUTION: dynamic headroom granted by adaptive_context_policy. */
    dynamic: number;
  };
  recovery: {
    /** P38-EVOLUTION: adaptive recovery planner wired (adaptive_recovery). */
    adaptive: boolean;
  };
  /** Mechanisms actually wired for this run/case. */
  mechanisms: {
    memory: boolean;
    subagent: boolean;
    scheduler: boolean;
    mcp: boolean;
    deferredSchema: boolean;
  };
  /** Effective model-visible tool set (normalized, sorted). */
  tools: string[];
  /** sha256 over the stable-serialized normalized tool set. */
  toolSetHash: string;
  /** sha256 over the stable-serialized full effective config (without the
   *  hash fields themselves — see buildEffectiveConfig). */
  runtimeConfigHash: string;
}

/** The effective config as serialized for hashing: runtimeConfigHash and
 *  toolSetHash are computed FROM this projection, never included in it. */
export type EffectiveConfigHashInput = Omit<
  BenchmarkEffectiveConfig,
  "toolSetHash" | "runtimeConfigHash"
>;

/**
 * Build the full effective config for one run/case. Normalizes the tool set
 * (sort + dedupe — order is semantically irrelevant), computes toolSetHash,
 * then runtimeConfigHash over the stable-serialized config (WITHOUT the hash
 * fields, so the hash is a pure function of the wiring).
 */
export function buildEffectiveConfig(input: EffectiveConfigHashInput): BenchmarkEffectiveConfig {
  const tools = normalizeToolSet(input.tools);
  const toolSetHash = computeRuntimeConfigHash(tools);
  const runtimeConfigHash = computeRuntimeConfigHash({ ...input, tools });
  return { ...input, tools, toolSetHash, runtimeConfigHash };
}

/** Sort + dedupe a tool-name array so semantically identical sets hash the
 *  same regardless of insertion order. */
export function normalizeToolSet(tools: readonly string[]): string[] {
  return [...new Set(tools)].sort();
}

/** Convenience hash over just a tool set (stable, order-independent). */
export function computeToolSetHash(tools: readonly string[]): string {
  return computeRuntimeConfigHash(normalizeToolSet(tools));
}

export interface BuildRunManifestOptions {
  model: string;
  provider: string;
  /** Explicit temperature (null/undefined → null: provider default). */
  temperature?: number | null;
  suiteVersion?: string;
  judgeVersion?: string;
  /** sha256 over the harness runtime config (computeRuntimeConfigHash). */
  runtimeConfigHash: string;
  /** Injectable timestamp (ISO string) for deterministic tests. */
  timestamp?: string;
  /** Injectable git info for deterministic tests; when absent, probed via git. */
  gitInfo?: { sha: string | null; dirty: boolean | null };
  now?: () => number;
  /** P21-1: harness profile label. */
  profile?: string;
  /** P21-1: effective feature-flag snapshot. */
  features?: Record<string, boolean>;
  /** P21-1: context budget (tokens); null = not pinned. */
  contextBudgetTokens?: number | null;
  /** P21-1: task suites executed. */
  taskSuites?: string[];
  /** P21-1: PRNG seed when fixed; null = not seeded. */
  randomSeed?: number | null;
  /** P38.3-10: challenger candidate id (undefined/null = champion baseline). */
  candidate?: string | null;
  /** P38.3-10: effective wiring manifest for this run (built by
   *  buildEffectiveConfig); recorded in provenance. */
  effectiveConfig?: BenchmarkEffectiveConfig;
}

/** Best-effort git identity probe. Any failure (no git, not a repo, timeout)
 *  yields `null` — never a fabricated sha. */
export async function buildRunManifest(opts: BuildRunManifestOptions): Promise<RunManifest> {
  const gitInfo = opts.gitInfo ?? (await detectGitInfo());
  return {
    gitSha: gitInfo.sha,
    dirty: gitInfo.dirty,
    model: opts.model,
    provider: opts.provider,
    temperature: opts.temperature ?? null,
    suiteVersion: opts.suiteVersion ?? BENCHMARK_SUITE_VERSION,
    judgeVersion: opts.judgeVersion ?? DEFAULT_JUDGE_VERSION,
    runtimeConfigHash: opts.runtimeConfigHash,
    timestamp: opts.timestamp ?? new Date(opts.now?.() ?? Date.now()).toISOString(),
    platform: process.platform,
    nodeVersion: process.version,
    // P21-1: reproducibility identity — absent values are honest nulls/[],
    // never guessed.
    profile: opts.profile ?? "benchmark",
    features: opts.features ?? {},
    contextBudgetTokens: opts.contextBudgetTokens ?? null,
    taskSuites: opts.taskSuites ?? [],
    randomSeed: opts.randomSeed ?? null,
    // P38.3-10: provenance — missing candidate means champion baseline.
    candidate: opts.candidate ?? null,
    ...(opts.effectiveConfig !== undefined ? { effectiveConfig: opts.effectiveConfig } : {}),
  };
}

/**
 * sha256 over a stable serialization of the runtime config. The serialization
 * is key-ordered and value-stable, so the same logical config always hashes
 * the same regardless of key insertion order. Any change to the harness wiring
 * (permissions, sandbox policy, budget, tool set, limits, …) changes the hash,
 * which is exactly the reproducibility signal the manifest needs.
 */
export function computeRuntimeConfigHash(config: unknown): string {
  return createHash("sha256").update(stableStringify(config)).digest("hex");
}

/** Deterministic key-ordered serialization (Q-5 stable serialization). */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * P38.4-7 — per-case evaluation context hash.
 *
 * Attributes that SHOULD remain identical across a baseline/challenger paired
 * evaluation: the case identity, the case fixture/version digest, the judge
 * version, the tool schema/policy digest, the suite version, the security
 * policy version, case prerequisite features, and the environment contract.
 *
 * Candidate-only knobs (recovery strategy, compaction strategy, context
 * pipeline, …) must NOT be part of this hash — a changed candidate must leave
 * `evaluationContextHash` unchanged (INV-P38.4-007 comparability).
 */
export function computeEvaluationContextHash(input: {
  caseId: string;
  fixtureDigest: string | null;
  judgeVersion: string;
  toolSchemaDigest: string | null;
  suiteVersion: string;
  securityPolicyVersion: string | null;
  prerequisiteFeatures: readonly string[];
  environmentContract: string | null;
}): string {
  return computeRuntimeConfigHash(input);
}

/**
 * P38.4-7 — per-case candidate configuration hash.
 *
 * The ACTUAL agent/challenger configuration under test: maxSteps, context
 * pipeline strategy, memory strategy, specialist routing, tool selection
 * strategy, recovery strategy, compaction strategy, and candidate/challenger
 * flags. Two runs with the same candidateConfigHash executed the same agent
 * wiring for the case; any change to a candidate-only knob changes this hash
 * (and only this hash).
 */
export function computeCandidateConfigHash(input: {
  candidate: string | null;
  maxSteps: number | null;
  contextPipeline: string | null;
  memoryStrategy: string | null;
  specialistRouting: string | null;
  toolSelection: string | null;
  recoveryStrategy: string | null;
  compactionStrategy: string | null;
  challengerFlags: Record<string, boolean>;
}): string {
  return computeRuntimeConfigHash(input);
}

async function detectGitInfo(): Promise<{ sha: string | null; dirty: boolean | null }> {
  let sha = "";
  let status = "";
  try {
    sha = await runGit(["rev-parse", "HEAD"]);
    status = await runGit(["status", "--porcelain"]);
  } catch {
    return { sha: null, dirty: null };
  }
  if (sha === "") return { sha: null, dirty: null };
  return { sha: sha.trim(), dirty: status.trim() !== "" };
}

function runGit(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd: process.cwd(), timeout: 5_000, windowsHide: true },
      (err, stdout) => {
        resolve(err !== null ? "" : String(stdout));
      },
    );
  });
}
