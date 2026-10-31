import { setImmediate as nextTick } from "node:timers/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { newAgentId, newSessionId, newToolCallId, newTurnId, type EventSink, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "@ar/contracts";
import { ToolOrchestrator } from "./orchestrator.js";
import { ToolRegistry } from "./registry.js";
import { execTool } from "./tools/exec.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(execute: (context: ToolExecutionContext) => Promise<ToolResult>, sink: EventSink, timeoutMs = 3000, tool?: ToolDefinition) {
  const controller = new AbortController();
  const reports: Array<{ context: string; error: unknown }> = [];
  const registry = new ToolRegistry();
  if (tool) registry.register(tool);
  else registry.register({
    name: "stream_fixture", description: "controlled live output", inputSchema: z.object({}), risk: "readonly",
    metadata: { name: "stream_fixture", version: "1", sideEffect: false, network: false, filesystem: false, process: false, interactive: false },
    execute: (_args, context) => execute(context),
  });
  const context: ToolExecutionContext = {
    cwd: process.cwd(), sessionId: newSessionId(), turnId: newTurnId(), agentId: newAgentId(), signal: controller.signal,
    permissions: { rules: [], defaultEffect: "allow" },
    sandboxPolicy: { filesystem: { mode: "read-only" }, network: { mode: "deny" }, process: { timeoutMs, maxOutputBytes: 128 } },
  };
  const orchestrator = new ToolOrchestrator({ registry, events: sink, nonFatal: { report: (context, error) => reports.push({ context, error }) } });
  const id = newToolCallId();
  const run = (args: Record<string, unknown> = {}) => orchestrator.execute({ id, sessionId: context.sessionId, turnId: context.turnId, agentId: context.agentId, call: { id, name: tool?.name ?? "stream_fixture", args } }, context);
  return { run, controller, reports, context };
}

describe("bounded live tool output under persistence pressure", () => {
  it("retains a real failed process's prefix and final stderr diagnostics behind a slow sink", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tool-live-pressure-"));
    const hold = deferred();
    let pending = 0, bytes = 0, peakPending = 0, peakBytes = 0;
    const f = fixture(async () => { throw new Error("use the real exec tool"); }, {
      async emit(_sessionId, type, payload) {
        if (type !== "tool.output" && type !== "tool.progress") return;
        const size = Buffer.byteLength(String(payload.text ?? ""));
        pending++; bytes += size; peakPending = Math.max(peakPending, pending); peakBytes = Math.max(peakBytes, bytes);
        try { await hold.promise; } finally { pending--; bytes -= size; }
      },
    }, 30000, execTool);
    f.context.cwd = cwd;
    f.context.sandboxPolicy.filesystem = { mode: "workspace-write", allowedPaths: [cwd] };
    const code = "const b=Buffer.alloc(65536,120);let n=128;function step(){if(--n<0){process.stderr.write('compiler-context '.repeat(1000)+'\\nFINAL_COMPILER_DIAGNOSTIC\\n',()=>{require('node:fs').writeFileSync('command-finished','ready');process.exitCode=7});return;}if(process.stdout.write(b))setImmediate(step);else process.stdout.once('drain',step);}step();";
    const running = f.run({ command: process.execPath, args: ["-e", code] });
    try {
      await expect.poll(() => readFile(join(cwd, "command-finished"), "utf8").catch(() => null), { timeout: 10000 }).toBe("ready");
      expect(peakPending).toBeLessThanOrEqual(8);
      expect(peakBytes).toBeLessThanOrEqual(65536);
      hold.resolve();
      const result = await running;
      expect(result.status).toBe("failed");
      const output = result.output as { exitCode: number; stdout: string; stderr: string; truncated: boolean; diagnostics: { stderrTail: string } };
      expect(output.exitCode).toBe(7);
      expect(output.stdout).toBe("x".repeat(128));
      expect(Buffer.byteLength(output.stderr)).toBeLessThanOrEqual(128);
      expect(output.truncated).toBe(true);
      expect(output.diagnostics.stderrTail).toContain("FINAL_COMPILER_DIAGNOSTIC");
    } finally { hold.resolve(); await running; await rm(cwd, { recursive: true, force: true }); }
  });

  it("bounds unresolved frames and bytes, reports omissions, and preserves the actual terminal result", async () => {
    const hold = deferred(), produced = deferred();
    let pending = 0, pendingBytes = 0, peakPending = 0, peakBytes = 0;
    const seen: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const terminal = { exitCode: 7, stdout: "bounded prefix", diagnostics: { incomplete: true, stderrTail: "FINAL_COMPILER_DIAGNOSTIC" } };
    const f = fixture(async context => {
      for (let i = 0; i < 4096; i++) context.onOutput?.({ stream: "stdout", text: "x".repeat(4096) });
      produced.resolve();
      return { status: "failed", output: terminal };
    }, {
      async emit(_sessionId, type, payload) {
        seen.push({ type, payload });
        if (type !== "tool.output" && type !== "tool.progress") return;
        pending++; pendingBytes += Buffer.byteLength(String(payload.text ?? ""));
        peakPending = Math.max(peakPending, pending); peakBytes = Math.max(peakBytes, pendingBytes);
        try { await hold.promise; } finally { pending--; pendingBytes -= Buffer.byteLength(String(payload.text ?? "")); }
      },
    });
    const running = f.run();
    try {
      await produced.promise; await nextTick();
      expect(peakPending).toBeLessThanOrEqual(8);
      expect(peakBytes).toBeLessThanOrEqual(65536);
      expect(seen.some(event => event.type === "tool.completed")).toBe(false);
    } finally { hold.resolve(); }
    const result = await running;
    expect(result).toMatchObject({ status: "failed", output: terminal });
    const omission = seen.find(event => event.payload.incomplete === true);
    expect(omission?.type).toBe("tool.progress");
    expect(omission?.payload.droppedBytes).toBeGreaterThan(0);
    expect(omission?.payload.droppedEvents).toBeGreaterThan(0);
    expect(pending).toBe(0);
  });

  it("copies a bounded complete UTF-8 prefix from an oversized frame", async () => {
    const frames: Record<string, unknown>[] = [];
    const f = fixture(async context => {
      context.onOutput?.({ stream: "stdout", text: "中🧪".repeat(100000) });
      return { status: "success", output: "actual result" };
    }, { async emit(_sessionId, type, payload) { if (type === "tool.output" || type === "tool.progress") frames.push(payload); } });
    expect((await f.run()).status).toBe("success");
    const text = String(frames.find(frame => frame.stream === "stdout")?.text);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192);
    expect(text).not.toContain("�");
    expect(("中🧪".repeat(100000)).startsWith(text)).toBe(true);
    expect(frames.find(frame => frame.incomplete === true)?.droppedBytes).toBe(700000 - Buffer.byteLength(text));
  });

  it("drains ordinary stdout/stderr/progress before publishing completion", async () => {
    const hold = deferred(), produced = deferred();
    const seen: Array<{ type: string; payload: Record<string, unknown>; confirmed: boolean }> = [];
    const f = fixture(async context => {
      context.onOutput?.({ stream: "stdout", text: "read " });
      context.onOutput?.({ stream: "stderr", text: "中🧪" });
      context.onOutput?.({ stream: "progress", text: "checking" });
      produced.resolve();
      return { status: "success", output: "done" };
    }, { async emit(_sessionId, type, payload) {
      const event = { type, payload, confirmed: false }; seen.push(event);
      if (type === "tool.output" || type === "tool.progress") await hold.promise;
      event.confirmed = true;
    } });
    const running = f.run();
    try {
      await produced.promise; await nextTick();
      expect(seen.some(event => event.type === "tool.completed")).toBe(false);
    } finally { hold.resolve(); }
    expect((await running).status).toBe("success");
    expect(seen.filter(event => event.type === "tool.output" || event.type === "tool.progress").map(event => event.payload.text)).toEqual(["read ", "中🧪", "checking"]);
    expect(seen.every(event => event.confirmed)).toBe(true);
    expect(seen.at(-1)?.type).toBe("tool.completed");
  });

  it("keeps rejecting sinks observable without failing the actual tool", async () => {
    const f = fixture(async context => {
      context.onOutput?.({ stream: "stdout", text: "actual output" });
      return { status: "success", output: "actual result" };
    }, { async emit(_sessionId, type) { if (type === "tool.output") throw new Error("output sink rejected"); } });
    expect((await f.run()).status).toBe("success");
    expect(f.reports).toEqual([expect.objectContaining({ context: "orchestrator.emit:tool.output", error: expect.objectContaining({ message: "output sink rejected" }) })]);
  });

  it("releases a drain already waiting on persistence when its owner is cancelled", async () => {
    const hold = deferred(), produced = deferred();
    const f = fixture(async context => {
      context.onOutput?.({ stream: "stdout", text: "actual failed-command diagnostics" });
      produced.resolve();
      return { status: "failed", output: { exitCode: 7 } };
    }, { async emit(_sessionId, type) { if (type === "tool.output") await hold.promise; } });
    const running = f.run();
    try {
      await produced.promise; await nextTick();
      f.controller.abort();
      // The process had already failed. Releasing a cancelled progress drain
      // must retain that outcome instead of waiting for the tool timeout.
      expect(await running).toMatchObject({ status: "failed", output: { exitCode: 7 } });
    } finally { hold.resolve(); await running; }
  });

  it.each(["timeout", "cancel"] as const)("does not let stalled output extend %s or admit late output", async mode => {
    const hold = deferred(), produced = deferred();
    let emitLate!: () => void;
    const seen: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const f = fixture(async context => {
      emitLate = () => context.onOutput?.({ stream: "stdout", text: "must not be published after termination" });
      for (let i = 0; i < 1000; i++) context.onOutput?.({ stream: "stdout", text: "before" });
      produced.resolve();
      if (mode === "cancel") await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { status: mode === "cancel" ? "cancelled" : "success", output: "real result" };
    }, { async emit(_sessionId, type, payload) {
      seen.push({ type, payload });
      if (type === "tool.output" || type === "tool.progress") await hold.promise;
    } }, mode === "timeout" ? 50 : 3000);
    const running = f.run();
    try {
      await produced.promise;
      if (mode === "cancel") f.controller.abort();
      const result = await running;
      expect(result.status).toBe(mode === "timeout" ? "timeout" : "cancelled");
      const beforeLate = seen.length;
      emitLate(); await nextTick();
      expect(seen).toHaveLength(beforeLate);
      expect(seen.filter(event => event.type === "tool.output").length).toBeLessThanOrEqual(8);
    } finally { hold.resolve(); await running; }
  });
});
