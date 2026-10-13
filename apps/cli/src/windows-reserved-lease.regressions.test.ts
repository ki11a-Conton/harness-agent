import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acquireDataDirLease, type DataDirLease } from "./data-dir-lease.js";

const fault = vi.hoisted(() => ({ reserved: 0, probePort: 0, attempted: [] as number[] }));
vi.mock("node:net", async original => {
  const net = await original<typeof import("node:net")>();
  return { ...net, createServer: (...args: Parameters<typeof net.createServer>) => {
    const server = net.createServer(...args), listen = server.listen.bind(server);
    server.listen = ((options: { port: number }, ...rest: unknown[]) => {
      fault.attempted.push(options.port);
      if (options.port === fault.reserved) { queueMicrotask(() => server.emit("error", Object.assign(new Error("Windows excluded/exclusive port"), { code: "EACCES" }))); return server; }
      return Reflect.apply(listen, server, [options, ...rest]);
    }) as typeof server.listen;
    return server;
  }, createConnection: ((options: { host: string; port: number }) => net.createConnection({ ...options,
    ...(fault.probePort ? { port: fault.probePort } : {}) })) as typeof net.createConnection };
});
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const roots: string[] = [], leases: DataDirLease[] = [];
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  await Promise.all(leases.splice(0).map(lease => lease.release()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  fault.reserved = fault.probePort = 0; fault.attempted = [];
});
async function directory() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "reserved-lease-real-"))); roots.push(root);
  fault.reserved = 49_152 + createHash("sha256").update(root.toLowerCase()).digest().readUInt32BE(0) % 16_384;
  Object.defineProperty(process, "platform", { value: "win32" }); return root;
}
it("an excluded dynamic Windows port does not prevent a real fixed-anchor lease or allow a second current writer", async () => {
  const root = await directory(), first = await acquireDataDirLease(root); expect(first).toBeDefined(); leases.push(first!);
  expect(first!.lockPort).toBeGreaterThanOrEqual(10_000); expect(first!.lockPort).toBeLessThan(30_000);
  await expect(acquireDataDirLease(root)).rejects.toMatchObject({ code: "HARNESS_DATA_DIR_IN_USE" });
  const anchor = first!.lockPort; await first!.release();
  const next = await acquireDataDirLease(root); leases.push(next!); expect(next!.lockPort).toBe(anchor);
  expect(new Set(fault.attempted)).toEqual(new Set([anchor, fault.reserved]));
});
it("EACCES alone cannot bypass a live legacy listener and failed acquisition releases its new anchor", async () => {
  const root = await directory(), listener = createServer(socket => socket.destroy());
  await new Promise<void>(done => listener.listen({ host: "127.0.0.1", port: 0 }, done));
  fault.probePort = (listener.address() as { port: number }).port;
  try { await expect(acquireDataDirLease(root)).rejects.toMatchObject({ code: "HARNESS_DATA_DIR_IN_USE" }); }
  finally { await new Promise<void>((done, reject) => listener.close(error => error ? reject(error) : done())); }
  fault.probePort = 0;
  const next = await acquireDataDirLease(root); leases.push(next!); expect(next).toBeDefined();
});
