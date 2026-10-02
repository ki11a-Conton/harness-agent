import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, spawn as Spawn } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { newAgentId, newSessionId, newToolCallId, newTurnId } from "@ar/contracts";
import type { ToolDefinition, ToolResult } from "@ar/contracts";
import { ProcessExecutor } from "./executor.js";
import type { SandboxExecutionOption } from "./sandbox-executor.js";
import { ToolOrchestrator } from "../orchestrator.js";
import { ToolRegistry } from "../registry.js";

const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:child_process")>()), spawn: mock.spawn }));
let ws: string;
beforeAll(async () => { ws = await mkdtemp(join(tmpdir(), "r3b-utf8-")); });
afterAll(async () => { await rm(ws, { recursive: true, force: true }); });
beforeEach(async () => { const real = await vi.importActual<typeof import("node:child_process")>("node:child_process"); mock.spawn.mockImplementation(real.spawn); });

function childWithChunks(stdout: Buffer[], stderr: Buffer[] = [], exitCode = 0) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, kill: vi.fn() });
  mock.spawn.mockReturnValueOnce(child as unknown as ChildProcess);
  queueMicrotask(() => {
    for (const chunk of stdout) child.stdout.write(chunk);
    for (const chunk of stderr) child.stderr.write(chunk);
    child.stdout.end(); child.stderr.end();
    child.emit("close", exitCode, null);
  });
}

function sandbox(): SandboxExecutionOption {
  const selfTest = { ok: true, backendId: "controlled-test", schemaVersion: "1.0.0", digest: "test", attempted: [], failures: [], probes: [] };
  return {
    backend: { id: "controlled-test", platform: process.platform, strongIsolation: true, schemaVersion: "1.0.0", wrapperArgv: () => [], selfTest: async () => selfTest },
    policy: { schemaVersion: "1.0.0", writableDirs: [ws], readonlyDirs: [], envAllowlist: [], network: false, pidNamespace: true, maxOutputBytes: 8, timeoutMs: 1000 }, selfTest,
  };
}

async function collectRoute(route: string, stdout: Buffer[], stderr: Buffer[], maxOutputBytes: number, onOutput?: (event: { stream: "stdout" | "stderr"; text: string }) => void) {
  childWithChunks(stdout, stderr);
  const executor = new ProcessExecutor();
  return route === "argv"
    ? executor.runArgv({ file: process.execPath, args: [], cwd: ws, maxOutputBytes, onOutput })
    : executor.run({ command: "controlled-test", cwd: ws, maxOutputBytes, onOutput, ...(route === "sandbox" ? { sandboxExecution: sandbox() } : {}) });
}

describe("R3b ProcessExecutor UTF-8 byte capture and streaming", () => {
  it.each(["argv", "shell", "sandbox"])("%s limits stdout/stderr to independent 8-byte prefixes", async (route) => {
    const out = await collectRoute(route, [Buffer.from("中".repeat(100))], [Buffer.from("😀".repeat(100))], 8);
    expect(out.status).toBe("success");
    expect(out.stdout).toBe("中中");
    expect(out.stderr).toBe("😀😀");
    expect(Buffer.byteLength(out.stdout)).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(out.stderr)).toBeLessThanOrEqual(8);
    expect(out.truncated).toBe(true);
    if (route === "sandbox") expect(out.provenance).toMatchObject({ backendId: "controlled-test", strongIsolation: true, selfTestDigest: "test" });
  });

  it.each(["argv", "shell", "sandbox"])("%s preserves valid UTF-8 across every single-byte chunk and full streaming after capture fills", async (route) => {
    const text = "A中😀B";
    const events: Array<{ stream: string; text: string }> = [];
    const chunks = [...Buffer.from(text)].map((byte) => Buffer.from([byte]));
    const out = await collectRoute(route, chunks, chunks, 4, (event) => events.push(event));
    expect(out.stdout).toBe("A中");
    expect(out.stderr).toBe("A中");
    expect(events.filter((event) => event.stream === "stdout").map((event) => event.text).join("")).toBe(text);
    expect(events.filter((event) => event.stream === "stderr").map((event) => event.text).join("")).toBe(text);
    expect(out.truncated).toBe(true);
  });

  it.each([0, 1, 2, 3, 4, 7, 8, 9, 10])("cap=%s retains only a whole-character prefix", async (cap) => {
    const text = "A中😀BC";
    const out = await collectRoute("argv", [Buffer.from(text)], [], cap);
    expect(Buffer.byteLength(out.stdout)).toBeLessThanOrEqual(cap);
    expect(text.startsWith(out.stdout)).toBe(true);
    expect(Buffer.from(out.stdout).toString("utf8")).toBe(out.stdout);
    expect(out.truncated).toBe(cap < Buffer.byteLength(text));
  });

  it("flushes genuinely incomplete UTF-8 once with replacement semantics", async () => {
    const streamed: string[] = [];
    const out = await collectRoute("argv", [Buffer.from([0xf0, 0x9f])], [], 8, (event) => streamed.push(event.text));
    expect(out.stdout).toBe("�");
    expect(streamed.join("")).toBe("�");
    expect(out.truncated).toBe(false);
  });

  it.each(["argv", "shell", "sandbox"])("%s keeps decoding and capturing when the streaming observer throws", async (route) => {
    const diagnostics = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const events: Array<{ stream: string; text: string }> = [];
    const text = "A中😀B";
    const chunks = [...Buffer.from(text)].map((byte) => Buffer.from([byte]));
    try {
      const out = await collectRoute(route, chunks, chunks, 4, (event) => {
        events.push(event);
        throw new Error("observer failed");
      });
      expect(out).toMatchObject({ status: "success", exitCode: 0, stdout: "A中", stderr: "A中", truncated: true });
      expect(events.filter((event) => event.stream === "stdout").map((event) => event.text).join("")).toBe(text);
      expect(events.filter((event) => event.stream === "stderr").map((event) => event.text).join("")).toBe(text);
      expect(diagnostics).toHaveBeenCalledWith("[degraded] executor.onOutput: observer failed\n");
    } finally {
      diagnostics.mockRestore();
    }
  });

  it("continues draining a flood after the capture prefix is closed", async () => {
    const streamed: string[] = [];
    const out = await collectRoute("argv", [Buffer.from("中"), ...Array.from({ length: 100 }, () => Buffer.alloc(2048, 120))], [], 1, (event) => streamed.push(event.text));
    expect(out.stdout).toBe("");
    expect(out.status).toBe("success");
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(streamed.join(""))).toBe(204803);
  });

  it("captures actual argv process UTF-8 under the cap without changing exit status", async () => {
    const out = await new ProcessExecutor().runArgv({ file: process.execPath, args: ["-e", "process.stdout.write('中'.repeat(100)); process.stderr.write('😀'.repeat(100)); process.exitCode=3"], cwd: ws, maxOutputBytes: 8 });
    expect(out.status).toBe("failed");
    expect(out.exitCode).toBe(3);
    expect(out.stdout).toBe("中中");
    expect(out.stderr).toBe("😀😀");
  });
});

describe("R3b Orchestrator string capture cap", () => {
  async function executeResult(raw: ToolResult, maxOutputBytes: number) {
    const registry = new ToolRegistry();
    const tool: ToolDefinition = {
      name: "output_contract", description: "test", inputSchema: z.object({}), risk: "readonly",
      metadata: { name: "output_contract", version: "1", sideEffect: false, network: false, filesystem: false, process: false, interactive: false },
      execute: async () => raw,
    };
    registry.register(tool);
    const sessionId = newSessionId(); const turnId = newTurnId(); const agentId = newAgentId();
    return new ToolOrchestrator({ registry, workspaceRoot: ws }).execute(
      { id: newToolCallId(), sessionId, turnId, agentId, call: { id: newToolCallId(), name: tool.name, args: {} } },
      { sessionId, turnId, agentId, cwd: ws, signal: new AbortController().signal, permissions: { defaultEffect: "allow", rules: [] }, sandboxPolicy: { filesystem: { mode: "workspace-write", allowedPaths: [ws] }, network: { mode: "deny" }, process: { maxOutputBytes } } },
    );
  }

  it.each(["中".repeat(100), "😀".repeat(100)])("caps the real tool result by UTF-8 body bytes", async (output) => {
    const registry = new ToolRegistry();
    const tool: ToolDefinition = {
      name: "echo_utf8", description: "test", inputSchema: z.object({}), risk: "readonly",
      metadata: { name: "echo_utf8", version: "1", sideEffect: false, network: false, filesystem: false, process: false, interactive: false },
      execute: async () => ({ status: "success", output }),
    };
    registry.register(tool);
    const sessionId = newSessionId(); const turnId = newTurnId(); const agentId = newAgentId();
    const result = await new ToolOrchestrator({ registry, workspaceRoot: ws }).execute(
      { id: newToolCallId(), sessionId, turnId, agentId, call: { id: newToolCallId(), name: tool.name, args: {} } },
      { sessionId, turnId, agentId, cwd: ws, signal: new AbortController().signal, permissions: { defaultEffect: "allow", rules: [] }, sandboxPolicy: { filesystem: { mode: "workspace-write", allowedPaths: [ws] }, network: { mode: "deny" }, process: { maxOutputBytes: 8 } } },
    );
    expect(result.status).toBe("success");
    const [body] = (result.output as string).split("\n");
    expect(Buffer.byteLength(body!)).toBeLessThanOrEqual(8);
    expect(Buffer.from(body!).toString("utf8")).toBe(body);
    expect(result.output).toContain("output truncated at 8 bytes");
  });

  it.each([0, 1, 2, 3, 4, 7, 8, 9, 10, 11])("cap=%s limits only whole UTF-8 body bytes and adds a separate marker", async (cap) => {
    const output = "A中😀\r\nB";
    const raw: ToolResult = { status: "failed", output, error: { code: "PROCESS_ERROR", message: "exit code 3", retryable: false, safeToRetry: false }, evidence: [{ type: "command", description: "retained", source: "fixture", timestamp: 0 }], metadata: { exitCode: 3 } };
    const before = structuredClone(raw);
    const result = await executeResult(raw, cap);
    if (cap < Buffer.byteLength(output)) {
      const marker = `\n…[output truncated at ${cap} bytes]`;
      expect((result.output as string).endsWith(marker)).toBe(true);
      const body = (result.output as string).slice(0, -marker.length);
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(cap);
      expect(output.startsWith(body)).toBe(true);
      expect(body).not.toContain("�");
      expect(Buffer.byteLength(result.output as string)).toBeGreaterThan(cap);
    } else {
      expect(result.output).toBe(output);
    }
    expect(result).toMatchObject({ status: raw.status, error: raw.error, evidence: raw.evidence, metadata: raw.metadata });
    expect(raw).toEqual(before);
  });

  it("keeps structured process results intact even at cap=0", async () => {
    const output = { exitCode: 3, stdout: "中".repeat(100), stderr: "😀".repeat(100), truncated: false };
    const raw: ToolResult = { status: "failed", output, error: { code: "PROCESS_ERROR", message: "exit code 3", retryable: false, safeToRetry: false }, metadata: { retained: true } };
    const result = await executeResult(raw, 0);
    expect(result.output).toBe(output);
    expect(result).toMatchObject(raw);
    expect(output.truncated).toBe(false);
  });
});
