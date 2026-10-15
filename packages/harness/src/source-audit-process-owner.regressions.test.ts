import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";

type Owner = { child: ChildProcess; done: Promise<void>; readonly closed: boolean; stop(options?: { force?: boolean; timeoutMs?: number }): Promise<void> };
const helper = await import(new URL("../../../scripts/research/source-audit-20261007/process-owner.mjs", import.meta.url).href) as {
  ownChildProcess(child: ChildProcess): Owner;
  finishAudit(owners: Owner[], root: string, primary?: unknown): Promise<void>;
  createAuditWorkspace(options?: { makeRoot?: () => Promise<string>; attempts?: number }): Promise<string>;
};

it("cleanup waits for inherited pipes to close after the real parent exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "audit-process-close-")), cwd = join(root, "cwd"), release = join(root, "release");
  await mkdir(cwd);
  const descendant = "const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(t);process.exit(0)}},10);";
  const parent = `const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[1]],{detached:true,stdio:['ignore',1,2]});c.unref();console.log('PIPE_READY');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["-e", parent, release], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const owner = helper.ownChildProcess(child);
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const ready = new Promise<void>((resolve, reject) => {
    child.once("error", reject); let text = "";
    child.stdout!.on("data", bytes => { text += String(bytes); if (text.includes("PIPE_READY")) resolve(); });
  });
  let finishing: Promise<void> | undefined;
  try {
    await ready;
    let settled = false;
    finishing = helper.finishAudit([owner], cwd).then(() => { settled = true; }, error => { settled = true; throw error; });
    void finishing.catch(() => {});
    await exited; await immediate();
    expect(settled, "directory cleanup returned before inherited stdio closed").toBe(false);
    expect(owner.closed).toBe(false);
    await expect(readFile(release)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(release, "close the descendant"); await finishing;
    expect(owner.closed).toBe(true);
    await expect(readFile(join(cwd, "anything"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await writeFile(release, "release on assertion failure");
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await owner.done; await finishing?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

it("a signal-exited child still waits for close and repeated stops send no extra signal", async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: "SIGTERM", kill: () => { throw new Error("signal sent to an exited child"); } }) as unknown as ChildProcess;
  const owner = helper.ownChildProcess(child); let settled = false;
  const stopping = owner.stop().then(() => { settled = true; });
  await immediate(); expect(settled).toBe(false);
  child.emit("close", null, "SIGTERM"); await stopping; await owner.stop();
  expect(owner.closed).toBe(true);
});

it("cleanup keeps both the primary error and a stop failure and retains the owned directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "audit-cleanup-error-"));
  const primary = new Error("original startup failure"), secondary = new Error("stop failed");
  try {
    const owner = { stop: async () => { throw secondary; } } as unknown as Owner;
    const failure = await helper.finishAudit([owner], root, primary).catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError); expect(failure.errors[0]).toBe(primary);
    expect(failure.errors[1].errors).toEqual([secondary]);
    await writeFile(join(root, "still-owned"), "retained");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("a graceful timeout still waits for forced close and clears both deadline timers", async () => {
  vi.useFakeTimers();
  try {
    const signals: string[] = [];
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null as string | null,
      kill: (signal: string) => { signals.push(signal); return true; } }) as unknown as ChildProcess;
    const owner = helper.ownChildProcess(child); let settled = false;
    const outcome = owner.stop({ timeoutMs: 100 }).then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(100);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]); expect(settled).toBe(false);
    child.emit("exit", null, "SIGKILL"); await Promise.resolve(); expect(settled).toBe(false);
    child.emit("close", null, "SIGKILL");
    expect(String(await outcome)).toMatch(/Graceful shutdown timed out/);
    expect(owner.closed).toBe(true); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

async function busyLeaseDirectory() {
  // Allocate the listener first. A fixture never assumes a random fixed port
  // is free while other test processes use the machine's TCP namespace.
  for (let attempt = 0; attempt < 16; attempt++) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "audit-busy-")));
    const data = join(root, "data"); await mkdir(data);
    const hash = createHash("sha256").update(process.platform === "win32" ? data.toLowerCase() : data).digest().readUInt32BE(0);
    const port = process.platform === "win32" ? 10000 + hash % 20000 : 49152 + hash % 16384;
    const listener = createServer(socket => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen({ host: "127.0.0.1", port }, resolve); });
      return { root, listener };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      if (!["EACCES", "EADDRINUSE"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw new Error("Unable to allocate the controlled lease-conflict listener");
}

it("a busy fixed-port candidate is rejected before allocating a real usable fixture directory", async () => {
  const { root: blocked, listener } = await busyLeaseDirectory();
  let allocated: string | undefined, calls = 0;
  try {
    allocated = await helper.createAuditWorkspace({ makeRoot: () => calls++ === 0 ? Promise.resolve(blocked) : mkdtemp(join(tmpdir(), "audit-free-")) });
    expect(allocated).not.toBe(blocked); expect(calls).toBeGreaterThanOrEqual(2);
    await expect(realpath(blocked)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await realpath(join(allocated, "data"))).toBeTruthy();
  } finally {
    if (listener.listening) await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await rm(blocked, { recursive: true, force: true });
    if (allocated !== undefined) await rm(allocated, { recursive: true, force: true });
  }
});
