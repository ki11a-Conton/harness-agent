/** Strict offline replay uses the recorded source's own rebuilt verifier.
 * Never substitute current facts for old facts or grant a new paid allowance. */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { assert, inside, readJson, REPO, sha256, verifyIndex } from "./execution-common.mjs";

export async function verifyHistoricalArchive({ role, archive, campaign, judge, sourceRepo = REPO }) {
  verifyIndex(archive);
  const binding = readJson(join(archive, "execution-binding.json"));
  const source = binding.source, sha = source?.sourceSha;
  assert(typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha), "HISTORICAL_SOURCE_INVALID");
  const repo = resolve(sourceRepo);
  const git = (args, cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try { assert(git(["rev-parse", `${sha}^{commit}`]).trim() === sha, "HISTORICAL_SOURCE_MISSING"); }
  catch { assert(false, "HISTORICAL_SOURCE_MISSING"); }
  const worktree = join(repo, ".ci", "n7-historical", randomUUID());
  await mkdir(join(repo, ".ci", "n7-historical"), { recursive: true });
  let added = false;
  try {
    git(["worktree", "add", "--detach", "--no-checkout", worktree, sha]); added = true;
    git(["-c", "core.autocrlf=false", "checkout", "--detach", sha], worktree);
    const requireFiles = (files, code) => {
      assert(Array.isArray(files) && files.length > 0, code);
      for (const file of files) {
        assert(typeof file.path === "string" && !/[\\\0]/.test(file.path) && !file.path.split("/").includes(".."), code);
        const path = resolve(worktree, file.path); inside(worktree, path);
        assert(existsSync(path), code);
        const bytes = readFileSync(path);
        assert(bytes.length === file.bytes && sha256(bytes) === file.sha256, code);
      }
    };
    requireFiles(source.sourceFiles, "HISTORICAL_SOURCE_BYTES_DRIFT");
    const env = { ...process.env, OPENAI_API_KEY: "", RUN_PAID_BENCHMARKS: "0", HARNESS_PROVIDER: "stub" };
    const run = (command, args, label) => {
      const result = spawnSync(command, args, { cwd: worktree, env, encoding: "utf8", timeout: 600000,
        maxBuffer: 4 * 1024 * 1024, shell: process.platform === "win32" && command === "pnpm" });
      assert(result.status === 0, `HISTORICAL_${label}_FAILED`);
      return result.stdout;
    };
    // Reuse the invoking checkout's declared cache, rather than falling back
    // to a global store that may be unwritable or lack the frozen dependencies.
    const modulesFile = join(repo, "node_modules", ".modules.yaml");
    const declaredStore = existsSync(modulesFile) ? readFileSync(modulesFile, "utf8").match(/^\s*["']?storeDir["']?:\s*["']?([^"'\r\n,]+)["']?,?\s*$/m)?.[1] : undefined;
    const store = declaredStore ? resolve(declaredStore.trim(), "..") : join(repo, ".ci", "n7-historical-store");
    run("pnpm", ["install", "--frozen-lockfile", "--offline", "--ignore-scripts", "--store-dir", store], "INSTALL");
    run("pnpm", ["build"], "BUILD");
    assert(git(["rev-parse", "HEAD"], worktree).trim() === sha && git(["status", "--porcelain", "--untracked-files=all"], worktree).trim() === "", "HISTORICAL_TREE_DRIFT");
    requireFiles(source.buildFiles, "HISTORICAL_BUILD_BYTES_DRIFT");
    const helper = join(worktree, "scripts/research/agent-next7-20261006/campaign-evidence.mjs");
    const { pathToFileURL } = await import("node:url");
    const code = `const {verifyArchive}=await import(${JSON.stringify(pathToFileURL(helper).href)});const judgment=await verifyArchive(...JSON.parse(process.argv[1]));process.stdout.write(JSON.stringify(judgment));`;
    const output = run(process.execPath, ["--input-type=module", "-e", code, JSON.stringify([role, archive, campaign, judge])], "VERIFY");
    return { sourceSha: sha, judgment: JSON.parse(output), paidCalls: 0 };
  } finally {
    if (added) git(["worktree", "remove", "--force", worktree]);
    else await rm(worktree, { recursive: true, force: true });
  }
}
