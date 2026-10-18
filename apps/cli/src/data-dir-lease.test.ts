import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireDataDirLease, type DataDirLease } from "./data-dir-lease.js";

const directories: string[] = [];
const leases: DataDirLease[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.all(leases.splice(0).map(lease => lease.release()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function directory(): Promise<string> {
  const result = await mkdtemp(join(tmpdir(), "harness-data-dir-lease-")); directories.push(result); return result;
}
async function lease(directory: string): Promise<DataDirLease> {
  const result = await acquireDataDirLease(directory);
  if (result === undefined) throw new Error("expected persistent directory lease");
  leases.push(result); return result;
}
async function leasedDirectory(): Promise<{ root: string; held: DataDirLease }> {
  // A fresh path does not imply its deterministic TCP anchor is free. This
  // allocation is before any business assertion and keeps the admitted lease.
  for (let attempt = 0; attempt < 16; attempt++) {
    const root = await directory();
    try { return { root, held: await lease(root) }; }
    catch (error) {
      if ((error as { code?: unknown }).code !== "HARNESS_DATA_DIR_IN_USE") throw error;
    }
  }
  throw new Error("Unable to allocate an available lease fixture");
}
const childSource = `
import { writeFile } from 'node:fs/promises';
const { acquireDataDirLease } = await import(process.env.LEASE_MODULE);
try {
  const lease = await acquireDataDirLease(process.env.LEASE_DIRECTORY);
  if (process.env.LEASE_MODE === 'owner') {
    lease.ref();
    console.log(JSON.stringify({status:'OWNED',dataDir:lease.dataDir,port:lease.lockPort}));
    process.stdin.resume();
    process.stdin.once('data', async () => { await lease.release(); process.exit(0); });
  } else {
    await writeFile(process.env.LEASE_MARKER, 'contender modified the durable store');
    console.log(JSON.stringify({status:'ACQUIRED',port:lease.lockPort}));
    await lease.release();
  }
} catch(error) {
  console.error(JSON.stringify({code:error.code,message:error.message}));process.exitCode=73;
}`;
function child(directory: string, mode: string, marker: string) {
  const processChild = spawn(process.execPath, ["--input-type=module", "-e", childSource], {
    env: { ...process.env, LEASE_MODULE: pathToFileURL(fileURLToPath(new URL("./data-dir-lease.ts", import.meta.url))).href,
      LEASE_DIRECTORY: directory, LEASE_MODE: mode, LEASE_MARKER: marker },
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  children.push(processChild);
  let stdout = ""; let stderr = "";
  let ownedResolve: () => void = () => {}; let ownedReject: (error: Error) => void = () => {};
  const owned = new Promise<void>((resolveOwned, rejectOwned) => { ownedResolve = resolveOwned; ownedReject = rejectOwned; });
  // Most callers only await done; still observe a premature-owner rejection.
  void owned.catch(() => {});
  const timeout = setTimeout(() => { processChild.kill("SIGKILL"); ownedReject(new Error("lease child timed out")); }, 15_000);
  processChild.stdout!.on("data", chunk => { stdout += String(chunk); if (stdout.includes('"status":"OWNED"')) ownedResolve(); });
  processChild.stderr!.on("data", chunk => { stderr += String(chunk); });
  const done = new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolveDone, rejectDone) => {
    processChild.once("error", error => { clearTimeout(timeout); ownedReject(error); rejectDone(error); });
    processChild.once("close", (code, signal) => {
      clearTimeout(timeout); if (!stdout.includes('"status":"OWNED"')) ownedReject(new Error(`owner did not start: ${stderr}`));
      resolveDone({ code, signal, stdout, stderr });
    });
  });
  return { process: processChild, owned, done };
}

async function ownerFixture(allocate: () => Promise<string> = directory) {
  const rejected: string[] = [];
  for (let attempt = 0; attempt < 16; attempt++) {
    const root = await allocate();
    const marker = join(root, "durable-approval.json");
    const owner = child(root, "owner", marker);
    try {
      await owner.owned;
      return { root, marker, owner, rejected };
    } catch (error) {
      // Drain this exact process before another fresh directory is considered.
      // Only a structured, expected busy-anchor refusal qualifies; a crash,
      // import error, permission failure or timeout must retain its failure.
      const result = await owner.done;
      let failure: { code?: unknown; message?: unknown };
      try { failure = JSON.parse(result.stderr.trim().split("\n").at(-1)!) as typeof failure; }
      catch (parseError) {
        if (parseError instanceof SyntaxError) throw error;
        throw parseError;
      }
      if (result.code !== 73 || failure?.code !== "HARNESS_DATA_DIR_IN_USE"
        || typeof failure.message !== "string" || !failure.message.startsWith("HARNESS_DATA_DIR_IN_USE:")) throw error;
      rejected.push(root);
    }
  }
  throw new Error("Unable to allocate an available owner fixture after 16 refusals");
}

describe("single local product host per persistent data directory", () => {
  it("memory-only hosts need no listener, and released ownership is reusable", async () => {
    expect(await acquireDataDirLease(undefined)).toBeUndefined(); expect(await acquireDataDirLease("")).toBeUndefined();
    const { root, held: first } = await leasedDirectory();
    expect(first.dataDir).toBe(await realpath(root));
    expect(first.lockPort).toBeGreaterThanOrEqual(process.platform === "win32" ? 10_000 : 49_152);
    expect(first.lockPort).toBeLessThanOrEqual(process.platform === "win32" ? 29_999 : 65_535);
    first.ref(); first.unref(); await first.release(); await first.release();
    const second = await lease(root); expect(second.lockPort).toBe(first.lockPort);
  });

  it("symlink aliases cannot acquire a second owner of the same directory", async () => {
    const { root } = await leasedDirectory(); const alias = `${root}-alias`; directories.push(alias);
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(acquireDataDirLease(alias)).rejects.toMatchObject({ code: "HARNESS_DATA_DIR_IN_USE" });
  });

  it.runIf(process.platform === "win32")("Windows case aliases use the same canonical lease", async () => {
    const { root } = await leasedDirectory();
    await expect(acquireDataDirLease(root.toUpperCase())).rejects.toMatchObject({ code: "HARNESS_DATA_DIR_IN_USE" });
  });

  it("an unrelated service on the fixed port fails closed without a store write or alternate port", async () => {
    const { root, held: first } = await leasedDirectory(); const port = first.lockPort; await first.release();
    const existing = createServer(socket => socket.destroy());
    await new Promise<void>((resolveListening, reject) => { existing.once("error", reject); existing.listen({ host: "127.0.0.1", port, exclusive: true }, resolveListening); });
    const marker = join(root, "approval-store.json"); await writeFile(marker, '["approval-a"]');
    try {
      let writes = 0;
      await expect((async () => { const acquired = await acquireDataDirLease(root); if (acquired) { leases.push(acquired); writes++; await writeFile(marker, '[]'); } })())
        .rejects.toMatchObject({ code: "HARNESS_DATA_DIR_IN_USE" });
      expect(writes).toBe(0); expect(await readFile(marker, "utf8")).toBe('["approval-a"]');
    } finally { await new Promise<void>((resolveClosed, reject) => existing.close(error => error ? reject(error) : resolveClosed())); }
  });

  it("two real processes compete before a write, and a graceful release admits the next host", async () => {
    const { root, marker, owner } = await ownerFixture(); await writeFile(marker, '["approval-a"]');
    const contender = await child(root, "contender", marker).done;
    expect(contender.code).toBe(73); expect(contender.stderr).toContain("HARNESS_DATA_DIR_IN_USE");
    expect(await readFile(marker, "utf8")).toBe('["approval-a"]');
    owner.process.stdin!.write("release\n"); expect((await owner.done).code).toBe(0);
    const successor = await child(root, "contender", marker).done;
    expect(successor.code).toBe(0); expect(successor.stdout).toContain('"status":"ACQUIRED"');
  });

  it("a killed real owner releases its OS lease without a stale lock file", async () => {
    const { root, marker, owner } = await ownerFixture(); await writeFile(marker, '["approval-a"]');
    owner.process.kill("SIGKILL"); await owner.done;
    const successor = await child(root, "contender", marker).done;
    expect(successor.code).toBe(0); expect(successor.stdout).toContain('"status":"ACQUIRED"');
  });

  it("a busy initial fixture is replaced before assertions while its actual owner stays locked", async () => {
    const { root: busy } = await leasedDirectory(); let allocations = 0;
    const { root, marker, owner, rejected } = await ownerFixture(async () => ++allocations === 1 ? busy : directory());
    expect(rejected[0]).toBe(busy); expect(root).not.toBe(busy); expect(allocations).toBeGreaterThanOrEqual(2);
    await expect(readFile(join(busy, "durable-approval.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const contender = await child(root, "contender", marker).done;
    expect(contender.code).toBe(73); expect(contender.stderr).toContain("HARNESS_DATA_DIR_IN_USE");
    await expect(acquireDataDirLease(busy)).rejects.toMatchObject({ code: "HARNESS_DATA_DIR_IN_USE" });
    owner.process.stdin!.write("release\n"); expect((await owner.done).code).toBe(0);
  });

  it("non-busy owner startup failures propagate without reallocating a fixture", async () => {
    const root = await directory(); const file = join(root, "not-a-directory"); await writeFile(file, "keep"); let allocations = 0;
    await expect(ownerFixture(async () => { allocations++; return file; })).rejects.toThrow("owner did not start:");
    expect(allocations).toBe(1); expect(await readFile(file, "utf8")).toBe("keep");
  });

  it("unavailable owner fixture allocation is bounded and never writes durable data", async () => {
    const { root } = await leasedDirectory(); let allocations = 0;
    await expect(ownerFixture(async () => { allocations++; return root; })).rejects.toThrow("after 16 refusals");
    expect(allocations).toBe(16);
    await expect(readFile(join(root, "durable-approval.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(acquireDataDirLease(root)).rejects.toMatchObject({ code: "HARNESS_DATA_DIR_IN_USE" });
  });
});
