/**
 * E3-09 — real benchmark exec sandbox backend.
 *
 * These tests exercise the sandbox execution backend, its policy construction,
 * env allowlist, deny decisions and self-test plumbing with INJECTED backends /
 * runners — no real bwrap is required (this machine is Windows; the Linux
 * backend code is exercised by CI). Every test is offline and deterministic.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ProcessExecutor } from "./executor.js";
import {
  ALLOW_INSECURE_LOCAL_BENCHMARK_FLAG,
  SANDBOX_BACKEND_DENIED,
  buildBwrapArgv,
  buildProbePaths,
  buildSandboxPolicySpec,
  capabilityProbe,
  capabilityProbeCommands,
  decideBenchmarkConfinement,
  filterEnvAllowlist,
  insecureLocalBackend,
  policyDigestOf,
  probeDigestOf,
  probeSandboxBackend,
  runCapabilityProbes,
  selfTestForBackend,
  unavailableBackend,
  type SandboxExecutionBackend,
  type SandboxPolicySpec,
} from "./sandbox-executor.js";

const NODE = process.execPath;
const q = (s: string): string => JSON.stringify(s);

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "e3-09-"));
}

function basePolicy(overrides: Partial<SandboxPolicySpec> = {}): SandboxPolicySpec {
  return buildSandboxPolicySpec({
    writableDirs: ["/work/case-1"],
    readonlyDirs: [],
    envAllowlist: ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TZ"],
    maxOutputBytes: 1024,
    timeoutMs: 5000,
    maxMemoryMb: 512,
    cpuShare: 256,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. Policy construction
// ---------------------------------------------------------------------------

describe("E3-09 sandbox policy construction", () => {
  it("buildSandboxPolicySpec records the only-writable area and runtime read-only dirs", () => {
    const p = buildSandboxPolicySpec({
      writableDirs: ["/work/case-1"],
      readonlyDirs: ["/usr", "/opt"],
      envAllowlist: ["PATH"],
      maxOutputBytes: 100,
      timeoutMs: 1000,
    });
    expect(p.schemaVersion).toBeTruthy();
    expect(p.writableDirs).toEqual(["/work/case-1"]);
    expect(p.readonlyDirs).toEqual(["/usr", "/opt"]);
    expect(p.network).toBe(false);
    expect(p.pidNamespace).toBe(true);
    expect(p.envAllowlist).toContain("PATH");
    expect(p.maxOutputBytes).toBe(100);
    expect(p.timeoutMs).toBe(1000);
  });

  it("policy digest is deterministic and stable across key order", () => {
    const a = basePolicy();
    const b = buildSandboxPolicySpec({
      writableDirs: [...a.writableDirs],
      readonlyDirs: [...a.readonlyDirs],
      envAllowlist: [...a.envAllowlist],
      maxOutputBytes: a.maxOutputBytes,
      timeoutMs: a.timeoutMs,
      maxMemoryMb: a.maxMemoryMb,
      cpuShare: a.cpuShare,
    });
    expect(policyDigestOf(a)).toBe(policyDigestOf(b));
    // A different writable area MUST change the digest (provenance integrity).
    expect(policyDigestOf(basePolicy({ writableDirs: ["/work/other"] }))).not.toBe(policyDigestOf(a));
  });
});

// ---------------------------------------------------------------------------
// 2. bwrap argv construction (pure — exercised by Linux CI, unit-tested here)
// ---------------------------------------------------------------------------

describe("E3-09 bwrap argv construction", () => {
  it("host root is bound READ-ONLY; the workspace is the only rw bind", () => {
    const argv = buildBwrapArgv(basePolicy());
    const joined = argv.join(" ");
    // Host root ro-bind must come first so later rw binds can shadow it.
    expect(argv[0]).toBe("--ro-bind");
    expect(argv[1]).toBe("/");
    expect(argv).toContain("--ro-bind");
    // The workspace rw bind is present.
    const wsIdx = argv.indexOf("/work/case-1");
    expect(wsIdx).toBeGreaterThan(0);
    expect(argv[wsIdx + 1]).toBe("/work/case-1");
    // The rw bind comes AFTER the ro root bind.
    expect(wsIdx).toBeGreaterThan(argv.indexOf("/") + 1);
  });

  it("network namespace is disabled, PID namespace on, temp/dev/proc are virtual", () => {
    const argv = buildBwrapArgv(basePolicy());
    const joined = argv.join(" ");
    expect(argv).toContain("--unshare-net");
    expect(argv).toContain("--unshare-pid");
    expect(argv).toContain("--die-with-parent");
    expect(argv).toContain("--new-session");
    expect(argv).toContain("--tmpfs");
    expect(argv).toContain("/tmp");
    expect(argv).toContain("--dev");
    expect(argv).toContain("--proc");
    expect(joined).not.toContain("--share-net");
  });

  it("env allowlist is expressed via --clearenv + --setenv only", () => {
    const argv = buildBwrapArgv(basePolicy());
    expect(argv).toContain("--clearenv");
    expect(argv).toContain("--setenv");
    // PATH must be allowlisted (required to run tools inside the sandbox).
    const setenvPath = argv[argv.indexOf("--setenv") + 1];
    expect(setenvPath?.startsWith("PATH=")).toBe(true);
    // HOME/LANG/TZ are allowlisted (predictable runtime).
    // HOME/LANG/TZ are allowlisted (predictable runtime). Only assert
    // env vars that are actually set in the host environment (buildBwrapArgv
    // only emits --setenv for defined vars).
    const setEnvKeys = ["HOME", "LANG", "TZ"].filter((k) => process.env[k] !== undefined);
    for (const key of setEnvKeys) {
      const found = argv.some((_, i) => argv[i] === "--setenv" && i + 1 < argv.length && (argv[i + 1] ?? "").startsWith(`${key}=`));
      expect(found).toBe(true);
    }
  });

  it("resource limits (fd, cpu, memory) are encoded", () => {
    const argv = buildBwrapArgv(basePolicy({ maxMemoryMb: 512, cpuShare: 256, timeoutMs: 6000 }));
    expect(argv).toContain("--rlimit-nofile");
    expect(argv).toContain("--rlimit-cpu");
    expect(argv).toContain("--rlimit-as");
  });

  it("read-only runtime dirs are bound read-only", () => {
    const argv = buildBwrapArgv(basePolicy({ readonlyDirs: ["/usr", "/opt"] }));
    expect(argv).toContain("/usr");
    expect(argv).toContain("/opt");
  });
});

// ---------------------------------------------------------------------------
// 3. Env allowlist logic (pure)
// ---------------------------------------------------------------------------

describe("E3-09 env allowlist", () => {
  it("keeps allowlisted keys and drops everything else", () => {
    const env = { PATH: "/usr/bin", HOME: "/home/x", OPENAI_API_KEY: "sk-secret", NODE_ENV: "production" };
    const out = filterEnvAllowlist(env, ["PATH", "HOME"]);
    expect(out).toEqual({ PATH: "/usr/bin", HOME: "/home/x" });
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.NODE_ENV).toBeUndefined();
  });

  it("an empty allowlist yields an empty environment (fail-closed)", () => {
    expect(filterEnvAllowlist({ A: "1", B: "2" }, [])).toEqual({});
  });

  it("allowlist is case-sensitive (no accidental secret widening)", () => {
    const env = { ApiKey: "1", apikey: "2", APIKEY: "3" };
    const out = filterEnvAllowlist(env, ["APIKEY"]);
    expect(out.APIKEY).toBe("3");
    expect(out.ApiKey).toBeUndefined();
    expect(out.apikey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Backend probe matrix (real platform behavior — honest on Windows)
// ---------------------------------------------------------------------------

describe("E3-09 backend probe matrix", () => {
  it("Windows has NO strong backend — reported honestly, never faked", async () => {
    const backend = await probeSandboxBackend("win32");
    expect(backend.strongIsolation).toBe(false);
    expect(backend.id).toBe("win32-none");
    expect(backend.platform).toBe("win32");
  });

  it("darwin without container tooling has no strong backend", async () => {
    const backend = await probeSandboxBackend("darwin");
    expect(backend.strongIsolation).toBe(false);
  });

  it("an unsupported platform is fail-closed unknown", async () => {
    const backend = await probeSandboxBackend("freebsd" as never);
    expect(backend.strongIsolation).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Self-test plumbing (injected backends / runners — no real bwrap needed)
// ---------------------------------------------------------------------------

/** A fake strong backend whose selfTest reports all probes prevented. */
function fakeStrongBackend(): SandboxExecutionBackend {
  return {
    id: "fake-strong",
    platform: "linux",
    strongIsolation: true,
    schemaVersion: "1.0.0",
    wrapperArgv: () => [],
    async selfTest() {
      return {
        ok: true,
        backendId: "fake-strong",
        schemaVersion: "1.0.0",
        digest: "d-ok",
        attempted: ["external-absolute-write"],
        failures: [],
        probes: [{ id: "external-absolute-write", prevented: true, detail: "blocked" }],
      };
    },
  };
}

/** A fake backend whose selfTest reports one failure (leak). */
function leakingBackend(): SandboxExecutionBackend {
  return {
    id: "fake-leaking",
    platform: "linux",
    strongIsolation: true,
    schemaVersion: "1.0.0",
    wrapperArgv: () => [],
    async selfTest() {
      return {
        ok: false,
        backendId: "fake-leaking",
        schemaVersion: "1.0.0",
        digest: "d-leak",
        attempted: ["external-absolute-write", "secret-env-exposure"],
        failures: ["external-absolute-write"],
        probes: [
          { id: "external-absolute-write", prevented: false, detail: "escaped" },
          { id: "secret-env-exposure", prevented: true, detail: "blocked" },
        ],
      };
    },
  };
}

describe("E4-00: capability self-test leaves no residue in the repo working tree", () => {
  const probePolicy = (): SandboxPolicySpec =>
    buildSandboxPolicySpec({
      writableDirs: [process.cwd()],
      readonlyDirs: [],
      envAllowlist: ["PATH", "HOME"],
      maxOutputBytes: 1000,
      timeoutMs: 5000,
    });
  const isUnderTmp = (p: string): boolean => {
    const rel = relative(resolve(tmpdir()), resolve(p));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };

  it("runs the probe in a temp dir (never under cwd) and removes it on success", async () => {
    let capturedBase = "";
    const backend: SandboxExecutionBackend = {
      id: `e400-capture-${process.hrtime.bigint()}`,
      platform: "linux",
      strongIsolation: true,
      schemaVersion: "1.0.0",
      wrapperArgv: () => [],
      async selfTest(paths) {
        capturedBase = paths.outsideDir;
        // Simulate the historical pollution: a real backend writes fixtures/leaks
        // under the probe base (bwrap does mkdirSync + writeFileSync here).
        writeFileSync(join(capturedBase, "e3-09-leaked.txt"), "pwned");
        return {
          ok: true,
          backendId: backend.id,
          schemaVersion: "1.0.0",
          digest: "d-e400",
          attempted: [],
          failures: [],
          probes: [],
        };
      },
    };
    await selfTestForBackend(backend, probePolicy());
    // The base was relocated to the OS temp dir, NOT the repo working tree.
    expect(capturedBase).not.toBe("");
    expect(capturedBase.startsWith(process.cwd())).toBe(false);
    expect(isUnderTmp(capturedBase)).toBe(true);
    // The temp base (and the simulated leak inside it) is gone after the call.
    expect(existsSync(capturedBase)).toBe(false);
    // And the historical repo-root pollution path is never created.
    expect(existsSync(join(process.cwd(), ".e3-09-self-test"))).toBe(false);
  });

  it("removes the temp dir even when the self-test throws", async () => {
    let capturedBase = "";
    const backend: SandboxExecutionBackend = {
      id: `e400-throw-${process.hrtime.bigint()}`,
      platform: "linux",
      strongIsolation: true,
      schemaVersion: "1.0.0",
      wrapperArgv: () => [],
      async selfTest(paths) {
        capturedBase = paths.outsideDir;
        writeFileSync(join(capturedBase, "e3-09-partial.txt"), "x");
        throw new Error("boom-e400");
      },
    };
    await expect(selfTestForBackend(backend, probePolicy())).rejects.toThrow("boom-e400");
    expect(capturedBase.startsWith(process.cwd())).toBe(false);
    // finally-cleanup ran despite the throw.
    expect(existsSync(capturedBase)).toBe(false);
    expect(existsSync(join(process.cwd(), ".e3-09-self-test"))).toBe(false);
  });

  it("capabilityProbe on a non-strong backend also leaves no repo residue", async () => {
    let capturedBase = "";
    const backend: SandboxExecutionBackend = {
      id: `e400-nonstrong-${process.hrtime.bigint()}`,
      platform: "win32",
      strongIsolation: false,
      schemaVersion: "1.0.0",
      wrapperArgv: () => [],
      async selfTest(paths) {
        capturedBase = paths.outsideDir;
        writeFileSync(join(capturedBase, "e3-09-leaked.txt"), "x");
        return {
          ok: false,
          backendId: backend.id,
          schemaVersion: "1.0.0",
          digest: "d-nonstrong",
          attempted: [],
          failures: [],
          probes: [],
        };
      },
    };
    await capabilityProbe({ backend });
    expect(capturedBase.startsWith(process.cwd())).toBe(false);
    expect(isUnderTmp(capturedBase)).toBe(true);
    expect(existsSync(capturedBase)).toBe(false);
    expect(existsSync(join(process.cwd(), ".e3-09-probe"))).toBe(false);
  });

  it("E4-00 no-dirty-worktree: the real-platform gate adds no untracked files to the repo", async () => {
    const porcelain = (): string => {
      try {
        return execFileSync("git", ["status", "--porcelain"], { cwd: process.cwd(), encoding: "utf8" });
      } catch {
        return "";
      }
    };
    const untracked = (): Set<string> =>
      new Set(porcelain().split("\n").filter((l) => l.startsWith("??")).map((l) => l.slice(3).trim()));
    const before = untracked();
    // Exercise the platform-derived gate paths that historically polluted cwd.
    await capabilityProbe();
    await decideBenchmarkConfinement({ allowInsecureLocal: true });
    const added = [...untracked()].filter((p) => !before.has(p));
    expect(added, `gate left untracked files: ${added.join(", ")}`).toEqual([]);
    expect(existsSync(join(process.cwd(), ".e3-09-self-test"))).toBe(false);
    expect(existsSync(join(process.cwd(), ".e3-09-probe"))).toBe(false);
  });
});

describe("E3-09 capability self-test plumbing", () => {
  it("a strong backend whose self-test passes -> capabilityProbe ok, strongIsolation true", async () => {
    const report = await capabilityProbe({ backend: fakeStrongBackend() });
    expect(report.ok).toBe(true);
    expect(report.strongIsolation).toBe(true);
    expect(report.selfTest.digest).toBe("d-ok");
    expect(report.backendId).toBe("fake-strong");
  });

  it("a backend whose self-test fails -> capabilityProbe FAILS CLOSED", async () => {
    const report = await capabilityProbe({ backend: leakingBackend() });
    expect(report.ok).toBe(false);
    expect(report.strongIsolation).toBe(true); // claimed, but NOT trusted
    expect(report.reason).toContain("self-test");
    expect(report.selfTest.failures).toContain("external-absolute-write");
  });

  it("an unavailable backend -> capabilityProbe ok=false with a typed reason", async () => {
    const report = await capabilityProbe({ backend: unavailableBackend("win32") });
    expect(report.ok).toBe(false);
    expect(report.strongIsolation).toBe(false);
    // The reason names the platform/backend and states the fail-closed policy.
    expect(report.reason).toContain("no strong sandbox backend");
    expect(report.reason).toContain("win32");
  });

  it("probe digest is deterministic over (id, prevented) pairs", () => {
    const a = probeDigestOf([
      { id: "network-access", prevented: true, detail: "x" },
      { id: "external-absolute-write", prevented: true, detail: "y" },
    ]);
    const b = probeDigestOf([
      { id: "external-absolute-write", prevented: true, detail: "y" },
      { id: "network-access", prevented: true, detail: "x" },
    ]);
    expect(a).toBe(b);
    expect(a).not.toBe(probeDigestOf([
      { id: "external-absolute-write", prevented: false, detail: "y" },
      { id: "network-access", prevented: true, detail: "x" },
    ]));
  });
});

// ---------------------------------------------------------------------------
// 6. Effect-prevention attack suite orchestration (injected runner)
// ---------------------------------------------------------------------------

describe("E3-09 effect-prevention attack suite", () => {
  const paths = buildProbePaths("/work/base");

  it("each probe command references its attack surface", () => {
    const cmds = capabilityProbeCommands(paths);
    expect(cmds.external).toContain(q(paths.outside));
    expect(cmds.dotdot).toContain(q(paths.workspace));
    expect(cmds.symlink).toContain(q(paths.workspace));
    expect(cmds.symlink).toContain(q(paths.outsideDir));
    expect(cmds.redirection).toContain(q(paths.outside));
    expect(cmds.interpreter).toContain(q(paths.interpreterTarget));
    expect(cmds.tracked).toContain(q(paths.trackedAttack));
    expect(cmds.secret).toContain(q(paths.secretName));
    expect(cmds.network).toContain(paths.networkHost);
  });

  it("a runner that blocks every attack -> all probes prevented, ok=true", async () => {
    const dir = tmp();
    const p = buildProbePaths(dir);
    const runner = async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 });
    const result = await runCapabilityProbes({
      backendId: "injected",
      paths: p,
      runner,
      secretName: "E3_09_SECRET",
      secretValue: "hunter2",
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.attempted.length).toBeGreaterThanOrEqual(6);
    // Every probe has a deterministic digest.
    expect(result.digest).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a runner that lets one attack succeed -> that probe fails and ok=false", async () => {
    const dir = tmp();
    const p = buildProbePaths(dir);
    // Simulate an escape: runner exits 1 (the write succeeded -> leak signal).
    const runner = async () => ({ exitCode: 1, stdout: "", stderr: "", durationMs: 1 });
    const result = await runCapabilityProbes({
      backendId: "injected",
      paths: p,
      runner,
      secretName: "E3_09_SECRET",
      secretValue: "hunter2",
    });
    expect(result.ok).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    // The effect assertion is the core: a leak means an external file exists.
    expect(result.probes.every((pr) => pr.prevented)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("the effect assertion is on the file NOT existing, not on a sentinel flag", async () => {
    const dir = tmp();
    const p = buildProbePaths(dir);
    // Runner claims "blocked" (exit 0) BUT actually wrote the file -> must fail.
    const runner = async () => {
      // Write the outside file even though the runner reports success (a
      // dishonest backend must still be caught by the effect check).
      const { writeFileSync } = await import("node:fs");
      try {
        writeFileSync(p.outside, "pwned");
      } catch {
        /* effect check below decides */
      }
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    };
    const result = await runCapabilityProbes({
      backendId: "injected",
      paths: p,
      runner,
      secretName: "E3_09_SECRET",
      secretValue: "hunter2",
    });
    // The effect check must mark the external write probe as NOT prevented.
    const ext = result.probes.find((pr) => pr.id === "external-absolute-write");
    expect(ext?.prevented).toBe(false);
    expect(result.ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 7. Confinement decision / insecure local mode
// ---------------------------------------------------------------------------

describe("E3-09 confinement decision (insecure local mode)", () => {
  it("strong backend + self-test ok -> mode strong, promotionEligible true", async () => {
    const decision = await decideBenchmarkConfinement({ allowInsecureLocal: false, backend: fakeStrongBackend() });
    expect(decision.mode).toBe("strong");
    expect(decision.promotionEligible).toBe(true);
    expect(decision.warning).toBeUndefined();
    expect(decision.provenance.strongIsolation).toBe(true);
    expect(decision.provenance.selfTestDigest).toBe("d-ok");
  });

  it("weak backend + no --allow-insecure-local-benchmark -> REFUSED before any provider call", async () => {
    const decision = await decideBenchmarkConfinement({
      allowInsecureLocal: false,
      backend: unavailableBackend("win32"),
    });
    expect(decision.mode).toBe("refused");
    expect(decision.promotionEligible).toBe(false);
  });

  it("weak backend + explicit allow-insecure-local -> insecure-local, NEVER promotion-eligible, warning", async () => {
    const decision = await decideBenchmarkConfinement({
      allowInsecureLocal: true,
      backend: unavailableBackend("win32"),
    });
    expect(decision.mode).toBe("insecure-local");
    expect(decision.promotionEligible).toBe(false);
    expect(decision.warning).toBeTruthy();
    expect(decision.warning).toContain("INSECURE");
    expect(decision.provenance.insecureLocal).toBe(true);
    expect(decision.provenance.strongIsolation).toBe(false);
  });

  it("the insecure-local flag name is the documented CLI contract", () => {
    expect(ALLOW_INSECURE_LOCAL_BENCHMARK_FLAG).toBe("--allow-insecure-local-benchmark");
  });

  it("insecureLocalBackend is a distinct backend that is never promotion-eligible", async () => {
    const backend = insecureLocalBackend("win32");
    expect(backend.strongIsolation).toBe(false);
    const self = await backend.selfTest(buildProbePaths("/tmp/x"), basePolicy());
    expect(self.ok).toBe(false);
    expect(self.probes.every((pr) => pr.prevented === false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. ProcessExecutor with a verified sandbox execution spec
// ---------------------------------------------------------------------------

describe("E3-09 ProcessExecutor sandboxed spawn", () => {
  it("unavailable backend + strong-required -> typed DENIAL, no process spawn, exitCode null", async () => {
    const ws = tmp();
    try {
      const policy = buildSandboxPolicySpec({
        writableDirs: [ws],
        readonlyDirs: [],
        envAllowlist: ["PATH", "HOME"],
        maxOutputBytes: 1000,
        timeoutMs: 5000,
      });
      const backend = unavailableBackend("win32");
      const outcome = await new ProcessExecutor().run({
        command: `${q(NODE)} -e "process.exit(0)"`,
        cwd: ws,
        sandboxExecution: {
          backend,
          policy,
          selfTest: { ok: false, backendId: backend.id, schemaVersion: "1.0.0", digest: "unavailable", attempted: [], failures: [], probes: [] },
        },
      });
      expect(outcome.status).toBe("denied");
      expect(outcome.exitCode).toBeNull();
      expect(outcome.denial?.code).toBe(SANDBOX_BACKEND_DENIED);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("insecure-local backend runs but flags the outcome insecure (never promotion-eligible)", async () => {
    const ws = tmp();
    try {
      const policy = buildSandboxPolicySpec({
        writableDirs: [ws],
        readonlyDirs: [],
        envAllowlist: ["PATH", "HOME"],
        maxOutputBytes: 1000,
        timeoutMs: 5000,
      });
      const backend = insecureLocalBackend(process.platform);
      const outcome = await new ProcessExecutor().run({
        command: `${q(NODE)} -e "process.stdout.write('ran')"`,
        cwd: ws,
        sandboxExecution: {
          backend,
          policy,
          selfTest: { ok: false, backendId: backend.id, schemaVersion: "1.0.0", digest: "insecure-none", attempted: [], failures: [], probes: [] },
          allowInsecureLocal: true,
        },
      });
      expect(outcome.status).toBe("success");
      expect(outcome.stdout).toBe("ran");
      expect(outcome.insecure).toBe(true);
      expect(outcome.provenance?.insecureLocal).toBe(true);
      expect(outcome.provenance?.strongIsolation).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("strong backend applies the env allowlist: a secret is NOT visible to the child", async () => {
    const ws = tmp();
    try {
      const policy = buildSandboxPolicySpec({
        writableDirs: [ws],
        readonlyDirs: [],
        envAllowlist: ["PATH", "HOME"],
        maxOutputBytes: 1000,
        timeoutMs: 5000,
      });
      // A fake strong backend: plain shell spawn but with allowlist filtering.
      const backend: SandboxExecutionBackend = {
        id: "fake-strong-filter",
        platform: "linux",
        strongIsolation: true,
        schemaVersion: "1.0.0",
        wrapperArgv: () => [],
        async selfTest() {
          return { ok: true, backendId: "fake-strong-filter", schemaVersion: "1.0.0", digest: "d", attempted: [], failures: [], probes: [] };
        },
      };
      const secretValue = "sk-TOP-SECRET";
      const outcome = await new ProcessExecutor().run({
        command: `${q(NODE)} -e "process.stdout.write(process.env.E3_09_LEAK || 'none')"`,
        cwd: ws,
        env: { E3_09_LEAK: secretValue },
        sandboxExecution: { backend, policy, selfTest: { ok: true, backendId: "x", schemaVersion: "1.0.0", digest: "d", attempted: [], failures: [], probes: [] } },
      });
      expect(outcome.status).toBe("success");
      // The allowlist does NOT include E3_09_LEAK, so the child must NOT see it.
      expect(outcome.stdout).toBe("none");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
