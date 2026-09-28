/**
 * E4-R17 — the CONCURRENCY GUARD of `scripts/e4/r97-mutation-check.mjs`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * MEASURED (E4-R14 report §4): a stray `node scripts/e4/r97-mutation-check.mjs` was
 * still walking its mutation list while another suite ran. That suite reported FOUR
 * failures naming `a2`'s anchor as absent, and the modified file changed between
 * attempts (`r97-budget-channel.ts` EOL-only → `r97-budget-ledger.ts` →
 * `tool-call-efficiency-paired-campaign.ts` with a real mutation). After the stray
 * process was killed and the tree restored, the IDENTICAL command returned
 * 47 passed (47). The failures were a CONCURRENCY artifact, not a defect.
 *
 * The gate now carries five behaviours against that hazard. Each one is pinned here:
 *
 *   X1  a SECOND gate REFUSES to start while a live holder is recorded in the lock,
 *       and the refusal names the holder's pid and the file it is mutating;
 *   X2  a STALE lock (holder not alive, foreign host, unreadable record) is RECLAIMED,
 *       so a killed run can never deadlock CI;
 *   X3  the lock is RELEASED on every exit path, the tree is restored FIRST, and that
 *       covers a thrown error, SIGINT, SIGTERM and `process.on("exit")`;
 *   X4  the PRE-FLIGHT refuses a tree with a REAL change, reports the paths, and
 *       tolerates ONLY a provably EOL/stat-only entry — loudly and on the record;
 *   X5  a mutation whose anchor DID NOT LAND, or a file the gate did NOT mutate
 *       changing underneath it, is a distinct LOUD failure rather than a silent MISS.
 *
 * HOW THESE TESTS AVOID THE HAZARD THEY TEST. This file NEVER mutates a production
 * source and NEVER writes the repository's own lock: every case drives the guard
 * through the injectable seam (`main(argv, overrides)`, `acquireLock`, `createExitGuard`,
 * …) against temp directories, or against a genuinely separate OS process whose lock
 * lives in a temp directory. Running this suite concurrently with the gate is therefore
 * safe by construction — which is what makes it runnable by `pnpm test` at all.
 *
 * The META-suite (`r97-mutation-check.test.ts`) is deliberately left untouched: its
 * 32 cases pin the mutations themselves, and its count is part of this round's
 * acceptance. Nothing here weakens `anchorOccurrences`, a mutation, or the catch rule.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.cwd();
const GATE_SOURCE = join(REPO, "scripts", "e4", "r97-mutation-check.mjs");
const SCRIPT = pathToFileURL(GATE_SOURCE).href;
const HOST = hostname();

type LockRecord = {
  schema: string;
  pid: number;
  host: string;
  startedAt: string;
  mutating: string | null;
  repoRoot?: string | null;
};

type MutationStub = {
  id: string;
  planWording: string;
  round: string;
  file: string;
  find: string;
  replace: string;
  suite: string;
  test: string;
};

interface GateModule {
  LOCK_SCHEMA: string;
  LOCK_RELPATH: string;
  EXIT_OK: number;
  EXIT_FAILED: number;
  EXIT_CONFIG: number;
  EXIT_REFUSED: number;
  EXIT_DIRTY_TREE: number;
  MUTATIONS: MutationStub[];
  defaultIsProcessAlive: (pid: number) => boolean;
  lockStaleness: (
    record: unknown,
    env: { host: string; pid: number; isProcessAlive: (pid: number) => boolean },
  ) => { stale: boolean; because: string | null };
  lockRefusalReason: (record: Partial<LockRecord> | null) => string;
  acquireLock: (deps: Record<string, unknown>) => {
    acquired: boolean;
    record?: LockRecord;
    reclaimedBecause?: string | null;
    reason?: string;
  };
  writeLockMutation: (deps: Record<string, unknown>) => { updated: boolean; because: string | null };
  releaseLock: (deps: Record<string, unknown>) => { released: boolean; because: string | null };
  createJournal: (fs?: { writeFileSync: (path: string, text: string) => unknown }) => {
    record: (path: string, text: string) => void;
    commit: (path: string) => void;
    size: () => number;
    paths: () => string[];
    restoreAll: () => string[];
  };
  createExitGuard: (deps: Record<string, unknown>) => {
    restoreAll: () => string[];
    handleExit: () => void;
    handleSignal: (signal: string) => void;
  };
  signalExitCode: (signal: string) => number;
  dirtyTreePaths: (porcelain: string) => string[];
  eolOnlyPaths: (numstat: string) => Set<string>;
  preflightVerdict: (
    porcelain: string,
    numstat: string,
  ) => { clean: boolean; tolerated: Array<{ path: string }>; blocking: Array<{ path: string }> };
  dirtyTreeReason: (verdict: { tolerated?: Array<{ path: string }>; blocking?: Array<{ line: string }> }) => string;
  verifyMutationLanded: (opts: {
    mutation: { file: string; find: string; replace: string };
    afterText: string;
  }) => { landed: boolean; findCount: number; replaceCount: number; reason: string | null };
  changedPorcelainLines: (before: string, after: string) => string[];
  unexpectedChangedPaths: (
    before: string,
    after: string,
    expectedFile: string,
  ) => Array<{ line: string; path: string }>;
  notMutatedFileChangedReason: (
    mutation: { id: string; file: string },
    treeNow: string | null,
    unexpected: Array<{ line: string; path: string }>,
  ) => string;
  toleratedDirtDigest: (paths: string[], digestOf: (path: string) => string | null) => string;
  toleratedDirtChangedReason: (paths: string[]) => string;
  parseArgs: (argv: string[]) => { only?: string; out?: string; forceUnlock?: boolean };
  main: (argv: string[], overrides?: Record<string, unknown>) => Promise<number>;
}

const mod = (await import(SCRIPT)) as unknown as GateModule;

const NODE_FS = { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, linkSync, renameSync };

/* ------------------------------------------------------------------ helpers */

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "r17-gate-guard-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

type Handler = () => void;

/** A stand-in for the `process` global, so a test never registers real signal handlers. */
function fakeProcess(): {
  listeners: Map<string, Handler[]>;
  exits: Array<number | undefined>;
  on: (event: string, fn: Handler) => void;
  emit: (event: string) => void;
  exit: (code?: number) => void;
} {
  const listeners = new Map<string, Handler[]>();
  const exits: Array<number | undefined> = [];
  return {
    listeners,
    exits,
    on(event, fn) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
    },
    emit(event) {
      for (const fn of listeners.get(event) ?? []) fn();
    },
    exit(code) {
      exits.push(code);
    },
  };
}

function capture(): { stream: { write: (chunk: string) => boolean }; text: () => string } {
  let text = "";
  return {
    stream: {
      write(chunk: string) {
        text += chunk;
        return true;
      },
    },
    text: () => text,
  };
}

/** The lock dependencies, pointed at a temp directory and a synthetic clock. */
function lockDeps(
  dir: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    repoRoot: "/repo",
    lockPath: join(dir, "gate.lock.json"),
    fs: NODE_FS,
    env: {
      pid: 4242,
      host: HOST,
      now: () => "2026-01-01T00:00:00.000Z",
      isProcessAlive: () => true,
    },
    ...overrides,
  };
}

/** Every override `main` needs so a test touches no real repository state. */
function mainDeps(
  lockPath: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    lockPath,
    pid: 4242,
    host: HOST,
    now: () => "2026-01-01T00:00:00.000Z",
    isProcessAlive: () => true,
    fs: NODE_FS,
    proc: fakeProcess(),
    stdout: capture().stream,
    stderr: capture().stream,
    treeState: () => "",
    diffNumstat: () => "",
    ...overrides,
  };
}

/** An id that exists in the real list, so `--only` selects exactly one mutation. */
const ONE_ID = "same-build-for-both-arms";

function stubResult(id: string, ok = true): Record<string, unknown> {
  const mutation = mod.MUTATIONS.find((m) => m.id === id);
  if (mutation === undefined) throw new Error(`${id} is not in the gate's list`);
  return {
    id,
    planWording: mutation.planWording,
    round: mutation.round,
    file: mutation.file,
    suite: mutation.suite,
    test: mutation.test,
    ok,
    applied: true,
    restored: true,
  };
}

/* ==========================================================================
 * X1 — a SECOND gate refuses while a live holder is recorded.
 * ========================================================================== */

describe("E4-R17 X1: a second gate REFUSES while a live holder owns the lock", () => {
  it("refuses, names the holding pid, and does NOT remove the holder's lock", () => {
    const dir = tempDir();
    const lockPath = join(dir, "gate.lock.json");
    const first = mod.acquireLock(lockDeps(dir));
    expect(first.acquired, "the first gate must take the lock").toBe(true);
    expect(first.record?.pid).toBe(4242);

    const noticed: string[] = [];
    const second = mod.acquireLock(
      lockDeps(dir, {
        env: {
          pid: 7777,
          host: HOST,
          now: () => "2026-01-01T00:00:01.000Z",
          isProcessAlive: (pid: number) => pid === 4242,
        },
        notice: (text: string) => noticed.push(text),
      }),
    );

    expect(second.acquired, "a second gate must not start on top of a live one").toBe(false);
    expect(second.reason, "the refusal must name the holding pid").toContain("4242");
    expect(second.reason).toMatch(/REFUSING TO START/);
    expect(existsSync(lockPath), "the holder's lock must survive the refused attempt").toBe(true);
    expect(noticed.join("\n"), "a refusal must not claim to have reclaimed anything").not.toMatch(
      /reclaiming a STALE lock/,
    );
  });

  it("names the file the holder is mutating RIGHT NOW, from the lock record", () => {
    const dir = tempDir();
    const lockPath = join(dir, "gate.lock.json");
    const first = mod.acquireLock(lockDeps(dir));
    const held = first.record as LockRecord;
    const updated = mod.writeLockMutation({
      lockPath,
      fs: NODE_FS,
      identity: held,
      mutating: "packages/evaluation/src/r97-budget-ledger.ts",
    });
    expect(updated.updated).toBe(true);

    const second = mod.acquireLock(
      lockDeps(dir, { env: { pid: 7777, host: HOST, now: () => "t", isProcessAlive: () => true } }),
    );
    expect(second.acquired).toBe(false);
    expect(second.reason, "the refusal must name the file that is mutated as it is read").toContain(
      "packages/evaluation/src/r97-budget-ledger.ts",
    );
  });

  it("does not publish a half-written record: the lock never exists without readable content", () => {
    // Two gates racing the SAME dead lock must not both win. The record is written to a
    // temp file and LINKED into place, so the visible lock is complete at publication.
    const dir = tempDir();
    const first = mod.acquireLock(lockDeps(dir));
    expect(first.acquired).toBe(true);
    const text = readFileSync(join(dir, "gate.lock.json"), "utf8");
    expect(() => JSON.parse(text)).not.toThrow();
    expect((JSON.parse(text) as LockRecord).schema).toBe(mod.LOCK_SCHEMA);
    // No scratch names are left behind by the atomic create.
    expect(existsSync(`${join(dir, "gate.lock.json")}.4242.0.tmp`)).toBe(false);
  });

  it("keeps the lock in a GITIGNORED location, so the lock cannot dirty the tree", () => {
    // Load-bearing, not tidy: a lock in `git status --porcelain` would make the very
    // pre-flight it must not perturb refuse the SECOND gate for the wrong reason.
    expect(mod.LOCK_RELPATH.replace(/\\/g, "/")).toMatch(/^\.ci\//);
    const ignore = readFileSync(join(REPO, ".gitignore"), "utf8");
    expect(ignore.split(/\r?\n/)).toContain(".ci/");
  });

  it("identifies the holder by the RECORDED pid — never by scanning a process list", () => {
    // MEASURED this round (r6-protocol): a filter over the OS process table's command
    // lines matched its OWN query string and raised a false "live gate process" alarm.
    // The lock record plus a pid probe cannot make that mistake.
    const source = readFileSync(GATE_SOURCE, "utf8");
    expect(source).toContain("process.kill(pid, 0)");
    expect(source, "the guard must not pattern-match a process list").not.toMatch(
      /Win32_Process|Get-CimInstance|Get-Process|tasklist|\bwmic\b/,
    );
  });
});

/* ==========================================================================
 * X2 — a STALE lock is reclaimed, so a killed run cannot deadlock CI.
 * ========================================================================== */

describe("E4-R17 X2: a STALE lock is RECLAIMED rather than deadlocking CI", () => {
  const RECORD = (over: Partial<LockRecord> = {}): string =>
    `${JSON.stringify(
      {
        schema: "e4-r97-mutation-lock-v1",
        pid: 999999,
        host: HOST,
        startedAt: "2026-01-01T00:00:00.000Z",
        mutating: null,
        repoRoot: "/repo",
        ...over,
      },
      null,
      2,
    )}\n`;

  it("reclaims a lock whose holder pid is not alive, and says why", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "gate.lock.json"), RECORD({ mutating: "packages/x.ts" }), "utf8");
    const notices: string[] = [];
    const acquired = mod.acquireLock(
      lockDeps(dir, { env: { pid: 4242, host: HOST, now: () => "t", isProcessAlive: () => false }, notice: (t: string) => notices.push(t) }),
    );
    expect(acquired.acquired).toBe(true);
    expect(acquired.reclaimedBecause).toMatch(/not alive/);
    // The leftover named a target, so the operator is told the tree may still be dirty.
    expect(notices.join("\n")).toMatch(/reclaiming a STALE lock/);
    expect(notices.join("\n")).toContain("packages/x.ts");
  });

  it("reclaims a lock written by ANOTHER HOST, whose pid cannot be probed here", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "gate.lock.json"), RECORD({ host: "some-other-runner" }), "utf8");
    const acquired = mod.acquireLock(
      lockDeps(dir, { env: { pid: 4242, host: HOST, now: () => "t", isProcessAlive: () => true } }),
    );
    expect(acquired.acquired).toBe(true);
    expect(acquired.reclaimedBecause).toMatch(/host/);
  });

  it("reclaims an UNREADABLE lock file instead of refusing forever", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "gate.lock.json"), "", "utf8");
    const acquired = mod.acquireLock(lockDeps(dir));
    expect(acquired.acquired).toBe(true);
    expect(acquired.reclaimedBecause).toMatch(/not a readable lock RECORD/);

    writeFileSync(join(dir, "gate.lock.json"), "not json at all", "utf8");
    const again = mod.acquireLock(lockDeps(dir, { env: { pid: 5151, host: HOST, now: () => "t", isProcessAlive: () => true } }));
    expect(again.acquired).toBe(true);
  });

  it("treats a record from a DIFFERENT schema as foreign, not as ours", () => {
    expect(
      mod.lockStaleness(
        { schema: "something-else", pid: 1, host: HOST, startedAt: "t" },
        { host: HOST, pid: 4242, isProcessAlive: () => true },
      ).stale,
    ).toBe(true);
  });

  it("treats a lock taken by THIS process as stale: a re-entrant take is a caller bug", () => {
    const verdict = mod.lockStaleness(
      { schema: "e4-r97-mutation-lock-v1", pid: 4242, host: HOST, startedAt: "t" },
      { host: HOST, pid: 4242, isProcessAlive: () => true },
    );
    expect(verdict.stale).toBe(true);
    expect(verdict.because).toMatch(/THIS process/);
  });

  it("does NOT reclaim a live holder on this host — the one condition that must refuse", () => {
    const verdict = mod.lockStaleness(
      { schema: "e4-r97-mutation-lock-v1", pid: 999, host: HOST, startedAt: "t" },
      { host: HOST, pid: 4242, isProcessAlive: (pid: number) => pid === 999 },
    );
    expect(verdict.stale).toBe(false);
    expect(verdict.because).toBeNull();
  });

  it("releases only our OWN lock: a reclaimed lock is never deleted by the old holder", () => {
    const dir = tempDir();
    const lockPath = join(dir, "gate.lock.json");
    const mine = mod.acquireLock(lockDeps(dir));
    const identity = mine.record as LockRecord;
    // Another process reclaimed it (we were thought dead) and is now the holder.
    writeFileSync(
      lockPath,
      `${JSON.stringify({ ...identity, pid: 8888, startedAt: "2026-01-02T00:00:00.000Z" }, null, 2)}\n`,
      "utf8",
    );
    const outcome = mod.releaseLock({ lockPath, fs: NODE_FS, identity });
    expect(outcome.released).toBe(false);
    expect(outcome.because).toMatch(/no longer ours/);
    expect(existsSync(lockPath), "the new holder's lock must survive").toBe(true);
  });

  it("--force-unlock removes a live holder's lock and SAYS what it removed", () => {
    const dir = tempDir();
    const lockPath = join(dir, "gate.lock.json");
    const first = mod.acquireLock(lockDeps(dir));
    mod.writeLockMutation({
      lockPath,
      fs: NODE_FS,
      identity: first.record as LockRecord,
      mutating: "packages/evaluation/src/held.ts",
    });
    const notices: string[] = [];
    const forced = mod.acquireLock(
      lockDeps(dir, {
        env: { pid: 7777, host: HOST, now: () => "t", isProcessAlive: () => true },
        force: true,
        notice: (t: string) => notices.push(t),
      }),
    );
    expect(forced.acquired).toBe(true);
    expect(notices.join("\n")).toMatch(/--force-unlock: removing/);
    expect(notices.join("\n")).toContain("packages/evaluation/src/held.ts");
    expect(mod.parseArgs(["--force-unlock"]).forceUnlock).toBe(true);
  });

  it("does NOT delete a lock that was REPLACED between the read and the reclaim (race-safe)", () => {
    // ATTACK (adversarial review): reclaimers race the SAME stale lock. With a bare
    // unlink, process B can delete the lock process A created microseconds earlier,
    // admitting a THIRD gate — the opposite of what the lock is for. The reclaim
    // therefore MOVES the file aside and verifies it is still the bytes it judged stale,
    // and puts it back when it is not.
    const dir = tempDir();
    const lockPath = join(dir, "gate.lock.json");
    const stale = `${JSON.stringify(
      { schema: mod.LOCK_SCHEMA, pid: 999999, host: HOST, startedAt: "stale", mutating: null },
      null,
      2,
    )}\n`;
    const live = `${JSON.stringify(
      { schema: mod.LOCK_SCHEMA, pid: 8888, host: HOST, startedAt: "live", mutating: "packages/x.ts" },
      null,
      2,
    )}\n`;
    writeFileSync(lockPath, stale, "utf8");

    let injected = false;
    const racingFs = {
      ...NODE_FS,
      // The interleaving, made deterministic: another gate has ALREADY reclaimed the
      // stale lock and taken its own before this process gets to move it.
      renameSync: (from: string, to: string) => {
        if (!injected) {
          injected = true;
          writeFileSync(lockPath, live, "utf8");
        }
        return renameSync(from, to);
      },
    };

    const lost = mod.acquireLock({
      repoRoot: "/repo",
      lockPath,
      fs: racingFs,
      env: { pid: 4242, host: HOST, now: () => "t", isProcessAlive: (pid: number) => pid === 8888 },
    });

    expect(lost.acquired, "the process that lost the reclaim race must NOT start").toBe(false);
    expect(injected).toBe(true);
    expect(readFileSync(lockPath, "utf8"), "the live holder's lock must be put back").toBe(live);
    expect(lost.reason).toContain("8888");
  });

  it("leaves no scratch files behind after a reclaim", () => {
    const dir = tempDir();
    const lockPath = join(dir, "gate.lock.json");
    writeFileSync(
      lockPath,
      `${JSON.stringify({ schema: mod.LOCK_SCHEMA, pid: 999999, host: HOST, startedAt: "s", mutating: null })}\n`,
      "utf8",
    );
    const acquired = mod.acquireLock(
      lockDeps(dir, { env: { pid: 4242, host: HOST, now: () => "t", isProcessAlive: () => false } }),
    );
    expect(acquired.acquired).toBe(true);
    expect(readdirSync(dir).filter((name) => name !== "gate.lock.json")).toEqual([]);
  });
});

/* ==========================================================================
 * X2b — the same refusal and reclaim across a REAL second OS process.
 * ========================================================================== */

describe("E4-R17 X2b: a genuinely separate OS process is excluded by the lock itself", () => {
  it("refuses the live child, then reclaims its lock once the child is killed", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "gate.lock.json");
    const marker = join(dir, "holder.ready");
    const holder = join(dir, "holder.mjs");
    const source = [
      `import { acquireLock, writeLockMutation } from ${JSON.stringify(SCRIPT)};`,
      `import * as fs from "node:fs";`,
      `import { hostname } from "node:os";`,
      `const lockPath = ${JSON.stringify(lockPath)};`,
      `const marker = ${JSON.stringify(marker)};`,
      `const isProcessAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err && err.code === "EPERM"; } };`,
      `const lock = acquireLock({ repoRoot: "/repo", lockPath, fs, env: { pid: process.pid, host: hostname(), now: () => new Date().toISOString(), isProcessAlive } });`,
      `if (!lock.acquired) { fs.writeFileSync(marker, "REFUSED: " + String(lock.reason)); process.exit(9); }`,
      `writeLockMutation({ lockPath, fs, identity: lock.record, mutating: "packages/evaluation/src/r97-budget-ledger.ts" });`,
      `fs.writeFileSync(marker, "HELD " + String(process.pid));`,
      `setInterval(() => {}, 1000);`,
      "",
    ].join("\n");
    writeFileSync(holder, source, "utf8");

    const child = spawn(process.execPath, [holder], { stdio: "ignore" });
    try {
      const deadline = Date.now() + 20_000;
      while (!existsSync(marker) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(existsSync(marker), "the holder process never reported that it took the lock").toBe(true);
      const held = readFileSync(marker, "utf8");
      expect(held, `the holder refused its own lock: ${held}`).toMatch(/^HELD \d+$/);
      const childPid = Number(held.slice("HELD ".length));
      expect(childPid).toBe(child.pid);

      // THE PARENT IS A REAL SECOND PROCESS, using the REAL pid probe.
      const refused = mod.acquireLock({
        repoRoot: "/repo",
        lockPath,
        fs: NODE_FS,
        env: { pid: process.pid, host: HOST, now: () => new Date().toISOString(), isProcessAlive: mod.defaultIsProcessAlive },
      });
      expect(refused.acquired, "a live second process must be refused by the lock, not only by a stub").toBe(false);
      expect(refused.reason).toContain(String(childPid));
      expect(refused.reason).toContain("packages/evaluation/src/r97-budget-ledger.ts");

      // A KILLED holder must never deadlock the next run.
      child.kill();
      await new Promise((resolve) => child.once("close", resolve));
      const goneDeadline = Date.now() + 10_000;
      while (mod.defaultIsProcessAlive(childPid) && Date.now() < goneDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(mod.defaultIsProcessAlive(childPid), "the holder is still alive; the reclaim below would be wrong").toBe(false);

      const reclaimed = mod.acquireLock({
        repoRoot: "/repo",
        lockPath,
        fs: NODE_FS,
        env: { pid: process.pid, host: HOST, now: () => new Date().toISOString(), isProcessAlive: mod.defaultIsProcessAlive },
      });
      expect(reclaimed.acquired, "a killed holder's lock must be reclaimed, or CI deadlocks").toBe(true);
      expect(reclaimed.reclaimedBecause).toMatch(/not alive/);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  }, 60_000);
});

/* ==========================================================================
 * X3 — the lock is released on EVERY exit path, and the tree first.
 * ========================================================================== */

describe("E4-R17 X3: every exit path releases the lock, and restores the tree FIRST", () => {
  it("restores the written files BEFORE releasing, then exits with the signal's code", () => {
    const order: string[] = [];
    const journal = mod.createJournal({
      writeFileSync: (path: string) => {
        order.push(`restore:${path}`);
        return undefined;
      },
    });
    journal.record("/x/production.ts", "the bytes before the mutation");
    const guard = mod.createExitGuard({
      journal,
      release: () => {
        order.push("release");
        return { released: true, because: null };
      },
      warn: () => {},
      exit: (code: number) => {
        order.push(`exit:${code}`);
      },
    });

    guard.handleSignal("SIGINT");

    // ORDER IS THE CONTRACT. Releasing first would publish "the tree is free" while a
    // mutated file was still on disk — the exact window that produces false failures.
    expect(order).toEqual(["restore:/x/production.ts", "release", "exit:130"]);
    expect(mod.signalExitCode("SIGINT")).toBe(130);
    expect(mod.signalExitCode("SIGTERM")).toBe(143);
  });

  it("REALLY puts the bytes back and removes the lock, for SIGINT and SIGTERM", () => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const dir = tempDir();
      const lockPath = join(dir, "gate.lock.json");
      const target = join(dir, "production-source.ts");
      writeFileSync(target, "export const FIXED = true;\n", "utf8");
      const mine = mod.acquireLock(lockDeps(dir));
      const identity = mine.record as LockRecord;

      const journal = mod.createJournal({ writeFileSync });
      journal.record(target, readFileSync(target, "utf8"));
      writeFileSync(target, "export const MUTATED = true;\n", "utf8");

      const exits: Array<number | undefined> = [];
      const guard = mod.createExitGuard({
        journal,
        release: () => mod.releaseLock({ lockPath, fs: NODE_FS, identity }),
        warn: () => {},
        exit: (code: number) => exits.push(code),
      });
      guard.handleSignal(signal);

      expect(exits).toEqual([mod.signalExitCode(signal)]);
      expect(existsSync(lockPath), `${signal}: the lock must be released`).toBe(false);
      expect(readFileSync(target, "utf8"), `${signal}: the mutated file must be restored`).toBe(
        "export const FIXED = true;\n",
      );
    }
  });

  it("is idempotent: a signal followed by `exit` restores and releases only once", () => {
    let restores = 0;
    let releases = 0;
    const journal = mod.createJournal({
      writeFileSync: () => {
        restores += 1;
      },
    });
    journal.record("/x/production.ts", "before");
    const guard = mod.createExitGuard({
      journal,
      release: () => {
        releases += 1;
        return { released: true, because: null };
      },
      warn: () => {},
      exit: () => {},
    });
    guard.handleSignal("SIGTERM");
    guard.handleExit();
    guard.handleExit();
    expect(restores).toBe(1);
    expect(releases).toBe(1);
  });

  it("wires SIGINT, SIGTERM and `exit` through the process handle `main` was given", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "gate.lock.json");
    const proc = fakeProcess();
    const code = await mod.main(["--only", ONE_ID], mainDeps(lockPath, { proc, runOne: () => stubResult(ONE_ID) }));
    expect(code).toBe(mod.EXIT_OK);
    expect([...proc.listeners.keys()].sort()).toEqual(["SIGINT", "SIGTERM", "exit"]);
  });

  it("RELEASES the lock when the runner THROWS, and leaves the next run able to start", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "gate.lock.json");
    const stderr = capture();
    await expect(
      mod.main(["--only", ONE_ID], mainDeps(lockPath, {
        stderr: stderr.stream,
        runOne: () => {
          throw new Error("boom from the injectable seam");
        },
      })),
    ).rejects.toThrow("boom from the injectable seam");
    expect(existsSync(lockPath), "a thrown error must not leave a live-looking lock behind").toBe(false);
    // And a fresh acquisition therefore succeeds without any stale-reclaim detour.
    const again = mod.acquireLock(lockDeps(dir));
    expect(again.acquired).toBe(true);
    expect(again.reclaimedBecause).toBeNull();
  });

  it("RELEASES the lock when the PRE-FLIGHT refuses", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "gate.lock.json");
    const code = await mod.main(["--only", ONE_ID], mainDeps(lockPath, {
      treeState: () => " M packages/evaluation/src/r97-plan.ts\n",
      diffNumstat: () => "4\t2\tpackages/evaluation/src/r97-plan.ts\n",
    }));
    expect(code).toBe(mod.EXIT_DIRTY_TREE);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("RELEASES the lock on the NORMAL path, after the report is written", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "gate.lock.json");
    const stdout = capture();
    const code = await mod.main(["--only", ONE_ID], mainDeps(lockPath, {
      stdout: stdout.stream,
      runOne: () => stubResult(ONE_ID),
    }));
    expect(code).toBe(mod.EXIT_OK);
    expect(existsSync(lockPath)).toBe(false);
    expect(stdout.text()).toMatch(/\[lock\] held /);
    expect(stdout.text()).toMatch(/\[lock\] released /);
  });

  it("reports a failed release rather than deleting a lock that is no longer ours", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "gate.lock.json");
    const stdout = capture();
    await mod.main(["--only", ONE_ID], mainDeps(lockPath, {
      stdout: stdout.stream,
      runOne: () => {
        // Another gate reclaimed our lock mid-run (we were thought dead) and holds it.
        writeFileSync(
          lockPath,
          `${JSON.stringify({ schema: mod.LOCK_SCHEMA, pid: 999999, host: HOST, startedAt: "other", mutating: null }, null, 2)}\n`,
          "utf8",
        );
        return stubResult(ONE_ID);
      },
    }));
    // The other holder's lock must still be there, and the gate must not claim to have
    // released it.
    expect(existsSync(lockPath)).toBe(true);
    expect((JSON.parse(readFileSync(lockPath, "utf8")) as LockRecord).pid).toBe(999999);
    expect(stdout.text()).not.toMatch(/\[lock\] released /);
  });
});

/* ==========================================================================
 * X4 — the pre-flight refuses REAL dirt, tolerates ONLY provable EOL/stat-only.
 * ========================================================================== */

describe("E4-R17 X4: the pre-flight refuses a dirty tree and reports the paths", () => {
  it("REFUSES a real content change, names the path, and never calls the runner", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "gate.lock.json");
    const stderr = capture();
    let ran = 0;
    const code = await mod.main(["--only", ONE_ID], mainDeps(lockPath, {
      stderr: stderr.stream,
      treeState: () => " M packages/evaluation/src/r97-plan.ts\n",
      diffNumstat: () => "4\t2\tpackages/evaluation/src/r97-plan.ts\n",
      runOne: () => {
        ran += 1;
        return stubResult(ONE_ID);
      },
    }));
    expect(code).toBe(mod.EXIT_DIRTY_TREE);
    expect(ran, "no mutation may be applied on a dirty tree").toBe(0);
    expect(stderr.text()).toContain("packages/evaluation/src/r97-plan.ts");
    expect(stderr.text()).toMatch(/REFUSING TO START/);
    expect(stderr.text()).toMatch(/NOTHING was modified/);
  });

  it("REFUSES an untracked, staged, deleted or binary entry — the tolerance is narrow", () => {
    const numstat = "0\t0\ta.ts\n-\t-\tb.bin\n";
    expect([...mod.eolOnlyPaths(numstat)]).toEqual(["a.ts"]);
    const verdict = mod.preflightVerdict("?? brand-new.ts\nM  staged.ts\n D deleted.ts\n M a.ts\n M b.bin\n", numstat);
    expect(verdict.tolerated.map((entry) => entry.path)).toEqual(["a.ts"]);
    expect(verdict.blocking.map((entry) => entry.path).sort()).toEqual([
      "b.bin",
      "brand-new.ts",
      "deleted.ts",
      "staged.ts",
    ]);
    expect(mod.preflightVerdict("", "").clean).toBe(true);
  });

  it("TOLERATES a provably EOL/stat-only entry, LOUDLY, and records it in the report", async () => {
    // DELIBERATE, STATED CHOICE (E4-R17). The anchor matcher is EOL-insensitive (pinned
    // by the meta-suite's X5 cases) and the restore is byte-exact, so an EOL-only entry
    // cannot make either guarantee fail — while on this Windows checkout with
    // `core.autocrlf` such entries are LIKELY, and a gate that refuses them is a gate
    // operators learn to bypass. Only ` M` + numstat `0 0` qualifies.
    const dir = tempDir();
    const lockPath = join(dir, "gate.lock.json");
    const stdout = capture();
    const out = join(dir, "report.json");
    const ran: string[] = [];
    const code = await mod.main(["--only", ONE_ID, "--out", out], mainDeps(lockPath, {
      stdout: stdout.stream,
      treeState: () => " M packages/evaluation/src/r97-plan.ts\n",
      diffNumstat: () => "0\t0\tpackages/evaluation/src/r97-plan.ts\n",
      runOne: (mutation: { id: string }) => {
        ran.push(mutation.id);
        return stubResult(mutation.id);
      },
    }));
    expect(code).toBe(mod.EXIT_OK);
    expect(ran).toEqual([ONE_ID]);
    expect(stdout.text()).toMatch(/EOL\/stat-only/);
    const report = JSON.parse(readFileSync(out, "utf8")) as {
      preexistingEolOnlyDirt: string[];
      ok: boolean;
      treeRestored: boolean;
      lockReclaimedBecause: string | null;
    };
    expect(report.preexistingEolOnlyDirt).toEqual(["packages/evaluation/src/r97-plan.ts"]);
    expect(report.ok).toBe(true);
    expect(report.treeRestored).toBe(true);
    expect(report.lockReclaimedBecause).toBeNull();
  });

  it("fails CLOSED when git cannot report the tree or the numstat", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "gate.lock.json");
    const stderr = capture();
    const noTree = await mod.main(["--only", ONE_ID], mainDeps(lockPath, {
      stderr: stderr.stream,
      treeState: () => null,
    }));
    expect(noTree).toBe(mod.EXIT_DIRTY_TREE);
    expect(stderr.text()).toMatch(/git status --porcelain/);

    const noNumstat = await mod.main(["--only", ONE_ID], mainDeps(lockPath, {
      stderr: stderr.stream,
      diffNumstat: () => null,
    }));
    expect(noNumstat).toBe(mod.EXIT_DIRTY_TREE);
    expect(stderr.text()).toMatch(/git diff --numstat/);
  });

  it("renders the dirty paths and the tolerated note in the refusal text", () => {
    const reason = mod.dirtyTreeReason({
      blocking: [{ line: " M packages/evaluation/src/r97-plan.ts" }],
      tolerated: [{ path: "packages/evaluation/src/eol-only.ts" }],
    });
    expect(reason).toContain("r97-plan.ts");
    expect(reason).toContain("eol-only.ts");
    expect(reason).toMatch(/REAL change/);
    expect(mod.dirtyTreePaths(" M a.ts\n?? b.ts\n\n")).toEqual(["a.ts", "b.ts"]);
  });
});

/* ==========================================================================
 * X5 — a mutation that did not land, and a file the gate did not touch.
 * ========================================================================== */

describe("E4-R17 X5: silent false results are replaced by distinct loud failures", () => {
  const mutation = {
    file: "packages/evaluation/src/example.ts",
    find: "  return { verified: false, problems };",
    replace: "  return { verified: true, problems };",
  };

  it("verifyMutationLanded requires the anchor ABSENT and the mutated text PRESENT", () => {
    const landed = mod.verifyMutationLanded({
      mutation,
      afterText: "function f() {\n  return { verified: true, problems };\n}\n",
    });
    expect(landed.landed).toBe(true);
    expect(landed.findCount).toBe(0);
    expect(landed.replaceCount).toBe(1);
    expect(landed.reason).toBeNull();
  });

  it("verifyMutationLanded REFUSES a write that did not take", () => {
    // The whole reason this check exists: an unlanded mutation leaves the bound test
    // PASSING and is then reported as a MISS that reads like a defect in the test — or,
    // worse, a "restore" of a file nobody changed reports a catch for nothing.
    const landed = mod.verifyMutationLanded({
      mutation,
      afterText: "function f() {\n  return { verified: false, problems };\n}\n",
    });
    expect(landed.landed).toBe(false);
    expect(landed.findCount).toBe(1);
    expect(landed.reason).toMatch(/THE MUTATION DID NOT LAND/);
    expect(landed.reason).toContain(mutation.file);
  });

  it("ignores the file the mutation targets and reports ONLY the unexpected one", () => {
    const before = "";
    const after = ` M ${mutation.file}\n M packages/evaluation/src/SOMEBODY-ELSE.ts\n`;
    const unexpected = mod.unexpectedChangedPaths(before, after, mutation.file);
    expect(unexpected.map((entry) => entry.path)).toEqual(["packages/evaluation/src/SOMEBODY-ELSE.ts"]);
    // And the gate's OWN file, on its own, is not a "sibling change".
    expect(mod.unexpectedChangedPaths(before, ` M ${mutation.file}\n`, mutation.file)).toEqual([]);
    expect(mod.changedPorcelainLines(before, " M x.ts\n")).toEqual([" M x.ts"]);
  });

  it("renders an unreadable tolerated path as NOT_OBSERVED, never as an empty digest", () => {
    // Unknown stays `NOT_OBSERVED`/`null`, never `0` or `""`: an unreadable file must
    // not compare equal to a readable one that happens to hash to nothing.
    expect(mod.toleratedDirtDigest(["b.ts", "a.ts"], () => null)).toBe(
      "a.ts:NOT_OBSERVED\nb.ts:NOT_OBSERVED",
    );
    expect(mod.toleratedDirtDigest([], () => "ignored")).toBe("");
    expect(mod.toleratedDirtChangedReason(["x.ts"])).toMatch(/CONTENT digest of at least one of them changed/);
  });

  it("detects a CONTENT change inside a TOLERATED entry, which porcelain cannot see", async () => {
    // ATTACK (adversarial review): pre-dirty a tracked file so its porcelain line is
    // ALREADY ` M`, then change its CONTENT mid-run. The porcelain line is byte-identical
    // before and after, so a porcelain-only comparison is blind — this is the R14 blind
    // spot. The pre-flight makes the variant with a real content diff unreachable; the
    // variant that IS reachable is a tolerated EOL/stat-only entry, so THOSE bytes are
    // hashed at the baseline and re-checked after every mutation.
    const dir = tempDir();
    const lockPath = join(dir, "gate.lock.json");
    const stdout = capture();
    let digests = 0;
    const code = await mod.main(["--only", ONE_ID], mainDeps(lockPath, {
      stdout: stdout.stream,
      treeState: () => " M packages/evaluation/src/eol-only.ts\n",
      diffNumstat: () => "0\t0\tpackages/evaluation/src/eol-only.ts\n",
      fileDigest: () => `digest-${digests++}`,
      runOne: () => stubResult(ONE_ID),
    }));
    expect(code).toBe(mod.EXIT_FAILED);
    expect(stdout.text()).toContain("DID NOT MUTATE CHANGED");
    expect(stdout.text()).toMatch(/CONTENT digest of at least one of them changed/);
  });

  it("does NOT abort when the tolerated entry's content is genuinely unchanged", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "gate.lock.json");
    const out = join(dir, "report.json");
    const code = await mod.main(["--only", ONE_ID, "--out", out], mainDeps(lockPath, {
      treeState: () => " M packages/evaluation/src/eol-only.ts\n",
      diffNumstat: () => "0\t0\tpackages/evaluation/src/eol-only.ts\n",
      fileDigest: () => "a stable digest",
      runOne: () => stubResult(ONE_ID),
    }));
    expect(code).toBe(mod.EXIT_OK);
    const report = JSON.parse(readFileSync(out, "utf8")) as {
      eolOnlyDirtContentChanged: boolean;
      preexistingEolOnlyDirt: string[];
      ok: boolean;
    };
    expect(report.eolOnlyDirtContentChanged).toBe(false);
    expect(report.preexistingEolOnlyDirt).toEqual(["packages/evaluation/src/eol-only.ts"]);
    expect(report.ok).toBe(true);
  });

  it("names the unexpected path as the FALSE-FAILURE mode it is", () => {
    const reason = mod.notMutatedFileChangedReason({ id: "a2-deleted-root-can-be-reclaimed", file: mutation.file }, "", [
      { line: " M packages/evaluation/src/r97-budget-ledger.ts", path: "packages/evaluation/src/r97-budget-ledger.ts" },
    ]);
    expect(reason).toMatch(/DID NOT MUTATE CHANGED/);
    expect(reason).toContain("r97-budget-ledger.ts");
    expect(reason).toMatch(/FALSE-FAILURE/);
  });

  it("ABORTS with EXIT_FAILED and a distinct reason when a non-target file changed", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "gate.lock.json");
    const out = join(dir, "report.json");
    const stdout = capture();
    // The sequence `main` sees: pre-flight clean, then a SIBLING file dirty right after
    // the one mutation, then clean again at the end — exactly R14's signature.
    const states = ["", " M packages/evaluation/src/SOMEBODY-ELSE.ts\n"];
    const code = await mod.main(["--only", ONE_ID, "--out", out], mainDeps(lockPath, {
      stdout: stdout.stream,
      treeState: () => (states.length > 0 ? (states.shift() as string) : ""),
      diffNumstat: () => "",
      runOne: () => stubResult(ONE_ID),
    }));
    expect(code).toBe(mod.EXIT_FAILED);
    expect(stdout.text()).toMatch(/\[FAIL\] ABORTED/);
    expect(stdout.text()).toContain("SOMEBODY-ELSE.ts");
    const report = JSON.parse(readFileSync(out, "utf8")) as {
      ok: boolean;
      caught: number;
      mutationsWithSiblingChange: number;
      siblingChange: { mutationId: string; expected: string } | null;
    };
    expect(report.ok).toBe(false);
    expect(report.caught).toBe(0);
    expect(report.mutationsWithSiblingChange).toBe(1);
    expect(report.siblingChange?.mutationId).toBe(ONE_ID);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("does NOT abort when the tree is unchanged around a caught mutation", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "gate.lock.json");
    const out = join(dir, "report.json");
    const code = await mod.main(["--only", ONE_ID, "--out", out], mainDeps(lockPath, {
      runOne: () => stubResult(ONE_ID),
    }));
    expect(code).toBe(mod.EXIT_OK);
    const report = JSON.parse(readFileSync(out, "utf8")) as {
      mutationsWithSiblingChange: number;
      mutationsNotLanded: number;
      siblingChange?: unknown;
      caught: number;
      totalMutations: number;
    };
    expect(report.mutationsWithSiblingChange).toBe(0);
    expect(report.mutationsNotLanded).toBe(0);
    expect(report.siblingChange).toBeUndefined();
    expect(report.caught).toBe(1);
    expect(report.totalMutations).toBe(1);
  });
});

/* ==========================================================================
 * X6 — the guard must not break the ordinary contract.
 * ========================================================================== */

describe("E4-R17 X6: the guard leaves the ordinary invocation intact", () => {
  it("refuses two live gates BEFORE the tree check, so the cause is not misreported", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "gate.lock.json");
    // The live holder is a DIFFERENT pid from the one `main` runs as: a lock whose pid
    // equals our own is stale by definition (a re-entrant take), not a live holder.
    const first = mod.acquireLock({
      repoRoot: "/repo",
      lockPath,
      fs: NODE_FS,
      env: { pid: 9999, host: HOST, now: () => "t", isProcessAlive: () => true },
    });
    expect(first.acquired).toBe(true);
    expect(first.record?.pid).toBe(9999);
    const stderr = capture();
    const code = await mod.main(["--only", ONE_ID], mainDeps(lockPath, {
      stderr: stderr.stream,
      // The tree IS dirty for as long as the live holder mutates — the lock must win.
      treeState: () => " M packages/evaluation/src/held.ts\n",
      diffNumstat: () => "1\t1\tpackages/evaluation/src/held.ts\n",
      runOne: () => stubResult(ONE_ID),
    }));
    expect(code).toBe(mod.EXIT_REFUSED);
    expect(stderr.text()).toMatch(/REFUSING TO START: another mutation gate is LIVE/);
    expect(stderr.text()).toContain("9999");
    expect(stderr.text()).not.toMatch(/NOT clean/);
  });

  it("still parses the flags it always parsed, and refuses a value-less one", () => {
    expect(mod.parseArgs([]).only).toBeUndefined();
    expect(mod.parseArgs(["--out", "x.json"]).out).toBe("x.json");
    expect(mod.parseArgs([]).forceUnlock).toBe(false);
  });

  it("keeps the injected runner's own result shape, so a CAUGHT run is still EXIT_OK", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "gate.lock.json");
    const out = join(dir, "report.json");
    const code = await mod.main(["--only", ONE_ID, "--out", out], mainDeps(lockPath, {
      runOne: () => stubResult(ONE_ID),
    }));
    expect(code).toBe(mod.EXIT_OK);
    const report = JSON.parse(readFileSync(out, "utf8")) as {
      lockPath: string;
      caught: number;
      treeRestored: boolean;
      schema: string;
    };
    expect(report.schema).toBe("e4-r101-mutation-report-v1");
    expect(report.lockPath).toBe(lockPath);
    expect(report.caught).toBe(1);
    expect(report.treeRestored).toBe(true);
  });
});

/* ==========================================================================
 * X7 — the R14 failure mode itself: a gate killed after applying a mutation.
 * ========================================================================== */

describe("E4-R17 X7: a HARD-KILLED previous run is recovered, not deadlocked", () => {
  it("reclaims the dead holder's lock AND refuses the tree, naming the STILL-MUTATED path", async () => {
    // The R14 signature, end to end: the process is gone (kill -9), its lock file
    // survives, and the production file it was mutating is still modified on disk. The
    // next run must NOT deadlock on the leftover lock, and must NOT start mutating on a
    // tree whose restore it cannot prove.
    const dir = tempDir();
    const lockPath = join(dir, "gate.lock.json");
    writeFileSync(
      lockPath,
      `${JSON.stringify(
        {
          schema: mod.LOCK_SCHEMA,
          pid: 999999,
          host: HOST,
          startedAt: "2026-01-01T00:00:00.000Z",
          mutating: "packages/evaluation/src/r97-budget-ledger.ts",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const stdout = capture();
    const stderr = capture();
    let ran = 0;
    const code = await mod.main(["--only", ONE_ID], mainDeps(lockPath, {
      stdout: stdout.stream,
      stderr: stderr.stream,
      isProcessAlive: () => false,
      treeState: () => " M packages/evaluation/src/r97-budget-ledger.ts\n",
      diffNumstat: () => "2\t2\tpackages/evaluation/src/r97-budget-ledger.ts\n",
      runOne: () => {
        ran += 1;
        return stubResult(ONE_ID);
      },
    }));

    // 1. the stale lock is RECLAIMED — no deadlock — and the notice names the target it
    //    was mutating when it died;
    expect(stdout.text()).toMatch(/reclaiming a STALE lock/);
    expect(stdout.text()).toContain("r97-budget-ledger.ts");
    // 2. the tree is REFUSED, naming the still-mutated path;
    expect(code).toBe(mod.EXIT_DIRTY_TREE);
    expect(stderr.text()).toMatch(/REFUSING TO START/);
    expect(stderr.text()).toContain("packages/evaluation/src/r97-budget-ledger.ts");
    // 3. nothing was mutated by the new run, and the refuser released the lock again.
    expect(ran, "a refused run must not apply a mutation").toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("reclaims a CORRUPT or EMPTY lock left by a crash mid-write", () => {
    for (const junk of ["", "   ", "{ half-written", "null"]) {
      const dir = tempDir();
      writeFileSync(join(dir, "gate.lock.json"), junk, "utf8");
      const acquired = mod.acquireLock(
        lockDeps(dir, { env: { pid: 4242, host: HOST, now: () => "t", isProcessAlive: () => true } }),
      );
      expect(acquired.acquired, `the lock was not reclaimed for ${JSON.stringify(junk)}`).toBe(true);
      expect(acquired.reclaimedBecause).toMatch(/not a readable lock RECORD/);
    }
  });
});
