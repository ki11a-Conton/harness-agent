import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  newAgentId, newSessionId, newToolCallId, newTurnId,
  type ToolExecutionContext, type ToolResult,
} from "@ar/contracts";
import type { ManagedCommandOptions, ManagedCommandRecord } from "./managed-commands.js";
import { ToolRegistry } from "./registry.js";
import { writeFileTool } from "./tools/write-file.js";

const cleanups: Array<() => Promise<unknown>> = [];
beforeEach(() => vi.resetModules());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  // Separate module instances isolate each test's intentionally unreconciled
  // process-wide unknown reservations; production never clears those on close.
  const { ManagedCommands, ManagedCommandOrchestrator } = await import("./managed-commands.js");
  const root = await realpath(await mkdtemp(join(tmpdir(), "managed-recovery-capacity-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const old = join(root, "old"), next = join(root, "next");
  await Promise.all([mkdir(old), mkdir(next)]);
  const context = (cwd = next): ToolExecutionContext => ({
    cwd, sessionId: newSessionId(), turnId: newTurnId(), agentId: newAgentId(), signal: new AbortController().signal,
    permissions: { rules: [], defaultEffect: "allow" },
    sandboxPolicy: {
      filesystem: { mode: "workspace-write", allowedPaths: [root] },
      network: { mode: "deny" }, process: { timeoutMs: 5000, maxOutputBytes: 65536 },
    },
  });
  const create = (options: Partial<ManagedCommandOptions> = {}, ctx = context()) => {
    const manager = new ManagedCommands({
      maxJobMs: 5000,
      resolveAuthority: async (ctx) => ({ signal: ctx.signal, deadlineAt: Date.now() + 10000 }),
      ...options,
    });
    cleanups.push(() => manager.close().catch(() => {}));
    const registry = new ToolRegistry();
    for (const tool of manager.tools()) registry.register(tool);
    registry.register(writeFileTool);
    const orchestrator = new ManagedCommandOrchestrator({ registry, workspaceRoot: root }, manager);
    const call = (name: string, args: Record<string, unknown>, callContext = ctx): Promise<ToolResult<any>> => {
      const id = newToolCallId();
      return orchestrator.execute({ id, sessionId: callContext.sessionId, turnId: callContext.turnId, agentId: callContext.agentId, call: { id, name, args } }, callContext);
    };
    const start = (code: string, supersedes?: string) => call("exec_start", {
      command: process.execPath, args: ["-e", code], yieldMs: 0,
      ...(supersedes ? { supersedes } : {}),
    });
    const settled = async (jobId: string) => {
      for (let i = 0; i < 60; i++) {
        const result = await call("exec_poll", { jobId, waitMs: 100 });
        if (result.output?.state !== "running") return result;
      }
      throw new Error("actual command did not settle");
    };
    return { manager, call, start, settled, ctx };
  };
  const unknown = (overrides: Partial<ManagedCommandRecord> = {}): ManagedCommandRecord => ({
    id: "interrupted", owner: "old-owner", workspace: old,
    deadlineAt: Date.now() - 1000, state: "running", ...overrides,
  });
  const assertBlocked = async (owner: ReturnType<typeof create>, cwd = old) => {
    expect((await owner.call("write_file", { path: "unsafe", content: "bad" }, context(cwd))).status).toBe("denied");
    expect((await owner.call("exec_start", {
      command: process.execPath, args: ["-e", "require('node:fs').writeFileSync('replay','bad')"], yieldMs: 0,
    }, context(cwd))).status).toBe("denied");
    let calls = 0;
    const verifier = owner.manager.verifier({ verify: async () => {
      calls++;
      return { level: 1, passed: true, checks: [], evidence: [], startedAt: Date.now(), completedAt: Date.now() };
    } });
    const report = await verifier.verify({ id: "must-stay-unknown", goal: "no unconfirmed process" }, {
      cwd, sessionId: owner.ctx.sessionId, turnId: owner.ctx.turnId!, changedPaths: [], transcript: "", runStartedAt: Date.now(),
    });
    expect(report.passed).toBe(false);
    expect(calls).toBe(0);
  };
  const assertActualWrite = async (owner: ReturnType<typeof create>, file = "actual-coded.txt") => {
    const start = await owner.start(`require('node:fs').writeFileSync(${JSON.stringify(file)},'ACTUAL_CODED')`);
    expect(start.status, JSON.stringify(start)).toBe("success");
    expect((await owner.settled(start.output.jobId)).output?.state).toBe("succeeded");
    expect(await readFile(join(owner.ctx.cwd, file), "utf8")).toBe("ACTUAL_CODED");
  };
  return { root, old, next, context, create, unknown, assertBlocked, assertActualWrite };
}

it("counts one durable unknown once after 16 and 129 reopen/close cycles without releasing its barriers", async () => {
  const f = await fixture(), journal = join(f.root, "journal.json");
  await writeFile(journal, JSON.stringify([f.unknown()]));
  const reopen = async () => {
    const recovered: ManagedCommandRecord[] = JSON.parse(await readFile(journal, "utf8"));
    const owner = f.create({ recovered, save: (records) => writeFile(journal, JSON.stringify(records)) });
    await owner.manager.close();
    expect(JSON.parse(await readFile(journal, "utf8"))).toHaveLength(1);
    return owner;
  };
  let recovered = await reopen();
  for (let i = 1; i < 16; i++) recovered = await reopen();
  const independent = f.create();
  await f.assertBlocked(independent);
  await f.assertActualWrite(independent);
  for (let i = 16; i < 129; i++) recovered = await reopen();
  await f.assertBlocked(recovered);
  await f.assertActualWrite(independent, "still-coded.txt");
  await expect(readFile(join(f.old, "unsafe"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("counts a real live unknown and its recovered journal mirrors once", async () => {
  const f = await fixture();
  let saved: ManagedCommandRecord[] = [];
  const live = f.create({ save: async (records) => {
    saved = records.map((r) => ({ ...r }));
    if (records.some((r) => r.state !== "running")) throw new Error("controlled terminal rejection");
  } }, f.context(f.old));
  const start = await live.start("require('node:fs').writeFileSync('actually-ran','1')");
  expect(start.status).toBe("success");
  expect((await live.settled(start.output.jobId)).output?.state).toBe("unknown");
  expect(await readFile(join(f.old, "actually-ran"), "utf8")).toBe("1");
  expect(saved).toHaveLength(1);
  const mirror = saved.map((r) => ({ ...r }));
  for (let i = 0; i < 16; i++) await f.create({ recovered: mirror }).manager.close();
  const independent = f.create();
  await f.assertActualWrite(independent);
  await f.assertBlocked(independent);
  await expect(live.manager.close()).rejects.toThrow("controlled terminal rejection");
  await f.assertBlocked(independent);
});

it.each(["workspace", "owner"] as const)("does not merge 16 distinct %s identities sharing a command id", async (field) => {
  const f = await fixture();
  const records = Array.from({ length: 16 }, (_, i) => f.unknown({
    [field]: field === "workspace" ? join(f.old, String(i)) : `owner-${i}`,
  }));
  const recovered = f.create({ recovered: records });
  await recovered.manager.close();
  const independent = f.create();
  const start = await independent.start("require('node:fs').writeFileSync('must-not-spawn','bad')");
  expect(start.status).toBe("denied");
  expect(start.error?.message).toContain("capacity");
  await expect(readFile(join(f.next, "must-not-spawn"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("retains the 128 logical-record bound and a rejected constructor does not reserve its candidates", async () => {
  const f = await fixture();
  const records = Array.from({ length: 128 }, (_, i) => f.unknown({ id: `distinct-${i}` }));
  const retained = f.create({ recovered: records });
  for (let i = 0; i < 129; i++) await f.create({ recovered: [{ ...records[i % 128]! }] }).manager.close();
  expect(() => f.create({ recovered: [f.unknown({ id: "129th" })] })).toThrow("journal exceeds its bound");
  expect(() => f.create({ recovered: [f.unknown({ id: "another-unadmitted" }), ...records] })).toThrow("journal exceeds its bound");
  await f.create({ recovered: records }).manager.close();
  await retained.manager.close();
  await f.assertBlocked(retained);
});

it("keeps cross-manager handles separate while an exact successful repair and clean closes release real capacity", async () => {
  const f = await fixture(), owner = f.create({}, f.context(f.old)), other = f.create();
  const code = "const fs=require('node:fs');if(!fs.existsSync('first-attempt')){fs.writeFileSync('first-attempt','1');process.exitCode=7}else fs.writeFileSync('repaired','1')";
  const first = await owner.start(code);
  expect(first.status).toBe("success");
  expect((await owner.settled(first.output.jobId)).output?.state).toBe("failed");
  const foreignPoll = await other.call("exec_poll", { jobId: first.output.jobId }, owner.ctx);
  expect(foreignPoll.status).not.toBe("success");
  expect(foreignPoll.output).toBeUndefined();
  expect(JSON.stringify(foreignPoll)).not.toContain("first-attempt");
  expect((await other.start(code, first.output.jobId)).status).toBe("denied");
  const repair = await owner.start(code, first.output.jobId);
  expect(repair.status).toBe("success");
  expect((await owner.settled(repair.output.jobId)).output?.state).toBe("succeeded");
  expect((await owner.call("exec_jobs", {})).output.jobs.find((j: any) => j.jobId === first.output.jobId)?.state).toBe("failed");
  expect(await readFile(join(f.old, "repaired"), "utf8")).toBe("1");
  await other.manager.close();
  const verified = await owner.manager.verifier({ verify: async () => ({
    level: 1, passed: true, checks: [], evidence: [], startedAt: Date.now(), completedAt: Date.now(),
  }) }).verify({ id: "repaired", goal: "exact repair" }, {
    cwd: f.old, sessionId: owner.ctx.sessionId, turnId: owner.ctx.turnId!, changedPaths: [], transcript: "", runStartedAt: Date.now(),
  });
  expect(verified.passed).toBe(true);
  await owner.manager.close();
  await f.assertActualWrite(f.create({}, owner.ctx));
});
