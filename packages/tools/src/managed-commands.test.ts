import { mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  newSessionId,
  newTurnId,
  newAgentId,
  newToolCallId,
  type ToolExecutionContext,
  type ToolResult,
} from "@ar/contracts";
import {
  ManagedCommands,
  ManagedCommandOrchestrator,
  type ManagedCommandOptions,
} from "./managed-commands.js";
import { ToolRegistry } from "./registry.js";
import { createProductionTools } from "./production-tools.js";
import { TaskVerifier } from "./verification/task-verifier.js";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function fixture(options: Partial<ManagedCommandOptions> = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "managed-command-")));
  const controller = new AbortController();
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const context: ToolExecutionContext = {
    cwd,
    sessionId: newSessionId(),
    turnId: newTurnId(),
    agentId: newAgentId(),
    signal: controller.signal,
    permissions: { rules: [], defaultEffect: "allow" },
    sandboxPolicy: {
      filesystem: { mode: "workspace-write", allowedPaths: [cwd] },
      network: { mode: "deny" },
      process: { timeoutMs: 5000, maxOutputBytes: 65536 },
    },
  };
  const deadlineAt = Date.now() + 15000;
  const managed = new ManagedCommands({
    resolveAuthority: async (ctx) => ({ signal: ctx.signal, deadlineAt }),
    maxJobMs: 5000,
    ...options,
  });
  cleanups.push(() => managed.close().catch(() => {}));
  const registry = new ToolRegistry();
  for (const tool of createProductionTools({
    networkMode: "deny",
    availableTools: () => [],
  }))
    registry.register(tool);
  for (const tool of managed.tools()) registry.register(tool);
  const orchestrator = new ManagedCommandOrchestrator(
    { registry, workspaceRoot: cwd },
    managed,
  );
  async function call(
    name: string,
    args: Record<string, unknown>,
    ctx = context,
  ): Promise<ToolResult<any>> {
    const id = newToolCallId();
    return orchestrator.execute(
      {
        id,
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        agentId: ctx.agentId,
        call: { id, name, args },
      },
      ctx,
    );
  }
  const start = (code: string, extra: Record<string, unknown> = {}) =>
    call("exec_start", {
      command: process.execPath,
      args: ["-e", code],
      yieldMs: 0,
      ...extra,
    });
  const pollDone = async (id: string) => {
    let result;
    for (let i = 0; i < 80; i++) {
      result = await call("exec_poll", { jobId: id, waitMs: 100 });
      if (result.output?.state !== "running") return result;
    }
    throw new Error("job failed to settle");
  };
  const verification = {
    sessionId: context.sessionId,
    turnId: context.turnId,
    cwd,
    changedPaths: [],
    transcript: "",
    runStartedAt: Date.now(),
    executeCommand: (spec: any) => call("exec", spec),
  };
  return {
    cwd,
    context,
    controller,
    managed,
    registry,
    call,
    start,
    pollDone,
    verification,
  };
}
describe("managed commands through real permission/sandbox/executor", () => {
  it("starts once, yields, permits a real read while alive and delivers real exit/output", async () => {
    const f = await fixture();
    await writeFile(join(f.cwd, "source"), "RELATED_SOURCE");
    const result = await f.start(
      "const fs=require('node:fs');fs.appendFileSync('starts','1');setTimeout(()=>{fs.writeFileSync('done','1');console.log('ACTUAL_OK')},650)",
    );
    expect(result.output.state).toBe("running");
    const id = result.output.jobId;
    const read = await f.call("read_file", { path: "source" });
    expect(JSON.stringify(read.output)).toContain("RELATED_SOURCE");
    expect(await readFile(join(f.cwd, "done"), "utf8").catch(() => null)).toBe(
      null,
    );
    const end = await f.pollDone(id);
    expect(end.output).toMatchObject({ state: "succeeded", exitCode: 0 });
    expect(JSON.stringify(end.output)).toContain("ACTUAL_OK");
    expect(await readFile(join(f.cwd, "starts"), "utf8")).toBe("1");
    expect((await f.call("exec_poll", { jobId: id })).output.chunks).toEqual(
      [],
    );
  });
  it("denies each cross-owner dimension, guessed handles, and model-supplied authorization fields", async () => {
    const f = await fixture();
    const id = (await f.start("setTimeout(()=>{},3000)")).output.jobId;
    for (const altered of [
      { sessionId: newSessionId() },
      { turnId: newTurnId() },
      { agentId: newAgentId() },
      { permissions: { rules: [], defaultEffect: "deny" as const } },
      {
        sandboxPolicy: {
          ...f.context.sandboxPolicy,
          process: { ...f.context.sandboxPolicy.process, maxOutputBytes: 800 },
        },
      },
    ]) {
      for (const name of ["exec_poll", "exec_cancel"]) {
        const result = await f.call(
          name,
          { jobId: id },
          { ...f.context, ...altered },
        );
        expect(result.status).not.toBe("success");
        expect(JSON.stringify(result)).not.toContain("setTimeout");
      }
      expect(
        (await f.call("exec_jobs", {}, { ...f.context, ...altered })).output
          ?.jobs ?? [],
      ).toEqual([]);
    }
    expect((await f.call("exec_poll", { jobId: "guessed" })).status).not.toBe(
      "success",
    );
    expect(
      (await f.call("exec_poll", { jobId: id, command: "anything" })).status,
    ).not.toBe("success");
    expect(
      (await f.call("exec_jobs", { sessionId: f.context.sessionId })).status,
    ).not.toBe("success");
  });
  it("refuses sandbox, permission and cwd escapes without starting a child", async () => {
    const f = await fixture();
    const args = {
      command: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync('forbidden','x')"],
    };
    for (const altered of [
      { permissions: { rules: [], defaultEffect: "deny" as const } },
      {
        sandboxPolicy: {
          ...f.context.sandboxPolicy,
          process: { allowedCommands: ["never-allowed"], timeoutMs: 5000 },
        },
      },
    ])
      expect(
        (await f.call("exec_start", args, { ...f.context, ...altered })).status,
      ).not.toBe("success");
    expect(
      (
        await f.start("require('node:fs').writeFileSync('forbidden','x')", {
          cwd: "..",
          yieldMs: 1000,
        })
      ).output.state,
    ).toBe("failed");
    expect(
      await readFile(join(f.cwd, "forbidden"), "utf8").catch(() => null),
    ).toBe(null);
  });
  it("holds workspace writes/new commands even from another session until settled", async () => {
    const f = await fixture();
    const id = (await f.start("setTimeout(()=>{},2500)")).output.jobId;
    for (const ctx of [
      f.context,
      { ...f.context, sessionId: newSessionId(), turnId: newTurnId() },
    ]) {
      expect(
        (await f.call("write_file", { path: "late-edit", content: "bad" }, ctx))
          .status,
      ).toBe("denied");
      expect(
        (
          await f.call(
            "exec",
            { command: process.execPath, args: ["-e", "process.exit(0)"] },
            ctx,
          )
        ).status,
      ).toBe("denied");
      expect(
        (
          await f.call(
            "exec_start",
            { command: process.execPath, args: ["-e", "process.exit(0)"] },
            ctx,
          )
        ).status,
      ).toBe("denied");
    }
    await f.call("exec_cancel", { jobId: id });
    expect(
      (await f.call("write_file", { path: "late-edit", content: "after" }))
        .status,
    ).toBe("success");
  });
  it("retains owner cancellation after start returned and prevents late writes", async () => {
    const f = await fixture();
    await f.start(
      "const fs=require('node:fs');fs.writeFileSync('started','1');setTimeout(()=>fs.writeFileSync('late','bad'),700)",
    );
    for (
      let i = 0;
      i < 60 && !(await readFile(join(f.cwd, "started")).catch(() => null));
      i++
    )
      await delay(25);
    expect(await readFile(join(f.cwd, "started"), "utf8")).toBe("1");
    f.controller.abort();
    await f.managed.close();
    await delay(800);
    expect(await readFile(join(f.cwd, "late"), "utf8").catch(() => null)).toBe(
      null,
    );
  });
  it("cancel and close await cleanup including an admitted but suspended journal/spawn", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let saves = 0;
    const f = await fixture({
      save: async () => {
        if (++saves === 1) await gate;
      },
    });
    const id = (
      await f.start("require('node:fs').writeFileSync('spawned','bad')")
    ).output.jobId;
    let closed = false;
    const close = f.managed.close().then(() => {
      closed = true;
    });
    await delay(30);
    expect(closed).toBe(false);
    expect(
      (await f.call("exec_start", { command: process.execPath })).status,
    ).toBe("denied");
    release();
    await close;
    expect(
      await readFile(join(f.cwd, "spawned"), "utf8").catch(() => null),
    ).toBe(null);
    expect(id).toBeTruthy();
  });
  it("never extends absolute deadlines on repeated polls", async () => {
    const f = await fixture({ maxJobMs: 180 });
    const start = await f.start(
      "setTimeout(()=>require('node:fs').writeFileSync('late','bad'),800)",
    );
    const end = await f.pollDone(start.output.jobId);
    expect(end.output.deadlineAt).toBe(start.output.deadlineAt);
    expect(end.output.state).toBe("timed_out");
    await delay(850);
    expect(await readFile(join(f.cwd, "late"), "utf8").catch(() => null)).toBe(
      null,
    );
  });
  it("large real UTF-8 output is bounded and missing bytes remain explicit", async () => {
    const f = await fixture({ retainedBytes: 256 });
    const id = (
      await f.start(
        "process.stdout.write('🙂'.repeat(60000)+'REAL_ERROR_TAIL')",
      )
    ).output.jobId;
    const end = await f.pollDone(id);
    expect(end.output.state).toBe("succeeded");
    expect(end.output.retainedBytes).toBeLessThanOrEqual(256);
    expect(end.output.incomplete).toBe(true);
    expect(end.output.lostBytes).toBeGreaterThan(0);
    expect(JSON.stringify(end.output)).not.toContain("�");
    expect(JSON.stringify(end.output)).toContain("REAL_ERROR_TAIL");
  });
  it("blocks false verification and requires the identical failed command to succeed after repair", async () => {
    const f = await fixture();
    const code =
      "const fs=require('node:fs');setTimeout(()=>{console.error('CHECK');process.exitCode=fs.readFileSync('value','utf8')==='ok'?0:1},300)";
    await writeFile(join(f.cwd, "value"), "bad");
    const start = await f.start(code);
    let checks = 0;
    const delegate = new TaskVerifier();
    const verifier = f.managed.verifier({
      verify: (...args) => {
        checks++;
        return delegate.verify(...args);
      },
    });
    const task = {
      id: "real",
      goal: "check",
      verification: [
        {
          kind: "command" as const,
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
      ],
    };
    expect((await verifier.verify(task, f.verification)).passed).toBe(false);
    expect(checks).toBe(0);
    expect((await f.pollDone(start.output.jobId)).output.state).toBe("failed");
    expect((await verifier.verify(task, f.verification)).passed).toBe(false);
    await writeFile(join(f.cwd, "value"), "ok");
    expect(
      (await f.start("process.exit(0)", { supersedes: start.output.jobId }))
        .status,
    ).toBe("denied");
    const retry = await f.start(code, { supersedes: start.output.jobId });
    expect((await f.pollDone(retry.output.jobId)).output.state).toBe(
      "succeeded",
    );
    expect((await verifier.verify(task, f.verification)).passed).toBe(true);
    expect(checks).toBe(1);
  });
  it("query recovers current owner handles without replay or cross-owner data", async () => {
    const f = await fixture();
    const id = (await f.start("setTimeout(()=>{},2500)")).output.jobId;
    const query = await f.call("exec_jobs", {});
    expect(query.output.jobs.map((j: any) => j.jobId)).toEqual([id]);
    expect(query.output.jobs[0]).not.toHaveProperty("chunks");
  });
  it("failed pre-spawn journaling has no side effect, preserves unknown and blocks verification", async () => {
    const f = await fixture({
      save: async () => {
        throw new Error("storage unavailable");
      },
    });
    const start = await f.start(
      "require('node:fs').writeFileSync('forbidden','x')",
      { yieldMs: 1000 },
    );
    expect(start.output.state).toBe("unknown");
    const cancelled = await f.call("exec_cancel", {
      jobId: start.output.jobId,
    });
    expect(cancelled.status).toBe("failed");
    expect(cancelled.output.state).toBe("unknown");
    expect(await readFile(join(f.cwd, "forbidden")).catch(() => null)).toBe(
      null,
    );
    expect(
      (await f.call("write_file", { path: "forbidden", content: "x" })).status,
    ).toBe("denied");
    await expect(f.managed.close()).rejects.toThrow();
  });
  it("expired/missing trusted authority refuses all starts", async () => {
    const f = await fixture({
      resolveAuthority: async (ctx) => ({
        signal: ctx.signal,
        deadlineAt: Date.now() - 1,
      }),
    });
    expect((await f.start("process.exit(0)")).status).toBe("denied");
    const g = await fixture();
    expect(
      (
        await g.call(
          "exec_start",
          { command: process.execPath },
          { ...g.context, turnId: undefined },
        )
      ).status,
    ).toBe("denied");
  });
});
it("separate Harness registries share process capacity and canonical workspace barriers without sharing handles", async () => {
  const f = await fixture(),
    g = await fixture();
  const id = (await f.start("setTimeout(()=>{},2500)")).output.jobId;
  const sameWorkspace = {
    ...g.context,
    cwd: f.cwd,
    sandboxPolicy: {
      ...g.context.sandboxPolicy,
      filesystem: { mode: "workspace-write" as const, allowedPaths: [f.cwd] },
    },
  };
  expect(
    (
      await g.call(
        "write_file",
        { path: "cross-owner-write", content: "bad" },
        sameWorkspace,
      )
    ).status,
  ).not.toBe("success");
  expect(
    (await g.call("exec_poll", { jobId: id }, sameWorkspace)).status,
  ).not.toBe("success");
  expect(
    await readFile(join(f.cwd, "cross-owner-write")).catch(() => null),
  ).toBe(null);
});
it("recovered interrupted records block fresh starts and verification without replay", async () => {
  const f = await fixture();
  const interrupted = new ManagedCommands({
    resolveAuthority: async (ctx) => ({
      signal: ctx.signal,
      deadlineAt: Date.now() + 5000,
    }),
    recovered: [
      {
        id: "old-id",
        owner: "old-owner",
        workspace: f.cwd,
        deadlineAt: Date.now() - 10,
        state: "running",
      },
    ],
  });
  cleanups.push(() => interrupted.close().catch(() => {}));
  expect(
    (await f.start("require('node:fs').writeFileSync('replay','bad')")).status,
  ).toBe("denied");
  expect(
    (
      await interrupted
        .verifier(new TaskVerifier())
        .verify({ id: "recovery", goal: "resume" }, f.verification)
    ).passed,
  ).toBe(false);
  expect(await readFile(join(f.cwd, "replay")).catch(() => null)).toBe(null);
});
it("explicit cancel of an actual service-like job settles before acknowledging descendants", async () => {
  const f = await fixture();
  const code =
    "const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',\"setTimeout(()=>require('node:fs').writeFileSync('descendant-late','bad'),850)\"],{stdio:'inherit'});fs.writeFileSync('service-ready','1');setTimeout(()=>{},5000)";
  const id = (await f.start(code)).output.jobId;
  for (
    let i = 0;
    i < 100 &&
    !(await readFile(join(f.cwd, "service-ready")).catch(() => null));
    i++
  )
    await delay(25);
  expect(await readFile(join(f.cwd, "service-ready"), "utf8")).toBe("1");
  expect((await f.call("exec_cancel", { jobId: id })).output.state).toBe(
    "cancelled",
  );
  await delay(950);
  expect(await readFile(join(f.cwd, "descendant-late")).catch(() => null)).toBe(
    null,
  );
});
it("real multi-command verification keeps its original parallel execution semantics", async () => {
  const f = await fixture();
  const verifier = f.managed.verifier(new TaskVerifier());
  const result = await verifier.verify(
    {
      id: "parallel",
      goal: "real checks",
      verification: [
        {
          kind: "command",
          command: process.execPath,
          args: ["-e", "setTimeout(()=>{},60)"],
        },
        {
          kind: "command",
          command: process.execPath,
          args: ["-e", "setTimeout(()=>{},80)"],
        },
      ],
    },
    f.verification,
  );
  expect(result.passed).toBe(true);
  expect(result.checks).toHaveLength(2);
});
