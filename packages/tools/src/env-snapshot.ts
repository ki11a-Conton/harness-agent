/**
 * P2-32 Environment Capability Snapshot.
 *
 * Captures the session's environment capability facts once (OS, cwd, runtime
 * tool versions, git state, package manager, network policy, available tools),
 * so the model stops repeatedly probing the environment each turn.
 *
 * Policy:
 *  - read-only: only runs `--version` and read-only `git` queries, all with a
 *    short timeout and no network.
 *  - secrets-safe: environment variable VALUES are never captured. We only note
 *    WHICH sensitive-looking keys exist (names are fine; values are redacted).
 *  - network policy and available-tools are *provided* by the caller (never
 *    probed by probing the network), keeping this module free of side effects.
 */
import { platform, arch, type, release, cpus, totalmem } from "node:os";
import { env as processEnv } from "node:process";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { isNodeErrorCode } from "@ar/contracts";
import type { WorkingState } from "@ar/contracts";
import { ProcessExecutor } from "./process/executor.js";

export interface RuntimeVersion {
  name: string;
  version: string | null;
  found: boolean;
}

export interface GitState {
  available: boolean;
  branch: string | null;
  head: string | null;
  dirtyFiles: number;
  remote: string | null;
}

export interface PackageManagerInfo {
  detected: string | null;
  lockfile: string | null;
  version: string | null;
}

export interface EnvironmentSnapshot {
  capturedAt: number;
  os: { platform: string; arch: string; release: string; type: string; logicalCpus: number };
  cwd: string;
  workspaceRoot?: string;
  harnessProfile?: string;
  runtimes: RuntimeVersion[];
  packageManager: PackageManagerInfo;
  git: GitState;
  /** Supplied by caller — never probed via the network. */
  network: { mode: string };
  tools: { available: string[]; count: number };
  security: {
    /** Names (redacted) of sensitive env keys present; values are NEVER captured. */
    sensitiveEnvKeysPresent: string[];
    envValuesRedacted: boolean;
  };
}

const RUNTIME_PROBES: ReadonlyArray<{ name: string; args: string[] }> = [
  { name: "node", args: ["--version"] },
  { name: "npm", args: ["--version"] },
  { name: "yarn", args: ["--version"] },
  { name: "pnpm", args: ["--version"] },
  { name: "bun", args: ["--version"] },
  { name: "python3", args: ["--version"] },
  { name: "go", args: ["version"] },
  { name: "cargo", args: ["--version"] },
  { name: "rustc", args: ["--version"] },
  { name: "git", args: ["--version"] },
  { name: "docker", args: ["--version"] },
  { name: "make", args: ["--version"] },
];

const SENSITIVE_ENV_RE =
  /token|secret|pass(word|phrase)?|api[_-]?key|auth|credential|cookie|private[_-]?key|aws[_-]?secret|bearer|signing[_-]?key|ssh[_-]?key/i;

const LOCKFILE_TO_MANAGER: ReadonlyArray<[string, string]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];

export interface EnvSnapshotOptions {
  cwd: string;
  /** Same cancellation authority as the approved env_snapshot tool call. */
  signal?: AbortSignal;
  /** Supplied by the caller. */
  networkMode?: string;
  /** Supplied by the caller (registry tool names). */
  availableTools?: string[];
  /** Host wiring facts (P0-7): profile + workspace root, never env values. */
  workspaceRoot?: string;
  harnessProfile?: string;
  /** Restrict runtime probes (useful in tests / minimal environments). */
  probeLimit?: number;
}

/** Sequential, asynchronous probes reuse the existing argv/cancellation
 * lifecycle. In particular, a slow version command must not freeze the Web
 * host's event loop or resolve relative PATH entries from the gateway cwd. */
async function runProbe(file: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
  try {
    const outcome = await new ProcessExecutor().runArgv({ file, args, cwd, timeoutMs, maxOutputBytes: 1_048_576,
      ...(signal !== undefined ? { signal } : {}) });
    signal?.throwIfAborted();
    // execFileSync formerly refused an over-maxBuffer result. A captured
    // prefix is likewise not a complete version or Git response.
    return outcome.status === "success" && !outcome.truncated ? outcome.stdout : null;
  } catch {
    signal?.throwIfAborted();
    return null; // missing/unusable local binary, never a fabricated version
  }
}

async function probeVersion(name: string, args: string[], cwd: string, signal?: AbortSignal): Promise<string | null> {
  const out = await runProbe(name, args, cwd, 1500, signal);
  return out === null ? null : out.split("\n")[0]?.trim() || null;
}

async function gitState(cwd: string, signal?: AbortSignal): Promise<GitState> {
  const run = async (args: string[]): Promise<string | null> =>
    (await runProbe("git", ["-C", cwd, ...args], cwd, 2000, signal))?.trim() ?? null;
  const branch = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === null) {
    return { available: false, branch: null, head: null, dirtyFiles: 0, remote: null };
  }
  const head = await run(["rev-parse", "--short", "HEAD"]);
  const remote = await run(["remote", "get-url", "origin"]);
  const porcelain = await run(["status", "--porcelain"]);
  const dirtyFiles = porcelain === null || porcelain === "" ? 0 : porcelain.split("\n").length;
  return { available: true, branch, head, remote, dirtyFiles };
}

async function detectPackageManager(cwd: string, runtimes: RuntimeVersion[], signal?: AbortSignal): Promise<PackageManagerInfo> {
  for (const [lockfile, manager] of LOCKFILE_TO_MANAGER) {
    signal?.throwIfAborted();
    try {
      await fs.access(join(cwd, lockfile));
      signal?.throwIfAborted();
      const found = runtimes.find((r) => r.name === manager);
      return { detected: manager, lockfile, version: found?.version ?? null };
    } catch (err) {
      signal?.throwIfAborted();
      // P14-6: "try next" — a missing lockfile is the EXPECTED case (that is
      // the probe); only non-ENOENT access failures are reported.
      if (!isNodeErrorCode(err, "ENOENT")) {
        process.stderr.write(`[degraded] env-snapshot.lockfile-probe: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }
  const node = runtimes.find((r) => r.name === "node");
  if (node?.found) return { detected: "npm", lockfile: null, version: null };
  return { detected: null, lockfile: null, version: null };
}

/** Build a snapshot of the environment. Read-only, time-boxed, network-free. */
export async function snapshotEnvironment(opts: EnvSnapshotOptions): Promise<EnvironmentSnapshot> {
  opts.signal?.throwIfAborted();
  const cwd = resolve(opts.cwd);
  const probeLimit = opts.probeLimit ?? RUNTIME_PROBES.length;
  const runtimes: RuntimeVersion[] = [];
  for (const probe of RUNTIME_PROBES.slice(0, probeLimit)) {
    const version = await probeVersion(probe.name, probe.args, cwd, opts.signal);
    runtimes.push({ name: probe.name, found: version !== null, version });
  }
  const [git, packageManager] = await Promise.all([gitState(cwd, opts.signal), detectPackageManager(cwd, runtimes, opts.signal)]);

  opts.signal?.throwIfAborted();
  const sensitiveEnvKeysPresent: string[] = [];
  for (const key of Object.keys(processEnv)) {
    if (SENSITIVE_ENV_RE.test(key)) sensitiveEnvKeysPresent.push(key);
  }
  sensitiveEnvKeysPresent.sort();

  const tools = opts.availableTools ?? [];
  const osInfo = {
    platform: platform(),
    arch: arch(),
    release: release(),
    type: type(),
    logicalCpus: cpus().length,
  };
  void totalmem;

  return {
    capturedAt: Date.now(),
    os: osInfo,
    cwd,
    ...(opts.workspaceRoot !== undefined ? { workspaceRoot: resolve(opts.workspaceRoot) } : {}),
    ...(opts.harnessProfile !== undefined ? { harnessProfile: opts.harnessProfile } : {}),
    runtimes,
    packageManager,
    git,
    network: { mode: opts.networkMode ?? "deny" },
    tools: { available: tools, count: tools.length },
    security: {
      sensitiveEnvKeysPresent,
      envValuesRedacted: true, // contract: we never embed env values
    },
  };
}

/** A compact "one-liner" summary for prompts / WorkingState facts. */
export function snapshotSummary(s: EnvironmentSnapshot): string {
  const runtimes = s.runtimes.filter((r) => r.found).map((r) => `${r.name}@${r.version ?? "?"}`).join(", ");
  const git = s.git.available ? `${s.git.branch}@${s.git.head}` : "no-git";
  return `env ${s.os.type}(${s.os.arch}) | cwd=${s.cwd} | ${runtimes} | pm=${s.packageManager.detected ?? "none"} | git=${git} | net=${s.network.mode} | tools=${s.tools.count}`;
}

/** Record the snapshot summary into WorkingState.importantFacts (deduped). */
export function noteSnapshotInWorkingState(state: WorkingState, snap: EnvironmentSnapshot): void {
  const entry = snapshotSummary(snap);
  if (!state.importantFacts.includes(entry)) state.importantFacts.push(entry);
}