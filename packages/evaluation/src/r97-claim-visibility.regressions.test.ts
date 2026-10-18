import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const seam = vi.hoisted(() => ({
  rename: undefined as undefined | ((from: string, to: string) => Promise<void>),
  missing: undefined as undefined | ((path: string) => void),
  openFailures: [] as string[],
  claimOpenAttempts: 0,
}));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (String(args[0]).endsWith(".json.lock") && args[1] === "wx") {
        seam.claimOpenAttempts++;
        const code = seam.openFailures.shift();
        if (code !== undefined) throw Object.assign(new Error(`${code}: controlled claim lock open`), { code });
      }
      return actual.open(...args);
    },
    rename: (from: string, to: string) => seam.rename?.(from, to) ?? actual.rename(from, to),
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      try { return await actual.readFile(...args); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") seam.missing?.(String(args[0])); throw error; }
    },
  };
});
import { campaignIdOf, markR97CampaignClaimEstablished, readR97CampaignClaim, R97_CAMPAIGN_CLAIM_LOCK_HELD, R97_CAMPAIGN_CLAIMS_DIR_ENV } from "./r97-budget-ledger.js";
const dirs: string[] = [];
const previous = process.env[R97_CAMPAIGN_CLAIMS_DIR_ENV];
afterEach(async () => {
  seam.rename = undefined; seam.missing = undefined;
  seam.openFailures = []; seam.claimOpenAttempts = 0;
  if (previous === undefined) delete process.env[R97_CAMPAIGN_CLAIMS_DIR_ENV]; else process.env[R97_CAMPAIGN_CLAIMS_DIR_ENV] = previous;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "claim-read-")); dirs.push(dir);
  process.env[R97_CAMPAIGN_CLAIMS_DIR_ENV] = dir;
  const id = campaignIdOf("c".repeat(64), 1), path = join(dir, `claim-${id}.json`);
  return { dir, id, path };
}
it("an ENOENT observed while the real writer owns the claim lock is not an unclaimed approval", async () => {
  const { id, path } = await fixture();
  const seed = { campaignId: id, dir: "seed", claimedDirs: ["seed"], establishedDirs: ["seed"], firstClaimedAt: 1 };
  await writeFile(path, JSON.stringify(seed));
  // Model the observed Windows name-visibility window at the actual FS seam.
  // The production writer still owns its real cross-process claim lock.
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let expose!: () => void, release!: () => void, observed!: () => void;
  const gap = new Promise<void>(done => { expose = done; });
  const continueWrite = new Promise<void>(done => { release = done; });
  const absence = new Promise<void>(done => { observed = done; });
  seam.rename = async (from, to) => {
    if (to !== path) return actual.rename(from, to);
    await actual.rename(path, path + ".old"); expose();
    await continueWrite; await actual.rename(from, to);
  };
  seam.missing = candidate => { if (candidate === path) observed(); };
  const writer = markR97CampaignClaimEstablished(id, "next");
  await Promise.race([gap, writer]);
  // Windows can report EPERM for the contender's exclusive open while the
  // writer releases its name. Exercise that same branch deterministically.
  seam.openFailures = ["EPERM", "EPERM"];
  const reader = readR97CampaignClaim(id).then(value => ({ value }), error => ({ error }));
  try {
    await absence; release(); await writer;
    const outcome = await reader;
    if ("error" in outcome) throw outcome.error;
    const result = outcome.value;
    expect(result).not.toBeNull();
    expect(result!.establishedDirs).toEqual(["seed", "next"]);
    expect(seam.openFailures).toEqual([]);
  } finally { release(); await writer; }
});
it("a truly absent approval remains absent and a read creates no claim record", async () => {
  const { dir, id } = await fixture();
  expect(await readR97CampaignClaim(id)).toBeNull();
  expect(await readdir(dir)).toEqual([]);
});

async function establishedFixture() {
  const value = await fixture();
  const seed = { campaignId: value.id, dir: "seed", claimedDirs: ["seed"], establishedDirs: ["seed"], firstClaimedAt: 1 };
  const text = JSON.stringify(seed); await writeFile(value.path, text);
  return { ...value, seed, text };
}

it("transient EPERM creating the claim anchor lock still updates one established approval", async () => {
  const { dir, id, path } = await establishedFixture();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let commits = 0;
  seam.rename = async (from, to) => { if (to === path) commits++; await actual.rename(from, to); };
  seam.openFailures = ["EPERM", "EPERM"];
  await markR97CampaignClaimEstablished(id, "next");
  expect(seam.claimOpenAttempts).toBe(3); expect(seam.openFailures).toEqual([]); expect(commits).toBe(1);
  expect((await readR97CampaignClaim(id))!.establishedDirs).toEqual(["seed", "next"]);
  expect(await readdir(dir)).toEqual([basename(path)]);
});

it("persistent claim lock EPERM fails within the original deadline without changing approval", async () => {
  const { dir, id, path, text } = await establishedFixture();
  seam.openFailures = Array(100).fill("EPERM"); let tick = 0;
  await expect(markR97CampaignClaimEstablished(id, "must-not-commit", () => { const value = tick; tick += 2000; return value; }))
    .rejects.toThrow(R97_CAMPAIGN_CLAIM_LOCK_HELD);
  expect(seam.claimOpenAttempts).toBeGreaterThan(1); expect(seam.claimOpenAttempts).toBeLessThan(10);
  expect(await readFile(path, "utf8")).toBe(text); expect(await readdir(dir)).toEqual([basename(path)]);
});

it("claim lock EPERM never steals a live owner or writes without its own lock", async () => {
  const { id, path, text } = await establishedFixture();
  const holder = JSON.stringify({ token: "live-owner", pid: process.pid, host: "test", acquiredAt: 0 });
  await writeFile(path + ".lock", holder); seam.openFailures = ["EPERM"]; let tick = 0;
  await expect(markR97CampaignClaimEstablished(id, "must-not-commit", () => { const value = tick; tick += 2000; return value; }))
    .rejects.toThrow(R97_CAMPAIGN_CLAIM_LOCK_HELD);
  expect(await readFile(path + ".lock", "utf8")).toBe(holder); expect(await readFile(path, "utf8")).toBe(text);
});

it.each(["EACCES", "ENOSPC"])("unrelated claim lock open failure %s propagates immediately", async code => {
  const { dir, id, path, text } = await establishedFixture(); seam.openFailures = [code];
  await expect(markR97CampaignClaimEstablished(id, "must-not-commit")).rejects.toMatchObject({ code });
  expect(seam.claimOpenAttempts).toBe(1); expect(await readFile(path, "utf8")).toBe(text);
  expect(await readdir(dir)).toEqual([basename(path)]);
});
