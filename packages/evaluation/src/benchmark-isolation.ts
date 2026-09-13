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
import { join, win32, posix } from "node:path";
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
  /** E3-09: when true, this is the explicit insecure-local mode — no OS-level
   *  confinement. Such a backend is NEVER promotion-eligible, no matter what
   *  id/strongIsolation it reports. */
  insecureLocal?: boolean;
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

/** Promotion-grade benchmarks REQUIRE a strong isolation backend. Fail-closed.
 *  An insecure-local backend is NEVER promotion-eligible (E3-09). */
export function promotionEligible(backend: IsolationBackend): boolean {
  return backend.strongIsolation && backend.insecureLocal !== true;
}

/** E3-09: wrap any backend into the explicit insecure-local mode. The
 *  resulting backend is never promotion-eligible and its note carries the
 *  prominent warning. Use only for local development behind the explicit
 *  --allow-insecure-local-benchmark flag. */
export function asInsecureLocalBackend(backend: IsolationBackend): IsolationBackend {
  return {
    schemaVersion: backend.schemaVersion,
    id: backend.id,
    platform: backend.platform,
    strongIsolation: false,
    insecureLocal: true,
    note: `${backend.note} | INSECURE LOCAL MODE — no OS-level confinement; artifacts are NEVER promotion-eligible`,
  };
}

/** E3-09: the explicit flag that opts into insecure local mode. */
export const ALLOW_INSECURE_LOCAL_BENCHMARK_FLAG = "--allow-insecure-local-benchmark";

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

/** E4-R41 (K02): a host probe that could not be VERIFIED. A failed probe is a
 *  real, structured outcome — never a silent empty string that later reads as
 *  "verified unchanged". */
export interface HostProbeError {
  probe: "rev-parse" | "status";
  kind: "nonzero-exit" | "timeout" | "signal" | "spawn-failure";
  exitCode: number | null;
  signal: string | null;
  message: string;
}

/** Lightweight host fingerprint: git HEAD + porcelain status + tree digests.
 *
 *  E4-R41 (K02): each git signal carries its own VALIDITY. `headSha === null`
 *  or `statusPorcelain === ""` is only meaningful when the corresponding probe
 *  succeeded; a failed probe makes the state UNKNOWN, which must never be read
 *  as "no change" (a missing proof is not a security clearance). */
export interface HostState {
  schemaVersion: string;
  headSha: string | null;
  statusPorcelain: string;
  /** sha256 over the sorted (relativePath, digest) pairs of the tracked tree. */
  treeDigest: string | null;
  /** True only when `git rev-parse HEAD` succeeded for this capture. */
  headValid: boolean;
  /** True only when `git status --porcelain` succeeded for this capture. */
  statusValid: boolean;
  /** Structured reasons for any probe that failed (empty when all succeeded). */
  probeErrors: HostProbeError[];
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

/** E4-R41 (K02): structured result of one git probe. Exported as the injectable
 *  test seam so a deterministic failing/succeeding probe can be supplied
 *  WITHOUT touching the global git, the project PATH or a shared workspace. */
export interface GitProbeResult {
  ok: boolean;
  stdout: string;
  error: HostProbeError | null;
}

/** Injectable command-execution seam. Defaults to the real `git` binary. */
export type GitProbeFn = (
  probe: "rev-parse" | "status",
  args: string[],
  cwd: string,
) => Promise<GitProbeResult>;

/**
 * E4-R41 (K02): run `git` and return a STRUCTURED result. A non-zero exit, a
 * timeout and a spawn failure are real, classified outcomes (ok=false + a
 * reason) — historically they were collapsed to an empty string, which the
 * sentinel then read as "no mutation proven", silently clearing a case whose
 * host state could not actually be observed.
 */
async function gitProbe(probe: "rev-parse" | "status", args: string[], cwd: string): Promise<GitProbeResult> {
  return new Promise((resolvePromise) => {
    execFile("git", args, { cwd, timeout: 10000, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err === null) {
        resolvePromise({ ok: true, stdout: String(stdout), error: null });
        return;
      }
      const e = err as { code?: unknown; signal?: unknown; killed?: boolean; message?: unknown };
      const exitCode = typeof e.code === "number" ? e.code : null;
      const signal = typeof e.signal === "string" ? e.signal : null;
      // execFile kills a timed-out child with a signal and sets `killed`.
      const kind: HostProbeError["kind"] = e.killed === true && signal !== null
        ? "timeout"
        : exitCode !== null
          ? "nonzero-exit"
          : signal !== null
            ? "signal"
            : "spawn-failure";
      const detail = String(stderr ?? "").trim() !== ""
        ? String(stderr).trim()
        : typeof e.message === "string" ? e.message : String(err);
      resolvePromise({
        ok: false,
        stdout: String(stdout ?? ""),
        error: { probe, kind, exitCode, signal, message: detail },
      });
    });
  });
}

/** Capture the host state (repo head + status + optional tree digests).
 *  `git status --porcelain` is the lightweight primary signal (reflects both
 *  tracked modifications and untracked writes, e.g. a child process dropping
 *  a file into the repo). `opts.include` enables the heavier full-tree digest
 *  scan; pass an empty array to skip it (fast path for per-case sentinels).
 *
 *  E4-R41 (K02): the result records per-signal validity + probe errors, so a
 *  failed probe yields UNKNOWN rather than a fake "unchanged". */
export async function captureHostState(
  repoRoot: string,
  opts: { include: string[]; excludePrefixes: string[]; gitExec?: GitProbeFn },
): Promise<HostState> {
  const exec = opts.gitExec ?? gitProbe;
  const [rev, status] = await Promise.all([
    exec("rev-parse", ["rev-parse", "HEAD"], repoRoot),
    exec("status", ["status", "--porcelain"], repoRoot),
  ]);
  const probeErrors: HostProbeError[] = [];
  if (rev.error !== null) probeErrors.push(rev.error);
  if (status.error !== null) probeErrors.push(status.error);
  // A null head / empty porcelain is only reported when its probe SUCCEEDED.
  const headSha = rev.ok && rev.stdout.trim() !== "" ? rev.stdout.trim() : null;
  const statusPorcelain = status.ok ? status.stdout : "";
  const treeDigest = opts.include.length === 0
    ? null
    : await treeDigestOf(repoRoot, opts);
  return {
    schemaVersion: BENCHMARK_ISOLATION_SCHEMA_VERSION,
    headSha,
    statusPorcelain,
    treeDigest,
    headValid: rev.ok,
    statusValid: status.ok,
    probeErrors,
  };
}

/** E4-R40 (K01): the RAW per-signal values that participated in a host-mutation
 *  decision, small enough to travel inside a case outcome / paired artifact.
 *  A later `git status` reading (which happens after the case and after the
 *  temp roots are cleaned) can never prove what the tree looked like DURING the
 *  case — only these captured records can. */
export interface HostStateSummary {
  headSha: string | null;
  statusPorcelain: string;
  treeDigest: string | null;
  /** E4-R41 (K02): per-signal validity, so a persisted record can never read a
   *  failed probe as "verified unchanged". */
  headValid: boolean;
  statusValid: boolean;
  /** Structured probe failures (probe/kind/exit/signal/message). */
  probeErrors: HostProbeError[];
}

/** E4-R40: reduce a captured HostState to the artifact-safe record. */
export function hostStateSummary(state: HostState): HostStateSummary {
  return {
    headSha: state.headSha,
    statusPorcelain: state.statusPorcelain,
    treeDigest: state.treeDigest,
    headValid: state.headValid,
    statusValid: state.statusValid,
    probeErrors: state.probeErrors,
  };
}

/** E4-R41 (K02): three-state host comparison. `unknown` is a first-class
 *  outcome — a required probe failed, so a change can NEITHER be confirmed NOR
 *  ruled out. It must never be presented as a verified mutation or as a clean
 *  result. */
export type HostMutationStatus = "unchanged" | "changed" | "unknown";

export interface HostMutationComparison {
  status: HostMutationStatus;
  details: string[];
  before: HostState;
  after: HostState;
}

/**
 * Compare two host captures without conflating "no change observed" with
 * "observation failed".
 *
 *   - `changed`   — at least one VERIFIED signal (head / status / treeDigest)
 *                   differs between two captures that both succeeded.
 *   - `unchanged` — both captures verified every required signal and none differ.
 *   - `unknown`   — a required probe failed on one or both sides.
 */
export function compareHostState(before: HostState, after: HostState): HostMutationComparison {
  const headComparable = before.headValid && after.headValid;
  const statusComparable = before.statusValid && after.statusValid;
  const verifiedChanged =
    (headComparable && before.headSha !== after.headSha) ||
    (statusComparable && before.statusPorcelain !== after.statusPorcelain) ||
    (before.treeDigest !== null && after.treeDigest !== null && before.treeDigest !== after.treeDigest);

  if (verifiedChanged) {
    const details: string[] = [
      "host state changed during case execution (possible child-process write outside the case workspace)",
    ];
    if (headComparable && before.headSha !== after.headSha) details.push(` head: ${before.headSha} -> ${after.headSha}`);
    if (statusComparable && before.statusPorcelain !== after.statusPorcelain) details.push(" git status changed");
    if (before.treeDigest !== null && after.treeDigest !== null && before.treeDigest !== after.treeDigest) {
      details.push(` tree digest: ${before.treeDigest.slice(0, 12)} -> ${after.treeDigest.slice(0, 12)}`);
    }
    return { status: "changed", details, before, after };
  }

  if (headComparable && statusComparable) {
    return { status: "unchanged", details: [], before, after };
  }

  const details: string[] = [
    "host state is UNKNOWN: a required host probe failed, so a change can neither be confirmed nor ruled out",
  ];
  for (const pe of [...before.probeErrors, ...after.probeErrors]) {
    details.push(
      ` host probe failed (${pe.probe}): ${pe.kind}` +
        `${pe.exitCode !== null ? ` exit=${pe.exitCode}` : ""}` +
        `${pe.signal !== null ? ` signal=${pe.signal}` : ""} — ${pe.message}`,
    );
  }
  return { status: "unknown", details, before, after };
}

/** Whether the host state was VERIFIABLY changed between two captures.
 *  E4-R41 (K02): an UNKNOWN result is NOT a mutation (so this stays `false` for
 *  it) — callers that must fail closed on unknown MUST consult
 *  `compareHostState(...).status` instead of relying on this boolean alone. */
export function hostMutated(before: HostState, after: HostState): boolean {
  return compareHostState(before, after).status === "changed";
}

/** Target path platform flavor. The host OS must NOT be used to interpret
 *  another platform's path syntax — that is how Windows escape cases broke
 *  on POSIX hosts (and vice versa). */
export type PathFlavor = "win32" | "posix";

export function isPathOutsideWorkspace(path: string, workspaceAbs: string, flavor: PathFlavor = process.platform === "win32" ? "win32" : "posix"): boolean {
  const p = flavor === "win32" ? win32 : posix;
  const ws = p.resolve(workspaceAbs);
  const target = p.resolve(path);
  const rel = p.relative(ws, target);
  const sep = flavor === "win32" ? "\\" : "/";
  if (rel === "") return false;
  return rel.startsWith(`..${sep}`) || rel === ".." || p.isAbsolute(rel);
}

export interface SentinelReport {
  schemaVersion: string;
  hostMutated: boolean;
  /** E4-R41 (K02): three-state outcome. `unknown` means a required probe failed
   *  and a change can neither be confirmed nor ruled out. */
  status: HostMutationStatus;
  details: string[];
  /** Structured probe failures from either capture (empty when all succeeded). */
  probeErrors: HostProbeError[];
  workspace: string;
  hostRoot: string;
}

/**
 * Run a case with host mutation sentinel: captures host state around the
 * execution and reports real host changes (child-process escapes etc.) that
 * the tool-argument sentinel could never see. Callers decide how to fail the
 * case (here: infrastructure failure).
 *
 * E4-R41 (K02): the report distinguishes `changed` from `unknown`; when a
 * required probe failed on either side the status is `unknown` and the probe
 * errors are surfaced in `details` — it is NOT silently reported as unchanged
 * with an empty details list.
 */
export async function withHostMutationSentinel<T>(
  input: {
    hostRoot: string;
    watchInclude: string[];
    watchExcludePrefixes: string[];
    /** E4-R41 (K02): optional deterministic probe seam (tests only). */
    gitExec?: GitProbeFn;
    run: () => Promise<T>;
  },
): Promise<{ value: T; report: SentinelReport }> {
  const before = await captureHostState(input.hostRoot, {
    include: input.watchInclude,
    excludePrefixes: input.watchExcludePrefixes,
    ...(input.gitExec !== undefined ? { gitExec: input.gitExec } : {}),
  });
  const value = await input.run();
  const after = await captureHostState(input.hostRoot, {
    include: input.watchInclude,
    excludePrefixes: input.watchExcludePrefixes,
    ...(input.gitExec !== undefined ? { gitExec: input.gitExec } : {}),
  });
  const comparison = compareHostState(before, after);
  return {
    value,
    report: {
      schemaVersion: BENCHMARK_ISOLATION_SCHEMA_VERSION,
      hostMutated: comparison.status === "changed",
      status: comparison.status,
      details: comparison.details,
      probeErrors: [...before.probeErrors, ...after.probeErrors],
      workspace: input.hostRoot,
      hostRoot: input.hostRoot,
    },
  };
}