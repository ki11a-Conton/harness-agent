// E4-R92 probe: reproduce the Linux-only failure of the R91 end-to-end shim test.
//
// `describe("E4-R91: argv launch planning (platform-parameterised)")` is NOT
// platform-guarded, but its last test actually SPAWNS a `.cmd` shim resolved by
// bare name. On Windows that works (planArgvLaunch routes it through cmd.exe).
// On POSIX, planArgvLaunch passes the name straight to spawn — and POSIX spawn
// has no PATHEXT, so a file that exists only as `r91endtoend.cmd` is not found.
//
// This probe forces the POSIX decision locally (on Windows) so the defect is
// reproducible without a Linux box.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const repoRoot = process.argv[2] ?? process.cwd();
const executorUrl = pathToFileURL(join(repoRoot, "packages", "tools", "dist", "process", "executor.js")).href;
const { planArgvLaunch } = await import(executorUrl);

const dir = mkdtempSync(join(tmpdir(), "r92-posix-probe-"));
try {
  // Exactly the fixture the R91 end-to-end test creates: a .cmd shim only.
  const shim = join(dir, "r91endtoend.cmd");
  writeFileSync(shim, ["@echo off", "echo E2E_OK %1", "exit /b 0", ""].join("\r\n"), "utf8");

  const env = { ...process.env, PATH: `${dir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` };

  // What POSIX planning decides for this exact call.
  const posixPlan = planArgvLaunch("r91endtoend", ["arg"], env, "linux");
  console.log("POSIX plan:", JSON.stringify(posixPlan));

  // The test asserts status === "success". Under POSIX planning, spawn cannot
  // find a file literally named `r91endtoend` (no PATHEXT on POSIX).
  const outcome = await new Promise((resolve) => {
    let settled = false;
    const child = spawn(posixPlan.file, posixPlan.args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      resolve({ status: "error", error: `${err.code ?? err.name}: ${err.message}`, stdout });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      resolve({ status: code === 0 ? "success" : "nonzero", exitCode: code, stdout });
    });
  });

  console.log("POSIX outcome:", JSON.stringify(outcome));
  const wouldPass = outcome.status === "success" && String(outcome.stdout).includes("E2E_OK arg");
  console.log(`the test's assertion (status==="success" && stdout contains "E2E_OK arg") would ${wouldPass ? "PASS" : "FAIL"} on POSIX`);
  console.log(wouldPass ? "PROBE RESULT: cannot reproduce" : "PROBE RESULT: REPRODUCED (test fails on POSIX)");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
