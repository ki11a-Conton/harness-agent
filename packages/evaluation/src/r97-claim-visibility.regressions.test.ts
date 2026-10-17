import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const seam = vi.hoisted(() => ({
  rename: undefined as undefined | ((from: string, to: string) => Promise<void>),
  missing: undefined as undefined | ((path: string) => void),
}));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual,
    rename: (from: string, to: string) => seam.rename?.(from, to) ?? actual.rename(from, to),
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      try { return await actual.readFile(...args); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") seam.missing?.(String(args[0])); throw error; }
    },
  };
});
import { campaignIdOf, markR97CampaignClaimEstablished, readR97CampaignClaim, R97_CAMPAIGN_CLAIMS_DIR_ENV } from "./r97-budget-ledger.js";
const dirs: string[] = [];
const previous = process.env[R97_CAMPAIGN_CLAIMS_DIR_ENV];
afterEach(async () => {
  seam.rename = undefined; seam.missing = undefined;
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
  const reader = readR97CampaignClaim(id);
  try {
    await absence; release(); await writer;
    const result = await reader;
    expect(result).not.toBeNull();
    expect(result!.establishedDirs).toEqual(["seed", "next"]);
  } finally { release(); await writer; }
});
it("a truly absent approval remains absent and a read creates no claim record", async () => {
  const { dir, id } = await fixture();
  expect(await readR97CampaignClaim(id)).toBeNull();
  expect(await readdir(dir)).toEqual([]);
});
