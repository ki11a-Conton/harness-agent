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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  campaignIdOf,
  openR97BudgetLedger,
  parseR97Ledger,
  readR97BudgetView,
  readR97CampaignClaim,
  readR97LedgerFile,
  viewOfR97Ledger,
  R97_BUDGET_STATE_CORRUPT,
  R97_BUDGET_STATE_MISSING,
  R97_CAMPAIGN_CLAIMS_DIR_ENV,
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

/**
 * The per-authorization CLAIM anchor (plan §R98 line 121's cross-directory
 * guard) lives outside any single campaign directory. Point it at a scratch
 * directory so no test reads or writes machine-level state.
 *
 * ONE FRESH ANCHOR PER TEST (plan §A2 怎么做 6: "普通测试应使用独立的 claim
 * namespace/独立批准 ID"). Several tests here deliberately reuse the same
 * `PLAN` in a brand-new temporary directory, and the suite removes its
 * directories afterwards. Under finding F2 an anchor that records "this approval
 * ESTABLISHED a budget here" is no longer ignorable just because the directory
 * was cleaned up — which is the whole point of the fix — so sharing one anchor
 * across tests would make each later test look like a double-spend of an
 * approval an earlier test already spent. Isolating the namespace preserves the
 * tests' original intent exactly: each test measures its OWN approval.
 */
let CLAIMS_DIR = "";
beforeEach(async () => {
  CLAIMS_DIR = await mkdtemp(join(tmpdir(), "r97-claims-"));
  process.env[R97_CAMPAIGN_CLAIMS_DIR_ENV] = CLAIMS_DIR;
});
afterEach(async () => {
  delete process.env[R97_CAMPAIGN_CLAIMS_DIR_ENV];
  if (CLAIMS_DIR !== "") await rm(CLAIMS_DIR, { recursive: true, force: true }).catch(() => {});
  CLAIMS_DIR = "";
});

const PLAN = "a".repeat(64);
const OTHER_PLAN = "b".repeat(64);

function ledger(entries: Partial<R97LedgerFile["entries"][number]>[], grant = 3): R97LedgerFile {
  return {
    schemaVersion: R97_LEDGER_SCHEMA,
    planDigest: PLAN,
    campaignModelCalls: grant,
    campaignId: campaignIdOf(PLAN, grant),
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

describe("E4-R97 G6: hostile budget data can never INCREASE the allowance (R98 / F3)", () => {
  // Plan §R98 怎么做: "严格校验 consumed、reserved、transportRetries、pid、时间、状态
  // 组合和唯一 reservationId … committed 必須满足 0 <= consumed <= reserved … 任何
  // 计算结果违反 0 <= remaining <= granted 必须拒绝，不能靠 clamp 掩盖错误."
  //
  // MEASURED RED (plan §0.2): {"grant":3,"consumed":-100,"remaining":103} was
  // ACCEPTED by parseR97Ledger.

  const writeLedger = async (dir: string, body: unknown): Promise<void> => {
    await writeFile(join(dir, R97_LEDGER_FILENAME), `${JSON.stringify(body, null, 2)}\n`, "utf8");
  };

  it("REFUSES a negative consumed instead of inflating the remaining budget", async () => {
    const dir = await tempDir();
    await writeLedger(dir, {
      schemaVersion: R97_LEDGER_SCHEMA,
      planDigest: PLAN,
      campaignModelCalls: 3,
      entries: [
        { reservationId: "r0", arm: "baseline", pid: 1, reservedAt: 0, reserved: 1, status: "committed", consumed: -100, transportRetries: 0 },
      ],
    });
    await expect(readR97LedgerFile(dir)).rejects.toThrow(/consumed|negative|safe integer|0 <= consumed/i);
    // And no reader may report the inflated view either.
    await expect(readR97BudgetView(dir)).rejects.toThrow();
  });

  it("parseR97Ledger names the defect for every illegal counter", () => {
    const base = { schemaVersion: R97_LEDGER_SCHEMA, planDigest: PLAN, campaignModelCalls: 3 };
    const bad: Array<[string, unknown]> = [
      ["negative consumed", { ...base, entries: [{ reservationId: "r0", reserved: 1, status: "committed", consumed: -1 }] }],
      ["non-integer consumed", { ...base, entries: [{ reservationId: "r0", reserved: 1, status: "committed", consumed: 1.5 }] }],
      ["consumed above reserved", { ...base, entries: [{ reservationId: "r0", reserved: 1, status: "committed", consumed: 2 }] }],
      ["negative reserved", { ...base, entries: [{ reservationId: "r0", reserved: -1, status: "reserved" }] }],
      ["negative transportRetries", { ...base, entries: [{ reservationId: "r0", reserved: 1, status: "committed", consumed: 1, transportRetries: -5 }] }],
      ["non-integer transportRetries", { ...base, entries: [{ reservationId: "r0", reserved: 1, status: "committed", consumed: 1, transportRetries: 0.5 }] }],
      ["duplicate reservationId", { ...base, entries: [
        { reservationId: "dup", reserved: 1, status: "committed", consumed: 1 },
        { reservationId: "dup", reserved: 1, status: "committed", consumed: 1 },
      ] }],
      ["committed without consumed", { ...base, entries: [{ reservationId: "r0", reserved: 1, status: "committed", consumed: null }] }],
      ["abandoned with non-zero consumed", { ...base, entries: [{ reservationId: "r0", reserved: 1, status: "abandoned", consumed: 3 }] }],
      ["unknown with a consumed count", { ...base, entries: [{ reservationId: "r0", reserved: 1, status: "unknown", consumed: 1 }] }],
      ["grant above safe integer", { schemaVersion: R97_LEDGER_SCHEMA, planDigest: PLAN, campaignModelCalls: Number.MAX_SAFE_INTEGER + 2, entries: [] }],
    ];
    for (const [name, body] of bad) {
      const { ledger: parsed, issue } = parseR97Ledger(body);
      expect(parsed, `${name} must be REFUSED`).toBeNull();
      expect(issue, `${name} must name a defect`).toBeTruthy();
    }
  });

  it("viewOfR97Ledger never reports remaining outside [0, granted] and never clamps", () => {
    // A well-formed file cannot produce an out-of-range view; the invariant is
    // asserted on the pure projection for a range of legal entry mixes.
    const cases: R97LedgerFile[] = [
      ledger([]),
      ledger([{ status: "committed", consumed: 3, reserved: 3 }]),
      ledger([{ status: "unknown", reserved: 3 }]),
      ledger([{ status: "reserved", reserved: 3 }]),
      ledger([{ status: "abandoned", consumed: 0, reserved: 2 }]),
    ];
    for (const l of cases) {
      const v = viewOfR97Ledger(l);
      expect(v.remaining, JSON.stringify(l.entries)).toBeGreaterThanOrEqual(0);
      expect(v.remaining, JSON.stringify(l.entries)).toBeLessThanOrEqual(v.granted);
    }
  });

  it("a commit cannot record a negative or fractional consumed count", async () => {
    const dir = await tempDir();
    const l = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3 });
    const r = await l.reserve("baseline", 1);
    await expect(l.commit(r.reservationId!, -1)).rejects.toThrow();
    await expect(l.commit(r.reservationId!, 0.5)).rejects.toThrow();
    // The reservation is still open after the refused commits.
    expect((await l.view()).outstanding).toBe(1);
  });

  it("refuses a transportRetries count that is not a non-negative safe integer", async () => {
    const dir = await tempDir();
    const l = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3 });
    const r = await l.reserve("baseline", 1);
    await expect(l.commit(r.reservationId!, 1, -2)).rejects.toThrow();
    await expect(l.commit(r.reservationId!, 1, 1.25)).rejects.toThrow();
  });
});

describe("E4-R97 G7: an ESTABLISHED campaign with missing/foreign state fails closed (R98 / F4)", () => {
  // Plan §R98 怎么做: "`read() ?? emptyLedger()` 只能用于明确的首次创建。恢复时账本
  // 不存在、JSON损坏、被替换为别的计划，都报 BUDGET_STATE_MISSING/CORRUPT/MISMATCH，
  // 不能刷新额度."
  //
  // MEASURED RED: after the grant was fully consumed, deleting the ledger file
  // inside the diagnostic directory let the SAME open handle reserve again.

  it("REFUSES to refresh the allowance when the ledger disappears after open", async () => {
    const dir = await tempDir();
    const l = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3 });
    const r = await l.reserve("baseline", 3);
    expect(r.ok).toBe(true);
    await l.commit(r.reservationId!, 3);
    expect((await l.view()).remaining).toBe(0);

    // The deletion a faulty/attacker filesystem could perform.
    await rm(join(dir, R97_LEDGER_FILENAME), { force: true });

    await expect(l.reserve("candidate", 1)).rejects.toThrow(/BUDGET_STATE_MISSING|missing|disappear/i);
    await expect(l.view()).rejects.toThrow(/BUDGET_STATE_MISSING|missing|disappear/i);
  });

  it("REFUSES to reuse a ledger that was replaced by another plan's state", async () => {
    const dir = await tempDir();
    const l = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3 });
    // Another campaign's ledger lands in the same directory.
    await writeFile(
      join(dir, R97_LEDGER_FILENAME),
      `${JSON.stringify({ schemaVersion: R97_LEDGER_SCHEMA, planDigest: OTHER_PLAN, campaignModelCalls: 3, entries: [] }, null, 2)}\n`,
      "utf8",
    );
    await expect(l.reserve("baseline", 1)).rejects.toThrow(/BUDGET_STATE_MISMATCH|different plan/i);
  });

  it("REFUSES to treat a corrupted ledger as an empty (full) budget on a resume", async () => {
    const dir = await tempDir();
    const l = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3 });
    await writeFile(join(dir, R97_LEDGER_FILENAME), "{ this is not json", "utf8");
    await expect(l.reserve("baseline", 1)).rejects.toThrow(/CORRUPT|not valid JSON|damaged/i);
  });

  it("still bootstraps normally when NO ledger exists yet (true first creation)", async () => {
    const dir = await tempDir();
    const l = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3 });
    const r = await l.reserve("baseline", 1);
    expect(r.ok).toBe(true);
    expect((await l.view()).remaining).toBe(2);
  });
});

describe("E4-R97 G8: lock ownership is by live owner token, not by age (R98 / F4)", () => {
  // Plan §R98 怎么做: "锁采用 owner token + 进程存活判断；年龄只能作为检查线索。活
  // owner 超时返回占用错误，不能删锁。释放时只能删除自己仍持有的 token."
  //
  // MEASURED RED: a lock older than 60s whose owner was ALIVE was taken over.

  it("REFUSES to steal a lock whose owner is still alive, however old it is", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, R97_LEDGER_LOCK_FILENAME);
    // A lock owned by THIS live process, with an mtime far beyond the stale age.
    await writeFile(lockPath, JSON.stringify({ token: "other-owner-token", pid: process.pid }), "utf8");
    const ancient = new Date(Date.now() - 10 * 60_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(lockPath, ancient, ancient);

    await expect(
      openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3, lockTimeoutMs: 200 }),
    ).rejects.toThrow(/lock/i);

    // And the live owner's lock is STILL THERE — never deleted by the loser.
    expect(await readFile(lockPath, "utf8")).toContain("other-owner-token");
    await rm(lockPath, { force: true });
  });

  it("takes over a lock whose owner is truly dead, even when it is young", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, R97_LEDGER_LOCK_FILENAME);
    // A REAL child process that has already exited: its pid is a dead owner.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const { stdout } = await run(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
    const deadPid = Number(stdout.trim());
    expect(Number.isSafeInteger(deadPid)).toBe(true);
    await writeFile(lockPath, JSON.stringify({ token: "dead-owner-token", pid: deadPid }), "utf8");

    const l = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3, lockTimeoutMs: 2_000 });
    const r = await l.reserve("baseline", 1);
    expect(r.ok).toBe(true);
  });

  it("a taker's release never deletes a lock another owner has since acquired", async () => {
    const dir = await tempDir();
    const l = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3 });
    // While the handle is open and idle, another owner's lock appears.
    const lockPath = join(dir, R97_LEDGER_LOCK_FILENAME);
    await l.reserve("baseline", 1);
    await writeFile(lockPath, JSON.stringify({ token: "third-party-token", pid: process.pid }), "utf8");
    // A refused acquisition must leave that foreign lock in place.
    await expect(
      openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 3, lockTimeoutMs: 150 }),
    ).rejects.toThrow(/lock/i);
    expect(await readFile(lockPath, "utf8")).toContain("third-party-token");
    await rm(lockPath, { force: true });
  });
});

describe("E4-R97 G9: one authorization cannot be spent twice through a different directory", () => {
  // Plan §R98 怎么做 (line 121): "campaign 初始化与 resume 用明确模式或持久 header
  // 区分；命令行换 ledgerDir/outDir 不得静默启动同一授权的另一个空预算."
  //
  // MEASURED DEFECT this closes: the ledger used to be identified ONLY by
  // (directory, planDigest, campaignModelCalls). Pointing `--ledger`/`--out` at
  // a different directory therefore started a brand-new EMPTY budget for the
  // SAME approved plan, so one authorization could be spent twice — in two
  // directories, with nothing anywhere recording that fact.
  //
  // The fix is a PERSISTED campaign identity (`campaignId`, derived from the
  // authorization) plus an explicit open MODE. These tests drive the real
  // module against real temp directories; the tamper tests use raw `writeFile`
  // and never touch a committed fixture.

  const writeLedgerBody = async (dir: string, body: unknown): Promise<void> => {
    await writeFile(join(dir, R97_LEDGER_FILENAME), `${JSON.stringify(body, null, 2)}\n`, "utf8");
  };

  /**
   * A plan digest unique to ONE test.
   *
   * The claim anchor is keyed by `campaignId`, i.e. by the authorization — so
   * two tests that both use `PLAN` would share an anchor and the second would
   * see the first's claim. That is the FEATURE working, but it makes tests
   * order-dependent, so each test derives its own authorization. (Tests that
   * deliberately exercise the cross-directory conflict share ONE digest on
   * purpose.)
   */
  let digestCounter = 0;
  const freshPlan = (): string => (++digestCounter).toString(16).padStart(64, "c");

  it("campaignIdOf is deterministic and binds BOTH the plan digest and the grant", () => {
    // Deterministic: the same authorization derives the same identity every
    // time, in this process and any other.
    expect(campaignIdOf(PLAN, 3)).toBe(campaignIdOf(PLAN, 3));
    expect(campaignIdOf(PLAN, 3)).not.toBe("");

    // A different PLAN is a different authorization.
    expect(campaignIdOf(OTHER_PLAN, 3)).not.toBe(campaignIdOf(PLAN, 3));
    // A different GRANT is also a different authorization: 3 calls and 320 calls
    // are not the same approved spend, so they must not share an identity.
    expect(campaignIdOf(PLAN, 320)).not.toBe(campaignIdOf(PLAN, 3));
    // And a one-character plan difference must not collide.
    expect(campaignIdOf(`${"a".repeat(63)}b`, 3)).not.toBe(campaignIdOf(PLAN, 3));
  });

  it("REFUSES a first-run in directory B when the same authorization already owns directory A", async () => {
    // This is the "silly to start an empty budget elsewhere" case. Arm A spends
    // 2 of the 3 approved calls in A; pointing the CLI's `--ledger` at a fresh
    // directory B must NOT silently produce another full grant of 3.
    const a = await tempDir();
    const b = await tempDir();
    const plan = freshPlan();

    const first = await openR97BudgetLedger(a, { planDigest: plan, campaignModelCalls: 3, mode: "first-run" });
    const r = await first.reserve("baseline", 2);
    expect(r.ok).toBe(true);
    await first.commit(r.reservationId!, 2);

    // The refusal. The error NAMES the conflict and the other directory, so an
    // operator can see that this authorization is already in use elsewhere.
    await expect(
      openR97BudgetLedger(b, { planDigest: plan, campaignModelCalls: 3, mode: "first-run" }),
    ).rejects.toThrow(/BUDGET_CAMPAIGN_DIR_DUPLICATE/);
    await expect(
      openR97BudgetLedger(b, { planDigest: plan, campaignModelCalls: 3, mode: "first-run" }),
    ).rejects.toThrow(new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    // The refusal must be durable and non-destructive: B is left WITHOUT a
    // ledger (it did not bootstrap an empty budget), and A still holds its 1
    // remaining call.
    expect(await readR97LedgerFile(b)).toBeNull();
    expect((await readR97BudgetView(a))?.remaining).toBe(1);
  });

  it("RECORDS the competing directory durably, so the double-spend is DETECTABLE", async () => {
    // The honest limitation: a fresh directory B cannot SEE A's ledger — the
    // ledger is directory-local by construction, and no directory-local file can
    // observe a sibling. So the evidence lives in a durable per-authorization
    // CLAIM ANCHOR instead of being implied by a file's location.
    //
    // This is the LENIENT half of the design, and it is deliberate: a strict
    // machine-global veto would permanently wedge legitimate re-runs (a cleaned
    // CI workspace, a fresh machine, a deliberately relocated --out) and, being
    // bypassable by deleting one anchor file, would buy no real security — plan
    // §R98 line 121 scopes the guarantee to local recovery integrity. What is
    // NOT acceptable is silence, so under the default `auto` mode the conflict
    // is recorded AND surfaced on the handle rather than hidden.
    const a = await tempDir();
    const b = await tempDir();
    // One authorization, exercised across two directories on purpose.
    const plan = freshPlan();
    const id = campaignIdOf(plan, 3);

    await openR97BudgetLedger(a, { planDigest: plan, campaignModelCalls: 3, mode: "first-run" });
    expect((await readR97CampaignClaim(id))?.claimedDirs).toContain(a);

    // A default (auto) open in a DIFFERENT directory does not throw — that is
    // the documented lenient behaviour — but it cannot hide the conflict.
    const second = await openR97BudgetLedger(b, { planDigest: plan, campaignModelCalls: 3 });
    expect(second.duplicateCampaignDirs).toContain(a);
    expect(second.duplicateCampaignDirs).not.toContain(b);
    // Re-opening the FIRST directory now also reports the competing directory:
    // the conflict is a property of the AUTHORIZATION, not of whichever handle
    // happened to be created first, so neither handle may hide it. (Asserting
    // `[]` here would contradict the durable-anchor assertion below.)
    const firstHandle = await openR97BudgetLedger(a, { planDigest: plan, campaignModelCalls: 3 });
    expect(firstHandle.duplicateCampaignDirs).toContain(b);
    expect(firstHandle.duplicateCampaignDirs).not.toContain(a);

    // And the evidence is durable: the anchor names BOTH directories, so the
    // double-spend is inspectable after the fact even though B's own ledger
    // started empty.
    const claim = await readR97CampaignClaim(id);
    expect(claim?.claimedDirs).toContain(a);
    expect(claim?.claimedDirs).toContain(b);

    // A DIFFERENT authorization has its own, independent claim.
    const otherId = campaignIdOf(freshPlan(), 3);
    expect(otherId).not.toBe(id);
    expect(await readR97CampaignClaim(otherId)).toBeNull();
  });

  it("a first-run into its OWN already-claimed directory is NOT a conflict", async () => {
    // The guard must not break the ordinary re-run: re-opening the SAME
    // directory for the same authorization is the normal adopt/resume path.
    const a = await tempDir();
    const plan = freshPlan();
    await openR97BudgetLedger(a, { planDigest: plan, campaignModelCalls: 3, mode: "first-run" });
    const again = await openR97BudgetLedger(a, { planDigest: plan, campaignModelCalls: 3, mode: "first-run" });
    expect(again.duplicateCampaignDirs).toEqual([]);
    expect((await again.view()).remaining).toBe(3);
    // An adopted open reports that it RESUMED rather than created.
    expect(again.mode).toBe("resume");
  });

  it("REGRESSION: a first-run cannot hide behind a ledger an earlier auto open already created", async () => {
    // The cross-directory guard must not be a CREATE-only check. If it ran only
    // on the create path, an `auto` open in the new directory B would bootstrap
    // B's ledger first, and a subsequent explicit `first-run` in B would then
    // find a ledger, "adopt" it, and never consult the claim anchor at all —
    // silently starting a second full budget for an authorization already spent
    // in A. MEASURED before the fix: with A claimed, an auto open in B followed
    // by `first-run` in B did NOT throw.
    const a = await tempDir();
    const b = await tempDir();
    const plan = freshPlan();

    await openR97BudgetLedger(a, { planDigest: plan, campaignModelCalls: 3, mode: "first-run" });
    // The lenient default open in B is allowed to create B's own ledger...
    const autoB = await openR97BudgetLedger(b, { planDigest: plan, campaignModelCalls: 3 });
    expect(autoB.duplicateCampaignDirs).toContain(a);
    expect(await readR97LedgerFile(b)).not.toBeNull();

    // ...but the EXPLICIT first-run in B must STILL refuse, even though B now
    // has a perfectly valid ledger of its own to adopt.
    await expect(
      openR97BudgetLedger(b, { planDigest: plan, campaignModelCalls: 3, mode: "first-run" }),
    ).rejects.toThrow(/BUDGET_CAMPAIGN_DIR_DUPLICATE/);

    // A resume in B remains legal: that is the supported way to continue.
    const resumedB = await openR97BudgetLedger(b, { planDigest: plan, campaignModelCalls: 3, mode: "resume" });
    expect(resumedB.duplicateCampaignDirs).toContain(a);
  });

  it("REFUSES a resume against a directory with NO ledger, and creates nothing", async () => {
    const dir = await tempDir();
    const plan = freshPlan();
    // A resume may NOT create: it promises "recover the state that exists".
    await expect(
      openR97BudgetLedger(dir, { planDigest: plan, campaignModelCalls: 3, mode: "resume" }),
    ).rejects.toThrow(/BUDGET_STATE_MISSING/);

    // The discriminator for "must NOT create anything": no ledger file exists
    // afterwards. (A created-but-empty ledger would be the silent re-grant.)
    expect(await readR97LedgerFile(dir)).toBeNull();
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(dir);
    expect(names).not.toContain(R97_LEDGER_FILENAME);
  });

  it("resume ADOPTS an existing ledger that carries the matching campaign identity", async () => {
    const dir = await tempDir();
    const plan = freshPlan();
    const first = await openR97BudgetLedger(dir, { planDigest: plan, campaignModelCalls: 3, mode: "first-run" });
    const r = await first.reserve("baseline", 2);
    await first.commit(r.reservationId!, 2);

    // A genuine resume sees the spend and does NOT refresh the allowance.
    const resumed = await openR97BudgetLedger(dir, { planDigest: plan, campaignModelCalls: 3, mode: "resume" });
    expect((await resumed.view()).remaining).toBe(1);
    expect((await resumed.read()).campaignId).toBe(campaignIdOf(plan, 3));
    expect(resumed.mode).toBe("resume");
  });

  it("REFUSES a TAMPERED campaignId on both the resume open AND a later reserve()", async () => {
    const dir = await tempDir();
    const plan = freshPlan();
    // Establish a valid ledger first...
    const l = await openR97BudgetLedger(dir, { planDigest: plan, campaignModelCalls: 3, mode: "first-run" });
    await l.reserve("baseline", 1);

    // ...then rewrite ONLY the identity field, leaving every counter legal.
    const onDisk = JSON.parse(await readFile(join(dir, R97_LEDGER_FILENAME), "utf8")) as Record<string, unknown>;
    expect(onDisk["campaignId"]).toBe(campaignIdOf(plan, 3));
    onDisk["campaignId"] = campaignIdOf(freshPlan(), 3); // a DIFFERENT authorization's id
    await writeLedgerBody(dir, onDisk);

    // (1) The resume OPEN refuses it.
    await expect(
      openR97BudgetLedger(dir, { planDigest: plan, campaignModelCalls: 3, mode: "resume" }),
    ).rejects.toThrow(/BUDGET_STATE_MISMATCH/);

    // (2) The ALREADY-OPEN handle must also refuse at mutate time: the identity
    // is re-validated inside the locked read-modify-write, not only at open.
    await expect(l.reserve("candidate", 1)).rejects.toThrow(/BUDGET_STATE_MISMATCH/);
  });

  it("handles a LEGACY ledger with NO campaignId strictly: refused as BUDGET_STATE_MISMATCH", async () => {
    // DECISION: a file written before this change (no `campaignId`) is REJECTED,
    // not silently adopted. Rationale: the whole point of the identity is to
    // prove that the budget in THIS directory belongs to THIS authorization. A
    // file that carries no identity cannot prove that, and "I cannot verify the
    // identity" must never degrade into "assume it is mine" — that is exactly
    // the silent double-spend the campaign id exists to prevent. Because the
    // field is absent rather than contradictory, the honest named code is
    // MISMATCH (found: none, expected: the derived id), and the error message
    // says so explicitly so an operator can recognise an old file.
    const dir = await tempDir();
    const plan = freshPlan();
    const legacy = {
      schemaVersion: R97_LEDGER_SCHEMA,
      planDigest: plan,
      campaignModelCalls: 3,
      entries: [],
      // NOTE: no campaignId at all.
    };
    await writeLedgerBody(dir, legacy);

    // The parse layer itself does not invent an identity for it.
    const parsed = parseR97Ledger(legacy);
    expect(parsed.ledger?.campaignId ?? null).toBeNull();

    await expect(
      openR97BudgetLedger(dir, { planDigest: plan, campaignModelCalls: 3, mode: "resume" }),
    ).rejects.toThrow(/BUDGET_STATE_MISMATCH/);
    // ...and the refusal names the missing identity, not a generic parse error.
    await expect(
      openR97BudgetLedger(dir, { planDigest: plan, campaignModelCalls: 3, mode: "first-run" }),
    ).rejects.toThrow(/campaignId/i);
  });

  it("reserve() inside the LOCKED MUTATE path refuses a plan-digest swap (not just read())", async () => {
    // The existing G7 test proves `read()` refuses a swapped plan. That is NOT
    // enough: `reserve` is a READ-MODIFY-WRITE that runs under the lock, and if
    // the identity check lived only in `read()`/open, a swap landing between the
    // bootstrap and a mutate could still be written through. This test names
    // that distinction: it asserts the SAME check runs inside withLedger.
    const dir = await tempDir();
    const plan = freshPlan();
    const foreign = freshPlan();
    const l = await openR97BudgetLedger(dir, { planDigest: plan, campaignModelCalls: 3, mode: "first-run" });

    // Externally replace the ledger with a VALID file for a DIFFERENT plan.
    await writeLedgerBody(dir, {
      schemaVersion: R97_LEDGER_SCHEMA,
      planDigest: foreign,
      campaignModelCalls: 3,
      campaignId: campaignIdOf(foreign, 3),
      entries: [],
    });

    // The mutate path — not merely a read — must refuse and must not persist.
    await expect(l.reserve("baseline", 1)).rejects.toThrow(/BUDGET_STATE_MISMATCH/);
    await expect(l.commit("r-nope", 1)).rejects.toThrow(/BUDGET_STATE_MISMATCH/);
    await expect(l.recover()).rejects.toThrow(/BUDGET_STATE_MISMATCH/);
  });

  it("reserve() inside the LOCKED MUTATE path refuses a SCHEMA swap", async () => {
    // The same uniformity claim for the schema version: every locked
    // read-modify-write re-checks it, and the failure is CORRUPT (the file is
    // structurally not our ledger) rather than MISMATCH.
    const dir = await tempDir();
    const plan = freshPlan();
    const l = await openR97BudgetLedger(dir, { planDigest: plan, campaignModelCalls: 3, mode: "first-run" });
    await writeLedgerBody(dir, {
      schemaVersion: "e4-r97-budget-ledger-v0",
      planDigest: plan,
      campaignModelCalls: 3,
      campaignId: campaignIdOf(plan, 3),
      entries: [],
    });
    await expect(l.reserve("baseline", 1)).rejects.toThrow(/BUDGET_STATE_CORRUPT/);
  });

  it("a first-run may ADOPT an existing ledger only when the identity matches", async () => {
    const dir = await tempDir();
    const plan = freshPlan();
    const first = await openR97BudgetLedger(dir, { planDigest: plan, campaignModelCalls: 3, mode: "first-run" });
    const r = await first.reserve("baseline", 3);
    await first.commit(r.reservationId!, 3);
    expect((await first.view()).remaining).toBe(0);

    // A re-run with the SAME authorization adopts the ledger and sees 0 left —
    // it does NOT re-create an empty one.
    const again = await openR97BudgetLedger(dir, { planDigest: plan, campaignModelCalls: 3, mode: "first-run" });
    expect((await again.view()).remaining).toBe(0);
    expect((await again.reserve("candidate", 1)).ok).toBe(false);
  });

  it("a first-run ADOPTS the existing ledger but REFUSES a different grant for the same plan", async () => {
    // The grant is part of the authorization, so a re-open that declares a
    // different cap is refused even in the directory that owns the campaign.
    const dir = await tempDir();
    const plan = freshPlan();
    await openR97BudgetLedger(dir, { planDigest: plan, campaignModelCalls: 3, mode: "first-run" });
    await expect(
      openR97BudgetLedger(dir, { planDigest: plan, campaignModelCalls: 320, mode: "first-run" }),
    ).rejects.toThrow(/BUDGET_STATE_MISMATCH/);
  });
});

describe("E4-R97 G10: a DELETED ledger is never a fresh allowance (deletion injection)", () => {
  // Plan §R98 怎么做: "`read() ?? emptyLedger()` 只能用于明确的首次创建。恢复时账本
  // 不存在、JSON损坏、被替换为别的计划，都报 BUDGET_STATE_MISSING/CORRUPT/MISMATCH，
  // 不能刷新额度."
  //
  // WHY THIS BLOCK EXISTS, AND WHY THE FAULT IS A DELETION.
  // -------------------------------------------------------
  // G7 above already proves the headline property with a loose `/MISSING|missing|
  // disappear/i` matcher on two methods. This block PINS the property exactly:
  // the named code, on EVERY entry point including all four settle paths, with the
  // on-disk state asserted afterwards (no re-created ledger, no stale lock).
  //
  // The fault is `rm` of `budget-ledger.json`, and that choice is deliberate:
  //   * `rm`/unlink(2) removes a DIRECTORY ENTRY and is governed by the
  //     DIRECTORY's permission, not the file's mode. It behaves identically on
  //     Windows and on ubuntu-latest, so this test needs NO platform branch.
  //   * `chmod 0o444` was REJECTED for exactly the opposite reason — see the
  //     header of `r97-budget-write-fault.test.ts`, candidate (b). MEASURED there
  //     on Windows it makes `rename` fail with EPERM, but on POSIX the atomic
  //     write creates a NEW temp file and `rename(2)` replaces a read-only
  //     destination using only the directory's permission, so the injection stops
  //     producing a failure at all. A chmod test would be green here and vacuous
  //     on the Linux half of the matrix.
  //
  // MEASURED by the independent probe `.ci/team-verify/probe-ledger-read-deleted.mjs`
  // (log `.ci/team-verify/probe-ledger-read-deleted.log`, win32, node v24.18.1),
  // whose verbatim values these tests encode: read/view/reserve/commit/abandon/
  // markUnknown/recover all throw BUDGET_STATE_MISSING, the ledger is NOT
  // re-created, and NO stale lock is left behind.
  //
  // WHY THIS IS NOT "PASSING FOR THE WRONG REASON". A deletion-based test could be
  // green merely because a path is MISSING for an incidental reason (an errno, a
  // typo in the filename, a directory that was never created). Three guards:
  //   1. The message is asserted to CONTAIN `BUDGET_STATE_MISSING` AND to contain
  //      NONE of `EPERM|EACCES|ENOENT|EISDIR` — so the refusal cannot be an
  //      errno that happens to look like a refusal.
  //   2. The NEGATIVE CONTROL drives a genuinely fresh directory and shows the
  //      very same assertions do NOT hold there, so a refusal is not an artefact
  //      of the harness.
  //   3. The establishment is ASSERTED (reserve succeeded, remaining dropped)
  //      BEFORE the deletion, so the test cannot be green because the ledger was
  //      never there in the first place.
  const LEDGER_PATH = (dir: string): string => join(dir, R97_LEDGER_FILENAME);

  let digestCounter = 0;
  const freshPlan = (): string => (++digestCounter).toString(16).padStart(64, "d");

  /** Establish a ledger, spend 2 of the 3 calls, and assert the spend landed. */
  async function establishedWithSpend(dir: string, plan: string) {
    const l = await openR97BudgetLedger(dir, { planDigest: plan, campaignModelCalls: 3, mode: "auto" });
    const r = await l.reserve("baseline", 2);
    expect(r.ok).toBe(true);
    await l.commit(r.reservationId!, 2);
    expect((await l.view()).remaining).toBe(1);
    expect(existsSync(LEDGER_PATH(dir))).toBe(true);
    return l;
  }

  /** Every mutation entry point, so the settle paths are pinned too, not just read(). */
  function allEntryPoints(l: Awaited<ReturnType<typeof openR97BudgetLedger>>, rid: string) {
    return [
      ["read()", () => l.read()],
      ["view()", () => l.view()],
      ['reserve("candidate", 1)', () => l.reserve("candidate", 1)],
      [`commit("${rid}", 1)`, () => l.commit(rid, 1)],
      [`abandon("${rid}")`, () => l.abandon(rid)],
      [`markUnknown("${rid}")`, () => l.markUnknown(rid)],
      ["recover()", () => l.recover()],
    ] as const;
  }

  it("REGRESSION (probe c): after establishment, a deleted ledger is BUDGET_STATE_MISSING on EVERY entry point", async () => {
    const dir = await tempDir();
    const plan = freshPlan();
    const l = await establishedWithSpend(dir, plan);
    const rid = (await l.read()).entries[0]!.reservationId;

    // The deletion. `force` keeps this idempotent; the file is asserted present
    // immediately before, so this cannot pass on an already-missing path.
    await rm(LEDGER_PATH(dir), { force: true });
    expect(existsSync(LEDGER_PATH(dir))).toBe(false);

    for (const [label, call] of allEntryPoints(l, rid)) {
      const message = (await thrownBy(call)).message;
      expect(message, `${label} must name the MISSING state`).toContain(R97_BUDGET_STATE_MISSING);
      // Guard 1: the refusal is the NAMED state, not an errno wearing its name.
      expect(message, `${label} must not refuse for an errno reason`).not.toMatch(/EPERM|EACCES|ENOENT|EISDIR|EEXIST/);
      // A lost budget is not a lost CAMPAIGN and not a foreign ledger: the code
      // is specifically MISSING, so a future refactor cannot widen it silently.
      expect(message, `${label} must not be reported as CORRUPT/MISMATCH`).not.toMatch(
        /BUDGET_STATE_CORRUPT|BUDGET_STATE_MISMATCH/,
      );
    }
  });

  it("REGRESSION (probe c): the failed settles leave NO ledger file and NO stale lock behind", async () => {
    const dir = await tempDir();
    const plan = freshPlan();
    const l = await establishedWithSpend(dir, plan);
    const rid = (await l.read()).entries[0]!.reservationId;
    await rm(LEDGER_PATH(dir), { force: true });

    for (const [label, call] of allEntryPoints(l, rid)) {
      await expect(call(), `${label} must refuse`).rejects.toThrow(/BUDGET_STATE_MISSING/);
      // The whole DIRECTORY LISTING is read, not just the ledger path: a
      // silently re-created EMPTY ledger (the exact defect this closes) and a
      // stale lock are both visible here and nowhere else.
      const names = await readdir(dir);
      expect(names, `${label} must not re-create the ledger`).not.toContain(R97_LEDGER_FILENAME);
      expect(names, `${label} must not leave a stale lock`).not.toContain(R97_LEDGER_LOCK_FILENAME);
      expect(names, `${label} must leave the directory empty`).toEqual([]);
    }
    expect(existsSync(LEDGER_PATH(dir))).toBe(false);
  });

  it("REGRESSION (probe c2): re-opening the emptied directory cannot mint a fresh allowance either", async () => {
    const dir = await tempDir();
    const plan = freshPlan();
    await establishedWithSpend(dir, plan);
    await rm(LEDGER_PATH(dir), { force: true });

    // mode "resume" promises "recover what exists" and may never create.
    await expect(
      openR97BudgetLedger(dir, { planDigest: plan, campaignModelCalls: 3, mode: "resume" }),
    ).rejects.toThrow(/BUDGET_STATE_MISSING/);
    expect(existsSync(LEDGER_PATH(dir))).toBe(false);

    // Even a CREATE-capable mode is refused, because the approval is recorded as
    // having ESTABLISHED a budget here (finding F2: a deleted root is a LOSS of
    // the consumed record, not a fresh allowance). This is the strongest form of
    // "the deletion is never silently repaired".
    await expect(
      openR97BudgetLedger(dir, { planDigest: plan, campaignModelCalls: 3, mode: "auto" }),
    ).rejects.toThrow(/CAMPAIGN_STATE_LOST/);
    expect(existsSync(LEDGER_PATH(dir))).toBe(false);
  });

  /** Capture the thrown error, so the NAMED code can be asserted exactly. */
  async function thrownBy(call: () => Promise<unknown>): Promise<Error> {
    const err = await call().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    return err as Error;
  }

  it("REGRESSION (probe d1): a DIRECTORY at the ledger path is CORRUPT, never an empty budget", async () => {
    // Established handle: the reader's errno is NAMED, not leaked.
    const dir = await tempDir();
    const plan = freshPlan();
    const l = await establishedWithSpend(dir, plan);
    await rm(LEDGER_PATH(dir), { force: true });
    await mkdir(LEDGER_PATH(dir), { recursive: true });
    // Evidence that the path really is a directory, so this is not a missing path.
    expect(statSync(LEDGER_PATH(dir)).isDirectory()).toBe(true);

    for (const [label, call] of [
      ["read()", () => l.read()],
      ["view()", () => l.view()],
      ['reserve("candidate", 1)', () => l.reserve("candidate", 1)],
    ] as const) {
      const message = (await thrownBy(call)).message;
      expect(message, `${label} must name the CORRUPT state`).toContain(R97_BUDGET_STATE_CORRUPT);
      // The refusal must NOT be reported as the missing state.
      expect(message, `${label} must not be the missing state`).not.toContain(R97_BUDGET_STATE_MISSING);
    }

    // Never-established open: the raw reader error propagates unwrapped (there is
    // no prior durable state to make it a "corrupt ESTABLISHED ledger"), and it
    // still must NOT be treated as an empty full allowance.
    const freshDirB = await tempDir();
    const planB = freshPlan();
    await mkdir(LEDGER_PATH(freshDirB), { recursive: true });
    await expect(
      openR97BudgetLedger(freshDirB, { planDigest: planB, campaignModelCalls: 3, mode: "auto" }),
    ).rejects.toThrow(/EISDIR/);
    // No ledger was written: the directory is still the only entry.
    expect((await readdir(freshDirB)).sort()).toEqual([R97_LEDGER_FILENAME]);
  });

  it("REGRESSION (probe d2): an invalid-JSON ledger is CORRUPT and is never read as empty", async () => {
    // Established handle.
    const dir = await tempDir();
    const plan = freshPlan();
    const l = await establishedWithSpend(dir, plan);
    const corrupt = "{ this is not json";
    await writeFile(LEDGER_PATH(dir), corrupt, "utf8");

    for (const [label, call] of [
      ["read()", () => l.read()],
      ["view()", () => l.view()],
      ['reserve("candidate", 1)', () => l.reserve("candidate", 1)],
    ] as const) {
      const message = (await thrownBy(call)).message;
      expect(message, `${label} must name the CORRUPT state`).toContain(R97_BUDGET_STATE_CORRUPT);
      expect(message, `${label} must not be the missing state`).not.toContain(R97_BUDGET_STATE_MISSING);
    }
    // The corrupt bytes are LEFT ALONE: the refusal must not "repair" the file by
    // overwriting it with a fresh empty ledger, which would re-grant the budget.
    expect(await readFile(LEDGER_PATH(dir), "utf8")).toBe(corrupt);

    // Never-established open over the same corruption.
    const dirB = await tempDir();
    const planB = freshPlan();
    await writeFile(LEDGER_PATH(dirB), corrupt, "utf8");
    await expect(
      openR97BudgetLedger(dirB, { planDigest: planB, campaignModelCalls: 3, mode: "auto" }),
    ).rejects.toThrow(/not valid JSON/);
    expect(await readFile(LEDGER_PATH(dirB), "utf8")).toBe(corrupt);
  });

  it("NEGATIVE CONTROL: a GENUINE first run does NOT reproduce the missing-state refusal", async () => {
    // The discriminator the plan demands: the SAME assertions that hold after a
    // deletion must NOT hold for a fresh directory. Without this, the block above
    // could be green merely because the harness always throws.
    const dir = await tempDir();
    const plan = freshPlan();
    expect(existsSync(LEDGER_PATH(dir))).toBe(false);

    const l = await openR97BudgetLedger(dir, { planDigest: plan, campaignModelCalls: 3, mode: "auto" });
    expect(l.mode).toBe("first-run");
    // (a) The read RESOLVES rather than throwing...
    const file = await l.read();
    expect(file.entries).toEqual([]);
    expect((await l.view()).remaining).toBe(3);
    // ...and the first run DOES create the file on disk.
    expect(existsSync(LEDGER_PATH(dir))).toBe(true);
    // (b) ...and a reservation is ADMITTED, not refused.
    const r = await l.reserve("baseline", 1);
    expect(r.ok).toBe(true);
    expect((await l.view()).remaining).toBe(2);
    // The assertions from the deletion block are asserted FALSE here, explicitly.
    await expect(l.read()).resolves.toBeDefined();
    await expect(l.view()).resolves.toBeDefined();
  });
});
