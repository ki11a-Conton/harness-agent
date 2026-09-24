#!/usr/bin/env node
// E4-R89 test fixture: a FAKE benchmark CLI.
//
// It exists so the campaign runner's PAID-SHAPED control flow (argv, exit codes,
// resume, quarantine) can be covered end to end with ZERO provider calls and
// ZERO network access. It never reads a key and never opens a socket.
//
// Behaviour is controlled by environment variables:
//   FAKE_CLI_LOG        append one JSON line per invocation (argv + cwd)
//   FAKE_CLI_MODE       ok | truncate | wrongmodel | wrongsuite | wrongtask |
//                       exit1 | noreport | dryrunfail
//   FAKE_CLI_STATE_DIR  where the "request sent" marker is written (crash sim)
//
// E4-R94 additions (the six termination points of the interruption contract):
//   FAKE_CLI_CRASH      after-start | after-request | after-report |
//                       before-completion   (unset = no crash)
//   FAKE_CLI_SLOW_MS    busy-wait before the request phase (lock/concurrency tests)
//   FAKE_CLI_SLOW_AFTER_REPORT_MS
//                       busy-wait AFTER the durable report, before exiting
//   FAKE_CLI_HANG       before-report -> never write a report, never exit
//   FAKE_CLI_PID_FILE   write this process's pid, so a test can kill exactly it
//
// Supported shapes (mirroring the real CLI contract):
//   benchmark --suite <s> --cases <dir> ... --dry-run
//       -> prints {"planDigest":"<hex>"} and exits 0
//   benchmark --suite <s> --cases <dir> ... --plan-digest <d> --out <dir>
//       -> writes <dir>/<baseline|suite>.json and exits 0
//
// E4-R94: the dry-run digest is derived from the ACTUAL case source contents, so
// a case edit at an unchanged git SHA produces a DIFFERENT plan digest. The
// pre-R94 runner passed the OLD digest back to itself and therefore could not
// notice such an edit; a fixture with a constant digest could not expose that.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_CLI_MODE ?? "ok";
const logPath = process.env.FAKE_CLI_LOG;
const stateDir = process.env.FAKE_CLI_STATE_DIR;
const crash = process.env.FAKE_CLI_CRASH ?? "";
const slowMs = Number.parseInt(process.env.FAKE_CLI_SLOW_MS ?? "0", 10) || 0;
const slowAfterReportMs = Number.parseInt(process.env.FAKE_CLI_SLOW_AFTER_REPORT_MS ?? "0", 10) || 0;
const hang = process.env.FAKE_CLI_HANG ?? "";
const pidFile = process.env.FAKE_CLI_PID_FILE;

function busyWait(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* deliberate busy wait: no timers, so the process cannot be reaped early */
  }
}

if (pidFile) {
  try {
    writeFileSync(pidFile, String(process.pid));
  } catch {
    /* best effort */
  }
}

if (logPath) {
  // Record whether the child could SEE a key in OPENAI_API_KEY — the variable the
  // real CLI actually reads — without ever recording the key itself.
  appendFileSync(
    logPath,
    JSON.stringify({
      argv,
      cwd: process.cwd(),
      sawOpenAiKey: typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.length > 0,
    }) + "\n",
  );
}

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

const suite = flag("--suite") ?? "adversarial";
const casesDir = flag("--cases");
const outDir = flag("--out");
const isDryRun = argv.includes("--dry-run");

// `benchmark campaign validate` is a separate subcommand: the real CLI
// re-derives the campaign numbers from the raw reports. The fake accepts it so
// the runner's end-of-campaign validation step is exercised offline.
if (argv[1] === "campaign" && argv[2] === "validate") {
  process.stdout.write("fake cli: campaign VALID\n");
  process.exit(process.env.FAKE_CLI_VALIDATE_MODE === "fail" ? 1 : 0);
}

// The case id is the single subdirectory name under --cases.
let caseId = "unknown-case";
if (casesDir) {
  try {
    const entries = readdirSync(casesDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    if (entries.length > 0) caseId = entries[0].name;
  } catch {
    /* leave the default */
  }
}

// A content-derived digest: <relative path>=<sha256 of bytes>, sorted, hashed.
// Any edit to any case file changes it, so "the case changed but HEAD did not"
// is detectable by the runner.
function dirDigest(dir) {
  const rows = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (statSync(p).isFile()) {
        rows.push(`${r}=${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
      }
    }
  };
  try {
    walk(dir, "");
  } catch {
    /* an unreadable case dir still yields a stable (empty) digest */
  }
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

if (isDryRun) {
  if (mode === "dryrunfail") {
    process.stderr.write("fake cli: dry run failed\n");
    process.exit(7);
  }
  const planDigest = casesDir ? dirDigest(casesDir) : "f".repeat(64);
  process.stdout.write(JSON.stringify({ planDigest, suite, caseId }) + "\n");
  process.exit(0);
}

// --- execution phase -------------------------------------------------------
// The interruption contract's FIRST point: the child was spawned but died
// before it did anything. The runner has already written its durable in-flight
// intent, so it must still be conservative — a child that dies this early may
// or may not have been billed.
if (crash === "after-start") {
  process.stderr.write("fake cli: died immediately after start, before any request\n");
  process.exit(8);
}

// A slow child, so the single-instance-lock test has a real concurrency window.
if (slowMs > 0) {
  busyWait(slowMs);
}

// A crash simulation: the request was already sent, the outcome was not
// persisted. The runner must treat this as OUTCOME_UNKNOWN, never as "done".
if (stateDir) {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, `request-sent-${suite}-${caseId}.marker`), "request sent\n");
  } catch {
    /* best effort */
  }
}

// FAKE_CLI_CRASH=after-request: the request went out, then the process died
// before any report was written. This is the exact window in which no
// exactly-once guarantee is possible.
if (crash === "after-request") {
  process.stderr.write("fake cli: crashed after the request was sent, before persisting the outcome\n");
  process.exit(9);
}

if (!outDir) {
  process.stderr.write("fake cli: --out is required for execution\n");
  process.exit(2);
}

const base = suite === "regression" ? "baseline" : suite;
const reportPath = join(outDir, `${base}.json`);
mkdirSync(outDir, { recursive: true });

// The "dispatched, no durable report, still running" point: the request marker
// has been written, so a request may have gone out, but nothing is durable. A
// test kills THIS pid, reproducing a hard kill between request and report.
if (hang === "before-report") {
  busyWait(600000);
  process.exit(12);
}

if (mode === "noreport") {
  process.exit(0);
}

const doc = {
  meta: {
    generatedAt: "1970-01-01T00:00:00.000Z",
    benchmarkVersion: "2.0.0",
    model: { providerId: flag("--provider") ?? "openai", modelId: flag("--model") ?? "fake-model" },
    casesTotal: 1,
    suite: mode === "wrongsuite" ? "not-the-suite" : suite,
  },
  results: [
    {
      task_id: mode === "wrongtask" ? "not-the-case" : caseId,
      suite,
      judge_version: "1.0.0",
      success: true,
      actual_status: "completed",
      duration_ms: 1,
      model_calls: 1,
      input_tokens: 1,
      output_tokens: 1,
      tool_calls: 0,
      termination_reason: "verified_complete",
    },
  ],
  summary: { total: 1, passed: 1, failed: 0, errors: 0 },
  manifest: {
    gitSha: "ffffffff",
    dirty: false,
    model: mode === "wrongmodel" ? "some-other-model" : (flag("--model") ?? "fake-model"),
    provider: flag("--provider") ?? "openai",
    judgeVersion: "1.0.0",
    platform: "synthetic",
    nodeVersion: "v0",
  },
};

const serialized = JSON.stringify(doc, null, 2);
if (mode === "truncate") {
  // A partial write: exactly the crash-between-write-and-fsync shape.
  writeFileSync(reportPath, serialized.slice(0, Math.floor(serialized.length / 2)));
} else {
  writeFileSync(reportPath, serialized);
}

// The report is now durable, but the process lingers. A test kills it here,
// reproducing "the report is on disk, the runner never recorded completion".
if (slowAfterReportMs > 0) {
  busyWait(slowAfterReportMs);
}

// The report is now durable, but the process never reached a clean exit. The
// runner's in-flight state is still on disk, so recovery must re-derive the
// completion offline rather than re-bill.
if (crash === "after-report") {
  process.stderr.write("fake cli: report is durable, the process died before exiting cleanly\n");
  process.exit(10);
}
if (crash === "before-completion") {
  process.stderr.write("fake cli: died in the window between the durable report and the completion record\n");
  process.exit(11);
}

process.exit(mode === "exit1" ? 1 : 0);
