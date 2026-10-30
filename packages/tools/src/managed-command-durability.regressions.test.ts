import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import {
  newAgentId, newSessionId, newToolCallId, newTurnId,
  type ToolExecutionContext, type ToolResult,
} from "@ar/contracts";
import { ManagedCommands, ManagedCommandOrchestrator, type ManagedCommandRecord } from "./managed-commands.js";
import { ToolRegistry } from "./registry.js";
import { createProductionTools } from "./production-tools.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function gate() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  return { pending, release };
}

async function fixture(options: { rejectTerminal?: boolean; suspendAdmission?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "managed-durability-")));
  const cwd = join(root, "owner"), other = join(root, "other");
  await Promise.all([mkdir(cwd), mkdir(other)]);
  const owner = new AbortController();
  const context: ToolExecutionContext = {
    cwd, sessionId: newSessionId(), turnId: newTurnId(), agentId: newAgentId(), signal: owner.signal,
    permissions: { rules: [], defaultEffect: "allow" },
    sandboxPolicy: {
      filesystem: { mode: "workspace-write", allowedPaths: [root] },
      network: { mode: "deny" }, process: { timeoutMs: 5000, maxOutputBytes: 65536 },
    },
  };
  const admission = gate(), terminal = gate(), terminalEntered = gate();
  let saves = 0;
  const manager = new ManagedCommands({
    resolveAuthority: async () => ({ signal: owner.signal, deadlineAt: Date.now() + 15000 }),
    maxJobMs: options.suspendAdmission ? 25 : 5000,
    save: async (records) => {
      if (++saves === 1 && options.suspendAdmission) await admission.pending;
      if (saves === 2) {
        terminalEntered.release();
        await terminal.pending;
        if (options.rejectTerminal) throw new Error("controlled terminal journal rejection");
      }
      await writeFile(join(root, "journal.json"), JSON.stringify(records));
    },
  });
  cleanups.push(async () => {
    admission.release(); terminal.release(); owner.abort();
    await manager.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const registry = new ToolRegistry();
  for (const tool of createProductionTools({ networkMode: "deny", availableTools: () => [] })) registry.register(tool);
  for (const tool of manager.tools()) registry.register(tool);
  const orchestrator = new ManagedCommandOrchestrator({ registry, workspaceRoot: root }, manager);
  const call = async (name: string, args: Record<string, unknown>, ctx = context): Promise<ToolResult<any>> => {
    const id = newToolCallId();
    return orchestrator.execute({ id, sessionId: ctx.sessionId, turnId: ctx.turnId, agentId: ctx.agentId, call: { id, name, args } }, ctx);
  };
  const start = (code: string) => call("exec_start", { command: process.execPath, args: ["-e", code], yieldMs: 0 });
  const poll = (jobId: string) => call("exec_poll", { jobId, waitMs: 0 });
  const journal = async (): Promise<ManagedCommandRecord[]> => JSON.parse(await readFile(join(root, "journal.json"), "utf8"));
  let delegateCalls = 0;
  const verifier = manager.verifier({ verify: async () => {
    delegateCalls++;
    return { level: 1, passed: true, checks: [], evidence: [], startedAt: Date.now(), completedAt: Date.now() };
  } });
  const verify = () => verifier.verify({ id: "durability", goal: "actual command settled" }, {
    sessionId: context.sessionId, turnId: context.turnId!, cwd, changedPaths: [], transcript: "", runStartedAt: Date.now(),
  });
  // Await the actual journal boundary under the runner's existing test timeout;
  // process startup speed is not part of this durability assertion.
  const terminalSave = () => terminalEntered.pending;
  const settled = async (jobId: string): Promise<ToolResult<any>> => {
    for (let i = 0; i < 100; i++) {
      const result = await poll(jobId);
      if (result.output?.state !== "running") return result;
      await delay(10);
    }
    throw new Error("managed command did not settle");
  };
  return { root, cwd, context, other, manager, call, start, poll, journal, verify, terminalSave, settled,
    admission, terminal, delegateCalls: () => delegateCalls };
}

it.each([0, 7])("does not publish exit %i or release workspace/verification before terminal journaling", async (exitCode) => {
  const f = await fixture();
  const start = await f.start(`process.stdout.write('ACTUAL_FINISHED');process.exitCode=${exitCode}`);
  const id = start.output.jobId;
  await f.terminalSave();
  expect((await f.journal())[0]?.state).toBe("running");
  const pending = await f.poll(id);
  expect(pending.output).toMatchObject({ state: "running", exitCode: null, commandStatus: null });
  expect((await f.call("exec_jobs", {})).output.jobs[0]?.state).toBe("running");
  expect((await f.call("write_file", { path: "too-early", content: "bad" })).status).toBe("denied");
  expect((await f.verify()).passed).toBe(false);
  expect(f.delegateCalls()).toBe(0);
  const otherContext = { ...f.context, cwd: f.other, sessionId: newSessionId(), turnId: newTurnId() };
  expect((await f.call("write_file", { path: "independent", content: "allowed" }, otherContext)).status).toBe("success");
  f.terminal.release();
  const end = await f.settled(id);
  expect(end.output).toMatchObject({ state: exitCode === 0 ? "succeeded" : "failed", exitCode });
  expect((await f.journal())[0]?.state).toBe(end.output.state);
  expect((await f.call("write_file", { path: "after-confirmation", content: "allowed" })).status).toBe("success");
  expect((await f.verify()).passed).toBe(exitCode === 0);
});

it("keeps a rejected terminal journal unknown without an earlier successful observation", async () => {
  const f = await fixture({ rejectTerminal: true });
  const id = (await f.start("process.stdout.write('ACTUAL_FINISHED')")).output.jobId;
  await f.terminalSave();
  expect((await f.poll(id)).output.state).toBe("running");
  expect((await f.verify()).passed).toBe(false);
  f.terminal.release();
  const end = await f.settled(id);
  expect(end.status).toBe("failed");
  expect(end.output.state).toBe("unknown");
  expect(end.error?.code).toBe("PERSISTENCE_ERROR");
  expect((await f.call("write_file", { path: "unreconciled", content: "bad" })).status).toBe("denied");
  expect((await f.verify()).passed).toBe(false);
  expect(f.delegateCalls()).toBe(0);
  await expect(f.manager.close()).rejects.toThrow("reconciliation required");
});

it("does not acknowledge explicit cancellation or release its barrier before the cancellation journal", async () => {
  const f = await fixture();
  const id = (await f.start("require('node:fs').writeFileSync('started','1');setInterval(()=>{},1000)")).output.jobId;
  for (let i = 0; i < 100 && !(await readFile(join(f.cwd, "started")).catch(() => null)); i++) await delay(10);
  expect(await readFile(join(f.cwd, "started"), "utf8")).toBe("1");
  let acknowledged = false;
  const cancelling = f.call("exec_cancel", { jobId: id }).then((result) => { acknowledged = true; return result; });
  await f.terminalSave();
  expect(acknowledged).toBe(false);
  expect((await f.call("exec_jobs", {})).output.jobs[0]?.state).toBe("running");
  expect((await f.call("write_file", { path: "too-early", content: "bad" })).status).toBe("denied");
  expect((await f.verify()).passed).toBe(false);
  expect(f.delegateCalls()).toBe(0);
  f.terminal.release();
  expect((await cancelling).output.state).toBe("cancelled");
  expect((await f.journal())[0]?.state).toBe("cancelled");
  expect((await f.verify()).passed).toBe(true);
});

it("journals a deadline exhausted during admission before releasing the workspace", async () => {
  const f = await fixture({ suspendAdmission: true });
  const id = (await f.start("require('node:fs').writeFileSync('must-not-spawn','bad')")).output.jobId;
  await delay(40);
  f.admission.release();
  await f.terminalSave();
  expect((await f.poll(id)).output.state).toBe("running");
  expect((await f.call("write_file", { path: "too-early", content: "bad" })).status).toBe("denied");
  f.terminal.release();
  expect((await f.settled(id)).output.state).toBe("timed_out");
  expect((await f.journal())[0]?.state).toBe("timed_out");
  expect(await readFile(join(f.cwd, "must-not-spawn")).catch(() => null)).toBe(null);
});
