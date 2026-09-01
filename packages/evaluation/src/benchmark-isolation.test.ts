import { describe, expect, it, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  probeIsolationBackend,
  promotionEligible,
  treeDigestOf,
  captureHostState,
  hostMutated,
  isPathOutsideWorkspace,
  withHostMutationSentinel,
} from "./benchmark-isolation.js";

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
});

describe("E2-09 host mutation sentinel (real child-process escapes)", () => {
  it("2. node -e writing an absolute path OUTSIDE the workspace mutates the host tree -> detected", async () => {
    const ws = await makeTemp();
    const host = await makeTemp(); // pretend host repo sandbox
    try {
      await writeFile(join(host, "tracked.txt"), "original", "utf8");
      await mkdir(join(host, "src"), { recursive: true });
      const before = await captureHostState(host, { include: ["tracked.txt", "src"], excludePrefixes: [] });

      // Child process writes OUTSIDE ws into the host tree via absolute path.
      const escaped = join(host, "src", "escaped.txt");
      await new Promise<void>((res, rej) => {
        execFile(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(escaped)}, 'pwned')`], { cwd: ws }, (err) => (err ? rej(err) : res()));
      });

      const after = await captureHostState(host, { include: ["tracked.txt", "src"], excludePrefixes: [] });
      expect(hostMutated(before, after)).toBe(true);

      // And the external file actually exists (proving the escape happened and
      // the sentinel caught it).
      const { stat } = await import("node:fs/promises");
      await expect(stat(escaped)).resolves.toBeDefined();
    } finally {
      await rm(ws, { recursive: true, force: true });
      await rm(host, { recursive: true, force: true });
    }
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

  it("8. isPathOutsideWorkspace classifies escape vs containment (incl. relative ..)", () => {
    const ws = resolve("C:\\ws\\case-1");
    expect(isPathOutsideWorkspace("C:\\ws\\case-1\\file.txt", ws)).toBe(false);
    expect(isPathOutsideWorkspace("C:\\ws\\other\\file.txt", ws)).toBe(true);
    expect(isPathOutsideWorkspace("C:\\ws\\case-1\\..\\..\\etc\\passwd", ws)).toBe(true);
    expect(isPathOutsideWorkspace("D:\\elsewhere\\x", ws)).toBe(true);
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