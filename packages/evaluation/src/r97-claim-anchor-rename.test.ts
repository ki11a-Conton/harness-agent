/**
 * E4-R97 N1 — THE CLAIM-ANCHOR REPLACE RETRIES *ONLY* TRANSIENT WINDOWS
 * CONTENTION, AND A RENAME THAT STILL FAILS IS A NAMED REFUSAL.
 *
 * WHY THIS FILE EXISTS — evidence, not implementation.
 * ---------------------------------------------------
 * Plan §N1 怎么验收: "单独验证真正坏文件、无权限或注入 write/rename 失败仍然
 * fail closed" ("independently verify that a genuinely damaged file, a missing
 * permission, or an INJECTED write/rename failure still fails closed").
 *
 * The atomic claim replace (r97-budget-ledger.ts, `writeClaimAtomic`) renames a
 * unique same-directory temp file over the anchor. On Windows that replace is
 * CONTENDED: an EXTERNAL, transient lock on the freshly closed temp file (a
 * real-time antivirus / filesystem indexer scanning a burst of new files) makes
 * the rename fail with `EPERM`/`EACCES`/`EBUSY`. The Windows CI leg of the N1
 * race test produced exactly that — `EPERM: operation not permitted, rename …`
 * (run 36010819289) — even though the location was writable, and the FIRST
 * budget (5 attempts / ~0.5s) was not enough for the burst, which is why the
 * retry is now generous and exponential. (It is NOT the lock-free reader: every
 * `node:fs` open passes `FILE_SHARE_DELETE`, so a reader cannot block the
 * replace.)
 *
 * That behavior cannot be reproduced deterministically OFF Windows, and the
 * Windows leg that does reproduce it is intermittent by nature, so a real
 * `EPERM` is a poor regression guard. This file instead injects the errno at the
 * `node:fs/promises` boundary — the SAME boundary the production code calls —
 * and pins the three properties the retry must have:
 *
 *   1. TRANSIENT CONTENTION NO LONGER REFUSES A WRITABLE ANCHOR. A rename that
 *      fails with EPERM a few times and then succeeds must end in a COMPLETE new
 *      anchor, not a `CAMPAIGN_CLAIM_WRITE_FAILED`.
 *   2. A PERMANENT ERRNO IS NOT RETRIED. A non-sharing error (here ENOENT) is
 *      thrown on the FIRST attempt, so the retry can never delay or soften a
 *      real, non-transient failure.
 *   3. EXHAUSTED TRANSIENT RETRIES STILL FAIL CLOSED. An anchor that can never
 *      be replaced ends in the named `CAMPAIGN_CLAIM_WRITE_FAILED` refusal, and
 *      the previous COMPLETE anchor is left byte-identical — a rename failure is
 *      never allowed to become "this approval was free".
 *
 * Only `rename` is intercepted; every other filesystem call stays the REAL one,
 * so the anchors, locks and dirs here are genuine.
 */

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The override lives in a `vi.hoisted` box so the mock factory below can install
 * a pass-through `rename` whose behavior a test changes at will. `null` override
 * means "call the real rename", so the mocked module is inert by default.
 */
const h = vi.hoisted(() => ({
  real: null as null | ((from: string, to: string) => Promise<void>),
  override: null as null | ((from: string, to: string) => Promise<void>),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  h.real = actual.rename as (from: string, to: string) => Promise<void>;
  return {
    ...actual,
    rename: (from: string, to: string): Promise<void> => {
      const impl = h.override ?? h.real;
      if (impl === null) throw new Error("test harness: real rename was never captured");
      return impl(from, to);
    },
  };
});

import {
  campaignIdOf,
  markR97CampaignClaimEstablished,
  readR97CampaignClaim,
  R97_CAMPAIGN_CLAIM_WRITE_FAILED,
  R97_CAMPAIGN_CLAIMS_DIR_ENV,
  type R97CampaignClaim,
} from "./r97-budget-ledger.js";

const CLAIMS_DIR = await mkdtemp(join(tmpdir(), "r97-claim-rename-"));
process.env[R97_CAMPAIGN_CLAIMS_DIR_ENV] = CLAIMS_DIR;

afterEach(() => {
  h.override = null;
});
afterAll(async () => {
  delete process.env[R97_CAMPAIGN_CLAIMS_DIR_ENV];
  await rm(CLAIMS_DIR, { recursive: true, force: true }).catch(() => {});
});

/** A fresh authorization per test, so no two tests share an anchor. */
let seq = 0;
function freshCampaignId(): string {
  seq += 1;
  return campaignIdOf(`${seq.toString(16).padStart(2, "0")}${"a".repeat(62)}`, 3);
}

/** Write a COMPLETE version-0 anchor and return its exact bytes. */
async function seedAnchor(campaignId: string): Promise<{ path: string; text: string }> {
  const seeded: R97CampaignClaim = {
    campaignId,
    dir: "/n1-rename/seed-dir",
    claimedDirs: ["/n1-rename/seed-dir"],
    establishedDirs: ["/n1-rename/seed-dir"],
    firstClaimedAt: 1,
  };
  const path = join(CLAIMS_DIR, `claim-${campaignId}.json`);
  const text = `${JSON.stringify(seeded, null, 2)}\n`;
  await writeFile(path, text, "utf8");
  return { path, text };
}

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: injected rename failure`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("R98-N1: the claim-anchor rename — transient contention retried, everything else unchanged", () => {
  it("a TRANSIENT EPERM no longer refuses a writable anchor", async () => {
    const campaignId = freshCampaignId();
    const { path } = await seedAnchor(campaignId);

    // The Windows contention shape: the FIRST three renames collide with a
    // reader, then the reader lets go and the rename succeeds.
    let calls = 0;
    h.override = async (from, to) => {
      calls += 1;
      if (calls <= 3) throw errno("EPERM");
      await h.real!(from, to);
    };

    await markR97CampaignClaimEstablished(campaignId, "/n1-rename/new-dir");

    // The write went through after retrying — NOT a refusal.
    expect(calls).toBe(4);
    const after = await readR97CampaignClaim(campaignId);
    expect(after?.claimedDirs).toContain("/n1-rename/new-dir");
    expect(after?.establishedDirs).toContain("/n1-rename/new-dir");
    // And it is a COMPLETE record on disk, not a torn one.
    const onDisk = await readFile(path, "utf8");
    expect(() => JSON.parse(onDisk) as unknown).not.toThrow();
    expect(onDisk.endsWith("\n")).toBe(true);
  });

  it("a PERMANENT errno is NOT retried — it fails on the FIRST attempt", async () => {
    const campaignId = freshCampaignId();
    const { path, text } = await seedAnchor(campaignId);

    let calls = 0;
    h.override = async () => {
      calls += 1;
      throw errno("ENOENT");
    };

    await expect(markR97CampaignClaimEstablished(campaignId, "/n1-rename/new-dir")).rejects.toThrow(
      new RegExp(R97_CAMPAIGN_CLAIM_WRITE_FAILED),
    );
    // A non-sharing errno means "do not retry" — exactly ONE attempt.
    expect(calls, "a permanent errno must not be retried").toBe(1);
    // Fail closed: the previous COMPLETE anchor is untouched.
    expect(await readFile(path, "utf8")).toBe(text);
  });

  it("EXHAUSTED transient retries still end in the named refusal, anchor intact", async () => {
    const campaignId = freshCampaignId();
    const { path, text } = await seedAnchor(campaignId);

    let calls = 0;
    h.override = async () => {
      calls += 1;
      throw errno("EPERM");
    };

    await expect(markR97CampaignClaimEstablished(campaignId, "/n1-rename/new-dir")).rejects.toThrow(
      new RegExp(R97_CAMPAIGN_CLAIM_WRITE_FAILED),
    );
    // Bounded: the retry gives up (it does not loop forever), and it never
    // degrades into "this approval was free".
    expect(calls, "transient retries must be bounded").toBe(20);
    expect(await readFile(path, "utf8")).toBe(text);
  });
});