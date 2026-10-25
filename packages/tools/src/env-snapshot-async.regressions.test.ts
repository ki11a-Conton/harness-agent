import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "@ar/contracts";
import { ProcessExecutor, type ExecOutcome } from "./process/executor.js";
import { snapshotEnvironment } from "./env-snapshot.js";
import { createEnvSnapshotTool } from "./tools/env-snapshot-tool.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const cwd = await mkdtemp(join(tmpdir(), "async-env-")); roots.push(cwd); return cwd; }
const success = (stdout: string): ExecOutcome => ({ status: "success", stdout, stderr: "", exitCode: 0, truncated: false, durationMs: 1 });
function context(cwd: string, signal: AbortSignal): ToolExecutionContext {
  return { cwd, signal, sessionId: "session_probe" as never, agentId: "agent_probe" as never, permissions: { rules: [] },
    sandboxPolicy: { filesystem: { mode: "workspace-write" }, network: { mode: "deny" }, process: {} } };
}
const tool = () => createEnvSnapshotTool({ networkMode: () => "deny", availableTools: () => ["env_snapshot"] });

it("all version and Git argv probes use the selected cwd, original deadlines, and the same signal", async () => {
  const cwd = await fixture(), controller = new AbortController();
  await writeFile(join(cwd, "pnpm-lock.yaml"), "lock");
  const calls: string[] = [];
  const execute = vi.spyOn(ProcessExecutor.prototype, "runArgv").mockImplementation(async opts => {
    calls.push(opts.file); expect(opts.cwd).toBe(cwd); expect(opts.signal).toBe(controller.signal); expect(opts.maxOutputBytes).toBe(1_048_576);
    expect(opts.timeoutMs).toBe(opts.file === "node" ? 1500 : 2000);
    if (opts.file === "node") return success("vFixture\nignored second line\n");
    expect(opts.args?.slice(0, 2)).toEqual(["-C", cwd]);
    return success(opts.args?.includes("--abbrev-ref") ? "branch\n" : opts.args?.includes("--short") ? "abc123\n" : opts.args?.includes("get-url") ? "https://example.invalid/repo\n" : " M old.ts\n?? new.ts\n");
  });
  const snapshot = await snapshotEnvironment({ cwd, probeLimit: 1, signal: controller.signal });
  expect(snapshot.runtimes).toEqual([{ name: "node", found: true, version: "vFixture" }]);
  expect(snapshot.git).toMatchObject({ available: true, branch: "branch", head: "abc123", dirtyFiles: 2 });
  expect(snapshot.packageManager).toMatchObject({ detected: "pnpm", lockfile: "pnpm-lock.yaml" });
  expect(calls).toEqual(["node", "git", "git", "git", "git"]); expect(execute).toHaveBeenCalledTimes(5);
});

it.each(["failed", "timeout", "error", "truncated"] as const)("a %s probe cannot become a partial successful runtime version", async mode => {
  const cwd = await fixture();
  vi.spyOn(ProcessExecutor.prototype, "runArgv").mockImplementation(async opts => opts.file === "git"
    ? { ...success(""), status: "failed", exitCode: 1 }
    : { ...success("vIncomplete"), ...(mode === "truncated" ? { truncated: true } : { status: mode, exitCode: null }) });
  expect((await snapshotEnvironment({ cwd, probeLimit: 1 })).runtimes).toEqual([{ name: "node", found: false, version: null }]);
});

it("pre-cancelled calls spawn nothing and never return a successful snapshot", async () => {
  const cwd = await fixture(), controller = new AbortController(); controller.abort();
  const execute = vi.spyOn(ProcessExecutor.prototype, "runArgv");
  await expect(snapshotEnvironment({ cwd, probeLimit: 12, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(await tool().execute({}, context(cwd, controller.signal))).toEqual({ status: "cancelled" });
  expect(execute).not.toHaveBeenCalled();
});

it("cancellation while waiting stops later probes instead of being swallowed as a missing version", async () => {
  const cwd = await fixture(), controller = new AbortController();
  const execute = vi.spyOn(ProcessExecutor.prototype, "runArgv").mockImplementation(async opts => {
    expect(opts.signal).toBe(controller.signal); controller.abort(); return { ...success(""), status: "cancelled", exitCode: null };
  });
  expect(await tool().execute({}, context(cwd, controller.signal))).toEqual({ status: "cancelled" });
  expect(execute).toHaveBeenCalledTimes(1);
});

it.each([false, true])("real argv child stays responsive and is reaped on cancellation (cancel=%s)", async cancel => {
  const cwd = await fixture(), controller = new AbortController(), ready = join(cwd, "ready.json"), release = join(cwd, "release"), finished = join(cwd, "finished");
  const original = ProcessExecutor.prototype.runArgv;
  let childReady = false, parentCallbackRan = false;
  const program = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,cwd:process.cwd()}));process.stdout.write('vProbeReady\\n');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);fs.writeFileSync(${JSON.stringify(finished)},'done')}},10);`;
  const execute = vi.spyOn(ProcessExecutor.prototype, "runArgv").mockImplementation(function (this: ProcessExecutor, opts) {
    if (opts.file !== "node") return original.call(this, opts);
    return original.call(this, { ...opts, file: process.execPath, args: ["-e", program], onOutput: event => {
      if (!event.text.includes("vProbeReady") || childReady) return;
      childReady = true;
      // The child cannot exit normally until a callback runs on THIS host.
      // This tests scheduling, not a flaky elapsed-time assertion.
      if (cancel) controller.abort();
      else setImmediate(() => { parentCallbackRan = true; void writeFile(release, "release"); });
    } });
  });
  const result = await tool().execute({ probeLimit: 1 }, context(cwd, controller.signal));
  expect(childReady).toBe(true);
  const child = JSON.parse(await readFile(ready, "utf8")) as { pid: number; cwd: string };
  expect(await realpath(child.cwd)).toBe(await realpath(cwd));
  if (cancel) {
    expect(result).toEqual({ status: "cancelled" }); expect(execute).toHaveBeenCalledTimes(1);
    expect(existsSync(finished)).toBe(false);
    expect(() => process.kill(child.pid, 0)).toThrow();
  } else {
    expect(result.status).toBe("success"); expect(parentCallbackRan).toBe(true); expect(existsSync(finished)).toBe(true);
    expect(result.output?.runtimes[0]).toEqual({ name: "node", found: true, version: "vProbeReady" });
    expect(result.output?.network.mode).toBe("deny");
  }
});
