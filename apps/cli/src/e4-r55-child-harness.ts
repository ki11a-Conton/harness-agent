/**
 * E4-R60 (G60) — the child-process lifecycle + evidence protocol used by the
 * E4-R55 parent verifier.
 *
 * WHY THIS MODULE EXISTS. The R55 parent verifier drove the real production
 * wiring through an isolated `vitest run` child with `spawnSync` and no
 * `timeout`, then read the child's JSON report with a bare
 * `JSON.parse(await readFile(...))`. That left five source-confirmable gaps:
 *
 *   1. `spawnSync` blocks the event loop, so the enclosing `it(..., 900_000)`
 *      could never interrupt a hanging child — the suite would hang instead of
 *      failing with a verdict;
 *   2. `proc.error` / `proc.signal` / `proc.stdout` / `proc.stderr` were
 *      discarded, so "the child never started" and "the child was killed" both
 *      surfaced as an unrelated error;
 *   3. a missing or malformed report THREW (ENOENT / SyntaxError) and masked the
 *      real process outcome — a spawn failure was reported as a missing file;
 *   4. `afterAll` deleted every temp root unconditionally, so a failing parent
 *      verification destroyed the evidence it needed to explain itself;
 *   5. the order-mutation branch asserted only "the acceptance failed", never
 *      the child's exit code, its exact assertion set, or that the failure was
 *      really the target ACCEPT assertion — an import error or a timeout could
 *      have masqueraded as a valid counterexample.
 *
 * This module supplies the MINIMAL protocol that closes them, in four pieces:
 *
 *   - `runControlledChild` — ONE async spawn with a real deadline, a bounded
 *     output capture, and a process-TREE kill (Windows `taskkill /T /F`; POSIX
 *     signal to the child's own process group). It never resolves before the
 *     child's terminal event is observed, and reports honestly when that event
 *     never arrived (`reaped: false`).
 *   - `readChildReport` — classifies a child report (`ok` / `missing` /
 *     `unreadable` / `invalid-json` / `unexpected-shape`) instead of throwing,
 *     so the process facts survive a report problem.
 *   - `judgeChildProcess` — returns EVERY reason a run is not decidable
 *     (launch failure, timeout, signal, unreaped, output overflow, unusable
 *     report, unexpected assertion set, wrong exit code) rather than a bare
 *     boolean.
 *   - `preserveEvidence` — writes a failing run's bounded logs, raw report and
 *     diagnostic bundle tree into a root the run's own cleanup cannot reach,
 *     so a failed parent verification stays explainable afterwards.
 *
 * It is deliberately NOT a general scheduling platform: no queue, no retry, no
 * pool, no policy. It fixes this test tool's lifecycle and nothing else.
 *
 * P14-6: this is a non-test source file under `apps/**\/src`, so the
 * no-silent-catch lint scans it. Every best-effort path reports through
 * `reportDegraded` (a `[degraded]` stderr line) — there is no empty catch.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { Dirent } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

export const CHILD_HARNESS_SCHEMA_VERSION = "1.0.0";

/** Bounded capture budget PER STREAM (stdout and stderr are bounded apart). */
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

/** How long the parent keeps waiting for a terminal event after a tree kill. */
export const DEFAULT_KILL_GRACE_MS = 15_000;

/** Report a best-effort / degraded failure on stderr (P14-6: never silent). */
export function reportDegraded(scope: string, err: unknown): void {
  process.stderr.write(`[degraded] ${scope}: ${messageOf(err)}\n`);
}

/** Read an error's message without ever throwing on an exotic value. */
export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m !== "") return m;
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  try {
    return String(err);
  } catch {
    return "<unprintable error>";
  }
}

// ---------------------------------------------------------------------------
// 1. Controlled child process
// ---------------------------------------------------------------------------

/**
 * How the child's life ended. These are EXHAUSTIVE and mutually exclusive, so a
 * caller can never mistake one for another:
 *   - `exited`      — a real exit code (0 or non-zero) was observed;
 *   - `signalled`   — it closed WITHOUT an exit code, i.e. killed by a signal;
 *   - `timeout`     — the parent's deadline fired and the tree was killed;
 *   - `spawn-error` — the executable could never be launched.
 */
export type ChildTermination = "exited" | "signalled" | "timeout" | "spawn-error";

export interface ControlledChildSpec {
  /** Short label carried into the outcome + preserved evidence. */
  label: string;
  /** Executable. Spawned WITHOUT a shell, so arguments are never re-split. */
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Wall-clock deadline. On expiry the child's whole process TREE is killed. */
  timeoutMs: number;
  maxOutputBytes?: number;
  /** Grace to observe the terminal event after a tree kill. */
  killGraceMs?: number;
}

export interface ControlledChildOutcome {
  label: string;
  command: string;
  args: string[];
  cwd: string;
  termination: ChildTermination;
  /**
   * The exit code of a process that actually EXITED. `null` for every other
   * termination — a process that never launched has no exit code, and reporting
   * the platform's internal launch-failure number here would be a false fact.
   */
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** The real launch error, preserved verbatim (never replaced by ENOENT). */
  spawnError: string | null;
  /**
   * Windows supplies its own launch-failure number on the `close` event of a
   * spawn that never started (measured: `-4058` for a missing binary). It is
   * NOT an exit code, so it is kept here rather than folded into `exitCode`.
   */
  launchFailureCode: number | null;
  stdout: string;
  stderr: string;
  /** true when either stream exceeded its capture budget (log is truncated). */
  outputOverflow: boolean;
  durationMs: number;
  /** true when a tree kill was attempted (deadline or abort). */
  killAttempted: boolean;
  /** true when the child's own terminal event was observed (process reaped). */
  reaped: boolean;
}

interface OutputBuffer {
  text: string;
  textBytes: number;
  totalBytes: number;
  overflow: boolean;
}

/** Append a chunk to a bounded buffer, cutting on a real byte boundary. */
function appendBounded(buf: OutputBuffer, chunk: Buffer, cap: number): void {
  buf.totalBytes += chunk.byteLength;
  if (buf.textBytes >= cap) {
    buf.overflow = true;
    return;
  }
  const text = chunk.toString("utf8");
  const allowed = cap - buf.textBytes;
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= allowed) {
    buf.text += text;
    buf.textBytes += encoded.byteLength;
    return;
  }
  // The cap falls inside this chunk: keep a valid UTF-8 prefix and mark the
  // capture as truncated. A cut mid-codepoint becomes a replacement char, which
  // is honest for a log excerpt (the byte budget is what matters here).
  const piece = encoded.subarray(0, allowed).toString("utf8");
  buf.text += piece;
  buf.textBytes += Buffer.byteLength(piece, "utf8");
  buf.overflow = true;
}

/**
 * Terminate a child's whole process TREE.
 *
 * Windows: `taskkill /pid <pid> /t /f` — the same recipe the production
 * `ProcessExecutor` uses; `child.kill()` alone leaves the descendants behind.
 * POSIX: the child is spawned `detached`, so it leads its own process group and
 * a single negative-pid signal reaches every descendant in that group.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform() === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      // A killer that cannot start must not crash the parent with an unhandled
      // 'error' event; the direct kill below is the fallback either way.
      killer.on("error", (err) => reportDegraded("e4-r60 taskkill spawn", err));
      killer.unref();
    } catch (err) {
      reportDegraded("e4-r60 taskkill", err);
      killDirect(child);
    }
    return;
  }
  try {
    // Negative pid = the whole process GROUP led by the detached child.
    process.kill(-pid, "SIGKILL");
  } catch (err) {
    reportDegraded("e4-r60 process-group kill", err);
    killDirect(child);
  }
}

function killDirect(child: ChildProcess): void {
  try {
    child.kill("SIGKILL");
  } catch (err) {
    // Already gone is the expected case here; anything else is reported.
    reportDegraded("e4-r60 direct kill", err);
  }
}

/**
 * Run one child under an explicit lifecycle contract and return its structured
 * outcome. Resolves ONLY after the child reached a terminal state — or, if the
 * tree kill did not produce one within the grace period, resolves with
 * `reaped: false` rather than hanging the parent forever.
 */
export async function runControlledChild(spec: ControlledChildSpec): Promise<ControlledChildOutcome> {
  const started = Date.now();
  const cap = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const grace = spec.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  const out: OutputBuffer = { text: "", textBytes: 0, totalBytes: 0, overflow: false };
  const errBuf: OutputBuffer = { text: "", textBytes: 0, totalBytes: 0, overflow: false };

  const build = (over: Partial<ControlledChildOutcome>): ControlledChildOutcome => ({
    label: spec.label,
    command: spec.command,
    args: [...spec.args],
    cwd: spec.cwd,
    termination: "spawn-error",
    exitCode: null,
    signal: null,
    timedOut: false,
    spawnError: null,
    launchFailureCode: null,
    stdout: out.text,
    stderr: errBuf.text,
    outputOverflow: out.overflow || errBuf.overflow,
    durationMs: Date.now() - started,
    killAttempted: false,
    reaped: false,
    ...over,
  });

  let child: ChildProcess;
  try {
    child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      // No shell: an argument containing a space (the repo root here) can never
      // be re-split, and the real exit code belongs to the real program.
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // POSIX only: leading our own process group is what makes a single signal
      // reach every descendant. Windows uses `taskkill /T` instead, and a
      // detached console there would be a new window.
      detached: platform() !== "win32",
    });
  } catch (err) {
    // A synchronous spawn throw (bad cwd, bad env shape) is still a real launch
    // failure and must be reported as one.
    return build({ termination: "spawn-error", spawnError: messageOf(err) });
  }

  return await new Promise<ControlledChildOutcome>((resolvePromise) => {
    let settled = false;
    let killAttempted = false;
    let timedOut = false;
    let spawnError: string | null = null;
    let deadline: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let errorSettleTimer: NodeJS.Timeout | undefined;

    const finish = (o: ControlledChildOutcome): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (errorSettleTimer !== undefined) clearTimeout(errorSettleTimer);
      resolvePromise(o);
    };

    const doKillTree = (): void => {
      killAttempted = true;
      killTree(child);
    };

    child.stdout?.on("data", (chunk: Buffer) => appendBounded(out, chunk, cap));
    child.stderr?.on("data", (chunk: Buffer) => appendBounded(errBuf, chunk, cap));

    child.on("error", (err) => {
      spawnError = messageOf(err);
      // 'close' follows 'error' for a process that never started; this timer is
      // the bounded fallback so a missing 'close' cannot hang the parent.
      errorSettleTimer = setTimeout(() => {
        finish(build({ termination: "spawn-error", spawnError, killAttempted, reaped: false }));
      }, 1_000);
    });

    child.on("close", (code, signal) => {
      if (timedOut) {
        finish(
          build({
            termination: "timeout",
            exitCode: code,
            signal,
            timedOut: true,
            spawnError,
            killAttempted,
            reaped: true,
          }),
        );
        return;
      }
      if (spawnError !== null) {
        // No process ever exited, so there is no exit code to report — the
        // platform's launch-failure number is kept separately.
        finish(
          build({
            termination: "spawn-error",
            exitCode: null,
            signal,
            spawnError,
            launchFailureCode: code,
            killAttempted,
            reaped: true,
          }),
        );
        return;
      }
      if (code === null) {
        // Closed without an exit code: it was killed by a signal. That is NOT a
        // verdict and must never be read as one.
        finish(build({ termination: "signalled", exitCode: null, signal, killAttempted, reaped: true }));
        return;
      }
      finish(build({ termination: "exited", exitCode: code, signal, killAttempted, reaped: true }));
    });

    if (spec.timeoutMs > 0) {
      deadline = setTimeout(() => {
        timedOut = true;
        doKillTree();
        graceTimer = setTimeout(() => {
          // The kill did not produce a terminal event in time. Report that
          // honestly instead of pretending the child is gone.
          finish(
            build({
              termination: "timeout",
              exitCode: null,
              signal: null,
              timedOut: true,
              spawnError,
              killAttempted,
              reaped: false,
            }),
          );
        }, grace);
      }, spec.timeoutMs);
    }
  });
}

// ---------------------------------------------------------------------------
// 2. Child report reading
// ---------------------------------------------------------------------------

export type ReportKind = "ok" | "missing" | "unreadable" | "invalid-json" | "unexpected-shape";

export interface ReportRead {
  path: string;
  kind: ReportKind;
  /** The real failure reason; never empty unless `kind === "ok"`. */
  error: string | null;
  results: { title: string; status: string }[];
  /** The report's exact bytes when it could be read at all (for evidence). */
  rawText: string | null;
}

/**
 * Read a vitest JSON report WITHOUT ever throwing. A report problem is
 * classified and returned next to the process facts, so "the child produced no
 * report" can never be mistaken for "the child never ran".
 */
export async function readChildReport(path: string): Promise<ReportRead> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as { code?: string }).code;
    return {
      path,
      kind: code === "ENOENT" ? "missing" : "unreadable",
      error: messageOf(err),
      results: [],
      rawText: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { path, kind: "invalid-json", error: messageOf(err), results: [], rawText: text };
  }

  const files = (parsed as { testResults?: unknown } | null)?.testResults;
  if (!Array.isArray(files)) {
    return {
      path,
      kind: "unexpected-shape",
      error: "the report has no `testResults` array",
      results: [],
      rawText: text,
    };
  }

  const results: { title: string; status: string }[] = [];
  for (const file of files) {
    const assertions = (file as { assertionResults?: unknown } | null)?.assertionResults;
    if (!Array.isArray(assertions)) continue;
    for (const assertion of assertions) {
      const rec = (assertion ?? {}) as { title?: unknown; status?: unknown };
      results.push({ title: String(rec.title ?? ""), status: String(rec.status ?? "") });
    }
  }
  return { path, kind: "ok", error: null, results, rawText: text };
}

// ---------------------------------------------------------------------------
// 3. Verdict
// ---------------------------------------------------------------------------

export interface ExpectedChildRun {
  /** `"<status> <title>"` for EVERY assertion the child must have reported. */
  expectedResults: string[];
  /** The exact exit code the child must have produced (no "any non-zero"). */
  expectedExitCode: number;
}

/**
 * Judge the process + report layer of one child run. Returns every reason the
 * run is NOT decidable, so a failure is readable instead of a bare boolean.
 *
 * The assertion set is compared EXACTLY: an extra failure, a renamed title, or
 * an unexpected success all reject the run. That is what stops an import error,
 * a timeout or a stray exception from masquerading as a valid counterexample.
 */
export function judgeChildProcess(
  outcome: ControlledChildOutcome,
  report: ReportRead,
  expected: ExpectedChildRun,
): string[] {
  const reasons: string[] = [];

  if (outcome.termination === "spawn-error") {
    reasons.push(`the child could not be launched: ${outcome.spawnError ?? "unknown launch error"}`);
  }
  if (outcome.timedOut) {
    reasons.push(
      `the child did not finish before its ${outcome.durationMs}ms deadline and its process tree was terminated — a TIMEOUT is not a verdict`,
    );
  }
  if (outcome.termination === "signalled") {
    reasons.push(`the child was killed by signal ${outcome.signal ?? "unknown"} and produced no exit code`);
  }
  if (!outcome.reaped) {
    reasons.push("the child's terminal state was never observed — it may still be running");
  }
  if (outcome.outputOverflow) {
    reasons.push("the child's captured output exceeded its budget and was truncated");
  }

  if (report.kind !== "ok") {
    reasons.push(`the child report is unusable (${report.kind}): ${report.error ?? "no reason recorded"}`);
  } else {
    const actual = report.results.map((r) => `${r.status} ${r.title}`).sort();
    const wanted = [...expected.expectedResults].sort();
    if (actual.length !== wanted.length || actual.some((line, i) => line !== wanted[i])) {
      reasons.push(
        `the child's assertion set is not the expected one\n      expected: ${wanted.join(" | ")}\n      actual:   ${actual.join(" | ")}`,
      );
    }
  }

  if (outcome.exitCode !== expected.expectedExitCode) {
    reasons.push(
      `the child exited with ${outcome.exitCode === null ? "no code" : outcome.exitCode}, expected ${expected.expectedExitCode}`,
    );
  }

  return reasons;
}

// ---------------------------------------------------------------------------
// 4. Evidence preservation
// ---------------------------------------------------------------------------

/**
 * Where a failing parent verification keeps its evidence.
 *
 * CI points this at the git-ignored `.ci/r55-parent-diagnostics`; locally it
 * falls back to a temp root. It is deliberately OUTSIDE every directory the
 * verifier's own cleanup sweeps, so preserved evidence survives.
 */
export function parentEvidenceRoot(): string {
  const override = process.env.E4_R55_PARENT_DIAG_DIR;
  if (override !== undefined && override.trim() !== "") return resolve(override.trim());
  return join(tmpdir(), "harness-agent-e4-r55-parent");
}

export interface PreserveEvidenceInput {
  label: string;
  outcome: ControlledChildOutcome;
  report: ReportRead;
  /** Every reason the run was judged undecidable. */
  reasons: string[];
  /** A directory whose CONTENTS must outlive the run (the diagnostic bundles). */
  diagDir?: string;
  /** Extra structured facts (chain identity, bundle labels, ...). */
  extra?: Record<string, unknown>;
}

export interface PreservedEvidence {
  dir: string;
  /** Relative paths of everything written, for the report/log line. */
  files: string[];
}

/** Copy a directory tree, reporting (never hiding) anything that fails. */
async function copyTree(src: string, dest: string): Promise<string[]> {
  const copied: string[] = [];
  const walk = async (from: string, to: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(from, { withFileTypes: true });
    } catch (err) {
      reportDegraded(`e4-r60 evidence copy: cannot list ${from}`, err);
      return;
    }
    await mkdir(to, { recursive: true });
    for (const entry of entries) {
      const srcPath = join(from, entry.name);
      const destPath = join(to, entry.name);
      if (entry.isDirectory()) {
        await walk(srcPath, destPath);
        continue;
      }
      if (!entry.isFile()) {
        copied.push(`${relative(dest, destPath)} (skipped: not a regular file)`);
        continue;
      }
      try {
        await copyFile(srcPath, destPath);
        copied.push(relative(dest, destPath));
      } catch (err) {
        reportDegraded(`e4-r60 evidence copy: cannot copy ${srcPath}`, err);
      }
    }
  };
  await walk(src, dest);
  return copied;
}

/**
 * Persist a failing run's evidence BEFORE the run's own cleanup runs.
 *
 * Writes the bounded child logs, the raw child report (when it could be read at
 * all), a copy of the diagnostic bundle tree, and a machine-readable `run.json`
 * carrying the process facts and every judgement reason. No environment is
 * dumped — only the class of run.
 */
export async function preserveEvidence(input: PreserveEvidenceInput): Promise<PreservedEvidence> {
  const root = parentEvidenceRoot();
  await mkdir(root, { recursive: true });
  const safeLabel = input.label.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
  const dir = await mkdtemp(join(root, `${safeLabel}__`));
  const files: string[] = [];

  const write = async (name: string, body: string): Promise<void> => {
    await writeFile(join(dir, name), body, "utf8");
    files.push(name);
  };

  await write("child.stdout.txt", input.outcome.stdout);
  await write("child.stderr.txt", input.outcome.stderr);
  if (input.report.rawText !== null) {
    await write("child-report.json", input.report.rawText);
  }

  let bundleFiles: string[] = [];
  if (input.diagDir !== undefined) {
    bundleFiles = await copyTree(input.diagDir, join(dir, "diagnostics"));
    files.push(...bundleFiles.map((f) => `diagnostics/${f}`));
  }

  const record = {
    schemaVersion: CHILD_HARNESS_SCHEMA_VERSION,
    kind: "e4-r55-parent-evidence",
    capturedAtIso: new Date().toISOString(),
    label: input.label,
    process: {
      command: input.outcome.command,
      args: input.outcome.args,
      cwd: input.outcome.cwd,
      termination: input.outcome.termination,
      exitCode: input.outcome.exitCode,
      signal: input.outcome.signal,
      timedOut: input.outcome.timedOut,
      spawnError: input.outcome.spawnError,
      launchFailureCode: input.outcome.launchFailureCode,
      outputOverflow: input.outcome.outputOverflow,
      killAttempted: input.outcome.killAttempted,
      reaped: input.outcome.reaped,
      durationMs: input.outcome.durationMs,
    },
    report: {
      path: input.report.path,
      kind: input.report.kind,
      error: input.report.error,
      resultCount: input.report.results.length,
      results: input.report.results,
    },
    reasons: input.reasons,
    environment: {
      platform: platform(),
      nodeVersion: process.version,
      cwd: process.cwd(),
      ci: process.env.CI === "true" || process.env.CI === "1",
    },
    extra: input.extra ?? {},
  };
  await write("run.json", `${JSON.stringify(record, null, 2)}\n`);

  return { dir, files };
}
