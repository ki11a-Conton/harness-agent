/**
 * E2-09 — benchmark workspace isolation boundary.
 *
 * The E1 exec containment (resolveExecCwd) confines the PROCESS CWD but a
 * child process can still use ABSOLUTE paths (node -e, shell redirection,
 * interpreters) to write OUTSIDE the case workspace — and the old sentinel
 * only looked at write_file/edit_file tool arguments, so child-process writes
 * were invisible (F-10).
 *
 * This module establishes the benchmark security boundary:
 *
 *   1. `IsolationBackend` — declares what OS-level isolation is AVAILABLE on
 *      this platform. On platforms with no strong backend (Windows, macOS
 *      without container tooling) promotion-grade benchmarks are REFUSED
 *      before any provider call; local development may opt into an explicit
 *      insecure mode that is NEVER promotion-eligible.
 *   2. `HostMutationSentinel` — measures the HOST state (repo tracked-file
 *      status + working-tree digests) before and after a case, so real
 *      child-process writes outside the case workspace are DETECTED from
 *      actual effects, not from tool arguments. A changed host fails the case
 *      as an infrastructure/policy failure.
 *
 * Scope note: this is the benchmark execution SECURITY boundary (a
 * maintenance fix under the Runtime Freeze exception for security
 * vulnerabilities in benchmark infrastructure) — it does not rewrite the
 * Runtime architecture.
 */

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, relative, sep, isAbsolute, resolve } from "node:path";
import { stableStringify } from "./manifest.js";

export const BENCHMARK_ISOLATION_SCHEMA_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Backend support matrix
// ---------------------------------------------------------------------------

export type IsolationBackendId =
  | "linux-bwrap"
  | "linux-unshare"
  | "container"
  | "macos-sandbox-exec"
  | "win32-none"
  | "darwin-none"
  | "unknown";

export interface IsolationBackend {
  schemaVersion: string;
  id: IsolationBackendId;
  platform: NodeJS.Platform;
  /** OS-level write confinement available. */
  strongIsolation: boolean;
  /** Human explanation for the support matrix. */
  note: string;
}

/** Detect the strongest isolation backend this platform offers. Free. */
export async function probeIsolationBackend(platform: NodeJS.Platform = process.platform): Promise<IsolationBackend> {
  switch (platform) {
    case "linux": {
      // bwrap present → strong isolation; else fall back to unshare; else
      // unknown (fail-closed). Each probe failure is a REAL decision (continue
      // probing), not a silent swallow.
      const bwrapOk = await runQuiet(["which", "bwrap"]).then(() => true).catch(() => false);
      if (bwrapOk) {
        return { schemaVersion: BENCHMARK_ISOLATION_SCHEMA_VERSION, id: "linux-bwrap", platform, strongIsolation: true, note: "bubblewrap available — OS-level mount/namespace isolation" };
      }
      const unshareOk = await runQuiet(["unshare", "--version"]).then(() => true).catch(() => false);
      if (unshareOk) {
        return { schemaVersion: BENCHMARK_ISOLATION_SCHEMA_VERSION, id: "linux-unshare", platform, strongIsolation: true, note: "unshare available — namespace isolation (best-effort)" };
      }
      return { schemaVersion: BENCHMARK_ISOLATION_SCHEMA_VERSION, id: "unknown", platform, strongIsolation: false, note: "no bwrap/unshare detected — strong isolation unavailable" };
    }
    case "darwin": {
      const sandboxOk = await runQuiet(["sandbox-exec", "--help"]).then(() => true).catch(() => false);
      if (sandboxOk) {
        return { schemaVersion: BENCHMARK_ISOLATION_SCHEMA_VERSION, id: "macos-sandbox-exec", platform, strongIsolation: true, note: "sandbox-exec available (seatbelt profiles)" };
      }
      return { schemaVersion: BENCHMARK_ISOLATION_SCHEMA_VERSION, id: "darwin-none", platform, strongIsolation: false, note: "no macOS strong isolation backend detected" };
    }
    case "win32":
      return { schemaVersion: BENCHMARK_ISOLATION_SCHEMA_VERSION, id: "win32-none", platform, strongIsolation: false, note: "no OS-level write-confinement backend on Windows — promotion benchmarks refused; local dev may opt into explicit insecure mode (never promotion-eligible)" };
    default:
      return { schemaVersion: BENCHMARK_ISOLATION_SCHEMA_VERSION, id: "unknown", platform, strongIsolation: false, note: `unsupported platform ${platform}` };
  }
}

/** Promotion-grade benchmarks REQUIRE a strong isolation backend. Fail-closed. */
export function promotionEligible(backend: IsolationBackend): boolean {
  return backend.strongIsolation;
}

function runQuiet(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(args[0]!, args.slice(1), { timeout: 5000, windowsHide: true }, (err: Error | null) => {
      if (err !== null) reject(err);
      else resolvePromise();
    });
  });
}

// ---------------------------------------------------------------------------
// Host mutation sentinel
// ---------------------------------------------------------------------------

/** Lightweight host fingerprint: git HEAD + porcelain status + tree digests. */
export interface HostState {
  schemaVersion: string;
  headSha: string | null;
  statusPorcelain: string;
  /** sha256 over the sorted (relativePath, digest) pairs of the tracked tree. */
  treeDigest: string | null;
}

/** Deterministic per-file digest over a directory subset (sorted, relative). */
export async function treeDigestOf(
  root: string,
  opts: { include: string[]; excludePrefixes: string[] },
): Promise<string | null> {
  const entries: Array<{ rel: string; digest: string }> = [];
  let unreadableFiles = 0;

  function excluded(relPath: string): boolean {
    return opts.excludePrefixes.some((p) => p !== "" && (relPath.startsWith(p) || relPath.split("/")[0] === p));
  }

  async function digestFile(abs: string, relPath: string): Promise<void> {
    try {
      const content = await readFile(abs);
      entries.push({ rel: relPath, digest: createHash("sha256").update(content).digest("hex") });
    } catch {
      // Unreadable file — skip it but OBSERVE the fact (never silently
      // swallowed): the count is reflected in the returned digest input.
      unreadableFiles += 1;
    }
  }

  async function walk(dir: string, rel: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    names.sort();
    for (const name of names) {
      const abs = join(dir, name);
      const relPath = rel === "" ? name : `${rel}/${name}`;
      if (excluded(relPath)) continue;
      let st;
      try {
        st = await stat(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        await walk(abs, relPath);
      } else if (st.isFile()) {
        await digestFile(abs, relPath);
      }
    }
  }

  for (const inc of opts.include) {
    const abs = join(root, inc);
    let st;
    try {
      st = await stat(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      await walk(abs, inc);
    } else if (st.isFile()) {
      await digestFile(abs, inc);
    }
  }
  if (entries.length === 0 && unreadableFiles === 0) return null;
  return createHash("sha256").update(stableStringify({ entries, unreadableFiles }), "utf8").digest("hex");
}

async function gitOutput(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise) => {
    execFile("git", args, { cwd, timeout: 10000, windowsHide: true, encoding: "utf8" }, (err, stdout) => {
      resolvePromise(err !== null ? "" : String(stdout));
    });
  });
}

/** Capture the host state (repo head + status + optional tree digests).
 *  `git status --porcelain` is the lightweight primary signal (reflects both
 *  tracked modifications and untracked writes, e.g. a child process dropping
 *  a file into the repo). `opts.include` enables the heavier full-tree digest
 *  scan; pass an empty array to skip it (fast path for per-case sentinels). */
export async function captureHostState(
  repoRoot: string,
  opts: { include: string[]; excludePrefixes: string[] },
): Promise<HostState> {
  const [headSha, statusPorcelain] = await Promise.all([
    gitOutput(["rev-parse", "HEAD"], repoRoot).then((s) => s.trim() === "" ? null : s.trim()),
    gitOutput(["status", "--porcelain"], repoRoot),
  ]);
  const treeDigest = opts.include.length === 0
    ? null
    : await treeDigestOf(repoRoot, opts);
  return {
    schemaVersion: BENCHMARK_ISOLATION_SCHEMA_VERSION,
    headSha,
    statusPorcelain,
    treeDigest,
  };
}

/** Whether the host state changed between two captures (real mutation).
 *  Primary signal: git HEAD + porcelain status (reflects tracked edits and
 *  untracked writes). Deep tree-digest comparison only applies when BOTH
 *  sides have a measurable digest (the heavy path). */
export function hostMutated(before: HostState, after: HostState): boolean {
  if (before.headSha !== after.headSha) return true;
  if (before.statusPorcelain !== after.statusPorcelain) return true;
  if (before.treeDigest !== null && after.treeDigest !== null && before.treeDigest !== after.treeDigest) return true;
  return false;
}

/** Classify a changed path against the case workspace (escape check). */
export function isPathOutsideWorkspace(path: string, workspaceAbs: string): boolean {
  const rel = relative(resolve(workspaceAbs), resolve(path));
  if (rel === "") return false;
  return rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel);
}

export interface SentinelReport {
  schemaVersion: string;
  hostMutated: boolean;
  details: string[];
  workspace: string;
  hostRoot: string;
}

/**
 * Run a case with host mutation sentinel: captures host state around the
 * execution and reports real host changes (child-process escapes etc.) that
 * the tool-argument sentinel could never see. Callers decide how to fail the
 * case (here: infrastructure failure).
 */
export async function withHostMutationSentinel<T>(
  input: {
    hostRoot: string;
    watchInclude: string[];
    watchExcludePrefixes: string[];
    run: () => Promise<T>;
  },
): Promise<{ value: T; report: SentinelReport }> {
  const before = await captureHostState(input.hostRoot, {
    include: input.watchInclude,
    excludePrefixes: input.watchExcludePrefixes,
  });
  const value = await input.run();
  const after = await captureHostState(input.hostRoot, {
    include: input.watchInclude,
    excludePrefixes: input.watchExcludePrefixes,
  });
  const mutated = hostMutated(before, after);
  const details: string[] = [];
  if (mutated) {
    details.push("host state changed during case execution (possible child-process write outside the case workspace)");
    if (before.headSha !== after.headSha) details.push(` head: ${before.headSha} -> ${after.headSha}`);
    if (before.statusPorcelain !== after.statusPorcelain) details.push(" git status changed");
    if (before.treeDigest !== after.treeDigest) details.push(` tree digest: ${before.treeDigest?.slice(0, 12) ?? "null"} -> ${after.treeDigest?.slice(0, 12) ?? "null"}`);
  }
  return {
    value,
    report: {
      schemaVersion: BENCHMARK_ISOLATION_SCHEMA_VERSION,
      hostMutated: mutated,
      details,
      workspace: input.hostRoot,
      hostRoot: input.hostRoot,
    },
  };
}