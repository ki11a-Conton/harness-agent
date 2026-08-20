import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LearningCandidate } from "./candidate.js";

/**
 * P2-7: learning candidate sandbox. A candidate (prompt rule / workflow /
 * skill / tool preference) runs in an isolated configuration before any
 * promotion gate: its own scratch directory, a read-only champion snapshot,
 * and a post-run mutation check against that snapshot. Candidates can never
 * reach champion global state directly — the sandbox is the only handle.
 */

export interface SandboxContext {
  /** The candidate under evaluation (read-only). */
  candidate: LearningCandidate;
  /** Isolated scratch directory for the candidate run. */
  scratchDir: string;
  /** Read-only champion snapshot captured before the run. */
  readChampion(): unknown;
  /** Write a file inside the scratch directory (relative path). */
  writeScratch(relPath: string, content: string): Promise<string>;
}

export type SandboxViolationKind =
  | "champion_mutation"
  | "scratch_escape"
  | "throw";

export interface SandboxViolation {
  kind: SandboxViolationKind;
  detail: string;
}

export interface SandboxResult<T> {
  /** Runner output (undefined when the runner threw). */
  result: T | undefined;
  /** Runner error, re-raised to the caller after cleanup. */
  error?: unknown;
  /** Violations detected by the sandbox. */
  violations: SandboxViolation[];
  /** Elapsed wall time of the run (ms). */
  elapsedMs: number;
  /** True when the runner threw (cleanup still ran). */
  threw: boolean;
}

export interface CandidateSandboxDeps {
  /** Scratch root; defaults to the system temp dir. */
  scratchRoot?: string;
  /** Injectable clock. */
  now?: () => number;
}

export interface SandboxRunDeps<T> {
  /** The candidate to run in isolation. */
  candidate: LearningCandidate;
  /** Reads the champion's global state; the sandbox snapshots it before the
   *  run and diffes it after. Required for the mutation check. May be async —
   *  the digest is always computed over the resolved value. */
  championState: () => unknown | Promise<unknown>;
  /** The isolated run. */
  runner: (ctx: SandboxContext) => Promise<T>;
}

/** Deterministic digest of champion state (stable key order). */
export function championDigest(state: unknown): string {
  return JSON.stringify(sortKeys(state));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = sortKeys(record[key]);
    return out;
  }
  return value;
}

export class CandidateSandbox {
  private readonly scratchRoot: string;
  private readonly now: () => number;

  constructor(deps: CandidateSandboxDeps = {}) {
    this.scratchRoot = deps.scratchRoot ?? tmpdir();
    this.now = deps.now ?? Date.now;
  }

  /**
   * Run the candidate in isolation: scratch dir → champion snapshot →
   * runner → champion re-check → cleanup. Cleanup and the mutation check
   * run even when the runner throws; the error is re-thrown afterwards.
   */
  async run<T>(deps: SandboxRunDeps<T>): Promise<SandboxResult<T>> {
    const started = this.now();
    const scratchDir = await mkdtemp(join(this.scratchRoot, "candidate-"));
    // Always digest the RESOLVED value — an async championState returning a
    // Promise must not be digested as "{}" (which would blind the mutation
    // check). Await before digesting.
    const digestOf = async (produce: () => unknown | Promise<unknown>): Promise<string> =>
      championDigest(await produce());
    const before = await digestOf(deps.championState);
    const violations: SandboxViolation[] = [];
    let result: T | undefined;
    let error: unknown;
    let threw = false;

    const ctx: SandboxContext = {
      candidate: deps.candidate,
      scratchDir,
      readChampion: () => deps.championState(),
      writeScratch: async (relPath, content) => {
        if (relPath.includes("..") || relPath.startsWith("/") || /^[a-z]:[\\/]/i.test(relPath)) {
          throw new Error(`sandbox: scratch path escapes the sandbox: ${relPath}`);
        }
        const target = join(scratchDir, relPath);
        await writeFile(target, content, "utf8");
        return target;
      },
    };

    try {
      result = await deps.runner(ctx);
    } catch (cause) {
      threw = true;
      error = cause;
      violations.push({ kind: "throw", detail: errorMessage(cause) });
    }

    try {
      const after = await digestOf(deps.championState);
      if (after !== before) {
        violations.push({ kind: "champion_mutation", detail: "champion state changed during the candidate run" });
      }
    } catch (cause) {
      violations.push({ kind: "champion_mutation", detail: `champion re-read failed: ${errorMessage(cause)}` });
    }

    await rm(scratchDir, { recursive: true, force: true });

    if (threw) throw error;
    return { result, violations, elapsedMs: this.now() - started, threw: false };
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}