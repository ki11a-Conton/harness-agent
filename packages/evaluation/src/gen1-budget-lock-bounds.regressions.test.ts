import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { campaignIdOf } from "./r97-budget-ledger.js";

it.each(["ledger-directory", "claim-directory", "persistent-eperm"])(
  "Gen1: %s cannot bypass the lock deadline or spin forever",
  async mode => {
    const root = await mkdtemp(join(tmpdir(), "gen1-lock-bounds-"));
    const ledger = join(root, "ledger"); await mkdir(ledger);
    const claims = join(root, "claims"); await mkdir(claims);
    const plan = "gen1-lock-bounds";
    if (mode === "ledger-directory") await mkdir(join(ledger, "budget-ledger.lock"));
    if (mode === "claim-directory") await mkdir(join(claims, `claim-${campaignIdOf(plan, 1)}.json.lock`));
    const source = pathToFileURL(join(process.cwd(), "packages/evaluation/dist/r97-budget-ledger.js")).href;
    const script = `
      const {openR97BudgetLedger,withR97CampaignLock}=await import(${JSON.stringify(source)});
      try {
        if (${JSON.stringify(mode)} === "persistent-eperm") {
          await withR97CampaignLock(${JSON.stringify(ledger)}, async () => "unexpected", {
            lockTimeoutMs: 100,
            openFn: async () => { const error=new Error("EPERM: transient name unavailable"); error.code="EPERM"; throw error; },
          });
        } else await openR97BudgetLedger(${JSON.stringify(ledger)}, {
          planDigest: ${JSON.stringify(plan)}, campaignModelCalls: 1, mode: "first-run", lockTimeoutMs: 100,
        });
        console.log("unexpected success");
      } catch(error) { console.log(String(error)); }
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, R97_CAMPAIGN_CLAIMS_DIR: claims }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout!.on("data", data => { stdout += data; });
    child.stderr!.on("data", data => { stderr += data; });
    let completed = false;
    const completion = new Promise<void>((resolve, reject) => {
      child.on("error", reject); child.on("close", () => { completed = true; resolve(); });
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([completion, new Promise<void>(resolve => { timeout = setTimeout(resolve, 2000); })]);
      expect(completed, `declared lock deadline was bypassed: stdout=${stdout}, stderr=${stderr}`).toBe(true);
      expect(stdout).toMatch(/BUDGET_LOCK_HELD|CAMPAIGN_CLAIM_LOCK_HELD|EISDIR/);
      expect(stdout).not.toContain("unexpected success");
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (child.exitCode === null) child.kill("SIGKILL");
      await completion;
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }, 10_000,
);
