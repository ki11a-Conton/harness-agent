/**
 * E4-R06 (F15) — cross-process lock exclusion, proven with a REAL child process.
 * The child creates the wx lock file with ITS OWN live pid and an old mtime;
 * the parent must NOT steal it while the child is alive (no two writers enter
 * the critical section), and MUST reclaim it after the child exits.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DurableRecoveryStore, RecoveryStoreError } from "./durable-recovery-store.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "e4-r06-xproc-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function childScript(): string {
  // A minimal child: atomically create the lock file (wx) with its own pid,
  // age it, hold it, then exit. No store import needed — the wx contract is
  // exactly what the parent's acquireFileLock contends against.
  return `
    const { open, utimes } = require("node:fs/promises");
    const lockPath = process.argv[2];
    (async () => {
      const h = await open(lockPath, "wx");
      await h.writeFile(process.pid + " child-holder");
      await h.close();
      const old = new Date(Date.now() - 120_000);
      await utimes(lockPath, old, old);
      console.log("HELD " + process.pid);
      await new Promise((r) => setTimeout(r, 2500));
    })().catch((e) => { console.error(String(e)); process.exit(1); });
  `;
}

describe("E4-R06 cross-process lock fencing", () => {
  it("a live child's old lock is NOT stolen; after the child exits it is reclaimed", async () => {
    const store = new DurableRecoveryStore({ dataDir: dir });
    const lockPath = join(dir, "recovery-xproc.lock");
    const scriptPath = join(dir, "holder.js");
    await writeFile(scriptPath, childScript(), "utf8");

    const child = spawn(process.execPath, [scriptPath, lockPath], { stdio: ["ignore", "pipe", "pipe"] });
    // Wait for the child to hold the lock (HELD line) with a finite timeout.
    const held = await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => { resolve(false); }, 8000);
      let out = "";
      child.stdout?.on("data", (d) => { out += String(d); if (out.includes("HELD")) { clearTimeout(timer); resolve(true); } });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("exit", () => { clearTimeout(timer); resolve(out.includes("HELD")); });
    });
    expect(held).toBe(true);

    const acquire = (store as unknown as { acquireFileLock(f: string): Promise<() => Promise<void>> }).acquireFileLock.bind(store);
    // While the child (a live pid) holds the lock with an OLD mtime, the parent
    // must fail fast — never a second writer in the critical section.
    await expect(acquire(lockPath)).rejects.toThrow(RecoveryStoreError);
    expect((await readFile(lockPath, "utf8")).trim().endsWith("child-holder")).toBe(true);

    // Child exits; the lock's owner is now dead → reclaim succeeds.
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    let released = false;
    for (let i = 0; i < 20 && !released; i += 1) {
      try {
        const release = await acquire(lockPath);
        released = true;
        await release();
      } catch {
        await new Promise((r) => setTimeout(r, 150)); // child still exiting/stat race
      }
    }
    expect(released).toBe(true);
  }, 30000);
});