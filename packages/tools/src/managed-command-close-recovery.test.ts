import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { newAgentId, newSessionId, newToolCallId, newTurnId, type ToolExecutionContext, type ToolResult } from "@ar/contracts";
import { ManagedCommands, ManagedCommandOrchestrator, type ManagedCommandRecord } from "./managed-commands.js";
import { ToolRegistry } from "./registry.js";
import { writeFileTool } from "./tools/write-file.js";
import { TaskVerifier } from "./verification/task-verifier.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "managed-close-recovery-")));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const journal = join(cwd, "journal.json");
  const context: ToolExecutionContext = {
    cwd, sessionId: newSessionId(), turnId: newTurnId(), agentId: newAgentId(), signal: new AbortController().signal,
    permissions: { rules: [], defaultEffect: "allow" },
    sandboxPolicy: { filesystem: { mode: "workspace-write", allowedPaths: [cwd] }, network: { mode: "deny" }, process: { timeoutMs: 5000, maxOutputBytes: 65536 } },
  };
  let refuseDrain = false;
  const saved = async (): Promise<ManagedCommandRecord[]> => JSON.parse(await readFile(journal, "utf8"));
  const create = (recovered?: ManagedCommandRecord[]) => {
    const manager = new ManagedCommands({
      maxJobMs: 5000,
      resolveAuthority: async (ctx) => ({ signal: ctx.signal, deadlineAt: Date.now() + 10000 }),
      save: async (records) => {
        if (refuseDrain && records.length === 0) throw new Error("final-journal-write-failed");
        await writeFile(journal, JSON.stringify(records));
      },
      ...(recovered ? { recovered } : {}),
    });
    cleanups.push(() => manager.close().catch(() => {}));
    const registry = new ToolRegistry();
    for (const tool of manager.tools()) registry.register(tool);
    registry.register(writeFileTool);
    const orchestrator = new ManagedCommandOrchestrator({ registry, workspaceRoot: cwd }, manager);
    const call = (name: string, args: Record<string, unknown>): Promise<ToolResult<any>> => {
      const id = newToolCallId();
      return orchestrator.execute({ id, sessionId: context.sessionId, turnId: context.turnId, agentId: context.agentId, call: { id, name, args } }, context);
    };
    const start = (code: string) => call("exec_start", { command: process.execPath, args: ["-e", code], yieldMs: 0 });
    const settled = async (jobId: string) => {
      for (let i = 0; i < 60; i++) {
        const result = await call("exec_poll", { jobId, waitMs: 100 });
        if (result.output?.state !== "running") return result;
      }
      throw new Error("actual command did not settle");
    };
    return { manager, call, start, settled };
  };
  return { cwd, journal, context, saved, create, failFinalWrite: () => { refuseDrain = true; } };
}

it.each(["succeeded", "failed", "explicit-cancel", "host-cancel"])("a clean %s shutdown does not manufacture an unknown recovery barrier", async (mode) => {
  const f = await fixture(), before = f.create();
  const service = mode.endsWith("cancel");
  const code = "const fs=require('node:fs');fs.appendFileSync('starts','1');fs.writeFileSync('ready','1');" +
    (service ? "setTimeout(()=>fs.writeFileSync('late','bad'),1500)" : mode === "failed" ? "process.exitCode=7" : "console.log('ACTUAL_OK')");
  const initial = await before.start(code);
  expect(initial.status, JSON.stringify(initial)).toBe("success");
  const jobId = initial.output.jobId;
  if (service) await expect.poll(async () => readFile(join(f.cwd, "ready"), "utf8").catch(() => null), { timeout: 5000 }).toBe("1");
  if (mode === "explicit-cancel") {
    const cancelled = await before.call("exec_cancel", { jobId });
    expect(cancelled.output?.state).toBe("cancelled");
  } else if (!service) {
    const result = await before.settled(jobId);
    expect(result.output?.state).toBe(mode);
    expect(result.output?.exitCode).toBe(mode === "failed" ? 7 : 0);
  }
  await before.manager.close();
  expect(await f.saved()).toEqual([]);
  const after = f.create(await f.saved());
  expect((await after.call("write_file", { path: "after-close", content: "ordinary edit" })).status).toBe("success");
  const next = await after.start("require('node:fs').writeFileSync('second','real fresh work')");
  expect(next.status, JSON.stringify(next)).toBe("success");
  expect((await after.settled(next.output.jobId)).output?.state).toBe("succeeded");
  expect(await readFile(join(f.cwd, "starts"), "utf8")).toBe("1");
  expect(await readFile(join(f.cwd, "second"), "utf8")).toBe("real fresh work");
  if (service) {
    await new Promise((done) => setTimeout(done, 1600));
    await expect(readFile(join(f.cwd, "late"))).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it("refuses to acknowledge a clean close if the final journal write fails", async () => {
  const f = await fixture(), before = f.create();
  const initial = await before.start("require('node:fs').appendFileSync('starts','1')");
  expect(initial.status).toBe("success");
  expect((await before.settled(initial.output.jobId)).output?.state).toBe("succeeded");
  const durable = await f.saved();
  expect(durable).toHaveLength(1); expect(durable[0]?.state).toBe("succeeded");
  f.failFinalWrite();
  await expect(before.manager.close()).rejects.toThrow("final-journal-write-failed");
  expect(await f.saved()).toEqual(durable);
  const recovered = f.create(await f.saved());
  expect((await recovered.start("require('node:fs').writeFileSync('replay','bad')")).status).toBe("denied");
  await expect(readFile(join(f.cwd, "replay"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.cwd, "starts"), "utf8")).toBe("1");
});

it("retains unknown recovery records and their workspace/verification barriers after close", async () => {
  const f = await fixture();
  const unknown: ManagedCommandRecord = { id: "interrupted", owner: "old-owner", workspace: f.cwd, state: "running", deadlineAt: Date.now() - 1000 };
  const before = f.create([unknown]);
  await before.manager.close();
  const durable = await f.saved();
  expect(durable).toEqual([{ ...unknown, state: "unknown" }]);
  const after = f.create(durable);
  expect((await after.start("require('node:fs').writeFileSync('replay','bad')")).status).toBe("denied");
  expect((await after.call("write_file", { path: "unsafe", content: "bad" })).status).toBe("denied");
  let verificationRan = false;
  const report = await after.manager.verifier(new TaskVerifier()).verify({ id: "actual-check", goal: "check" }, {
    cwd: f.cwd, sessionId: f.context.sessionId, turnId: f.context.turnId!, changedPaths: [], transcript: "", runStartedAt: Date.now(),
    executeCommand: async () => { verificationRan = true; throw new Error("must not run"); },
  });
  expect(report.passed).toBe(false); expect(verificationRan).toBe(false);
  await expect(readFile(join(f.cwd, "replay"))).rejects.toMatchObject({ code: "ENOENT" });
});
