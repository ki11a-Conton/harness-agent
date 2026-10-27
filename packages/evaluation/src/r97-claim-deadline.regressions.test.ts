import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({ mode: "", lock: "" }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (seam.mode === "open-eperm" && String(args[0]) === seam.lock && args[1] === "wx") {
        throw Object.assign(new Error("EPERM: controlled claim name contention"), { code: "EPERM" });
      }
      return actual.open(...args);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (seam.mode === "read-eperm" && String(args[0]) === seam.lock) {
        throw Object.assign(new Error("EPERM: controlled claim directory read"), { code: "EPERM" });
      }
      return actual.readFile(...args);
    },
  };
});
import { campaignIdOf, openR97BudgetLedger, R97_CAMPAIGN_CLAIMS_DIR_ENV } from "./r97-budget-ledger.js";
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "claim-deadline-"));
  seam.mode = ""; seam.lock = "";
  vi.stubEnv(R97_CAMPAIGN_CLAIMS_DIR_ENV, join(root, "claims"));
});
afterEach(async () => {
  seam.mode = ""; seam.lock = ""; vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

it.each(["live-owner", "read-eperm", "open-eperm", "reclaim-guard"])(
  "configured ledger timeout reaches the claim lock under %s without replacing its owner",
  async mode => {
    const ledger = join(root, "ledger"), claims = join(root, "claims");
    await mkdir(ledger); await mkdir(claims);
    const planDigest = "claim-deadline-propagation";
    seam.lock = join(claims, `claim-${campaignIdOf(planDigest, 1)}.json.lock`);
    const ownerPath = mode === "reclaim-guard" ? seam.lock + ".reclaim" : seam.lock;
    const owner = JSON.stringify({ token: "live-owner", pid: process.pid, host: hostname(), acquiredAt: 0 });
    await writeFile(ownerPath, owner);
    seam.mode = mode;
    // A controllable clock makes the timeout contract deterministic. Every
    // retry crosses the caller's 100 ms budget; no real startup timing involved.
    let tick = 0;
    await expect(openR97BudgetLedger(ledger, { planDigest, campaignModelCalls: 1, mode: "first-run",
      lockTimeoutMs: 100, now: () => { const value = tick; tick += 250; return value; },
    })).rejects.toThrow(/CAMPAIGN_CLAIM_LOCK_HELD:.*within 100ms/);
    expect(await actual.readFile(ownerPath, "utf8")).toBe(owner);
    expect(await readdir(ledger)).toEqual([]);
    expect(await readdir(claims)).toEqual([basename(ownerPath)]);
    // A refusal releases only our own ledger/takeover resources; once the
    // external holder is explicitly removed a fresh authorized open succeeds.
    seam.mode = "";
    await rm(ownerPath);
    const fresh = await openR97BudgetLedger(ledger, { planDigest, campaignModelCalls: 1, mode: "first-run", lockTimeoutMs: 100 });
    expect((await fresh.view()).remaining).toBe(1);
  },
);
