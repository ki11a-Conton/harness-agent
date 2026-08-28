import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execTool, resolveExecCwd } from "./exec.js";
import type { ToolExecutionContext } from "@ar/contracts";

let ws = "";
let outside = "";

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "ar-exec-ws-"));
  outside = mkdtempSync(join(tmpdir(), "ar-exec-out-"));
  mkdirSync(join(ws, "sub", "nested"), { recursive: true });
});

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const NODE = process.execPath;

function ctx(cwd = ws): ToolExecutionContext {
  return {
    sessionId: "s" as never,
    agentId: "a" as never,
    cwd,
    signal: new AbortController().signal,
    permissions: { allow: [] } as never,
    sandboxPolicy: {
      filesystem: { mode: "workspace-write" },
      network: { mode: "deny" },
      process: { timeoutMs: 10_000, maxOutputBytes: 100_000 },
    },
  };
}

describe("resolveExecCwd — E1-02 workspace containment", () => {
  it("no cwd → workspace root", async () => {
    expect(await resolveExecCwd(undefined, ws)).toBe(resolve(ws));
  });

  it("'.' → workspace root (NOT host cwd)", async () => {
    expect(await resolveExecCwd(".", ws)).toBe(resolve(ws));
  });

  it("'sub/dir' → normalized absolute inside workspace", async () => {
    expect(await resolveExecCwd("sub/nested", ws)).toBe(resolve(ws, "sub", "nested"));
  });

  it("absolute path inside workspace is allowed", async () => {
    expect(await resolveExecCwd(resolve(ws, "sub"), ws)).toBe(resolve(ws, "sub"));
  });

  it("'../outside' is rejected with WORKSPACE_POLICY:cwd-outside", async () => {
    await expect(resolveExecCwd("../outside", ws)).rejects.toThrow("WORKSPACE_POLICY:cwd-outside");
  });

  it("absolute path outside workspace is rejected", async () => {
    await expect(resolveExecCwd(resolve(outside), ws)).rejects.toThrow("WORKSPACE_POLICY:cwd-outside");
  });

  it("symlink inside pointing outside is rejected (WORKSPACE_POLICY:symlink-escape)", async () => {
    const link = join(ws, "escape-link");
    try {
      symlinkSync(outside, link, "dir");
    } catch {
      // symlink creation may fail on restricted hosts — skip rather than flake.
      return;
    }
    await expect(resolveExecCwd(link, ws)).rejects.toThrow("WORKSPACE_POLICY:symlink-escape");
  });

  it("non-existent cwd is rejected (WORKSPACE_POLICY:cwd-unresolvable)", async () => {
    await expect(resolveExecCwd("no-such-dir", ws)).rejects.toThrow("WORKSPACE_POLICY:cwd-unresolvable");
  });

  it("non-directory cwd is rejected (WORKSPACE_POLICY:cwd-not-directory)", async () => {
    const file = join(ws, "file.txt");
    writeFileSync(file, "x");
    await expect(resolveExecCwd("file.txt", ws)).rejects.toThrow("WORKSPACE_POLICY:cwd-not-directory");
  });
});

describe("execTool cwd — E1-02 end-to-end", () => {
  it("`cwd: '.'` runs inside the session workspace, not the host cwd", async () => {
    const r = await execTool.execute({ command: `${JSON.stringify(NODE)} -e "console.log(process.cwd())"`, cwd: "." }, ctx());
    expect(r.status).toBe("success");
    if (r.status === "success" && r.output !== undefined) {
      expect(r.output.stdout.trim()).toBe(resolve(ws));
    }
  });

  it("`cwd: '../outside'` is refused with WORKSPACE_POLICY before any process runs", async () => {
    const r = await execTool.execute({ command: `${JSON.stringify(NODE)} -e "process.exit(0)"`, cwd: "../outside" }, ctx());
    expect(r.status).toBe("failed");
    if (r.status === "failed" && r.error !== undefined) {
      expect(r.error.code).toBe("WORKSPACE_POLICY");
    }
  });

  it("`cwd: <absolute outside path>` is refused", async () => {
    const r = await execTool.execute({ command: `${JSON.stringify(NODE)} -e "process.exit(0)"`, cwd: resolve(outside) }, ctx());
    expect(r.status).toBe("failed");
    if (r.status === "failed" && r.error !== undefined) {
      expect(r.error.code).toBe("WORKSPACE_POLICY");
    }
  });
});
