import { spawn, type ChildProcess } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { withR97CampaignLock } from "./r97-budget-ledger.js";

it("Gen1: a delayed stale reclaimer cannot remove another reclaimer's new live ledger lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "gen1-ledger-takeover-"));
  const lock = join(root, "budget-ledger.lock");
  await writeFile(lock, JSON.stringify({ token: "dead-owner", pid: 2147483647, host: hostname(), acquiredAt: 0 }));
  const source = pathToFileURL(join(process.cwd(), "packages/evaluation/dist/r97-budget-ledger.js")).href;
  const children: ChildProcess[] = [];
  const completions: Array<Promise<{ code: number | null; stdout: string; stderr: string }>> = [];
  const exists = async (name: string) => { try { await access(join(root, name)); return true; } catch { return false; } };
  const waitFor = async (names: string[]) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      for (const name of names) if (await exists(name)) return name;
      if (Date.now() >= deadline) throw new Error(`barrier not reached: ${names.join(", ")}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  const start = (tag: string) => {
    const script = `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const originalRm = fs.rm, originalOpen = fs.open;
      let first = true;
      fs.rm = async function(path, ...args) {
        if (String(path) === ${JSON.stringify(lock)} && first) {
          first = false; await fs.writeFile(${JSON.stringify(root)} + "/rm-ready-" + ${JSON.stringify(tag)}, "1");
          for (;;) { try { await fs.access(${JSON.stringify(root)} + "/remove-" + ${JSON.stringify(tag)}); break; }
            catch { await new Promise(resolve => setTimeout(resolve, 5)); } }
        }
        return originalRm(path, ...args);
      };
      fs.open = async function(path, ...args) {
        try { return await originalOpen(path, ...args); }
        catch(error) {
          if (${JSON.stringify(tag)} === "b" && error.code === "EEXIST") {
            const name = String(path).endsWith(".reclaim") ? "/guard-blocked-b" : "/main-blocked-b";
            await fs.writeFile(${JSON.stringify(root)} + name, "1");
          }
          throw error;
        }
      };
      syncBuiltinESMExports();
      const {withR97CampaignLock}=await import(${JSON.stringify(source)});
      let overlap = false;
      try {
        await withR97CampaignLock(${JSON.stringify(root)}, async () => {
          await fs.writeFile(${JSON.stringify(root)} + "/held-" + ${JSON.stringify(tag)}, "1");
          if (${JSON.stringify(tag)} === "a") {
            for (;;) { try { await fs.access(${JSON.stringify(root)} + "/release-a"); break; }
              catch { await new Promise(resolve => setTimeout(resolve, 5)); } }
            await fs.writeFile(${JSON.stringify(root)} + "/released-a", "1");
          } else {
            try { await fs.access(${JSON.stringify(root)} + "/held-a");
              try { await fs.access(${JSON.stringify(root)} + "/released-a"); }
              catch { overlap = true; }
            } catch {}
          }
        }, {lockTimeoutMs: 5000});
        console.log(JSON.stringify({tag:${JSON.stringify(tag)},ok:true,overlap}));
      } catch(error) { console.log(JSON.stringify({tag:${JSON.stringify(tag)},ok:false,error:String(error)})); }
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(child); let stdout = "", stderr = "";
    child.stdout!.on("data", data => { stdout += data; }); child.stderr!.on("data", data => { stderr += data; });
    completions.push(new Promise((resolve, reject) => { child.on("error", reject); child.on("close", code => resolve({code,stdout,stderr})); }));
  };
  try {
    start("a"); await waitFor(["rm-ready-a"]);
    start("b"); await waitFor(["rm-ready-b", "guard-blocked-b"]);
    await writeFile(join(root, "remove-a"), "1"); await waitFor(["held-a"]);
    await writeFile(join(root, "remove-b"), "1");
    await waitFor(["held-b", "main-blocked-b"]);
    await writeFile(join(root, "release-a"), "1");
    const results = await Promise.all(completions);
    expect(results.map(result => result.code)).toEqual([0, 0]);
    const records = results.map(result => JSON.parse(result.stdout) as {ok:boolean;overlap?:boolean});
    expect(records, JSON.stringify(results)).toEqual([
      {tag:"a",ok:true,overlap:false}, {tag:"b",ok:true,overlap:false},
    ]);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.allSettled(completions);
    await rm(root, {recursive:true,force:true,maxRetries:3,retryDelay:50});
  }
}, 30_000);

it("Gen1: a leftover takeover guard is a bounded refusal, never silently stolen", async () => {
  const root = await mkdtemp(join(tmpdir(), "gen1-leftover-guard-"));
  const guard = join(root, "budget-ledger.lock.reclaim");
  const bytes = JSON.stringify({token:"dead-guard",pid:2147483647,host:hostname(),acquiredAt:0});
  try {
    await writeFile(guard, bytes);
    await expect(withR97CampaignLock(root, async () => "must not execute", {lockTimeoutMs:100})).rejects.toThrow(/BUDGET_LOCK_HELD.*takeover guard/);
    expect(await readFile(guard,"utf8")).toBe(bytes);
  } finally { await rm(root,{recursive:true,force:true}); }
});
