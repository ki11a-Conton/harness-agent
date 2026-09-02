import { describe, expect, it, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeIsolationBackend,
  promotionEligible,
  asInsecureLocalBackend,
  treeDigestOf,
  captureHostState,
  hostMutated,
  isPathOutsideWorkspace,
  withHostMutationSentinel,
  type IsolationBackend,
} from "./benchmark-isolation.js";
import { prepareSandboxedExec, ProcessExecutor, ALLOW_INSECURE_LOCAL_BENCHMARK_FLAG } from "@ar/tools";

async function makeTemp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "e2-09-"));
}

function node(cmd: string): string {
  const nodeExe = process.execPath;
  return `${JSON.stringify(nodeExe)} -e ${JSON.stringify(cmd)}`;
}

describe("E2-09 benchmark isolation backend matrix", () => {
  it("1. platform backend is known; Windows has NO strong isolation (promotion refused)", async () => {
    const backend = await probeIsolationBackend("win32");
    expect(backend.strongIsolation).toBe(false);
    expect(promotionEligible(backend)).toBe(false);
    expect(backend.id).toBe("win32-none");
    // Promotion preflight refuses before any provider call.
    expect(backend.note).toContain("never promotion-eligible");
  });

  it("1b. linux with bwrap detected is promotion-eligible", async () => {
    // Not asserting the actual host (we may not be on linux); assert the rule:
    // strongIsolation => promotionEligible.
    expect(promotionEligible({ schemaVersion: "1.0.0", id: "linux-bwrap", platform: "linux", strongIsolation: true, note: "x" })).toBe(true);
    expect(promotionEligible({ schemaVersion: "1.0.0", id: "unknown", platform: "linux", strongIsolation: false, note: "x" })).toBe(false);
  });

  it("1c. an insecure-local backend is NEVER promotion-eligible, even with a strong id", () => {
    const strong: IsolationBackend = { schemaVersion: "1.0.0", id: "linux-bwrap", platform: "linux", strongIsolation: true, note: "x" };
    const insecure = asInsecureLocalBackend(strong);
    expect(insecure.strongIsolation).toBe(false);
    expect(insecure.insecureLocal).toBe(true);
    expect(promotionEligible(insecure)).toBe(false);
    expect(insecure.note).toContain("INSECURE LOCAL MODE");
  });
});

describe("E2-09 host mutation sentinel (real child-process escapes)", () => {
  it("2. EFFECT PREVENTION: a scripted exec write outside the workspace is DENIED (or blocked); the external file does NOT exist (E3-09)", async () => {
    const ws = await makeTemp();
    const host = await makeTemp();
    const escaped = join(host, "src", "escaped.txt");
    try {
      await writeFile(join(host, "tracked.txt"), "original", "utf8");
      await mkdir(join(host, "src"), { recursive: true });

      // Scripted exec attempt: write a file outside the case workspace.
      const nodeCmd = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(escaped)}, 'pwned')`)}`;

      // Use the REAL platform backend probe (win32 → unavailable → denied).
      const prep = await prepareSandboxedExec({
        confinement: "strong",
        workspaceRoot: ws,
        command: nodeCmd,
        cwd: ws,
        timeoutMs: 10000,
        maxOutputBytes: 10000,
      });

      if (!prep.ok) {
        // Fail-closed: denied before any process. The effect never happened.
        expect(prep.denial.code).toBeTruthy();
        expect(prep.denial.code).toContain("SANDBOX_BACKEND");
      } else {
        // Strong backend available (Linux CI with bwrap): the process runs
        // inside the sandbox and the write to the read-only host root is
        // blocked. exitCode MUST be non-zero (write failed).
        const outcome = await new ProcessExecutor().run({
          command: nodeCmd,
          cwd: ws,
          timeoutMs: 10000,
          maxOutputBytes: 10000,
          sandboxExecution: prep.sandboxExecution,
        });
        // The sandbox blocked the write → the process exited with an error.
        // (A "denied" status also means blocked; "failed" with exitCode != 0
        // means the write was attempted but EROFS prevented it.)
        if (outcome.status === "denied") {
          expect(outcome.denial?.code).toBeTruthy();
        } else {
          expect(outcome.exitCode).not.toBe(0);
        }
      }

      // THE CORE ASSERTION: the external file does NOT exist (the effect
      // never happened). This is the E3-09 strengthening over the old
      // sentinel-only assertion.
      await expect(access(escaped)).rejects.toThrow();
    } finally {
      await rm(ws, { recursive: true, force: true });
      await rm(host, { recursive: true, force: true });
    }
  });

  it("2b. insecure local mode is explicit, warned, and NEVER promotion-eligible", async () => {
    const winBackend = await probeIsolationBackend("win32");
    const insecure = asInsecureLocalBackend(winBackend);
    expect(insecure.strongIsolation).toBe(false);
    expect(insecure.insecureLocal).toBe(true);
    expect(promotionEligible(insecure)).toBe(false);
    expect(insecure.note).toContain("INSECURE LOCAL MODE");
    expect(ALLOW_INSECURE_LOCAL_BENCHMARK_FLAG).toBe("--allow-insecure-local-benchmark");
  });

  it("2b. node -e writing INSIDE the workspace does not mutate the host tree", async () => {
    const ws = await makeTemp();
    const host = await makeTemp();
    try {
      await writeFile(join(host, "tracked.txt"), "original", "utf8");
      const before = await captureHostState(host, { include: ["tracked.txt"], excludePrefixes: [] });
      const inside = join(ws, "ok.txt");
      await new Promise<void>((res, rej) => {
        execFile(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(inside)}, 'ok')`], { cwd: ws }, (err) => (err ? rej(err) : res()));
      });
      const after = await captureHostState(host, { include: ["tracked.txt"], excludePrefixes: [] });
      expect(hostMutated(before, after)).toBe(false);
    } finally {
      await rm(ws, { recursive: true, force: true });
      await rm(host, { recursive: true, force: true });
    }
  });

  it("3. modifying a host tracked file is detected via git status / tree digest", async () => {
    const host = await makeTemp();
    try {
      await writeFile(join(host, "tracked.txt"), "original", "utf8");
      const before = await captureHostState(host, { include: ["tracked.txt"], excludePrefixes: [] });
      await writeFile(join(host, "tracked.txt"), "MODIFIED", "utf8");
      const after = await captureHostState(host, { include: ["tracked.txt"], excludePrefixes: [] });
      expect(hostMutated(before, after)).toBe(true);
    } finally {
      await rm(host, { recursive: true, force: true });
    }
  });

  it("3b. host unchanged (same content) is NOT mutated", async () => {
    const host = await makeTemp();
    try {
      await writeFile(join(host, "tracked.txt"), "same", "utf8");
      const before = await captureHostState(host, { include: ["tracked.txt"], excludePrefixes: [] });
      const after = await captureHostState(host, { include: ["tracked.txt"], excludePrefixes: [] });
      expect(hostMutated(before, after)).toBe(false);
    } finally {
      await rm(host, { recursive: true, force: true });
    }
  });

  it("4. withHostMutationSentinel reports host mutations around a case run", async () => {
    const ws = await makeTemp();
    const host = await makeTemp();
    try {
      await writeFile(join(host, "tracked.txt"), "original", "utf8");
      await mkdir(join(host, "src"), { recursive: true });
      const { value, report } = await withHostMutationSentinel({
        hostRoot: host,
        watchInclude: ["tracked.txt", "src"],
        watchExcludePrefixes: ["node_modules", ".git"],
        run: async () => {
          // Child writes into the host src dir (outside the case workspace).
          await writeFile(join(host, "src", "leak.ts"), "// leaked", "utf8");
          return "ran";
        },
      });
      expect(value).toBe("ran");
      expect(report.hostMutated).toBe(true);
      expect(report.details.length).toBeGreaterThan(0);
    } finally {
      await rm(ws, { recursive: true, force: true });
      await rm(host, { recursive: true, force: true });
    }
  });

  it("6. normal in-workspace work still passes through the sentinel untouched", async () => {
    const ws = await makeTemp();
    const host = await makeTemp();
    try {
      await writeFile(join(host, "tracked.txt"), "original", "utf8");
      const { value, report } = await withHostMutationSentinel({
        hostRoot: host,
        watchInclude: ["tracked.txt"],
        watchExcludePrefixes: [],
        run: async () => {
          // Normal case work inside the case workspace only.
          await writeFile(join(ws, "solution.txt"), "answer", "utf8");
          return "ok";
        },
      });
      expect(value).toBe("ok");
      expect(report.hostMutated).toBe(false);
    } finally {
      await rm(ws, { recursive: true, force: true });
      await rm(host, { recursive: true, force: true });
    }
  });

  it("8. isPathOutsideWorkspace classifies escape vs containment with explicit flavor", () => {
    // Windows workspace, interpreted with win32 semantics regardless of host OS.
    const ws = "C:\\ws\\case-1";
    expect(isPathOutsideWorkspace("C:\\ws\\case-1\\file.txt", ws, "win32")).toBe(false);
    expect(isPathOutsideWorkspace("C:\\ws\\other\\file.txt", ws, "win32")).toBe(true);
    expect(isPathOutsideWorkspace("C:\\ws\\case-1\\..\\..\\etc\\passwd", ws, "win32")).toBe(true);
    expect(isPathOutsideWorkspace("D:\\elsewhere\\x", ws, "win32")).toBe(true);

    // POSIX workspace, interpreted with posix semantics.
    const pws = "/ws/case-1";
    expect(isPathOutsideWorkspace("/ws/case-1/file.txt", pws, "posix")).toBe(false);
    expect(isPathOutsideWorkspace("/ws/other/file.txt", pws, "posix")).toBe(true);
    expect(isPathOutsideWorkspace("/ws/case-1/../../etc/passwd", pws, "posix")).toBe(true);
    expect(isPathOutsideWorkspace("/etc/passwd", pws, "posix")).toBe(true);
  });

  it("8b. path flavor covers Windows drive, UNC and POSIX root semantics", () => {
    // Drive letter must be resolved with win32 (host-independent).
    expect(isPathOutsideWorkspace("c:\\ws\\case-1\\a.txt", "C:\\ws\\case-1", "win32")).toBe(false);
    // UNC workspace (\\server\share\case) with UNC child path.
    const uncWs = "\\\\server\\share\\case-1";
    expect(isPathOutsideWorkspace("\\\\server\\share\\case-1\\file.txt", uncWs, "win32")).toBe(false);
    expect(isPathOutsideWorkspace("\\\\server\\share\\other\\file.txt", uncWs, "win32")).toBe(true);
    // POSIX root: a bare absolute path outside the workspace is outside.
    expect(isPathOutsideWorkspace("/tmp/x", "/ws/case-1", "posix")).toBe(true);
    expect(isPathOutsideWorkspace("/ws/case-1", "/ws/case-1", "posix")).toBe(false);
  });

  it("8c. default flavor follows host platform (consistent containment on host paths)", () => {
    // On the host platform the default flavor must never mis-classify a path
    // that lives inside the workspace.
    const hostWs = join(process.cwd(), "case-1");
    expect(isPathOutsideWorkspace(join(hostWs, "file.txt"), hostWs)).toBe(false);
    expect(isPathOutsideWorkspace(join(hostWs, "..", "other", "x.txt"), hostWs)).toBe(true);
  });

  it("treeDigestOf is deterministic and sensitive to content", async () => {
    const dir = await makeTemp();
    try {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "a.txt"), "a", "utf8");
      await writeFile(join(dir, "src", "b.txt"), "b", "utf8");
      const d1 = await treeDigestOf(dir, { include: ["src"], excludePrefixes: [] });
      const d2 = await treeDigestOf(dir, { include: ["src"], excludePrefixes: [] });
      expect(d1).toBe(d2);
      expect(d1).not.toBeNull();
      await writeFile(join(dir, "src", "a.txt"), "a-CHANGED", "utf8");
      const d3 = await treeDigestOf(dir, { include: ["src"], excludePrefixes: [] });
      expect(d3).not.toBe(d1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});