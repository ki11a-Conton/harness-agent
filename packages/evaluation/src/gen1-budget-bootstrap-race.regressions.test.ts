import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

/** Delay only a real native ledger write: no budget validation, permission,
 * model call, or real claim-lock operation is mocked or skipped. A second
 * process must either observe contention or reach its own write before we
 * release the first, so the unprotected bootstrap window is deterministic. */
it("Gen1: one authorization cannot bootstrap two budgets while its first ledger write is delayed", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "gen1-budget-bootstrap-"));
  const claims = join(scratch, "claims"); await mkdir(claims);
  const modulePath = pathToFileURL(join(process.cwd(), "packages/evaluation/dist/r97-budget-ledger.js")).href;
  const plan = randomBytes(32).toString("hex");
  const children: ChildProcess[] = [];
  const completions: Array<Promise<{ code: number | null; stdout: string; stderr: string }>> = [];
  const exists = async (name: string) => { try { await access(join(scratch, name)); return true; } catch { return false; } };
  const waitFor = async (names: string[]) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      for (const name of names) if (await exists(name)) return name;
      if (Date.now() >= deadline) throw new Error(`barrier was not reached: ${names.join(", ")}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  const start = (tag: string) => {
    const script = `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const originalWrite = fs.writeFile;
      const originalOpen = fs.open;
      fs.writeFile = async function(path, ...args) {
        if (String(path).includes("budget-ledger.json.tmp-")) {
          await originalWrite(${JSON.stringify(scratch)} + "/ready-" + ${JSON.stringify(tag)}, "1");
          for (;;) { try { await fs.access(${JSON.stringify(scratch)} + "/release"); break; }
            catch { await new Promise(resolve => setTimeout(resolve, 5)); } }
        }
        return originalWrite(path, ...args);
      };
      fs.open = async function(path, ...args) {
        try { return await originalOpen(path, ...args); }
        catch (error) {
          if (${JSON.stringify(tag)} === "b" && String(path).endsWith(".json.lock") && error.code === "EEXIST")
            await originalWrite(${JSON.stringify(scratch)} + "/contended-b", "1");
          throw error;
        }
      };
      syncBuiltinESMExports();
      const { openR97BudgetLedger } = await import(${JSON.stringify(modulePath)});
      try {
        const ledger = await openR97BudgetLedger(${JSON.stringify(join(scratch, tag))}, {
          planDigest: ${JSON.stringify(plan)}, campaignModelCalls: 1, mode: "first-run",
        });
        console.log(JSON.stringify({ tag: ${JSON.stringify(tag)}, ok: true, view: await ledger.view() }));
      } catch (error) { console.log(JSON.stringify({ tag: ${JSON.stringify(tag)}, ok: false, error: String(error) })); }
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, R97_CAMPAIGN_CLAIMS_DIR: claims }, stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let stdout = "", stderr = "";
    child.stdout!.on("data", data => { stdout += data; });
    child.stderr!.on("data", data => { stderr += data; });
    completions.push(new Promise((resolve, reject) => {
      child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
    }));
  };
  try {
    start("a"); await waitFor(["ready-a"]);
    start("b"); await waitFor(["ready-b", "contended-b"]);
    await writeFile(join(scratch, "release"), "1");
    const results = await Promise.all(completions);
    expect(results.map(result => result.code)).toEqual([0, 0]);
    const records = results.map(result => JSON.parse(result.stdout) as { ok: boolean; view?: { remaining: number }; error?: string });
    expect(records.filter(record => record.ok), JSON.stringify(records)).toHaveLength(1);
    expect(records.find(record => record.ok)?.view?.remaining).toBe(1);
    expect(records.find(record => !record.ok)?.error).toMatch(/BUDGET_CAMPAIGN_DIR_DUPLICATE|CAMPAIGN_STATE_LOST|CAMPAIGN_CLAIM_LOCK_HELD/);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.allSettled(completions);
    await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}, 30_000);
