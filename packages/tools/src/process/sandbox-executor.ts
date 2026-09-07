/**
 * E3-09 — real benchmark exec sandbox backend.
 *
 * Provides OS-level execution confinement for benchmark exec: the process
 * spawn is wrapped by an OS-level sandbox (bubblewrap on Linux) so a model
 * command cannot bypass the wrapper. On platforms without a strong backend
 * (Windows, macOS without container tooling) the backend reports unavailable
 * and the executor fails closed — no fake safety.
 *
 * All functions are testable offline with injected backends / runners.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { stableStringify } from "@ar/contracts";

export const SANDBOX_EXECUTOR_SCHEMA_VERSION = "1.0.0";

export const ALLOW_INSECURE_LOCAL_BENCHMARK_FLAG = "--allow-insecure-local-benchmark";

export const SANDBOX_BACKEND_DENIED = "SANDBOX_BACKEND_DENIED";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SandboxPolicySpec {
  schemaVersion: string;
  /** The ONLY writable area (case workspace). */
  writableDirs: string[];
  /** Read-only runtime areas needed to run tools (e.g., /usr, /opt). */
  readonlyDirs: string[];
  /** Env var names the child may see (allowlist). */
  envAllowlist: string[];
  network: false;
  pidNamespace: boolean;
  maxOutputBytes: number;
  timeoutMs: number;
  maxMemoryMb?: number;
  cpuShare?: number;
}

export interface SandboxExecutionProvenance {
  schemaVersion: string;
  backendId: string;
  platform: NodeJS.Platform;
  strongIsolation: boolean;
  policyDigest: string;
  selfTestDigest: string | null;
  insecureLocal: boolean;
}

export interface SandboxExecutionBackend {
  readonly id: string;
  readonly platform: NodeJS.Platform;
  readonly strongIsolation: boolean;
  readonly schemaVersion: string;
  /** Return the argv prefix that wraps the shell command inside the sandbox.
   *  Empty array = no wrapper (insecure / fake test backends). */
  wrapperArgv(policy: SandboxPolicySpec): string[];
  /** Run the capability self-test: attempt each attack vector inside this
   *  backend and report whether it was prevented. */
  selfTest(paths: ProbePaths, policy: SandboxPolicySpec): Promise<CapabilitySelfTestResult>;
}

export interface SandboxExecutionOption {
  backend: SandboxExecutionBackend;
  policy: SandboxPolicySpec;
  selfTest: CapabilitySelfTestResult;
  allowInsecureLocal?: boolean;
}

export type CapabilityProbeId =
  | "external-absolute-write"
  | "dotdot-escape"
  | "symlink-escape"
  | "shell-redirection"
  | "interpreter-invocation"
  | "repo-tracked-write"
  | "secret-env-exposure"
  | "network-access";

export interface CapabilityProbeResult {
  id: CapabilityProbeId;
  prevented: boolean;
  detail: string;
}

export interface CapabilitySelfTestResult {
  ok: boolean;
  backendId: string;
  schemaVersion: string;
  digest: string;
  attempted: CapabilityProbeId[];
  failures: CapabilityProbeId[];
  probes: CapabilityProbeResult[];
}

export interface ProbePaths {
  workspace: string;
  outside: string;
  outsideDir: string;
  tracked: string;
  /** Target a sandboxed write to the repo tracked area actually hits. The
   *  tracked file itself is pre-created; the attack must create THIS new file
   *  in the tracked area, so the effect assertion is on a file that cannot
   *  legitimately exist before the probe. */
  trackedAttack: string;
  secretName: string;
  networkHost: string;
  networkPort: number;
  dotdotTarget: string;
  symlinkTarget: string;
  interpreterTarget: string;
  redirectionTarget: string;
}

export type ProbeRunner = (command: string, opts: { cwd: string; env?: Record<string, string>; timeoutMs: number }) => Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}>;

export interface CapabilityProbeReport {
  ok: boolean;
  backendId: string;
  platform: NodeJS.Platform;
  strongIsolation: boolean;
  selfTest: CapabilitySelfTestResult;
  reason: string;
}

export interface BenchmarkConfinementDecision {
  mode: "strong" | "insecure-local" | "refused";
  promotionEligible: boolean;
  warning?: string;
  provenance: SandboxExecutionProvenance;
}

// ---------------------------------------------------------------------------
// Pure: policy construction
// ---------------------------------------------------------------------------

export function buildSandboxPolicySpec(input: {
  writableDirs: string[];
  readonlyDirs?: string[];
  envAllowlist: string[];
  maxOutputBytes: number;
  timeoutMs: number;
  maxMemoryMb?: number;
  cpuShare?: number;
}): SandboxPolicySpec {
  return {
    schemaVersion: SANDBOX_EXECUTOR_SCHEMA_VERSION,
    writableDirs: [...input.writableDirs],
    readonlyDirs: [...(input.readonlyDirs ?? [])],
    envAllowlist: [...input.envAllowlist],
    network: false,
    pidNamespace: true,
    maxOutputBytes: input.maxOutputBytes,
    timeoutMs: input.timeoutMs,
    maxMemoryMb: input.maxMemoryMb,
    cpuShare: input.cpuShare,
  };
}

// ---------------------------------------------------------------------------
// Pure: bwrap argv construction
// ---------------------------------------------------------------------------
// Order matters: ro-bind / first, then rw bind, then tmpfs/dev/proc, then
// unshare, then clearenv+setenv, then rlimit, then die-with-parent/new-session.

export function buildBwrapArgv(policy: SandboxPolicySpec): string[] {
  const argv: string[] = [];

  // 1. Host root read-only (allows runtime tools to work; nothing writable).
  argv.push("--ro-bind", "/", "/");

  // 2. Writable workspace dirs (shadow the ro root).
  for (const dir of policy.writableDirs) {
    argv.push("--bind", dir, dir);
  }

  // 3. Read-only runtime dirs.
  for (const dir of policy.readonlyDirs) {
    argv.push("--ro-bind", dir, dir);
  }

  // 4. Virtual filesystems.
  argv.push("--dev", "/dev");
  argv.push("--proc", "/proc");
  argv.push("--tmpfs", "/tmp");

  // 5. Network namespace disabled.
  argv.push("--unshare-net");

  // 6. PID namespace.
  argv.push("--unshare-pid");

  // 7. Environment allowlist: clear then set only allowlisted vars.
  argv.push("--clearenv");
  for (const key of policy.envAllowlist) {
    const val = process.env[key];
    if (val !== undefined) {
      argv.push("--setenv", `${key}=${val}`);
    }
  }

  // 8. Resource limits.
  argv.push("--rlimit-nofile", "1024");
  if (policy.maxMemoryMb !== undefined) {
    // bwrap --rlimit-as expects bytes; 512 MB default.
    argv.push("--rlimit-as", String(policy.maxMemoryMb * 1024 * 1024));
  }
  // CPU timeout: convert ms to seconds (ceil).
  const cpuSecs = Math.ceil(policy.timeoutMs / 1000) + 5; // 5s grace
  argv.push("--rlimit-cpu", String(cpuSecs));

  // 9. PID isolation: die with parent + new session.
  argv.push("--die-with-parent");
  argv.push("--new-session");

  return argv;
}

// ---------------------------------------------------------------------------
// Pure: env allowlist filter
// ---------------------------------------------------------------------------

export function filterEnvAllowlist(env: Record<string, string>, allowlist: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of allowlist) {
    if (key in env) {
      out[key] = env[key]!;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure: digests
// ---------------------------------------------------------------------------

export function policyDigestOf(policy: SandboxPolicySpec): string {
  return createHash("sha256").update(stableStringify(policy), "utf8").digest("hex");
}

export function probeDigestOf(probes: CapabilityProbeResult[]): string {
  const sorted = [...probes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return createHash("sha256").update(stableStringify(sorted.map((p) => ({ id: p.id, prevented: p.prevented }))), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Probe paths builder
// ---------------------------------------------------------------------------

export function buildProbePaths(baseDir: string): ProbePaths {
  // baseDir is the OUTSIDE area root. The workspace is a child of it, so that
  // ".." from the workspace lands in the unique outside area. All effect paths
  // live under baseDir, making them unique per call site (no cross-test
  // contamination on the shared tmpdir root).
  const workspace = join(baseDir, "workspace");
  const outside = join(baseDir, "e3-09-outside.txt");
  const outsideDir = baseDir;
  return {
    workspace,
    outside,
    outsideDir,
    tracked: join(baseDir, "e3-09-tracked.txt"),
    trackedAttack: join(baseDir, "e3-09-tracked.txt.attack"),
    secretName: "E3_09_SECRET",
    networkHost: "127.0.0.1",
    networkPort: 9,
    dotdotTarget: join(baseDir, "e3-09-dotdot.txt"),
    symlinkTarget: join(baseDir, "e3-09-symlink.txt"),
    interpreterTarget: join(baseDir, "e3-09-interpreter.txt"),
    redirectionTarget: outside,
  };
}

// ---------------------------------------------------------------------------
// Probe command definitions (pure)
// ---------------------------------------------------------------------------

export function capabilityProbeCommands(paths: ProbePaths): Record<string, string> {
  const node = JSON.stringify(process.execPath);
  const q = (s: string) => JSON.stringify(s);
  return {
    external: `${node} -e "try{require('fs').writeFileSync(process.argv[1],'pwned');process.exit(1)}catch(e){process.exit(0)}" ${q(paths.outside)}`,
    dotdot: `${node} -e "try{require('fs').writeFileSync(require('path').join(process.argv[1],'..','e3-09-dotdot.txt'),'pwned');process.exit(1)}catch(e){process.exit(0)}" ${q(paths.workspace)}`,
    symlink: `${node} -e "const fs=require('fs'),p=require('path');const l=p.join(process.argv[1],'e3-09-link');if(fs.existsSync(l))fs.unlinkSync(l);try{fs.symlinkSync(process.argv[2],l);fs.writeFileSync(p.join(process.argv[2],'e3-09-symlink.txt'),'x');process.exit(1)}catch(e){process.exit(0)}finally{try{fs.unlinkSync(l)}catch(e){}}" ${q(paths.workspace)} ${q(paths.outsideDir)}`,
    redirection: `echo pwned > ${q(paths.outside)}; [ $? -ne 0 ] && exit 0; exit 1`,
    interpreter: `${node} -e "try{require('fs').writeFileSync(process.argv[1],'pwned');process.exit(1)}catch(e){process.exit(0)}" ${q(paths.interpreterTarget)}`,
    tracked: `${node} -e "try{require('fs').writeFileSync(process.argv[1],'pwned');process.exit(1)}catch(e){process.exit(0)}" ${q(paths.trackedAttack)}`,
    secret: `${node} -e "process.exit(process.env[process.argv[1]]===undefined?0:1)" ${q(paths.secretName)}`,
    network: `${node} -e "const net=require('net');const s=net.connect({port:parseInt(process.argv[2]),host:process.argv[3]});s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0));setTimeout(()=>{s.destroy();process.exit(0)},2000)" ${String(paths.networkPort)} ${q(paths.networkHost)}`,
  };
}

// ---------------------------------------------------------------------------
// Self-test orchestration (pure — injects the runner)
// ---------------------------------------------------------------------------

export async function runCapabilityProbes(input: {
  backendId: string;
  paths: ProbePaths;
  runner: ProbeRunner;
  secretName: string;
  secretValue: string;
}): Promise<CapabilitySelfTestResult> {
  const cmds = capabilityProbeCommands(input.paths);
  const probeIds: CapabilityProbeId[] = [
    "external-absolute-write",
    "dotdot-escape",
    "symlink-escape",
    "shell-redirection",
    "interpreter-invocation",
    "repo-tracked-write",
    "secret-env-exposure",
    "network-access",
  ];
  const cmdMap: Record<CapabilityProbeId, string> = {
    "external-absolute-write": cmds.external!,
    "dotdot-escape": cmds.dotdot!,
    "symlink-escape": cmds.symlink!,
    "shell-redirection": cmds.redirection!,
    "interpreter-invocation": cmds.interpreter!,
    "repo-tracked-write": cmds.tracked!,
    "secret-env-exposure": cmds.secret!,
    "network-access": cmds.network!,
  };
  const effectPaths: Partial<Record<CapabilityProbeId, string>> = {
    "external-absolute-write": input.paths.outside,
    "dotdot-escape": input.paths.dotdotTarget,
    "symlink-escape": input.paths.symlinkTarget,
    "shell-redirection": input.paths.redirectionTarget,
    "interpreter-invocation": input.paths.interpreterTarget,
    "repo-tracked-write": input.paths.trackedAttack,
    "secret-env-exposure": undefined,
    "network-access": undefined,
  };

  const results: CapabilityProbeResult[] = [];
  const failures: CapabilityProbeId[] = [];

  for (const id of probeIds) {
    const cmd = cmdMap[id];
    if (!cmd) continue;
    const runnerEnv: Record<string, string> = {};
    if (id === "secret-env-exposure") {
      runnerEnv[input.secretName] = input.secretValue;
    }

    let exitCode: number | null = null;
    let detail = "";
    try {
      const res = await input.runner(cmd, { cwd: input.paths.workspace, env: runnerEnv, timeoutMs: 10_000 });
      exitCode = res.exitCode;
    } catch (err) {
      exitCode = null;
      detail = `runner failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Effect check: does the external file actually exist?
    const effectPath = effectPaths[id];
    let effectExists = false;
    if (effectPath !== undefined) {
      try {
        effectExists = existsSync(effectPath);
      } catch (err) {
        // existsSync should not throw; treat an unexpected error as "not
        // existing" and OBSERVE the fact (P14-6: comments alone are not
        // observability — the degraded channel is a real report).
        effectExists = false;
        process.stderr.write(`[degraded] sandbox.self-test.effect-check: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      // Cleanup the effect file if it exists (so subsequent probes aren't
      // contaminated).
      if (effectExists) {
        try {
          unlinkSync(effectPath);
        } catch (err) {
          // Best-effort cleanup — the effect assertion is what matters. The
          // failure is observed, never silent (P14-6).
          process.stderr.write(`[degraded] sandbox.self-test.cleanup: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    }

    // prevented = the attack was blocked (probe RAN and exited 0) AND the
    // external file does NOT exist (the EFFECT never happened). A runner error
    // (exitCode null — e.g. the backend could not even launch the probe) is NOT
    // "prevented": we cannot prove the attack was blocked, so we FAIL CLOSED.
    const prevented = exitCode === 0 && !effectExists;
    if (!prevented) {
      failures.push(id);
    }
    results.push({
      id,
      prevented,
      detail: effectExists
        ? `escape: effect file exists (${effectPath})`
        : detail || (exitCode === 0 ? "blocked" : exitCode === null ? "runner error" : `leaked (exit ${exitCode})`),
    });
  }

  const digest = probeDigestOf(results);
  return {
    ok: failures.length === 0,
    backendId: input.backendId,
    schemaVersion: SANDBOX_EXECUTOR_SCHEMA_VERSION,
    digest,
    attempted: [...probeIds],
    failures,
    probes: results,
  };
}

// ---------------------------------------------------------------------------
// Default probe runner: spawn the command via execFile (used by real backends)
// ---------------------------------------------------------------------------

export function defaultProbeRunner(): ProbeRunner {
  return async (command, opts) => {
    const started = Date.now();
    return new Promise((resolve) => {
      execFile(process.execPath, ["-e", command], {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        timeout: opts.timeoutMs,
        windowsHide: true,
      }, (err, stdout, stderr) => {
        // err?.code on execFile is the process exit code (number | string |
        // undefined). Coerce to number; null when the process didn't start or
        // was killed by a signal.
        const raw = err?.code != null ? Number(err.code) : null;
        resolve({
          exitCode: Number.isFinite(raw) ? raw : null,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          durationMs: Date.now() - started,
        });
      });
    });
  };
}

// ---------------------------------------------------------------------------
// Backend: bwrap (Linux only)
// ---------------------------------------------------------------------------

async function probeBwrap(): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("bwrap", ["--version"], { timeout: 5000, windowsHide: true }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    return true;
  } catch (err) {
    // bwrap missing or not executable → the backend is unavailable. This is a
    // REAL decision (fail-closed), never a silent swallow (P14-6).
    process.stderr.write(`[degraded] sandbox.bwrap-probe: ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  }
}

export async function bwrapBackend(): Promise<SandboxExecutionBackend | undefined> {
  if (process.platform !== "linux") return undefined;
  const available = await probeBwrap();
  if (!available) return undefined;
  return {
    id: "linux-bwrap",
    platform: "linux",
    strongIsolation: true, // Self-test runs separately; if it fails, no backend claims strong.
    schemaVersion: SANDBOX_EXECUTOR_SCHEMA_VERSION,
    wrapperArgv(policy: SandboxPolicySpec): string[] {
      return ["bwrap", ...buildBwrapArgv(policy)];
    },
    async selfTest(paths: ProbePaths, policy: SandboxPolicySpec): Promise<CapabilitySelfTestResult> {
      // The bwrap runner needs a real cwd and a writable workspace bind. The
      // outside area must exist so a leaked write materializes as a host file.
      mkdirSync(paths.workspace, { recursive: true });
      mkdirSync(paths.outsideDir, { recursive: true });
      // Pre-create the tracked file in the outside (host-read-only inside the
      // sandbox) area: the attack must create a NEW file next to it, which is
      // what the effect assertion checks.
      try {
        writeFileSync(paths.tracked, "tracked: do not modify\n");
      } catch (err) {
        process.stderr.write(`[degraded] sandbox.bwrap.self-test.tracked: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      const runner: ProbeRunner = async (command, opts) => {
        const started = Date.now();
        const bwrapArgv = buildBwrapArgv(policy);
        return new Promise((resolve) => {
          execFile("bwrap", [...bwrapArgv, "--", "/bin/sh", "-c", command], {
            cwd: opts.cwd,
            env: { ...process.env, ...opts.env },
            timeout: opts.timeoutMs,
            windowsHide: true,
          }, (err, stdout, stderr) => {
            const raw = err?.code != null ? Number(err.code) : null;
            resolve({
              exitCode: Number.isFinite(raw) ? raw : null,
              stdout: stdout ?? "",
              stderr: stderr ?? "",
              durationMs: Date.now() - started,
            });
          });
        });
      };
      return runCapabilityProbes({
        backendId: "linux-bwrap",
        paths,
        runner,
        secretName: paths.secretName,
        secretValue: "e3-09-self-test-secret",
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Backend: insecure local
// ---------------------------------------------------------------------------

export function insecureLocalBackend(platform: NodeJS.Platform): SandboxExecutionBackend {
  return {
    id: "insecure-local",
    platform,
    strongIsolation: false,
    schemaVersion: SANDBOX_EXECUTOR_SCHEMA_VERSION,
    wrapperArgv: () => [],
    async selfTest(paths: ProbePaths, _policy: SandboxPolicySpec): Promise<CapabilitySelfTestResult> {
      // Run probes through the DEFAULT runner (no confinement).
      const runner = defaultProbeRunner();
      const result = await runCapabilityProbes({
        backendId: "insecure-local",
        paths,
        runner,
        secretName: paths.secretName,
        secretValue: "e3-09-self-test-secret",
      });
      // Insecure backend: every probe that was "prevented" (exit code 0) is
      // actually a LEAK proof — the attack succeeded because there's no
      // confinement. Re-classify: prevented = false for all.
      const touched = result.probes.map((pr) => ({
        ...pr,
        prevented: false,
        detail: `insecure: no confinement — ${pr.detail}`,
      }));
      return {
        ok: false,
        backendId: "insecure-local",
        schemaVersion: SANDBOX_EXECUTOR_SCHEMA_VERSION,
        digest: "insecure-none",
        attempted: result.attempted,
        failures: [...result.attempted],
        probes: touched,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Backend: unavailable (fail-closed)
// ---------------------------------------------------------------------------

export function unavailableBackend(platform: NodeJS.Platform): SandboxExecutionBackend {
  return {
    id: platform === "win32" ? "win32-none" : platform === "darwin" ? "darwin-none" : "unknown",
    platform,
    strongIsolation: false,
    schemaVersion: SANDBOX_EXECUTOR_SCHEMA_VERSION,
    wrapperArgv: () => [],
    async selfTest(): Promise<CapabilitySelfTestResult> {
      return {
        ok: false,
        backendId: this.id,
        schemaVersion: SANDBOX_EXECUTOR_SCHEMA_VERSION,
        digest: "unavailable",
        attempted: [],
        failures: [],
        probes: [],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Self-test memoization
// ---------------------------------------------------------------------------

const selfTestCache = new Map<string, { digest: string; ok: boolean }>();

/**
 * E4-00 — run a backend's capability self-test inside a unique OS temp dir so
 * probe fixtures and any leaked writes NEVER touch the repository working tree.
 *
 * The self-test's effect paths are built under the probe base, and the probe
 * policy makes that base writable (mirroring the historical
 * `writableDirs: [process.cwd()]` with the base under cwd). Relocating BOTH the
 * base and the writable dir to the same temp path preserves the exact probe
 * semantics (effect paths sit under the writable base) while keeping the run
 * side-effect-free and reproducible — a hard requirement of the E4 offline
 * gates (every task must end with `git status --short` empty). Cleaned up in a
 * finally so a throwing self-test still leaves no residue.
 */
async function selfTestInTempDir(
  backend: SandboxExecutionBackend,
  policy: SandboxPolicySpec,
): Promise<CapabilitySelfTestResult> {
  const base = await mkdtemp(join(tmpdir(), "e3-09-selftest-"));
  try {
    const relocated: SandboxPolicySpec = {
      ...policy,
      writableDirs: policy.writableDirs.map((d) => (d === process.cwd() ? base : d)),
    };
    if (!relocated.writableDirs.includes(base)) {
      relocated.writableDirs = [base, ...relocated.writableDirs];
    }
    return await backend.selfTest(buildProbePaths(base), relocated);
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

export async function selfTestForBackend(backend: SandboxExecutionBackend, policy: SandboxPolicySpec, paths?: ProbePaths): Promise<CapabilitySelfTestResult> {
  const key = `${backend.id}@${SANDBOX_EXECUTOR_SCHEMA_VERSION}`;
  const cached = selfTestCache.get(key);
  if (cached !== undefined) {
    return {
      ok: cached.ok,
      backendId: backend.id,
      schemaVersion: SANDBOX_EXECUTOR_SCHEMA_VERSION,
      digest: cached.digest,
      attempted: [],
      failures: cached.ok ? [] : [],
      probes: [],
    };
  }
  const result = paths !== undefined
    ? await backend.selfTest(paths, policy)
    : await selfTestInTempDir(backend, policy);
  selfTestCache.set(key, { digest: result.digest, ok: result.ok });
  return result;
}

// ---------------------------------------------------------------------------
// Platform probe (real)
// ---------------------------------------------------------------------------

export async function probeSandboxBackend(platform: NodeJS.Platform = process.platform): Promise<SandboxExecutionBackend> {
  switch (platform) {
    case "linux": {
      const bwrap = await bwrapBackend();
      if (bwrap !== undefined) return bwrap;
      return unavailableBackend("linux");
    }
    case "win32":
      return unavailableBackend("win32");
    case "darwin":
      return unavailableBackend("darwin");
    default:
      return unavailableBackend(platform);
  }
}

// ---------------------------------------------------------------------------
// capabilityProbe — CLI preflight function
// ---------------------------------------------------------------------------

export async function capabilityProbe(opts?: {
  platform?: NodeJS.Platform;
  backend?: SandboxExecutionBackend;
}): Promise<CapabilityProbeReport> {
  const platform = opts?.platform ?? process.platform;
  const backend = opts?.backend ?? (await probeSandboxBackend(platform));
  if (!backend.strongIsolation) {
    const self = await selfTestInTempDir(backend, buildSandboxPolicySpec({
      writableDirs: [process.cwd()],
      readonlyDirs: [],
      envAllowlist: ["PATH", "HOME"],
      maxOutputBytes: 1000,
      timeoutMs: 5000,
    }));
    return {
      ok: false,
      backendId: backend.id,
      platform,
      strongIsolation: false,
      selfTest: self,
      reason: `no strong sandbox backend on ${platform} (${backend.id}) — benchmark promotion must be refused unless --allow-insecure-local-benchmark is explicitly passed`,
    };
  }

  // Strong backend: run self-test. If it fails, the backend is NOT trusted.
  const policy = buildSandboxPolicySpec({
    writableDirs: [process.cwd()],
    readonlyDirs: ["/usr"],
    envAllowlist: ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TZ"],
    maxOutputBytes: 1000,
    timeoutMs: 10000,
  });
  const self = await selfTestForBackend(backend, policy);
  if (!self.ok) {
    return {
      ok: false,
      backendId: backend.id,
      platform,
      strongIsolation: true,
      selfTest: self,
      reason: `sandbox backend ${backend.id} self-test FAILED — ${self.failures.length} probes failed (${self.failures.join(", ")})`,
    };
  }
  return {
    ok: true,
    backendId: backend.id,
    platform,
    strongIsolation: true,
    selfTest: self,
    reason: `strong isolation via ${backend.id}`,
  };
}

// ---------------------------------------------------------------------------
// decideBenchmarkConfinement — the decision the CLI preflight calls
// ---------------------------------------------------------------------------

export async function decideBenchmarkConfinement(input: {
  allowInsecureLocal: boolean;
  platform?: NodeJS.Platform;
  backend?: SandboxExecutionBackend;
  policy?: SandboxPolicySpec;
}): Promise<BenchmarkConfinementDecision> {
  const platform = input.platform ?? process.platform;
  const backend = input.backend ?? (await probeSandboxBackend(platform));
  const policy = input.policy ?? buildSandboxPolicySpec({
    writableDirs: [process.cwd()],
    readonlyDirs: ["/usr"],
    envAllowlist: ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TZ"],
    maxOutputBytes: 1_048_576,
    timeoutMs: 60_000,
    maxMemoryMb: 1024,
  });

  if (backend.strongIsolation) {
    const self = await selfTestForBackend(backend, policy);
    if (self.ok) {
      return {
        mode: "strong",
        promotionEligible: true,
        provenance: {
          schemaVersion: SANDBOX_EXECUTOR_SCHEMA_VERSION,
          backendId: backend.id,
          platform,
          strongIsolation: true,
          policyDigest: policyDigestOf(policy),
          selfTestDigest: self.digest,
          insecureLocal: false,
        },
      };
    }
  }

  // No strong backend or self-test failed.
  if (input.allowInsecureLocal) {
    const insecure = insecureLocalBackend(platform);
    return {
      mode: "insecure-local",
      promotionEligible: false,
      warning: "INSECURE LOCAL MODE — no OS-level confinement. The exec wrapper is PASSIVE; artifacts are NEVER promotion-eligible. Use only for local development.",
      provenance: {
        schemaVersion: SANDBOX_EXECUTOR_SCHEMA_VERSION,
        backendId: insecure.id,
        platform,
        strongIsolation: false,
        policyDigest: policyDigestOf(policy),
        selfTestDigest: null,
        insecureLocal: true,
      },
    };
  }

  return {
    mode: "refused",
    promotionEligible: false,
    warning: `no strong sandbox backend on ${platform} (${backend.id}). Pass --allow-insecure-local-benchmark for local-only non-promotion work, but even then no OS confinement is applied.`,
    provenance: {
      schemaVersion: SANDBOX_EXECUTOR_SCHEMA_VERSION,
      backendId: backend.id,
      platform,
      strongIsolation: false,
      policyDigest: policyDigestOf(policy),
      selfTestDigest: null,
      insecureLocal: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: build the launch config for a sandboxed spawn
// ---------------------------------------------------------------------------

export function buildSandboxLaunch(
  backend: SandboxExecutionBackend,
  policy: SandboxPolicySpec,
  shell: string,
  shellArgs: string[],
  env: Record<string, string>,
  cwd: string,
): { file: string; args: string[]; env: Record<string, string>; cwd: string } {
  const wrapper = backend.wrapperArgv(policy);
  if (wrapper.length > 0) {
    // Strong backend: spawn the wrapper binary; the shell runs inside.
    // The wrapper (bwrap) only needs a minimal env to start (PATH for bwrap
    // itself); the inner env is controlled via --setenv in the wrapper argv.
    const filteredEnv = filterEnvAllowlist(env, ["PATH"]);
    return {
      file: wrapper[0]!,
      args: [...wrapper.slice(1), "--", shell, ...shellArgs],
      env: filteredEnv,
      cwd,
    };
  }
  // Insecure / fake backend: spawn the shell directly.
  if (backend.strongIsolation) {
    // Fake strong: still filter env (testing isolation).
    return { file: shell, args: shellArgs, env: filterEnvAllowlist(env, policy.envAllowlist), cwd };
  }
  // Truly insecure: no filtering.
  return { file: shell, args: shellArgs, env, cwd };
}

// ---------------------------------------------------------------------------
// prepareSandboxedExec — the exec tool's decision + spec builder
// ---------------------------------------------------------------------------

export interface PreparedSandboxedExec {
  ok: true;
  sandboxExecution: SandboxExecutionOption;
  backend: SandboxExecutionBackend;
  policy: SandboxPolicySpec;
  provenance: SandboxExecutionProvenance;
}

export interface PreparedSandboxDenied {
  ok: false;
  denial: { code: string; reason: string };
}

export type PreparedSandboxResult = PreparedSandboxedExec | PreparedSandboxDenied;

/** Build the verified sandbox execution spec for one exec call.
 *  - confinement "strong": require a strong backend whose self-test passes;
 *    otherwise fail closed (typed denial) BEFORE any process runs.
 *  - confinement "insecure-local": run with the insecure backend; the outcome
 *    is flagged insecure and is NEVER promotion-eligible.
 *  Backend + self-test are injected for offline determinism. */
export async function prepareSandboxedExec(input: {
  confinement: "strong" | "insecure-local";
  workspaceRoot: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  platform?: NodeJS.Platform;
  backend?: SandboxExecutionBackend;
}): Promise<PreparedSandboxResult> {
  const platform = input.platform ?? process.platform;
  const policy = buildSandboxPolicySpec({
    writableDirs: [input.workspaceRoot],
    readonlyDirs: ["/usr", "/opt"],
    envAllowlist: ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TZ"],
    maxOutputBytes: input.maxOutputBytes,
    timeoutMs: input.timeoutMs,
  });
  const backend = input.backend ?? (await probeSandboxBackend(platform));

  if (input.confinement === "insecure-local") {
    const insecure = insecureLocalBackend(backend.platform);
    const self = await insecure.selfTest(buildProbePaths(input.workspaceRoot), policy);
    return {
      ok: true,
      sandboxExecution: { backend: insecure, policy, selfTest: self, allowInsecureLocal: true },
      backend: insecure,
      policy,
      provenance: {
        schemaVersion: SANDBOX_EXECUTOR_SCHEMA_VERSION,
        backendId: insecure.id,
        platform,
        strongIsolation: false,
        policyDigest: policyDigestOf(policy),
        selfTestDigest: null,
        insecureLocal: true,
      },
    };
  }

  // "strong" — fail closed unless the backend is strong AND its self-test passes.
  if (backend.strongIsolation) {
    const self = await selfTestForBackend(backend, policy);
    if (self.ok) {
      return {
        ok: true,
        sandboxExecution: { backend, policy, selfTest: self, allowInsecureLocal: false },
        backend,
        policy,
        provenance: {
          schemaVersion: SANDBOX_EXECUTOR_SCHEMA_VERSION,
          backendId: backend.id,
          platform,
          strongIsolation: true,
          policyDigest: policyDigestOf(policy),
          selfTestDigest: self.digest,
          insecureLocal: false,
        },
      };
    }
    return {
      ok: false,
      denial: {
        code: SANDBOX_BACKEND_DENIED,
        reason: `sandbox backend ${backend.id} self-test failed (${self.failures.join(", ")}) — benchmark exec refused (fail-closed)`,
      },
    };
  }

  return {
    ok: false,
    denial: {
      code: SANDBOX_BACKEND_DENIED,
      reason: `no strong sandbox backend on ${platform} (${backend.id}) — benchmark exec refused (fail-closed)`,
    },
  };
}