import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { resolve } from "node:path";

/** Product-host ownership only. Persistent snapshot stores are single-writer:
 * opening two CLI/Web hosts on one directory can overwrite durable approvals.
 * This local TCP lease is scoped to one machine/network namespace. It is not
 * a distributed/NFS lock and does not alter the SDK's store contract. */
export interface DataDirLease {
  /** Canonical path to pass to the stores, including symlink resolution. */
  readonly dataDir: string;
  readonly lockPort: number;
  /** Keep a CLI's asynchronous work alive until its finally block releases. */
  ref(): void;
  /** Web's HTTP listener owns process lifetime after startup. */
  unref(): void;
  /** Idempotent; process exit/crash also releases the operating-system lease. */
  release(): Promise<void>;
}

export class DataDirLeaseError extends Error {
  readonly code: "HARNESS_DATA_DIR_IN_USE" | "HARNESS_DATA_DIR_LEASE_FAILED";
  constructor(code: DataDirLeaseError["code"], dataDir: string, lockPort: number, cause: unknown) {
    const detail = code === "HARNESS_DATA_DIR_IN_USE"
      ? "another local CLI/Web host or service already owns the directory's fixed lock port"
      : "the local directory ownership listener could not start";
    super(`${code}: ${JSON.stringify(dataDir)}: ${detail} (127.0.0.1:${lockPort}). Close the owning host or choose a different HARNESS_DATA_DIR. No random port fallback is allowed. This lease requires all writers to share one local network namespace.`, { cause });
    this.name = "DataDirLeaseError";
    this.code = code;
  }
}

export async function acquireDataDirLease(dataDir: string | undefined): Promise<DataDirLease | undefined> {
  if (dataDir === undefined || dataDir.length === 0) return undefined;
  const requested = resolve(dataDir);
  await mkdir(requested, { recursive: true });
  const canonical = await realpath(requested);
  // Conservatively fold Windows casing, including directories with explicit
  // case-sensitive flags. This can over-lock, but cannot permit two aliases.
  const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const hash = createHash("sha256").update(identity, "utf8").digest();
  const legacyPort = 49_152 + hash.readUInt32BE(0) % 16_384;
  // Windows commonly excludes parts of its dynamic range for Hyper-V. Always
  // derive one fixed non-dynamic anchor, including when exclusions change.
  // An occupied anchor still refuses ownership; there is no random retry port.
  const lockPort = process.platform === "win32" ? 10_000 + hash.readUInt32BE(0) % 20_000 : legacyPort;
  const servers: Server[] = [];
  async function hold(port: number): Promise<void> {
    const server = createServer(socket => socket.destroy());
    await new Promise<void>((resolveLease, reject) => {
    const failed = (error: NodeJS.ErrnoException): void => {
      server.removeListener("listening", listening);
      reject(new DataDirLeaseError(error.code === "EADDRINUSE" ? "HARNESS_DATA_DIR_IN_USE" : "HARNESS_DATA_DIR_LEASE_FAILED", canonical, port, error));
    };
    const listening = (): void => {
      server.removeListener("error", failed);
      resolveLease();
    };
    server.once("error", failed);
    server.once("listening", listening);
    server.listen({ host: "127.0.0.1", port, exclusive: true });
    });
    servers.push(server); server.unref();
  }
  const closeAll = async (): Promise<void> => {
    await Promise.all(servers.map(server => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))));
  };
  try {
    await hold(lockPort);
    if (process.platform === "win32") {
      try { await hold(legacyPort); }
      catch (error) {
        // Preserve older live hosts. EACCES is also possible for an exclusive
        // listener, so only an explicit connection refusal proves no listener.
        if ((error as Error & { cause?: NodeJS.ErrnoException }).cause?.code !== "EACCES") throw error;
        const absent = await new Promise<boolean>((done, reject) => {
          const peer = createConnection({ host: "127.0.0.1", port: legacyPort });
          const timer = setTimeout(() => { peer.destroy(); reject(error); }, 750);
          peer.once("connect", () => { clearTimeout(timer); peer.destroy(); done(false); });
          peer.once("error", (failure: NodeJS.ErrnoException) => { clearTimeout(timer); peer.destroy(); if (failure.code === "ECONNREFUSED") done(true); else reject(error); });
        });
        if (!absent) throw new DataDirLeaseError("HARNESS_DATA_DIR_IN_USE", canonical, legacyPort, error);
      }
    }
  } catch (error) { await closeAll(); throw error; }
  let releasePromise: Promise<void> | undefined;
  return {
    dataDir: canonical,
    lockPort,
    ref() { if (releasePromise === undefined) for (const server of servers) server.ref(); },
    unref() { for (const server of servers) server.unref(); },
    release() {
      releasePromise ??= closeAll();
      return releasePromise;
    },
  };
}
