// E4-R91 (H1) acceptance probe — runs the REAL ProcessExecutor against REAL
// Windows script shims. This is deliberately not a mock: the whole point of H1
// is that `spawn(..., {shell:false})` could not START these files at all.
//
// Called from CI (windows-latest) and runnable locally. Exits non-zero on any
// violation so the CI step's `$LASTEXITCODE` check is meaningful.
//
// Assertions:
//   1. a `.cmd` shim resolved by BARE NAME (the reg-27 `npx` shape) RUNS;
//   2. a `.ps1` script RUNS and receives a dash-leading argument literally;
//   3. a metacharacter argument is REFUSED and creates NO sentinel file
//      (i.e. no second command executed);
//   4. an unsupported script type fails closed with an actionable reason.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessExecutor } from "../../packages/tools/dist/process/executor.js";

const probe = process.env.R91_PROBE ?? join(tmpdir(), `r91ci-${Date.now()}`);
mkdirSync(probe, { recursive: true });

const fail = (msg) => {
  console.error(`R91CI FAIL: ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`R91CI OK: ${msg}`);

const exe = new ProcessExecutor();
const env = { PATH: `${probe};${process.env.PATH ?? ""}` };

// ---- 1. bare-name .cmd shim (the exact shape that returned ENOENT) ----
const shim = join(probe, "r91ci.cmd");
writeFileSync(shim, "@echo off\r\necho R91CI_OK %1\r\nexit /b 0\r\n", "utf8");

const bare = await exe.runArgv({ file: "r91ci", args: ["ran"], cwd: probe, env });
if (bare.status !== "success" || !bare.stdout.includes("R91CI_OK ran")) {
  fail(`a bare-name .cmd shim did not run: ${JSON.stringify(bare)}`);
} else {
  ok(`bare-name .cmd shim ran (exit ${bare.exitCode}): ${bare.stdout.trim()}`);
}

// ---- 2. .ps1 with a dash-leading argument ----
const ps1 = join(probe, "r91ci.ps1");
writeFileSync(ps1, ["$o = ($args | ForEach-Object { \"[$_]\" }) -join ''", "Write-Output $o", "exit 0", ""].join("\n"), "utf8");

const ps = await exe.runArgv({ file: ps1, args: ["tsc", "--noEmit", "src/ann.ts"], cwd: probe });
if (ps.status !== "success" || ps.stdout.trim() !== "[tsc][--noEmit][src/ann.ts]") {
  fail(`a .ps1 script did not receive its arguments literally: ${JSON.stringify(ps)}`);
} else {
  ok(`.ps1 received dash-leading args literally: ${ps.stdout.trim()}`);
}

// ---- 3. injection refusal: no sentinel may appear ----
const sentinel = process.env.R91_SENTINEL ?? join(probe, "PWNED.txt");
rmSync(sentinel, { force: true });
const bad = await exe.runArgv({ file: "r91ci", args: [`a&echo PWNED>${sentinel}&rem`], cwd: probe, env });
if (bad.status !== "error") {
  fail(`a cmd metacharacter argument was NOT refused: ${JSON.stringify(bad)}`);
} else if (existsSync(sentinel)) {
  fail(`INJECTION: a metacharacter argument created ${sentinel}`);
} else if (bad.stdout !== "") {
  fail(`the refused shim still produced output: ${JSON.stringify(bad.stdout)}`);
} else {
  ok("metacharacter argument refused, no sentinel created, nothing executed");
}

// ---- 4. unsupported script type fails closed ----
const wsf = join(probe, "r91ci.wsf");
writeFileSync(wsf, "x", "utf8");
const unsupported = await exe.runArgv({ file: wsf, args: [], cwd: probe });
if (unsupported.status !== "error" || !(unsupported.error ?? "").match(/deterministically/i)) {
  fail(`an unsupported script type did not fail closed: ${JSON.stringify(unsupported)}`);
} else {
  ok("unsupported script type failed closed with an actionable reason");
}

console.log(process.exitCode === 1 ? "R91CI: FAILURES ABOVE" : "R91CI: all real Windows launch checks passed");
