/**
 * E4-R97 — the campaign-wide budget ledger.
 *
 * Plan §R97 怎么验收 (line 227) states the acceptance fixture exactly:
 *
 *   "用两臂合计上限 3 次的 fixture：一臂用 2 次，第二臂最多 1 次；重启不能刷新额度。
 *    未知请求计入保留额度。"
 *
 * So: a campaign-wide grant of 3 calls. Arm A consumes 2. Arm B may use at most
 * 1. A restart must NOT refresh the allowance. Unknown requests count against
 * the reservation.
 *
 * Every test here drives the REAL ledger against a REAL temp directory and REAL
 * child processes where cross-process behaviour is the claim. No provider is
 * constructed and no network call is made anywhere in this file.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  openR97BudgetLedger,
  parseR97Ledger,
  readR97BudgetView,
  readR97LedgerFile,
  viewOfR97Ledger,
  R97_LEDGER_FILENAME,
  R97_LEDGER_LOCK_FILENAME,
  R97_LEDGER_SCHEMA,
  type R97LedgerFile,
} from "./r97-budget-ledger.js";

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "r97-ledger-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
});

const PLAN = "a".repeat(64);
const OTHER_PLAN = "b".repeat(64);

function ledger(entries: Partial<R97LedgerFile["entries"][number]>[], grant = 3): R97LedgerFile {
  return {
    schemaVersion: R97_LEDGER_SCHEMA,
    planDigest: PLAN,
    campaignModelCalls: grant,
    entries: entries.map((e, i) => ({
      reservationId: e.reservationId ?? `r${i}`,
      arm: e.arm ?? "baseline",
      pid: e.pid ?? process.pid,
      reservedAt: e.reservedAt ?? 0,
      reserved: e.reserved ?? 1,
      status: e.status ?? "reserved",
      consumed: e.consumed ?? null,
      transportRetries: e.transportRetries ?? 0,
    })),
  };
}

describe("E4-R97 G1: the ledger accounts for every call exactly once", () => {
  it("the §R97 acceptance fixture: grant 3, arm A uses 2, arm B gets at most 1", async () => {
    const dir = await tempDir();
    const l = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3 });

    expect((await l.view()).remaining).toBe(3);

    // Arm A reserves and consumes 2.
    const a = await l.reserve("baseline", 2);
    expect(a.ok).toBe(true);
    await l.commit(a.reservationId!, 2);
    expect((await l.view()).remaining).toBe(1);

    // Arm B may take the single remaining call...
    const b = await l.reserve("candidate", 1);
    expect(b.ok).toBe(true);
    expect(b.view.remaining).toBe(0);
    await l.commit(b.reservationId!, 1);

    // ...and then nothing is left. A THIRD arm is refused, not granted.
    const c = await l.reserve("candidate", 1);
    expect(c.ok).toBe(false);
    expect(c.reason).toContain("BUDGET_EXHAUSTED");
    expect(c.view.remaining).toBe(0);
  });

  it("a reservation larger than the grant is refused atomically, leaving nothing consumed", async () => {
    const dir = await tempDir();
    const l = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3 });
    const r = await l.reserve("baseline", 4);
    expect(r.ok).toBe(false);
    expect(r.view.remaining).toBe(3); // the refusal reserved nothing
    expect((await l.read()).entries).toEqual([]);
  });

  it("reserving the exact remainder succeeds; one more fails", async () => {
    const dir = await tempDir();
    const l = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3 });
    expect((await l.reserve("baseline", 3)).ok).toBe(true);
    expect((await l.reserve("candidate", 1)).ok).toBe(false);
  });

  it("counts LOGICAL calls and PHYSICAL retries separately", async () => {
    const dir = await tempDir();
    const l = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3 });
    const a = await l.reserve("baseline", 2);
    // 2 logical calls that between them needed 5 physical transport attempts.
    const v = await l.commit(a.reservationId!, 2, 5);
    expect(v.committed).toBe(2);
    expect(v.transportRetries).toBe(5);
    // The retries did NOT consume the logical budget.
    expect(v.remaining).toBe(1);
  });

  it("committing fewer calls than reserved returns the difference", async () => {
    const dir = await tempDir();
    const l = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3 });
    const a = await l.reserve("baseline", 3);
    const v = await l.commit(a.reservationId!, 1);
    expect(v.committed).toBe(1);
    expect(v.remaining).toBe(2);
  });

  it("refuses a commit that consumed MORE than it reserved", async () => {
    const dir = await tempDir();
    const l = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 10 });
    const a = await l.reserve("baseline", 1);
    // The budget must be reserved BEFORE the call, so an overrun is a caller
    // defect — it must be loud, never silently absorbed.
    await expect(l.commit(a.reservationId!, 2)).rejects.toThrow(/reserved 1 call\(s\) but reports 2/);
  });

  it("refuses to commit or abandon a reservation twice", async () => {
    const dir = await tempDir();
    const l = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3 });
    const a = await l.reserve("baseline", 1);
    await l.commit(a.reservationId!, 1);
    await expect(l.commit(a.reservationId!, 1)).rejects.toThrow(/already committed/);
    await expect(l.abandon(a.reservationId!)).rejects.toThrow(/already committed/);
  });

  it("refuses a non-positive or non-integer reservation", async () => {
    const dir = await tempDir();
    const l = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3 });
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      const r = await l.reserve("baseline", bad);
      expect(r.ok, `count ${String(bad)} must be refused`).toBe(false);
    }
  });
});

describe("E4-R97 G2: the allowance survives a restart and is never re-granted", () => {
  it("a SECOND ledger handle on the same directory sees the consumed calls", async () => {
    const dir = await tempDir();
    const first = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3 });
    const a = await first.reserve("baseline", 2);
    await first.commit(a.reservationId!, 2);

    // A brand-new process would open exactly like this. It must NOT get 3 again.
    const second = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3 });
    expect((await second.view()).remaining).toBe(1);
    expect((await second.reserve("candidate", 1)).ok).toBe(true);
    expect((await second.reserve("candidate", 1)).ok).toBe(false);
  });

  it("the remaining budget is visible WITHOUT opening a ledger (a fresh reader)", async () => {
    const dir = await tempDir();
    const l = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3 });
    const a = await l.reserve("baseline", 2);
    await l.commit(a.reservationId!, 2);
    const view = await readR97BudgetView(dir);
    expect(view?.remaining).toBe(1);
    expect(view?.granted).toBe(3);
  });

  it("an OUTSTANDING reservation from a dead process counts against the budget", async () => {
    const dir = await tempDir();
    // Simulate a process that reserved 2 and crashed before committing.
    await writeFile(
      join(dir, R97_LEDGER_FILENAME),
      JSON.stringify(ledger([{ reserved: 2, status: "reserved", pid: 999_999 }]), null, 2),
      "utf8",
    );
    const view = await readR97BudgetView(dir);
    // 2 of 3 are held by an attempt that may have been billed.
    expect(view?.outstanding).toBe(2);
    expect(view?.remaining).toBe(1);
  });

  it("a process must not re-grant itself a DIFFERENT allowance for the same plan", async () => {
    const dir = await tempDir();
    await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3 });
    // Re-opening with a bigger grant is the "每个子进程重新给 320 次" defect.
    await expect(openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 320 })).rejects.toThrow(
      /never re-grant itself a different allowance/,
    );
  });

  it("a ledger bound to another plan is refused, never silently adopted", async () => {
    const dir = await tempDir();
    await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3 });
    await expect(openR97BudgetLedger(dir, { planDigest: OTHER_PLAN, campaignModelCalls: 3 })).rejects.toThrow(
      /belongs to a different plan/,
    );
  });
});

describe("E4-R97 G3: recovery preserves consumption and never silently refunds", () => {
  it("reclassifies a DEAD owner's outstanding reservation as unknown, WITHOUT returning it", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, R97_LEDGER_FILENAME),
      JSON.stringify(ledger([{ reserved: 2, status: "reserved", pid: 4242 }]), null, 2),
      "utf8",
    );
    const l = await openR97BudgetLedger(dir, {
      planDigest: PLAN,
      campaignModelCalls: 3,
      isAlive: (pid) => pid !== 4242, // 4242 is gone
    });
    const { unknown, view } = await l.recover();
    expect(unknown).toBe(1);
    // The allowance is NOT returned: a dispatched attempt may have been billed.
    expect(view.unknown).toBe(2);
    expect(view.outstanding).toBe(0);
    expect(view.remaining).toBe(1);
  });

  it("leaves a LIVE owner's reservation outstanding", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, R97_LEDGER_FILENAME),
      JSON.stringify(ledger([{ reserved: 1, status: "reserved", pid: 777 }]), null, 2),
      "utf8",
    );
    const l = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3, isAlive: () => true });
    const { unknown, view } = await l.recover();
    expect(unknown).toBe(0);
    expect(view.outstanding).toBe(1);
    expect(view.remaining).toBe(2);
  });

  it("only a provably-undispatched attempt may return its allowance", async () => {
    const dir = await tempDir();
    const l = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3 });
    const a = await l.reserve("baseline", 3);
    expect((await l.view()).remaining).toBe(0);
    // The attempt provably never dispatched, so this is the ONE legal refund.
    const v = await l.abandon(a.reservationId!);
    expect(v.remaining).toBe(3);
    expect(v.committed).toBe(0);
    expect(v.unknown).toBe(0);
  });

  it("an abandoned reservation is terminal and cannot be committed afterwards", async () => {
    const dir = await tempDir();
    const l = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3 });
    const a = await l.reserve("baseline", 1);
    await l.abandon(a.reservationId!);
    await expect(l.commit(a.reservationId!, 1)).rejects.toThrow(/already abandoned/);
  });
});

describe("E4-R97 G4: a damaged ledger fails closed", () => {
  it("refuses to treat unparseable JSON as an empty (full) budget", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, R97_LEDGER_FILENAME), "{not json", "utf8");
    await expect(readR97LedgerFile(dir)).rejects.toThrow(/not valid JSON/);
    await expect(openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3 })).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("rejects a structurally invalid ledger rather than defaulting the grant", async () => {
    const dir = await tempDir();
    for (const bad of [
      { schemaVersion: "wrong", planDigest: PLAN, campaignModelCalls: 3, entries: [] },
      { schemaVersion: R97_LEDGER_SCHEMA, planDigest: "", campaignModelCalls: 3, entries: [] },
      { schemaVersion: R97_LEDGER_SCHEMA, planDigest: PLAN, campaignModelCalls: -1, entries: [] },
      { schemaVersion: R97_LEDGER_SCHEMA, planDigest: PLAN, campaignModelCalls: 3, entries: [{ reservationId: "x", reserved: 1, status: "nonsense" }] },
    ]) {
      await writeFile(join(dir, R97_LEDGER_FILENAME), JSON.stringify(bad), "utf8");
      await expect(readR97LedgerFile(dir)).rejects.toThrow(/damaged budget ledger/);
    }
  });

  it("parseR97Ledger names the defect and never throws on hostile input", () => {
    for (const hostile of [null, [], 42, "str", {}, { schemaVersion: R97_LEDGER_SCHEMA }]) {
      const { ledger: l, issue } = parseR97Ledger(hostile);
      expect(l).toBeNull();
      expect(typeof issue).toBe("string");
    }
  });

  it("the ledger file carries NO key, endpoint or absolute host path", async () => {
    const dir = await tempDir();
    const l = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3 });
    const a = await l.reserve("baseline", 1);
    await l.commit(a.reservationId!, 1, 2);
    const text = await readFile(join(dir, R97_LEDGER_FILENAME), "utf8");
    expect(text).not.toMatch(/sk-|Bearer|api[_-]?key|https?:\/\//i);
    expect(text).not.toContain(dir);
  });
});

describe("E4-R97 G5: the budget holds ACROSS PROCESSES, not just in memory", () => {
  const LEDGER_MODULE = pathToFileURL(join(process.cwd(), "packages", "evaluation", "dist", "r97-budget-ledger.js")).href;

  /**
   * Run a REAL child process that opens the ledger, reserves `n`, and prints the
   * outcome as JSON. This is the only way to prove the claim plan §R97 line 216
   * makes: two arm subprocesses sharing one ledger.
   */
  async function childReserve(dir: string, grant: number, arm: string, n: number): Promise<{ ok: boolean; reason: string; remaining: number; pid: number }> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const script = `
      const m = await import(${JSON.stringify(LEDGER_MODULE)});
      const l = await m.openR97BudgetLedger(${JSON.stringify(dir)}, { planDigest: ${JSON.stringify(PLAN)}, campaignModelCalls: ${grant} });
      const r = await l.reserve(${JSON.stringify(arm)}, ${n});
      process.stdout.write(JSON.stringify({ ok: r.ok, reason: r.reason, remaining: r.view.remaining, pid: process.pid }));
    `;
    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], { timeout: 30_000 });
    return JSON.parse(stdout) as { ok: boolean; reason: string; remaining: number; pid: number };
  }

  it("a second PROCESS sees the first process's consumption (the real two-arm case)", async () => {
    const dir = await tempDir();
    // Arm A (process 1) takes 2 of the 3.
    const a = await childReserve(dir, 3, "baseline", 2);
    expect(a.ok).toBe(true);
    expect(a.remaining).toBe(1);

    // Arm B is a DIFFERENT process. It must see only 1 left, not 3.
    const b = await childReserve(dir, 3, "candidate", 1);
    expect(b.ok).toBe(true);
    expect(b.remaining).toBe(0);
    expect(b.pid).not.toBe(a.pid);

    // A third process is refused: the grant was 3 for the WHOLE campaign.
    const c = await childReserve(dir, 3, "candidate", 1);
    expect(c.ok).toBe(false);
    expect(c.reason).toContain("BUDGET_EXHAUSTED");
  });

  it("two processes racing for the last call do not both win", async () => {
    const dir = await tempDir();
    // Grant exactly 1 for the whole campaign. Two concurrent child processes
    // both ask for it; the exclusive lock must serialise them so exactly one
    // reservation is created and the other is refused.
    const [x, y] = await Promise.all([childReserve(dir, 1, "baseline", 1), childReserve(dir, 1, "candidate", 1)]);
    const winners = [x, y].filter((r) => r.ok);
    const losers = [x, y].filter((r) => !r.ok);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(losers[0]!.reason).toContain("BUDGET_EXHAUSTED");
    // And the ledger really holds exactly one reservation.
    expect((await readR97BudgetView(dir))?.outstanding).toBe(1);
  });

  it("REGRESSION: the first-open grant write happens UNDER the lock, not before it", async () => {
    // The bootstrap write used to happen OUTSIDE the lock: a process read
    // "no ledger", wrote an empty one, and only THEN took the lock. Two
    // processes could interleave so the later one's empty write erased the
    // earlier one's reservation — a genuine lost update that let BOTH racers
    // spend the last call.
    //
    // A probabilistic race cannot prove a fix, so this test makes the defect
    // DETERMINISTIC by holding the lock and observing whether the child writes
    // the ledger while it waits:
    //
    //   correct  -> the child BLOCKS, and no ledger exists while the lock is held
    //   defective-> the child writes the ledger IMMEDIATELY, before the lock
    const dir = await tempDir();
    const lockPath = join(dir, R97_LEDGER_LOCK_FILENAME);
    // A fresh lock owned by a live PID: the child must respect it, not reclaim it.
    await writeFile(lockPath, String(process.pid), "utf8");

    const child = childReserve(dir, 3, "baseline", 1);
    // Give the child ample time to reach the lock and (if defective) write.
    await new Promise((r) => setTimeout(r, 750));

    // The discriminator: while the lock is held, the ledger must NOT exist.
    expect(
      await readR97BudgetView(dir),
      "the bootstrap must not write the ledger before acquiring the lock",
    ).toBeNull();

    // Release the lock; the child must now complete normally.
    await rm(lockPath, { force: true });
    const result = await child;
    expect(result.ok).toBe(true);
    expect(result.remaining).toBe(2);
    expect((await readR97BudgetView(dir))?.outstanding).toBe(1);
  });

  it("a process waiting on a held lock eventually fails loudly rather than hanging forever", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, R97_LEDGER_LOCK_FILENAME);
    await writeFile(lockPath, String(process.pid), "utf8");
    // A tiny lock timeout, so the wait is bounded and reported.
    await expect(
      openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3, lockTimeoutMs: 150 }),
    ).rejects.toThrow(/could not acquire the budget ledger lock within 150ms/);
    await rm(lockPath, { force: true });
  });
});
