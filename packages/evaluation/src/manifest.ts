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
}

/** Suite definition version. P0-6 adds the integrity layer (manifest, failure
 *  classification, ordered execution) on top of the Phase 6.5 four-suite split;
 *  bump when the suite definitions or their judging semantics change. */
export const BENCHMARK_SUITE_VERSION = "2.1.0";

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
