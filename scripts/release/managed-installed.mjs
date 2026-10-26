import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { verifyArchive } from "./portable.mjs";
import { verifyManagedBrowserChecks } from "./managed-checks.mjs";
const { values: v } = parseArgs({
  options: {
    archive: { type: "string" },
    out: { type: "string" },
    version: { type: "string" },
    "source-sha": { type: "string" },
    "playwright-module": { type: "string" },
    chromium: { type: "string" },
  },
});
for (const k of [
  "archive",
  "out",
  "version",
  "source-sha",
  "playwright-module",
  "chromium",
])
  assert(v[k], k);
const out = resolve(v.out),
  source = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
await mkdir(out, { recursive: true });
const verified = await verifyArchive({
  archive: resolve(v.archive),
  out: join(out, "extracted"),
  version: v.version,
  sourceSha: v["source-sha"],
});
const fixture = join(out, "fixture");
let stdout = "",
  stderr = "",
  host,
  hostExit;
const bounded = (p, ms, label) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(Error(label)), ms);
    p.then(
      (x) => {
        clearTimeout(t);
        res(x);
      },
      (e) => {
        clearTimeout(t);
        rej(e);
      },
    );
  });
try {
  host = spawn(
    process.execPath,
    [
      join(source, "scripts/research/deepseek-live-host.mjs"),
      "--root",
      fixture,
      "--portable-root",
      verified.root,
      "--preflight-owner",
      "--ipc-control",
      "--managed-commands",
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true },
  );
  const exit = (hostExit = new Promise((res, rej) => {
    host.once("error", rej);
    host.once("close", (code, signal) => res({ code, signal }));
  }));
  host.stdout.on("data", (b) => (stdout += b));
  host.stderr.on("data", (b) => (stderr += b));
  const origin = await bounded(
    new Promise((res, rej) => {
      host.stdout.on("data", () => {
        const match = stdout.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) res(match[1]);
      });
      exit.then((x) =>
        rej(
          Error("Host exited before ready " + JSON.stringify(x) + " " + stderr),
        ),
      );
    }),
    45000,
    "managed host not ready",
  );
  const runner = spawn(
    process.execPath,
    [
      join(source, "scripts/research/managed-commands-20261025/browser.mjs"),
      "--url",
      origin,
      "--output",
      join(out, "browser"),
      "--fixture-evidence",
      join(fixture, "evidence"),
      "--playwright-module",
      resolve(v["playwright-module"]),
      "--chromium",
      resolve(v.chromium),
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let log = "";
  runner.stdout.on("data", (b) => (log += b));
  runner.stderr.on("data", (b) => (log += b));
  let result;
  try {
    result = await bounded(
      new Promise((res, rej) => {
        runner.once("error", rej);
        runner.once("close", (code, signal) => res({ code, signal }));
      }),
      180000,
      "managed browser deadline",
    );
  } finally {
    if (runner.exitCode === null && runner.signalCode === null)
      runner.kill("SIGTERM");
    await writeFile(join(out, "browser.log"), log);
  }
  assert.equal(result.code, 0, log);
  const browser = JSON.parse(
    await readFile(join(out, "browser/result.json"), "utf8"),
  );
  verifyManagedBrowserChecks(browser);
  const launch = JSON.parse(
    await readFile(join(fixture, "evidence/launch.json"), "utf8"),
  );
  await unlink(join(launch.cwd, "managed-done.txt"));
  const cli = spawn(
    process.execPath,
    [
      join(verified.root, "node_modules/@ar/cli/dist/main.js"),
      "--data-dir",
      join(out, "cli-state"),
      "run",
      launch.cwd,
      "[fixture:managed] Installed CLI long check",
      "--verify",
      '"' + process.execPath + '" managed-verify.cjs',
    ],
    {
      cwd: launch.cwd,
      env: {
        ...process.env,
        OPENAI_API_KEY: "local-fixture-credential",
        OPENAI_BASE_URL: launch.providerOrigin,
        OPENAI_MODEL: "web-loopback-fixture",
        HARNESS_MANAGED_COMMANDS: "1",
        HARNESS_MANAGED_TURN_MS: "30000",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let cliOut = "",
    cliErr = "";
  cli.stdout.on("data", (b) => (cliOut += b));
  cli.stderr.on("data", (b) => (cliErr += b));
  cli.stdin.end("allow\n".repeat(20));
  let cliExit;
  try {
    cliExit = await bounded(
      new Promise((res, rej) => {
        cli.once("error", rej);
        cli.once("close", (code, signal) => res({ code, signal }));
      }),
      90000,
      "installed managed CLI deadline",
    );
  } finally {
    if (cli.exitCode === null && cli.signalCode === null) cli.kill("SIGTERM");
    await writeFile(join(out, "cli.stdout.log"), cliOut);
    await writeFile(join(out, "cli.stderr.log"), cliErr);
  }
  assert.equal(cliExit.code, 0, cliErr + "\n" + cliOut);
  assert(cliOut.includes("grade: verified_complete"), cliOut);
  assert.equal(
    await readFile(join(launch.cwd, "managed-done.txt"), "utf8"),
    "ACTUAL_MANAGED_OK",
  );
  const approvals = (cliErr.match(/allowed for this call/g) ?? []).length;
  assert(approvals >= 2, cliErr);
  await writeFile(
    join(out, "cli-result.json"),
    JSON.stringify(
      {
        status: "PASS",
        exitCode: 0,
        grade: "verified_complete",
        approvals,
        paidModelCalls: 0,
      },
      null,
      2,
    ) + "\n",
  );
  host.send({ type: "fixture-stop" });
  const ended = await bounded(exit, 20000, "managed shutdown deadline");
  assert.equal(ended.code, 0, stderr);
  host = undefined;
  await writeFile(
    join(out, "result.json"),
    JSON.stringify(
      {
        status: "PASS",
        sourceSha: verified.manifest.sourceSha,
        archiveSha256: verified.sha256,
        platform: process.platform,
        checks: browser.checks.length,
        cli: { status: "PASS", grade: "verified_complete", approvals },
        paidModelCalls: 0,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  if (host) {
    if (host.connected) host.send({ type: "fixture-stop" });
    else host.kill("SIGTERM");
    if (hostExit) await bounded(hostExit, 20000, "managed cleanup deadline");
  }
  await writeFile(join(out, "host.stdout.log"), stdout);
  await writeFile(join(out, "host.stderr.log"), stderr);
}
