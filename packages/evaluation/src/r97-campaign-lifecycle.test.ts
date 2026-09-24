/**
 * E4-R98-A (plan T1 / finding N2) — THE CAMPAIGN LIFECYCLE.
 *
 * MEASURED DEFECT N2 (plan §0.2, P1):
 *
 *   "driver 打开 ledger 未传 mode；worker 显式 `mode:"auto"`；driver 不消费
 *    `duplicateCampaignDirs` … 同授权换目录仍可获得新预算，重启后缺失账本也可能按首次
 *    创建处理."
 *
 * Three separate holes, and each is a way for ONE authorization to be spent more
 * than once:
 *
 *   1. The DRIVER opened the ledger with no `mode` at all, so it took the
 *      `"auto"` default. `"auto"` cannot distinguish "I am starting" from "I am
 *      recovering", so it happily CREATES a fresh full allowance whenever the
 *      file is absent — including on a restart whose ledger was deleted.
 *   2. `duplicateCampaignDirs` was computed by the ledger and then never read by
 *      the caller, so a second directory claiming the same authorization was
 *      recorded and ignored. Plan §T1 怎么做 8: "遇到 duplicateCampaignDirs 必须
 *      影响执行结果，不能仅挂在未被使用的 handle 属性里."
 *   3. Nothing durable recorded WHERE the campaign lives, so pointing `--out` at
 *      a new directory was indistinguishable from a legitimate first run.
 *      Plan §T1 怎么做 7: "固定 campaign 根目录及 header 合同 … 单纯换 --out/--ledger
 *      必须拒绝或要求新授权. 临时目录里的 advisory claim 不能是唯一权威状态."
 *
 * THE CONTRACT THIS FILE PINS (plan §T1 怎么验收):
 *
 *   "同一目录重启前删除 ledger、保留 header/状态：拒绝且 0 调用。换新目录继续同一
 *    授权：拒绝且 0 调用。"
 *
 * The header is the DURABLE, campaign-local record that makes both refusals
 * possible. It is deliberately NOT the advisory claim anchor: that anchor lives
 * in a temp directory, is explicitly non-authoritative, and degrades to "no
 * evidence" when unwritable. The header sits INSIDE the campaign directory and
 * is authoritative for that directory.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  openR97Campaign,
  readR97CampaignHeader,
  R97_CAMPAIGN_HEADER_FILENAME,
  R97_CAMPAIGN_HEADER_MISSING,
  R97_CAMPAIGN_DIR_CONFLICT,
} from "./r97-campaign-lifecycle.js";
import { campaignIdOf, R97_CAMPAIGN_CLAIMS_DIR_ENV, R97_CAMPAIGN_STATE_LOST, R97_LEDGER_FILENAME } from "./r97-budget-ledger.js";
import { R97_EXEC_FILENAME } from "./r97-execution-state.js";

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "r97-lifecycle-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
});

/**
 * The cross-directory CLAIM anchor is machine-global by design, so it is
 * redirected at a scratch directory for this file — otherwise a claim left by
 * one test (or by an earlier run on this machine) would make an unrelated test's
 * fresh directory look like a conflict.
 */
const CLAIMS_DIR = await mkdtemp(join(tmpdir(), "r97-lifecycle-claims-"));
process.env[R97_CAMPAIGN_CLAIMS_DIR_ENV] = CLAIMS_DIR;
afterAll(async () => {
  delete process.env[R97_CAMPAIGN_CLAIMS_DIR_ENV];
  await rm(CLAIMS_DIR, { recursive: true, force: true }).catch(() => {});
});

/** A unique authorization per test, so the cross-directory guard does not fire
 *  for a reason unrelated to what a test is measuring. */
let seq = 0;
function freshPlan(): string {
  seq += 1;
  return `${seq.toString(16).padStart(2, "0")}${"e".repeat(62)}`;
}

const GRANT = 3;

describe("R98-A L1: the campaign header is a durable, campaign-local fact", () => {
  it("a first run writes the header and the ledger together", async () => {
    const dir = await tempDir();
    const plan = freshPlan();
    const campaign = await openR97Campaign(dir, { planDigest: plan, campaignModelCalls: GRANT, mode: "first-run" });

    expect(campaign.mode).toBe("first-run");
    const header = await readR97CampaignHeader(dir);
    expect(header, "a first run must leave a durable header").not.toBeNull();
    expect(header!.planDigest).toBe(plan);
    expect(header!.campaignModelCalls).toBe(GRANT);
    expect(header!.campaignId).toBe(campaignIdOf(plan, GRANT));
    // The ROOT is recorded, so a later run in another directory is a detectable
    // relocation rather than an innocent fresh start.
    expect(header!.rootDir).toBe(dir);
    expect(header!.schemaVersion).toMatch(/^e4-r97-campaign-header-v\d+$/);
    // The ledger is real, and the campaign handle exposes it.
    expect(await campaign.ledger.view()).toMatchObject({ granted: GRANT, remaining: GRANT });
  });

  it("a resume adopts the SAME budget and reports mode `resume`", async () => {
    const dir = await tempDir();
    const plan = freshPlan();
    const first = await openR97Campaign(dir, { planDigest: plan, campaignModelCalls: GRANT, mode: "first-run" });
    await first.ledger.reserve("baseline", 2);

    const second = await openR97Campaign(dir, { planDigest: plan, campaignModelCalls: GRANT, mode: "resume" });
    expect(second.mode).toBe("resume");
    // The spend is NOT refreshed: the two reservations are still outstanding
    // (they were never committed), so only ONE of the three calls remains.
    expect(await second.ledger.view()).toMatchObject({ granted: GRANT, outstanding: 2, committed: 0, remaining: 1 });
  });
});

describe("R98-A L2: a lost ledger is NEVER a fresh allowance", () => {
  it("REFUSES to start when the header exists but the ledger was deleted", async () => {
    // Plan §T1 怎么验收: "同一目录重启前删除 ledger、保留 header/状态：拒绝且 0 调用."
    const dir = await tempDir();
    const plan = freshPlan();
    await openR97Campaign(dir, { planDigest: plan, campaignModelCalls: GRANT, mode: "first-run" });
    // The operator (or a crash) removes the ledger but the header survives.
    await rm(join(dir, R97_LEDGER_FILENAME), { force: true });

    await expect(
      openR97Campaign(dir, { planDigest: plan, campaignModelCalls: GRANT, mode: "auto" }),
    ).rejects.toThrow(/BUDGET_STATE_MISSING/);

    // NOTHING was created: the refusal must not have re-materialised a budget.
    await expect(readFile(join(dir, R97_LEDGER_FILENAME), "utf8")).rejects.toThrow();
    // The header is untouched, so the evidence of the loss survives.
    const header = await readR97CampaignHeader(dir);
    expect(header!.campaignId).toBe(campaignIdOf(plan, GRANT));
  });

  it("REFUSES a resume when the header itself is missing", async () => {
    const dir = await tempDir();
    const plan = freshPlan();
    await openR97Campaign(dir, { planDigest: plan, campaignModelCalls: GRANT, mode: "first-run" });
    await rm(join(dir, R97_CAMPAIGN_HEADER_FILENAME), { force: true });

    await expect(
      openR97Campaign(dir, { planDigest: plan, campaignModelCalls: GRANT, mode: "resume" }),
    ).rejects.toThrow(new RegExp(R97_CAMPAIGN_HEADER_MISSING));
  });

  it("REFUSES an `auto` open when a ledger exists with no header", async () => {
    // A ledger that no header vouches for cannot be proven to belong to this
    // campaign directory, so it is not adopted silently.
    const dir = await tempDir();
    const plan = freshPlan();
    await openR97Campaign(dir, { planDigest: plan, campaignModelCalls: GRANT, mode: "first-run" });
    await rm(join(dir, R97_CAMPAIGN_HEADER_FILENAME), { force: true });

    await expect(
      openR97Campaign(dir, { planDigest: plan, campaignModelCalls: GRANT, mode: "auto" }),
    ).rejects.toThrow(new RegExp(R97_CAMPAIGN_HEADER_MISSING));
  });
});

describe("R98-A L3: the same authorization cannot be re-rooted into a new directory", () => {
  it("REFUSES a first-run in a DIFFERENT directory for the same authorization", async () => {
    // Plan §T1 怎么验收: "换新目录继续同一授权：拒绝且 0 调用."
    const dirA = await tempDir();
    const dirB = await tempDir();
    const plan = freshPlan();
    await openR97Campaign(dirA, { planDigest: plan, campaignModelCalls: GRANT, mode: "first-run" });

    await expect(
      openR97Campaign(dirB, { planDigest: plan, campaignModelCalls: GRANT, mode: "first-run" }),
    ).rejects.toThrow(new RegExp(R97_CAMPAIGN_DIR_CONFLICT));

    // Directory B got NOTHING: no ledger, no header.
    await expect(readFile(join(dirB, R97_LEDGER_FILENAME), "utf8")).rejects.toThrow();
    await expect(readFile(join(dirB, R97_CAMPAIGN_HEADER_FILENAME), "utf8")).rejects.toThrow();
  });

  it("the campaign reports the competing directories it refused over", async () => {
    const dirA = await tempDir();
    const dirB = await tempDir();
    const plan = freshPlan();
    await openR97Campaign(dirA, { planDigest: plan, campaignModelCalls: GRANT, mode: "first-run" });

    let caught: unknown = null;
    try {
      await openR97Campaign(dirB, { planDigest: plan, campaignModelCalls: GRANT, mode: "first-run" });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    // The refusal NAMES the other directory, so an operator can see where the
    // authorization is already in use instead of guessing.
    expect(String(caught)).toContain(dirA);
    expect(String(caught)).toContain(dirB);
  });

  it("a ledger whose header records a DIFFERENT root is refused", async () => {
    // The header is authoritative: a ledger copied into a new directory carries
    // a header that says it belongs somewhere else.
    const dirA = await tempDir();
    const dirB = await tempDir();
    const plan = freshPlan();
    await openR97Campaign(dirA, { planDigest: plan, campaignModelCalls: GRANT, mode: "first-run" });

    // Simulate a copy: B gets A's header, rewritten to claim B is the root while
    // the RECORDED root still points at A.
    const headerText = await readFile(join(dirA, R97_CAMPAIGN_HEADER_FILENAME), "utf8");
    const header = JSON.parse(headerText);
    header.rootDir = dirA; // the truth: it belongs to A
    await writeFile(join(dirB, R97_CAMPAIGN_HEADER_FILENAME), JSON.stringify(header), "utf8");
    await writeFile(join(dirB, R97_LEDGER_FILENAME), await readFile(join(dirA, R97_LEDGER_FILENAME), "utf8"), "utf8");

    await expect(
      openR97Campaign(dirB, { planDigest: plan, campaignModelCalls: GRANT, mode: "auto" }),
    ).rejects.toThrow(/CAMPAIGN_ROOT_MISMATCH/);
  });
});

describe("R98-A L3b: only a claim that never ESTABLISHED a budget is stale", () => {
  it("REFUSES a new root once the claiming directory is GONE — the claim is a LOSS, not garbage", async () => {
    // UPDATED FOR FINDING F2 (plan §A2 怎么做 6: "更新现有 stale-claim 测试。已消费但
    // 目录删除的 claim 不属于可安全忽略的垃圾"). This test used to assert the
    // OPPOSITE — that deleting the campaign root let the same authorization start
    // again in a new directory. THAT WAS THE DEFECT: one `rm -rf` refreshed a
    // spent approval with a full second allowance. The anchor durably records
    // that a budget was ESTABLISHED here, and that fact does not disappear when
    // the directory does.
    const dirA = await tempDir();
    const dirB = await tempDir();
    const plan = freshPlan();
    await openR97Campaign(dirA, { planDigest: plan, campaignModelCalls: GRANT, mode: "first-run" });
    // The campaign is removed entirely — an ordinary cleanup, not an attack.
    await rm(dirA, { recursive: true, force: true });

    await expect(
      openR97Campaign(dirB, { planDigest: plan, campaignModelCalls: GRANT, mode: "first-run" }),
    ).rejects.toThrow(new RegExp(R97_CAMPAIGN_STATE_LOST));

    // B got NOTHING: no header, no ledger. A refusal that still seeded state
    // would be the double-spend it claims to prevent.
    await expect(readFile(join(dirB, R97_CAMPAIGN_HEADER_FILENAME), "utf8")).rejects.toThrow();
    await expect(readFile(join(dirB, R97_LEDGER_FILENAME), "utf8")).rejects.toThrow();
  });

  it("still REFUSES while the claiming directory is LIVE", async () => {
    const dirA = await tempDir();
    const dirB = await tempDir();
    const plan = freshPlan();
    await openR97Campaign(dirA, { planDigest: plan, campaignModelCalls: GRANT, mode: "first-run" });
    // A still exists and still holds the campaign, so B is a real conflict.
    await expect(
      openR97Campaign(dirB, { planDigest: plan, campaignModelCalls: GRANT, mode: "first-run" }),
    ).rejects.toThrow(new RegExp(R97_CAMPAIGN_DIR_CONFLICT));
  });
});

describe("R98-A L4: the lifecycle refuses identity drift", () => {
  it("REFUSES a different grant for the same plan digest", async () => {
    const dir = await tempDir();
    const plan = freshPlan();
    await openR97Campaign(dir, { planDigest: plan, campaignModelCalls: GRANT, mode: "first-run" });
    await expect(
      openR97Campaign(dir, { planDigest: plan, campaignModelCalls: GRANT + 5, mode: "auto" }),
    ).rejects.toThrow(/BUDGET_STATE_MISMATCH/);
  });

  it("REFUSES a different plan digest in the same directory", async () => {
    const dir = await tempDir();
    await openR97Campaign(dir, { planDigest: freshPlan(), campaignModelCalls: GRANT, mode: "first-run" });
    await expect(
      openR97Campaign(dir, { planDigest: freshPlan(), campaignModelCalls: GRANT, mode: "auto" }),
    ).rejects.toThrow(/BUDGET_STATE_MISMATCH/);
  });

  it("REFUSES a corrupt header rather than treating it as absent", async () => {
    const dir = await tempDir();
    const plan = freshPlan();
    await openR97Campaign(dir, { planDigest: plan, campaignModelCalls: GRANT, mode: "first-run" });
    await writeFile(join(dir, R97_CAMPAIGN_HEADER_FILENAME), "{ not json", "utf8");
    await expect(
      openR97Campaign(dir, { planDigest: plan, campaignModelCalls: GRANT, mode: "auto" }),
    ).rejects.toThrow(/CAMPAIGN_HEADER_CORRUPT/);
  });
});

describe("R98-A L5: an established campaign has ALL THREE artifacts at once", () => {
  it("creates the case state in the same step as the header and the ledger", async () => {
    // ORDER IS THE CONTRACT, and this is its last part. If the case state were
    // created lazily — by the driver, on its way to the first unit — there would
    // be a window in which a fully authorized campaign (header + ledger present)
    // had NO state file, and a resume inside that window would be
    // indistinguishable from a DELETED state file. Creating all three together
    // closes the window by construction.
    const dir = await tempDir();
    const plan = freshPlan();
    const campaign = await openR97Campaign(dir, { planDigest: plan, campaignModelCalls: GRANT, mode: "first-run" });
    expect(await campaign.execState.records()).toEqual([]);
    // All three artifacts are on disk right now.
    await expect(readFile(join(dir, R97_CAMPAIGN_HEADER_FILENAME), "utf8")).resolves.toBeTruthy();
    await expect(readFile(join(dir, R97_LEDGER_FILENAME), "utf8")).resolves.toBeTruthy();
    await expect(readFile(join(dir, R97_EXEC_FILENAME), "utf8")).resolves.toBeTruthy();
  });

  it("a resume adopts the SAME state, and a DELETED state file is a named loss", async () => {
    const dir = await tempDir();
    const plan = freshPlan();
    const first = await openR97Campaign(dir, { planDigest: plan, campaignModelCalls: GRANT, mode: "first-run" });
    // Record some work, so the store is not trivially empty.
    const key = { experimentId: plan, caseId: "c1", suite: "regression", arm: "baseline", repetition: 1 };
    const attempt = await first.execState.begin(key, { reservationId: "r1", inputDigest: "d1" });
    await first.execState.complete(attempt, { resultHash: "h1" });

    // A resume sees the SAME completed unit — the campaign handle is the store.
    const resumed = await openR97Campaign(dir, { planDigest: plan, campaignModelCalls: GRANT, mode: "auto" });
    expect(resumed.mode).toBe("resume");
    expect(await resumed.execState.isDone(key)).toBe(true);

    // Now the state file is DELETED. The campaign is established (header +
    // ledger survive), so this is a LOSS, not a blank slate: re-running would
    // re-execute and re-bill every unit.
    await rm(join(dir, R97_EXEC_FILENAME), { force: true });
    await expect(
      openR97Campaign(dir, { planDigest: plan, campaignModelCalls: GRANT, mode: "auto" }),
    ).rejects.toThrow(/EXEC_STATE_MISSING/);
    // ...and the refusal did NOT create a fresh empty store.
    await expect(readFile(join(dir, R97_EXEC_FILENAME), "utf8")).rejects.toThrow();
    // The ledger is untouched by the refusal.
    await expect(readFile(join(dir, R97_LEDGER_FILENAME), "utf8")).resolves.toBeTruthy();
  });
});

/**
 * E4-R98-A / finding F2 — "删除 campaign 输出后，同一批准不能重新获得额度".
 *
 * MEASURED DEFECT F2 (plan §0.2): the cross-directory guard treats a claim whose
 * directory no longer exists as GARBAGE, so an authorization that has already
 * SPENT its allowance can be refreshed simply by deleting the directory it was
 * spent in. The claim anchor records "this approval was claimed here" — a
 * durable fact — but the refusal was made to depend on the claiming directory
 * still being READABLE, which is exactly the state an operator deletes.
 *
 * THE CONTRACT THESE TESTS PIN (plan §A2 怎么验收):
 *
 *   "A 已消费完→删除 A→同批准打开 B：拒绝；provider 构造数和调用数均为 0."
 *   "同路径删除后重建、换 --out、换 --ledger 都不能刷新额度."
 *
 * The distinction that makes this honest rather than merely strict: a claim that
 * was only PROBED (an open that recorded the claim but never got as far as
 * creating a budget) is still ignorable, so a failed first run cannot wedge the
 * authorization forever. Only a claim that ESTABLISHED a budget — and therefore
 * may already have been billed — is authoritative.
 */
describe("R98-A L3c: a SPENT authorization is not refreshed by deleting its root", () => {
  it("REFUSES a new root after the root that SPENT the authorization was deleted", async () => {
    const dirA = await tempDir();
    const dirB = await tempDir();
    const plan = freshPlan();
    // A full, real campaign: grant=1, and the single call is CONSUMED.
    const a = await openR97Campaign(dirA, { planDigest: plan, campaignModelCalls: 1, mode: "first-run" });
    const reserved = await a.ledger.reserve("baseline", 1);
    expect(reserved.ok, "the campaign really had budget to spend").toBe(true);
    await a.ledger.commit(reserved.reservationId!, 1, 0);
    expect((await a.ledger.view()).committed, "the allowance is SPENT, not merely claimed").toBe(1);

    // The operator's cleanup: the whole root is removed, the claim anchor is not.
    await rm(dirA, { recursive: true, force: true });

    let caught: unknown = null;
    try {
      await openR97Campaign(dirB, { planDigest: plan, campaignModelCalls: 1, mode: "first-run" });
    } catch (err) {
      caught = err;
    }

    expect(caught, "deleting the spent root must NOT re-grant the approval").not.toBeNull();
    expect(String(caught)).toMatch(/CAMPAIGN_STATE_LOST/);
    // The refusal names the root that was lost, so an operator can go looking
    // for the record instead of guessing.
    expect(String(caught)).toContain(dirA);

    // NOTHING was created in B: no header, no ledger, no case state. That is the
    // observable form of "provider constructions and calls are 0" — the refusal
    // happens at open time, before any provider can exist.
    await expect(readFile(join(dirB, R97_CAMPAIGN_HEADER_FILENAME), "utf8")).rejects.toThrow();
    await expect(readFile(join(dirB, R97_LEDGER_FILENAME), "utf8")).rejects.toThrow();
    await expect(readFile(join(dirB, R97_EXEC_FILENAME), "utf8")).rejects.toThrow();
  });

  it("REFUSES the SAME path after it was deleted and recreated", async () => {
    // The most tempting bypass: `rm -rf out && run again`. The path is identical,
    // so nothing about the LOCATION reveals that the budget was already spent.
    const dir = await tempDir();
    const plan = freshPlan();
    const first = await openR97Campaign(dir, { planDigest: plan, campaignModelCalls: 1, mode: "first-run" });
    const reserved = await first.ledger.reserve("baseline", 1);
    await first.ledger.commit(reserved.reservationId!, 1, 0);

    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });

    let caught: unknown = null;
    try {
      await openR97Campaign(dir, { planDigest: plan, campaignModelCalls: 1, mode: "first-run" });
    } catch (err) {
      caught = err;
    }
    expect(caught, "a recreated path must not look like a fresh campaign").not.toBeNull();
    expect(String(caught)).toMatch(/CAMPAIGN_STATE_LOST/);

    // The refusal did not seed replacement state at the path either.
    await expect(readFile(join(dir, R97_CAMPAIGN_HEADER_FILENAME), "utf8")).rejects.toThrow();
    await expect(readFile(join(dir, R97_LEDGER_FILENAME), "utf8")).rejects.toThrow();
  });

  it("a NEW, independently authorized campaign is unaffected by a lost one", async () => {
    // The refusal must be scoped to the ONE authorization that was lost: a
    // different approved plan must still be able to start normally.
    const dirA = await tempDir();
    const dirB = await tempDir();
    const spentPlan = freshPlan();
    const a = await openR97Campaign(dirA, { planDigest: spentPlan, campaignModelCalls: 1, mode: "first-run" });
    const reserved = await a.ledger.reserve("baseline", 1);
    await a.ledger.commit(reserved.reservationId!, 1, 0);
    await rm(dirA, { recursive: true, force: true });

    // The lost authorization is refused...
    await expect(
      openR97Campaign(dirB, { planDigest: spentPlan, campaignModelCalls: 1, mode: "first-run" }),
    ).rejects.toThrow(/CAMPAIGN_STATE_LOST/);

    // ...while a DIFFERENT authorization in the very same directory succeeds.
    const fresh = await openR97Campaign(dirB, { planDigest: freshPlan(), campaignModelCalls: 1, mode: "first-run" });
    expect(fresh.mode).toBe("first-run");
    expect(await fresh.ledger.view()).toMatchObject({ granted: 1, remaining: 1 });
  });

  it("a claim that never ESTABLISHED a budget does not wedge a legitimate first run", async () => {
    // The honest limit of the rule. The anchor is written before the budget is
    // created, so an open that died in between leaves a claim naming a directory
    // that never held a campaign. Refusing on THAT would wedge the authorization
    // forever, so only an established claim is authoritative.
    const dirA = await tempDir();
    const dirB = await tempDir();
    const plan = freshPlan();
    const campaignId = campaignIdOf(plan, 2);
    // Simulate the interrupted open: the anchor records the probe, no campaign
    // was ever established there.
    await writeFile(
      join(CLAIMS_DIR, `claim-${campaignId}.json`),
      `${JSON.stringify({ campaignId, dir: dirA, claimedDirs: [dirA], establishedDirs: [], firstClaimedAt: 1 }, null, 2)}\n`,
      "utf8",
    );

    const second = await openR97Campaign(dirB, { planDigest: plan, campaignModelCalls: 2, mode: "first-run" });
    expect(second.mode).toBe("first-run");
    expect(await second.ledger.view()).toMatchObject({ granted: 2, remaining: 2 });
  });
});

/**
 * Plan §A2 怎么验收: "claims 文件损坏/不可读/写入失败均拒绝执行，且错误可诊断."
 *
 * The old reader returned `null` for ANY failure, which made a damaged anchor
 * indistinguishable from "this approval was never claimed" — the one reading that
 * silently mints a second allowance. Only a MISSING anchor may degrade that way.
 */
describe("R98-A L3e: a damaged claim anchor is refused, not read as 'unclaimed'", () => {
  it("REFUSES a CORRUPT claim anchor and creates no replacement state", async () => {
    const dir = await tempDir();
    const plan = freshPlan();
    const campaignId = campaignIdOf(plan, 1);
    await writeFile(join(CLAIMS_DIR, `claim-${campaignId}.json`), "{ this is not json", "utf8");

    await expect(
      openR97Campaign(dir, { planDigest: plan, campaignModelCalls: 1, mode: "first-run" }),
    ).rejects.toThrow(/CAMPAIGN_CLAIM_CORRUPT/);

    // The refusal happens BEFORE anything is created, so a damaged anchor can
    // never be laundered into a fresh budget.
    expect(existsSync(join(dir, R97_CAMPAIGN_HEADER_FILENAME))).toBe(false);
    expect(existsSync(join(dir, R97_LEDGER_FILENAME))).toBe(false);
  });

  it("REFUSES an UNREADABLE claim anchor and creates no replacement state", async () => {
    const dir = await tempDir();
    const plan = freshPlan();
    const campaignId = campaignIdOf(plan, 1);
    // A DIRECTORY where the claim RECORD must be: reading it fails with EISDIR,
    // which is NOT "absent" and must never be read as "this approval is free".
    await mkdir(join(CLAIMS_DIR, `claim-${campaignId}.json`), { recursive: true });

    await expect(
      openR97Campaign(dir, { planDigest: plan, campaignModelCalls: 1, mode: "first-run" }),
    ).rejects.toThrow(/CAMPAIGN_CLAIM_UNREADABLE/);

    expect(existsSync(join(dir, R97_CAMPAIGN_HEADER_FILENAME))).toBe(false);
    expect(existsSync(join(dir, R97_LEDGER_FILENAME))).toBe(false);
  });
});

/**
 * Plan §A2 怎么验收: "两个真实进程以 barrier 同时抢同一批准的两个根目录，至多一方获得
 * 预算；不靠长 sleep 猜测竞争时机."
 *
 * TWO REAL PROCESSES, released by a real barrier (each waits until BOTH have
 * announced readiness), so the two opens genuinely overlap. A `setTimeout` would
 * only guess at overlap; the barrier makes it certain.
 */
describe("R98-A L3f: two REAL processes racing one approval cannot both win", () => {
  it("at most ONE of two concurrently opened roots receives the approval's budget", async () => {
    const dirA = await tempDir();
    const dirB = await tempDir();
    const barrier = await tempDir();
    const plan = freshPlan();
    const lifecycleModule = pathToFileURL(join(process.cwd(), "packages", "evaluation", "dist", "r97-campaign-lifecycle.js")).href;

    const childScript = (dir: string, tag: string): string => `
      const fs = await import("node:fs/promises");
      const barrier = ${JSON.stringify(barrier)};
      await fs.mkdir(barrier, { recursive: true });
      await fs.writeFile(barrier + "/ready-" + ${JSON.stringify(tag)}, "1");
      // THE BARRIER: neither process may proceed until BOTH are ready, so the
      // two opens overlap by construction rather than by timing luck.
      for (;;) {
        const seen = [];
        for (const t of ["a", "b"]) {
          try { await fs.access(barrier + "/ready-" + t); seen.push(t); } catch {}
        }
        if (seen.length === 2) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      const m = await import(${JSON.stringify(lifecycleModule)});
      try {
        const c = await m.openR97Campaign(${JSON.stringify(dir)}, {
          planDigest: ${JSON.stringify(plan)}, campaignModelCalls: 1, mode: "first-run",
        });
        const v = await c.ledger.view();
        process.stdout.write(JSON.stringify({ ok: true, remaining: v.remaining, mode: c.mode }));
      } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, error: String(err) }));
      }
    `;

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const [ra, rb] = await Promise.all([
      run(process.execPath, ["--input-type=module", "-e", childScript(dirA, "a")], { timeout: 60_000 }),
      run(process.execPath, ["--input-type=module", "-e", childScript(dirB, "b")], { timeout: 60_000 }),
    ]);
    const results = [JSON.parse(ra.stdout), JSON.parse(rb.stdout)] as Array<{ ok: boolean; remaining?: number; error?: string }>;

    const winners = results.filter((r) => r.ok === true);
    expect(winners.length, "exactly ONE root may receive the approval's budget").toBe(1);
    expect(winners[0]!.remaining, "the winner got the WHOLE grant, not a share").toBe(1);

    // The loser was REFUSED BY NAME — not silently handed a second budget.
    const loser = results.find((r) => r.ok === false)!;
    expect(String(loser.error)).toMatch(/CAMPAIGN_DIR_CONFLICT|CAMPAIGN_STATE_LOST|BUDGET_CAMPAIGN_DIR_DUPLICATE/);
  }, 120_000);

  /**
   * FINDING (independent verifier probe P16/P17, plan §A2 怎么验收 4).
   *
   * The claim anchor's lock had NO staleness recovery, and `withClaimLock`
   * proceeded WITHOUT the lock when acquisition timed out — then deleted a lock
   * file it had never owned. So ONE leftover lock file from a crashed process
   * disabled the anchor's mutual exclusion completely: two barrier-released
   * processes each observed "not established" and each minted a FULL budget for a
   * single approval (measured: winners = 2).
   *
   * WHY THIS DRIVES `openR97BudgetLedger` DIRECTLY, and not `openR97Campaign`:
   * `openR97Campaign` writes a campaign header BEFORE it opens the ledger, and
   * the ledger's duplicate-directory liveness probe reads that header. That
   * second, INDEPENDENT guard already catches the loser, so a campaign-level test
   * passes with or without this lock and would pin nothing. Measured: with the
   * lock's staleness recovery reverted, the campaign-level form still reported
   * exactly one winner, while this ledger-level form reported TWO. The hole is in
   * the ledger API's own guard — which plan §A2 names — so that is what is pinned.
   *
   * The stale lock here is deliberately the LEGACY BARE-TOKEN form, which names
   * no owner and therefore cannot be checked for liveness — the case that has to
   * fall back to age.
   */
  it("a LEFTOVER claim lock from a crashed process cannot hand TWO roots the same approval", async () => {
    const dirA = await tempDir();
    const dirB = await tempDir();
    const barrier = await tempDir();
    const plan = freshPlan();
    const campaignId = campaignIdOf(plan, 1);
    const ledgerModule = pathToFileURL(join(process.cwd(), "packages", "evaluation", "dist", "r97-budget-ledger.js")).href;

    // THE ONLY failure injection: a lock file a crashed process left behind.
    //
    // It is BACKDATED so the age-based debris rule is satisfied deterministically
    // for both children from their very first attempt. Relying on wall-clock age
    // made this test depend on how loaded the machine was: under a full parallel
    // suite run the children could reach the 5s staleness bound at different
    // times, and the test flaked. The assertion below is unchanged — only the
    // input is now deterministic.
    const staleLock = join(CLAIMS_DIR, `claim-${campaignId}.json.lock`);
    await writeFile(staleLock, "stale-lock-from-a-crashed-process", "utf8");
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(staleLock, longAgo, longAgo);

    const childScript = (dir: string, tag: string): string => `
      const fs = await import("node:fs/promises");
      const barrier = ${JSON.stringify(barrier)};
      await fs.mkdir(barrier, { recursive: true });
      await fs.writeFile(barrier + "/ready-" + ${JSON.stringify(tag)}, "1");
      for (;;) {
        const seen = [];
        for (const t of ["a", "b"]) {
          try { await fs.access(barrier + "/ready-" + t); seen.push(t); } catch {}
        }
        if (seen.length === 2) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      const m = await import(${JSON.stringify(ledgerModule)});
      try {
        const l = await m.openR97BudgetLedger(${JSON.stringify(dir)}, {
          planDigest: ${JSON.stringify(plan)}, campaignModelCalls: 1, mode: "first-run",
        });
        const v = await l.view();
        process.stdout.write(JSON.stringify({ ok: true, remaining: v.remaining, mode: l.mode }));
      } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, error: String(err) }));
      }
    `;

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const [ra, rb] = await Promise.all([
      run(process.execPath, ["--input-type=module", "-e", childScript(dirA, "a")], { timeout: 60_000 }),
      run(process.execPath, ["--input-type=module", "-e", childScript(dirB, "b")], { timeout: 60_000 }),
    ]);
    const results = [JSON.parse(ra.stdout), JSON.parse(rb.stdout)] as Array<{ ok: boolean; remaining?: number; error?: string }>;

    const winners = results.filter((r) => r.ok === true);
    expect(winners.length, "a leftover lock must not let BOTH roots receive one approval's budget").toBe(1);
    expect(winners[0]!.remaining, "the winner got the WHOLE grant, not a share").toBe(1);
    expect(String(results.find((r) => r.ok === false)!.error)).toMatch(
      /CAMPAIGN_DIR_CONFLICT|CAMPAIGN_STATE_LOST|BUDGET_CAMPAIGN_DIR_DUPLICATE|CAMPAIGN_CLAIM_LOCK_HELD/,
    );
  }, 120_000);
});
