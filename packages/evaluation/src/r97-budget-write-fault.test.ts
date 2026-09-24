/**
 * E4-R97 (plan T1-5, line ~146) — A FAILED LEDGER WRITE MUST REFUSE THE CALL.
 *
 * THE PROPERTY THE PLAN ASSERTS (plan(20260920-053219).md, §T1 怎么验收 line ~146):
 *
 *   "缺少预算 IPC/ledger、故障写盘、超过授权预算时，真实与离线模式都不会绕过检查."
 *
 *   ("When the budget IPC/ledger is missing, when the DISK WRITE FAILS, or when
 *    the authorized budget is exceeded, neither the real nor the offline mode
 *    may bypass the check.")
 *
 * with the mechanism stated at §T1 怎么做 2:
 *
 *   "在每次 generate 离开执行边界前，原子 reserve 一次；没有可靠预算通道就拒绝发送."
 *
 *   ("Reserve atomically before every generate leaves the execution boundary;
 *    with no reliable budget channel, REFUSE TO SEND.")
 *
 * THE GAP THIS FILE CLOSES — evidence, not implementation.
 * -------------------------------------------------------
 * An independent read-only audit established that the implementation IS
 * fail-closed: `writeLedgerAtomic` (r97-budget-ledger.ts ~746-750) is awaited by
 * `withLedger` (~970-984) and by the bootstrap (~1081) with NO catch, so a failed
 * `writeFile`/`rename` propagates out of `reserve()`; `r97-budget-channel.ts:181-193`
 * catches it and re-throws `BUDGET_REFUSED` ("refused rather than sent unbilled")
 * BEFORE the provider is entered.
 *
 * What was missing was PROOF. Before this file there were ZERO `ENOSPC|EACCES|
 * EROFS|EDQUOT|chmod` hits across `packages/evaluation/src/r97-*.test.ts`; only the
 * `BUDGET_EXHAUSTED` branch was ever exercised (r97-budget-channel.test.ts:124,150,
 * 180,290). The plan asserted the property; the suite did not demonstrate it. This
 * file supplies the counterexample-bearing evidence: it makes the ledger's WRITE
 * fail for real and measures what the channel then does.
 *
 * WHY THE FAULT IS INJECTED WHERE IT IS (and not where it was first suggested)
 * ---------------------------------------------------------------------------
 * Ranked candidate injections, and the empirical result on this host:
 *
 *  (b) `chmod 0o444` the ledger file. REJECTED — it is NOT cross-platform, and it
 *      would have passed here for a reason that does not survive Linux. MEASURED on
 *      this Windows host: `writeFile` over a 0o444 file -> EPERM, `rename` over it
 *      -> EPERM. But on POSIX the atomic write first creates a NEW temp file
 *      (writeFile(tmp) succeeds) and `rename(2)` replaces a read-only destination
 *      using only the DIRECTORY's permissions — so on Linux this injection stops
 *      producing a failure at all. A test built on it would be green on Windows and
 *      red (or worse, vacuous) on the ubuntu-latest half of the CI matrix.
 *
 *  (a-literal) Replace `budget-ledger.json` itself with a DIRECTORY. REJECTED as a
 *      test of THIS property — it fails the READ, not the write. MEASURED:
 *      `readFile` of a directory -> EISDIR, which `read()` maps to
 *      `BUDGET_STATE_CORRUPT` before any write is attempted. That is a real and
 *      valuable refusal, but it is the READ path; it would leave the plan's
 *      "故障写盘" (failed disk write) branch unproven while looking like it proved it.
 *
 *  (a-variant) CHOSEN: occupy the ATOMIC TEMP PATH with a directory. `writeLedgerAtomic`
 *      does `writeFile(tmp)` then `rename(tmp, ledger)`. With a directory sitting at
 *      `tmp`, the real `writeFile` fails with a real errno while the real
 *      `budget-ledger.json` stays readable and valid — so the failure lands squarely
 *      on the WRITE, exactly the branch the plan names. MEASURED on this host:
 *      `EISDIR: illegal operation on a directory, open '...budget-ledger.json.tmp-
 *      <pid>-<ms>'`. POSIX `writeFile(2)` on a directory gives the same EISDIR, so
 *      the injection is cross-platform and needs no branch.
 *
 *  (c) An injectable `writeFile`/`rename` seam. NOT USED — no seam was needed, and
 *      both ledger source files are left untouched by this change.
 *
 * WHY THIS IS NOT "PASSING FOR THE WRONG REASON"
 * ----------------------------------------------
 * A test that injected a fault by deleting a path could be green merely because the
 * path was MISSING. Three guards against that:
 *   1. The errno is ASSERTED (`/EISDIR|EPERM|EACCES/`) and `ENOENT` is asserted ABSENT,
 *      so the test fails loudly if the mechanism ever degrades into a missing path.
 *   2. A companion test drives a GENUINELY missing ledger and shows the distinct code
 *      `BUDGET_STATE_MISSING` in the refusal — proving the write-fault refusal is not
 *      that condition wearing a different name (the adjacent case the audit named).
 *   3. A positive CONTROL with a healthy ledger shows the very same call IS admitted
 *      and reaches the provider, so the refusal cannot be an artefact of the harness.
 *
 * ZERO external requests: the wrapped provider is the local `ScriptedModelProvider`,
 * and its own `calls` array — not any self-reported `model_calls` field — is the
 * ground truth for "did the call leave".
 */

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelProvider } from "@ar/model";
import { createLedgerBudgetedProvider, R97_BUDGET_REFUSED } from "./r97-budget-channel.js";
import {
  openR97BudgetLedger,
  viewOfR97Ledger,
  R97_BUDGET_STATE_CORRUPT,
  R97_BUDGET_STATE_MISSING,
  R97_CAMPAIGN_CLAIMS_DIR_ENV,
  R97_LEDGER_FILENAME,
} from "./r97-budget-ledger.js";

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "r97-write-fault-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  // Restore the pinned clock FIRST: the cleanup below must run on real time.
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
});

/**
 * The per-authorization CLAIM anchor lives OUTSIDE any single campaign directory, so
 * pointing several temp directories at the same plan digest would trip the
 * cross-directory double-spend guard — the guard working correctly, not a
 * budget-channel failure. Redirect it at a scratch directory for this file, exactly
 * as `r97-budget-channel.test.ts` and `r97-budget-ledger.test.ts` do.
 */
const CLAIMS_DIR = await mkdtemp(join(tmpdir(), "r97-write-fault-claims-"));
process.env[R97_CAMPAIGN_CLAIMS_DIR_ENV] = CLAIMS_DIR;
afterAll(async () => {
  delete process.env[R97_CAMPAIGN_CLAIMS_DIR_ENV];
  await rm(CLAIMS_DIR, { recursive: true, force: true }).catch(() => {});
});

/**
 * A UNIQUE authorization per test. The campaign identity is derived from
 * `(planDigest, grant)` alone, and a second directory claiming the SAME
 * authorization is a deliberate conflict (`BUDGET_CAMPAIGN_DIR_DUPLICATE`). Each
 * test below is its own campaign, so each gets its own digest.
 */
let planSeq = 0;
function freshPlan(): string {
  planSeq += 1;
  return `${planSeq.toString(16).padStart(2, "0")}${"f".repeat(62)}`;
}

/**
 * The wall clock `writeLedgerAtomic` stamps into its temp file name. Pinned so the
 * path the test occupies is EXACTLY the path the implementation will write to,
 * instead of a guess that might silently stop colliding (and thus silently stop
 * injecting anything). If the implementation ever changes that naming, this test
 * does not quietly pass: the write succeeds, the call is admitted, and the
 * assertions below fail loudly.
 */
const FIXED_NOW = 1_700_000_000_000;

function atomicTempPathFor(dir: string): string {
  return join(dir, `${R97_LEDGER_FILENAME}.tmp-${process.pid}-${FIXED_NOW}`);
}

/** Pin `Date.now` so the atomic-write temp name is deterministic. */
function pinClock(): void {
  vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
}

/**
 * Make the ledger's next atomic WRITE fail, for real, on both platforms: a
 * directory at the temp path makes `writeFile(tmp, ...)` fail with EISDIR while
 * leaving the real `budget-ledger.json` readable and valid, so the failure is
 * isolated to the WRITE and not to the read/lock/open paths.
 */
async function injectLedgerWriteFault(dir: string): Promise<string> {
  const tmp = atomicTempPathFor(dir);
  await mkdir(tmp);
  return tmp;
}

/** Drain one generate() and return the event types it yielded. */
async function drain(client: { generate: (r: unknown, s: AbortSignal) => AsyncIterable<{ type: string }> }): Promise<string[]> {
  const types: string[] = [];
  for await (const ev of client.generate({ messages: [{ role: "user", content: "x" }] }, new AbortController().signal)) {
    types.push(ev.type);
  }
  return types;
}

/** Run `fn` and return the Error it threw; fail if it did NOT throw. */
async function captureRejection(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  throw new Error("expected the call to be REFUSED, but it completed without throwing");
}

const TEXT = ScriptedModelProvider.text("done");

describe("R97 T1-5: a failed ledger WRITE refuses the call instead of sending it unbilled", () => {
  it("REFUSES with the named code, never enters the provider, and leaves the ledger untouched", async () => {
    const dir = await tempDir();
    pinClock();
    const ledger = await openR97BudgetLedger(dir, { planDigest: freshPlan(), campaignModelCalls: 2, mode: "first-run" });

    // The ledger is healthy and readable RIGHT BEFORE the fault: 2 granted, 0 spent.
    // Without this, a refusal caused by a broken/missing ledger would look identical.
    const ledgerPath = join(dir, R97_LEDGER_FILENAME);
    const beforeBytes = await readFile(ledgerPath, "utf8");
    expect(viewOfR97Ledger(await ledger.read())).toMatchObject({ granted: 2, committed: 0, outstanding: 0, unknown: 0, remaining: 2 });

    // ---- INJECT: the atomic write can no longer complete. --------------------
    const tmp = await injectLedgerWriteFault(dir);

    const inner = new ScriptedModelProvider([TEXT, TEXT]);
    const { provider, stats } = createLedgerBudgetedProvider({ provider: inner, ledger, arm: "baseline" });
    const client = provider.createClient({ providerId: "scripted", modelId: "m" }, {});

    const err = await captureRejection(() => drain(client as never));
    const msg = err.message;

    // (1) THE NAMED CODE — the real exported constant, never a literal copy.
    expect(msg).toContain(R97_BUDGET_REFUSED);

    // (2) THE FAILURE IS REPORTED, NOT SWALLOWED. The channel must name the write
    //     fault it is refusing over, and the underlying errno must survive into the
    //     message. MEASURED on this host: `EISDIR: illegal operation on a
    //     directory, open '...budget-ledger.json.tmp-<pid>-<ms>'`; POSIX gives the
    //     same EISDIR for writeFile(2) on a directory, and EPERM/EACCES are the
    //     platform alternates for the same "target cannot be written" condition.
    expect(msg).toContain("could not reserve");
    expect(msg).toContain("refused rather than sent unbilled");
    expect(msg).toMatch(/EISDIR|EPERM|EACCES/);
    // THE WRONG REASON WOULD BE A MISSING PATH: assert this fault is not ENOENT,
    // and not the adjacent missing/corrupt ledger states (see the contrast tests).
    expect(msg).not.toContain("ENOENT");
    expect(msg).not.toContain(R97_BUDGET_STATE_MISSING);
    expect(msg).not.toContain(R97_BUDGET_STATE_CORRUPT);

    // (3) THE PROVIDER WAS NEVER ENTERED. `inner.calls` is the fake provider's OWN
    //     counter — a real side effect — not a `model_calls` field reported about
    //     itself. A channel that reserved AFTER the call, or that swallowed the
    //     write failure, would show 1 here.
    expect(inner.calls, "a refused call must NOT reach the provider").toHaveLength(0);
    expect(stats.logicalCalls, "no logical call was admitted").toBe(0);
    expect(stats.refusedCalls, "the refusal is counted").toBe(1);
    expect(stats.reservationIds, "no reservation was taken").toHaveLength(0);
    expect(stats.unknownCalls).toBe(0);

    // (4) NO ALLOWANCE WAS SILENTLY CONSUMED, AND NONE WAS REFUNDED INCORRECTLY.
    //     The failed write must leave the on-disk ledger BYTE-IDENTICAL: no partial
    //     entry, no phantom reservation, no compensating refund.
    expect(await readFile(ledgerPath, "utf8")).toBe(beforeBytes);
    expect(viewOfR97Ledger(await ledger.read())).toMatchObject({
      granted: 2,
      committed: 0,
      outstanding: 0,
      unknown: 0,
      remaining: 2,
      transportRetries: 0,
    });

    // The failed write left no debris: the only `*.tmp-*` entry is the directory
    // this test placed there, i.e. no half-written temp file survived.
    const leftovers = (await readdir(dir)).filter((n) => n.startsWith(`${R97_LEDGER_FILENAME}.tmp-`));
    expect(leftovers).toEqual([tmp.slice(dir.length + 1)]);
  });

  it("the LEDGER's own write path propagates the failure — there is no catch to hide it", async () => {
    // The channel can only refuse if `reserve()` rejects. This pins that half of the
    // contract directly, with no channel in the way: a swallowed write failure here
    // would make the channel's refusal impossible, and would be invisible if only
    // the end-to-end assertion above existed.
    const dir = await tempDir();
    pinClock();
    const ledger = await openR97BudgetLedger(dir, { planDigest: freshPlan(), campaignModelCalls: 1, mode: "first-run" });
    await injectLedgerWriteFault(dir);

    const err = await captureRejection(() => ledger.reserve("baseline", 1));
    expect(err.message).toMatch(/EISDIR|EPERM|EACCES/);
    expect(err.message).not.toContain("ENOENT");
    expect(err.message).not.toContain(R97_BUDGET_STATE_MISSING);

    // And the failed reservation did not land: the ledger still grants 1.
    expect(viewOfR97Ledger(await ledger.read())).toMatchObject({ granted: 1, outstanding: 0, remaining: 1 });
  });

  it("CONTRAST: a GENUINELY missing ledger reports BUDGET_STATE_MISSING, a distinct condition", async () => {
    // The adjacent case the audit named: a write failure must NOT be reported as a
    // missing state. This drives the real missing-state path so the two codes can be
    // told apart by assertion rather than by reading the source. It also proves the
    // write-fault test above is not green because a path was absent.
    const dir = await tempDir();
    pinClock();
    const ledger = await openR97BudgetLedger(dir, { planDigest: freshPlan(), campaignModelCalls: 1, mode: "first-run" });
    // The handle has now OBSERVED durable state, so its disappearance is MISSING
    // rather than "a fresh campaign" (see openR97BudgetLedger's `established`).
    await rm(join(dir, R97_LEDGER_FILENAME), { force: true });

    const inner = new ScriptedModelProvider([TEXT]);
    const { provider, stats } = createLedgerBudgetedProvider({ provider: inner, ledger, arm: "baseline" });
    const err = await captureRejection(() => drain(provider.createClient({ providerId: "scripted", modelId: "m" }, {}) as never));

    // Same outer vocabulary (the caller sees one refusal code) ...
    expect(err.message).toContain(R97_BUDGET_REFUSED);
    // ... but the DIAGNOSIS differs, and it is named. This is the distinction that
    // the write-fault test asserts is ABSENT there.
    expect(err.message).toContain(R97_BUDGET_STATE_MISSING);
    expect(err.message).not.toContain(R97_BUDGET_STATE_CORRUPT);

    // Fail-closed here too: the missing ledger cost the provider nothing.
    expect(inner.calls).toHaveLength(0);
    expect(stats.logicalCalls).toBe(0);
    expect(stats.refusedCalls).toBe(1);
  });

  it("CONTROL: with a healthy ledger the SAME call is admitted and reaches the provider", async () => {
    // The discriminator for the whole file: everything above is identical except the
    // injected write fault. If the fault were not doing the work, this control and the
    // first test could not disagree.
    const dir = await tempDir();
    pinClock();
    const ledger = await openR97BudgetLedger(dir, { planDigest: freshPlan(), campaignModelCalls: 1, mode: "first-run" });

    const inner = new ScriptedModelProvider([TEXT]);
    const { provider, stats } = createLedgerBudgetedProvider({ provider: inner, ledger, arm: "baseline" });
    await drain(provider.createClient({ providerId: "scripted", modelId: "m" }, {}) as never);

    expect(inner.calls, "the admitted call MUST reach the provider").toHaveLength(1);
    expect(stats.logicalCalls).toBe(1);
    expect(stats.refusedCalls).toBe(0);
    // The reservation was taken AND settled, so the allowance is spent rather than
    // left outstanding — the healthy path this file contrasts against.
    expect(viewOfR97Ledger(await ledger.read())).toMatchObject({ granted: 1, committed: 1, outstanding: 0, remaining: 0 });
  });
});
