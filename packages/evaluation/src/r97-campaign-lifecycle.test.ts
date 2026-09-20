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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openR97Campaign,
  readR97CampaignHeader,
  R97_CAMPAIGN_HEADER_FILENAME,
  R97_CAMPAIGN_HEADER_MISSING,
  R97_CAMPAIGN_DIR_CONFLICT,
} from "./r97-campaign-lifecycle.js";
import { campaignIdOf, R97_CAMPAIGN_CLAIMS_DIR_ENV, R97_LEDGER_FILENAME } from "./r97-budget-ledger.js";

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

describe("R98-A L3b: a STALE claim does not wedge a legitimate new run", () => {
  it("allows a new root once the claiming directory is GONE", async () => {
    // The anchor is machine-global and advisory, so a directory it names may
    // since have been deleted (a cleaned CI workspace, a pruned temp dir). A
    // claim whose directory holds no campaign is NOT evidence of double-spend;
    // vetoing on it would wedge every later first run forever.
    const dirA = await tempDir();
    const dirB = await tempDir();
    const plan = freshPlan();
    await openR97Campaign(dirA, { planDigest: plan, campaignModelCalls: GRANT, mode: "first-run" });
    // The first campaign is removed entirely.
    await rm(dirA, { recursive: true, force: true });

    // The same authorization may now be started in B.
    const second = await openR97Campaign(dirB, { planDigest: plan, campaignModelCalls: GRANT, mode: "first-run" });
    expect(second.mode).toBe("first-run");
    expect(await second.ledger.view()).toMatchObject({ granted: GRANT, remaining: GRANT });
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
