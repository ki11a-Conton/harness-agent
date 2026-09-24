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
import { join, resolve } from "node:path";

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
  /**
   * E4-R64 test seam: override the tree-kill dependencies. Production callers
   * omit it, so the real platform/`taskkill`/`child.kill` are used. It exists so
   * the async launch-failure and non-zero-exit paths can be exercised WITHOUT
   * removing the system `taskkill` or editing PATH.
   */
  killDeps?: Partial<KillTreeDeps>;
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
  /**
   * Per-stream byte accounting (E4-R63). `stdout` / `stderr` above are the text
   * of `capture.stdout.text` / `capture.stderr.text`; the capture adds the
   * received-vs-captured byte counts and the truncation state, so a caller can
   * tell "the child said nothing" from "the budget cut it off".
   */
  capture: { stdout: StreamCapture; stderr: StreamCapture };
  /** true when either stream's capture is truncated (log is incomplete). */
  outputOverflow: boolean;
  durationMs: number;
  /** true when a tree kill was attempted (deadline or abort). */
  killAttempted: boolean;
  /**
   * E4-R64: what the tree-kill attempt actually achieved. `null` when no kill
   * was attempted. Carries the termination command's launch/exit/error facts so
   * a failed tree kill is visible in `run.json`, not only on stderr.
   */
  treeKill: TreeKillResult | null;
  /** true when the child's own terminal event was observed (process reaped). */
  reaped: boolean;
}

/**
 * One stream's bounded capture (E4-R63, H63).
 *
 * CONTRACT — this is a TEXT contract, and every clause is asserted by the tests:
 *   - `text` is the longest prefix of the received bytes whose UTF-8 encoding is
 *     at most the cap AND which ends on a complete character boundary;
 *   - `capturedBytes === Buffer.byteLength(text, "utf8") <= cap` ALWAYS;
 *   - a character that does not fit is never partially written, so a budget
 *     smaller than one character yields an EMPTY string. The previous
 *     implementation cut mid-codepoint and decoded the fragment to U+FFFD, so a
 *     cap of 1 byte on "中" produced 3 bytes — the budget was exceeded;
 *   - `receivedBytes` counts every byte the child wrote, kept or not;
 *   - `truncated` is true iff the capture does not represent every received byte
 *     (`capturedBytes !== receivedBytes`), so it is honest about both a dropped
 *     tail and a replacement-char substitution.
 *
 * Invalid UTF-8 inside the retained prefix is decoded with U+FFFD. Because that
 * substitution can inflate the byte count, the decoded text is trimmed by whole
 * code points until it fits the cap — the budget invariant holds for invalid
 * input too. The module therefore never claims byte-for-byte capture fidelity.
 */
export interface StreamCapture {
  text: string;
  receivedBytes: number;
  capturedBytes: number;
  truncated: boolean;
}

/** The end index of the longest COMPLETE UTF-8 prefix of `buf`. */
function completeUtf8PrefixEnd(buf: Buffer): number {
  let i = buf.length - 1;
  let continuations = 0;
  while (i >= 0 && (buf[i]! & 0xc0) === 0x80) {
    i -= 1;
    continuations += 1;
    // A valid sequence carries at most 3 continuation bytes; more than that is
    // not a real sequence, so there is no boundary to find and nothing to trim.
    if (continuations > 3) return buf.length;
  }
  if (i < 0) return buf.length;
  const lead = buf[i]!;
  let needed: number;
  if ((lead & 0x80) === 0) needed = 1;
  else if ((lead & 0xe0) === 0xc0) needed = 2;
  else if ((lead & 0xf0) === 0xe0) needed = 3;
  else if ((lead & 0xf8) === 0xf0) needed = 4;
  else needed = 1;
  return buf.length - i >= needed ? buf.length : i;
}

/** Decode a complete-character byte prefix, guaranteeing it re-encodes to <= cap. */
function decodeWithinBudget(complete: Buffer, cap: number): string {
  const text = new TextDecoder("utf-8").decode(complete);
  let bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= cap) return text;
  // Only reachable when invalid input decoded to U+FFFD (3 bytes each), which
  // can exceed the source byte count. Trim whole CODE POINTS so a surrogate pair
  // is never split, until the budget holds.
  const codePoints = Array.from(text);
  while (codePoints.length > 0 && bytes > cap) {
    const dropped = codePoints.pop();
    if (dropped !== undefined) bytes -= Buffer.byteLength(dropped, "utf8");
  }
  return codePoints.join("");
}

/**
 * A bounded, incrementally-fed capture for ONE stream.
 *
 * Raw bytes are retained and decoded EXACTLY ONCE, at the end. The previous
 * implementation decoded every `data` chunk on its own and re-encoded it, which
 * corrupted any character split across two chunks — a legal multi-byte character
 * arriving in pieces became replacement characters.
 */
export function createStreamCapture(cap: number): {
  push: (chunk: Buffer) => void;
  finish: () => StreamCapture;
} {
  const parts: Buffer[] = [];
  let retained = 0;
  let receivedBytes = 0;
  return {
    push(chunk: Buffer): void {
      receivedBytes += chunk.byteLength;
      const room = cap - retained;
      if (room <= 0) return;
      const take = Math.min(room, chunk.byteLength);
      if (take > 0) {
        parts.push(chunk.subarray(0, take));
        retained += take;
      }
    },
    finish(): StreamCapture {
      const raw = Buffer.concat(parts, retained);
      const end = completeUtf8PrefixEnd(raw);
      const complete = raw.subarray(0, end);
      const text = decodeWithinBudget(complete, cap);
      const capturedBytes = Buffer.byteLength(text, "utf8");
      // LOSSY covers the two ways the text can fail to represent the retained
      // bytes: an incomplete trailing sequence was dropped, or a decode/trim
      // changed the bytes (U+FFFD substitution, or a cap trim). `truncated` then
      // also covers bytes we never even retained. Invalid UTF-8 therefore never
      // reports "complete" while having been transcoded.
      const lossy = end !== raw.length || !Buffer.from(text, "utf8").equals(complete);
      return {
        text,
        receivedBytes,
        capturedBytes,
        truncated: lossy || capturedBytes !== receivedBytes,
      };
    },
  };
}

/**
 * The observable outcome of a tree-kill ATTEMPT (E4-R64, H64).
 *
 * Every field is a separate fact on purpose: "we asked for a tree kill" is not
 * "the command started", which is not "the command succeeded", which is not
 * "the tree is gone". The previous implementation reported none of them — it
 * only wrote to stderr, so a failed tree kill was invisible in `run.json`.
 */
export interface TreeKillResult {
  /** A tree kill was requested at all (false when the child never got a pid). */
  requested: boolean;
  mechanism: "taskkill" | "process-group" | "none";
  /** The tree-kill command line (null when a process-group signal was used). */
  command: string | null;
  /** Did the tree-kill COMMAND process start? null = not applicable / unknown. */
  commandLaunched: boolean | null;
  /** The tree-kill command's exit code; null when it never started or is unknown. */
  commandExitCode: number | null;
  /** Launch failure or non-zero exit reason. Never a silent failure. */
  commandError: string | null;
  /** A direct kill of the DIRECT child was attempted as a fallback. */
  directFallbackAttempted: boolean;
  /**
   * We asked the DIRECT child to die. This is NOT evidence that the whole tree
   * died — a descendant can outlive its parent, so it is deliberately named
   * "signalled" rather than "killed".
   */
  directChildSignalled: boolean;
  /** A fallback has already run, so a second failure cannot double-kill. */
  settled: boolean;
}

/** Injection seam so the async failure paths are testable without touching PATH. */
export interface KillTreeDeps {
  platform: NodeJS.Platform;
  spawnKiller: KillerSpawner;
  killDirect: (child: ChildProcess) => boolean;
}

export type KillerSpawner = (
  command: string,
  args: string[],
  options: { stdio: "ignore"; windowsHide: boolean },
) => ChildProcess;

function defaultKillDeps(): KillTreeDeps {
  return {
    platform: platform(),
    spawnKiller: (command, args, options) => spawn(command, args, options),
    killDirect: (child) => {
      try {
        child.kill("SIGKILL");
        return true;
      } catch (err) {
        // Already gone is the expected case here; anything else is reported.
        reportDegraded("e4-r60 direct kill", err);
        return false;
      }
    },
  };
}

/**
 * Terminate a child's whole process TREE, reporting exactly what happened.
 *
 * Windows: `taskkill /pid <pid> /t /f` — the same recipe the production
 * `ProcessExecutor` uses; `child.kill()` alone leaves the descendants behind.
 * POSIX: the child is spawned `detached`, so it leads its own process group and
 * a single negative-pid signal reaches every descendant in that group.
 *
 * H64: a `spawn` that cannot start reports through the ASYNC `error` event, which
 * the surrounding try/catch cannot cover — so the promised direct fallback used
 * to never run, and a non-zero `taskkill` exit was never checked at all. Both
 * paths now fall back exactly once.
 */
export function killTree(child: ChildProcess, deps: KillTreeDeps = defaultKillDeps()): TreeKillResult {
  const result: TreeKillResult = {
    requested: false,
    mechanism: "none",
    command: null,
    commandLaunched: null,
    commandExitCode: null,
    commandError: null,
    directFallbackAttempted: false,
    directChildSignalled: false,
    settled: false,
  };
  const pid = child.pid;
  if (pid === undefined) return result;
  result.requested = true;

  // Exactly one fallback, ever: a late second failure must not kill twice.
  const fallback = (reason: string): void => {
    if (result.settled) return;
    result.settled = true;
    result.directFallbackAttempted = true;
    result.commandError = result.commandError ?? reason;
    result.directChildSignalled = deps.killDirect(child);
  };

  if (deps.platform === "win32") {
    result.mechanism = "taskkill";
    const args = ["/pid", String(pid), "/t", "/f"];
    result.command = `taskkill ${args.join(" ")}`;
    let killer: ChildProcess;
    try {
      killer = deps.spawnKiller("taskkill", args, { stdio: "ignore", windowsHide: true });
      result.commandLaunched = true;
    } catch (err) {
      result.commandLaunched = false;
      reportDegraded("e4-r60 taskkill", err);
      fallback(messageOf(err));
      return result;
    }
    // NOT covered by the try/catch above: a missing taskkill binary reports here.
    killer.on("error", (err) => {
      result.commandLaunched = false;
      result.commandError = messageOf(err);
      reportDegraded("e4-r60 taskkill spawn", err);
      fallback(messageOf(err));
    });
    killer.on("close", (code) => {
      result.commandExitCode = code;
      if (code !== 0) {
        const reason = `taskkill exited with ${code === null ? "no code" : code}`;
        reportDegraded("e4-r60 taskkill exit", reason);
        fallback(reason);
      }
    });
    killer.unref();
    return result;
  }

  result.mechanism = "process-group";
  try {
    // Negative pid = the whole process GROUP led by the detached child.
    process.kill(-pid, "SIGKILL");
    result.settled = true;
  } catch (err) {
    reportDegraded("e4-r60 process-group kill", err);
    fallback(messageOf(err));
  }
  return result;
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

  const outCap = createStreamCapture(cap);
  const errCap = createStreamCapture(cap);
  // E4-R64: production uses the real platform/spawn/kill; a test may override.
  const deps: KillTreeDeps = { ...defaultKillDeps(), ...spec.killDeps };
  // Declared out here so `build` can carry it into every terminal outcome.
  let treeKill: TreeKillResult | null = null;

  const build = (over: Partial<ControlledChildOutcome>): ControlledChildOutcome => {
    const stdout = outCap.finish();
    const stderr = errCap.finish();
    return {
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
      stdout: stdout.text,
      stderr: stderr.text,
      capture: { stdout, stderr },
      outputOverflow: stdout.truncated || stderr.truncated,
      durationMs: Date.now() - started,
      killAttempted: false,
      treeKill,
      reaped: false,
      ...over,
    };
  };

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
      treeKill = killTree(child, deps);
    };

    /**
     * E4-R64: the grace period expired without a terminal event. The outcome
     * already reports `reaped: false`; this additionally stops the un-reaped
     * child from keeping THIS process alive forever by destroying the pipes and
     * unref'ing the handle. It is not a claim that the child died.
     */
    const releaseUnreapedChild = (): void => {
      try {
        child.stdout?.destroy();
      } catch (err) {
        reportDegraded("e4-r60 stdout release", err);
      }
      try {
        child.stderr?.destroy();
      } catch (err) {
        reportDegraded("e4-r60 stderr release", err);
      }
      try {
        child.unref();
      } catch (err) {
        reportDegraded("e4-r60 child unref", err);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => outCap.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => errCap.push(chunk));

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
          // honestly instead of pretending the child is gone, and release the
          // handles so an un-reaped child cannot hang this process (E4-R64).
          releaseUnreapedChild();
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
  /** E4-R67/R68 test seam; production callers omit it. */
  seam?: EvidenceSeam;
}

/**
 * How one entry of a diagnostics tree ended up (E4-R65, H65).
 *   - `copied`     — a regular file was written to the archive;
 *   - `missing`    — it (or its directory) did not exist;
 *   - `unreadable` — it existed but the operation failed for another reason;
 *   - `skipped`    — deliberately NOT copied (not a regular file, never followed).
 */
export type CopyEntryStatus = "copied" | "missing" | "unreadable" | "skipped";

export interface CopyEntry {
  /** Path relative to the copy destination root. */
  path: string;
  status: CopyEntryStatus;
  operation: "readdir" | "mkdir" | "copyFile";
  /** errno-style code when the platform supplied one. */
  errorCode: string | null;
  /** Always non-null for anything that is not `copied`. */
  reason: string | null;
}

/**
 * `complete` means every REGULAR FILE discovered was copied. `skipped`
 * non-regular entries (links, special files) do not degrade it — not following
 * them is the deliberate policy, not a failure — but they are still listed so a
 * reader can see they were left out.
 */
export type CopyIntegrity = "complete" | "partial" | "missing" | "not-requested";

export interface CopyTreeResult {
  source: string;
  requested: boolean;
  /** The source ROOT itself did not exist (distinct from an empty directory). */
  sourceMissing: boolean;
  /** The source root existed and held no entries at all. */
  empty: boolean;
  /** ONLY regular files that were actually written. */
  copied: string[];
  /** Every non-`copied` outcome (failures AND deliberate skips). */
  entries: CopyEntry[];
  integrity: CopyIntegrity;
}

/** Copy a directory tree, returning a structured, self-describing result. */
async function copyTree(src: string, dest: string, seam?: EvidenceSeam): Promise<CopyTreeResult> {
  const copyFileImpl = seam?.copyFile ?? ((from: string, to: string) => copyFile(from, to));
  const readdirImpl =
    seam?.readdir ?? ((from: string) => readdir(from, { withFileTypes: true }));
  const copied: string[] = [];
  const entries: CopyEntry[] = [];
  let sourceMissing = false;
  let empty = false;

  const record = (
    path: string,
    status: Exclude<CopyEntryStatus, "copied">,
    operation: CopyEntry["operation"],
    err: unknown,
  ): void => {
    entries.push({
      path,
      status,
      operation,
      errorCode: (err as { code?: string } | null)?.code ?? null,
      reason: messageOf(err),
    });
  };

  const walk = async (from: string, to: string, relDir: string): Promise<void> => {
    let dirents: Dirent[];
    try {
      dirents = await readdirImpl(from);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (relDir === "" && code === "ENOENT") {
        // The root we were asked to archive simply is not there. That is a
        // DIFFERENT fact from "it was there and had nothing in it" — and the
        // ENOENT itself is recorded so the archive alone can explain it.
        sourceMissing = true;
        record(".", "missing", "readdir", err);
        return;
      }
      record(relDir === "" ? "." : relDir, code === "ENOENT" ? "missing" : "unreadable", "readdir", err);
      return;
    }
    if (relDir === "" && dirents.length === 0) empty = true;
    try {
      await mkdir(to, { recursive: true });
    } catch (err) {
      record(relDir === "" ? "." : relDir, "unreadable", "mkdir", err);
      return;
    }
    for (const dirent of dirents) {
      const srcPath = join(from, dirent.name);
      const destPath = join(to, dirent.name);
      const rel = relDir === "" ? dirent.name : `${relDir}/${dirent.name}`;
      if (dirent.isDirectory()) {
        await walk(srcPath, destPath, rel);
        continue;
      }
      if (!dirent.isFile()) {
        // Deliberately NOT followed (unchanged protection) and deliberately NOT
        // listed as a copied file — a consumer must never count a skipped link
        // as successfully archived evidence.
        entries.push({
          path: rel,
          status: "skipped",
          operation: "copyFile",
          errorCode: null,
          reason: `not a regular file (${dirent.isSymbolicLink() ? "symbolic link" : "special file"}) — not followed`,
        });
        continue;
      }
      try {
        await copyFileImpl(srcPath, destPath);
        copied.push(rel);
      } catch (err) {
        record(rel, (err as { code?: string }).code === "ENOENT" ? "missing" : "unreadable", "copyFile", err);
      }
    }
  };

  await walk(src, dest, "");
  const failed = entries.some((e) => e.status === "missing" || e.status === "unreadable");
  const integrity: CopyIntegrity = sourceMissing ? "missing" : failed ? "partial" : "complete";
  // Deterministic order: `readdir` returns directory order, which differs
  // between filesystems and would make an archive's manifest unstable.
  copied.sort();
  entries.sort((a, b) => (a.path === b.path ? a.operation.localeCompare(b.operation) : a.path.localeCompare(b.path)));
  return { source: src, requested: true, sourceMissing, empty, copied, entries, integrity };
}

/** The archive's overall state, including the case where it could not be made. */
export type ArchiveIntegrity = "complete" | "partial" | "archive-failed";

/**
 * The archive roles that are written BEFORE `run.json` (E4-R67).
 *
 * `run.json` itself is deliberately NOT a member: its outcome cannot be recorded
 * inside the file it describes. It is expressed by `ok` and `archiveIntegrity`
 * instead — a persisted record exists only if `run.json` was written, and
 * `archiveIntegrity === "archive-failed"` is exactly the case where it was not.
 */
export type EvidenceRole = "stdout" | "stderr" | "raw-report";

export type EvidenceRoleStatus = "written" | "failed" | "not-requested";

export interface EvidenceRoleRecord {
  role: EvidenceRole;
  /** Path relative to the archive directory; null when the role was not requested. */
  path: string | null;
  requested: boolean;
  status: EvidenceRoleStatus;
  operation: "writeFile" | null;
  /** errno-style code when the platform supplied one. */
  errorCode: string | null;
  /** Always non-null unless the role was written. */
  reason: string | null;
  /**
   * Bytes ACTUALLY written to disk. `null` unless `status === "written"` — so it
   * can never be mistaken for the in-memory `capture.*.capturedBytes` of a log
   * that failed to reach the disk.
   */
  writtenBytes: number | null;
}

/**
 * Test seam (E4-R67/R68). It lets a SINGLE role's write — or a SINGLE file's
 * copy — fail deterministically, so the partial-archive paths are provable
 * without chmod races or random corruption. Production callers omit it and the
 * real `node:fs/promises` implementations are used.
 */
export interface EvidenceSeam {
  writeFile?: (path: string, data: string) => Promise<void>;
  copyFile?: (src: string, dest: string) => Promise<void>;
  /**
   * E4-R68: override a directory listing. This lets a test (a) classify a
   * NON-REGULAR entry deterministically WITHOUT needing platform symlink
   * privileges, and (b) control traversal order, so "a failure does not block a
   * later success / lose an earlier one" becomes provable instead of incidental.
   */
  readdir?: (path: string) => Promise<Dirent[]>;
}

export interface PreservedEvidence {
  /**
   * E4-R67: TRUE means a READABLE, self-describing archive exists — i.e.
   * `run.json` was written. It deliberately does NOT mean "every role is
   * complete": a partial archive is still `ok: true` because it is usable.
   * Use `archiveIntegrity` for completeness.
   */
  ok: boolean;
  /** Where the archive is — or, when `ok === false`, where it was attempted. */
  dir: string;
  /** Relative paths of files ACTUALLY written, for the report/log line. */
  files: string[];
  /** E4-R67: describes ONLY the diagnostics tree copy. */
  diagnosticsCopyIntegrity: CopyIntegrity;
  /** E4-R67: describes EVERY requested archive role, logs and report included. */
  archiveIntegrity: ArchiveIntegrity;
  /** E4-R67: per-role outcome for the content roles. */
  roles: EvidenceRoleRecord[];
  /** The diagnostics copy outcome; null when `diagDir` was not passed. */
  copy: CopyTreeResult | null;
  /** Why the archive failed; non-null only when `ok === false`. */
  error: string | null;
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
  const files: string[] = [];
  const writeFileImpl =
    input.seam?.writeFile ?? ((path: string, data: string) => writeFile(path, data, "utf8"));
  let dir: string;
  try {
    await mkdir(root, { recursive: true });
    const safeLabel = input.label.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
    dir = await mkdtemp(join(root, `${safeLabel}__`));
  } catch (err) {
    // Even the archive ROOT is unusable. Say so plainly — never hand back a
    // path that looks downloadable but holds nothing.
    reportDegraded("e4-r55 evidence root", err);
    return {
      ok: false,
      dir: root,
      files: [],
      diagnosticsCopyIntegrity: "not-requested",
      archiveIntegrity: "archive-failed",
      roles: [],
      copy: null,
      error: messageOf(err),
    };
  }

  const roles: EvidenceRoleRecord[] = [];

  /**
   * Write ONE content role and record its outcome (E4-R67). A failed write is no
   * longer only a stderr line — it becomes a structured fact inside `run.json`,
   * so an archive reader can tell "the log was never written" from "the log was
   * empty", and a complete diagnostics copy can no longer hide it.
   */
  const writeRole = async (role: EvidenceRole, name: string, body: string): Promise<void> => {
    try {
      await writeFileImpl(join(dir, name), body);
      files.push(name);
      roles.push({
        role,
        path: name,
        requested: true,
        status: "written",
        operation: "writeFile",
        errorCode: null,
        reason: null,
        writtenBytes: Buffer.byteLength(body, "utf8"),
      });
    } catch (err) {
      reportDegraded(`e4-r55 evidence write ${name}`, err);
      roles.push({
        role,
        path: name,
        requested: true,
        status: "failed",
        operation: "writeFile",
        errorCode: (err as { code?: string } | null)?.code ?? null,
        reason: messageOf(err),
        writtenBytes: null,
      });
    }
  };

  await writeRole("stdout", "child.stdout.txt", input.outcome.stdout);
  await writeRole("stderr", "child.stderr.txt", input.outcome.stderr);

  if (input.report.rawText === null) {
    // No raw report was available to save. That is NOT a write failure and NOT a
    // write success: record it as not-requested and keep the real `report.kind`,
    // so a reader never reads it as "the source report was missing".
    roles.push({
      role: "raw-report",
      path: null,
      requested: false,
      status: "not-requested",
      operation: null,
      errorCode: null,
      reason: `no raw report was available (report.kind=${input.report.kind})`,
      writtenBytes: null,
    });
  } else {
    await writeRole("raw-report", "child-report.json", input.report.rawText);
  }

  const copy =
    input.diagDir === undefined
      ? null
      : await copyTree(input.diagDir, join(dir, "diagnostics"), input.seam);
  if (copy !== null) files.push(...copy.copied.map((f) => `diagnostics/${f}`));

  // E4-R67 — TWO layers. The diagnostics copy is ONE role among several, so it
  // must not be reported as the integrity of the whole archive.
  const diagnosticsCopyIntegrity: CopyIntegrity = copy?.integrity ?? "not-requested";
  const failedRoles = roles.filter((r) => r.status === "failed").map((r) => r.role);
  const diagnosticsIncomplete =
    diagnosticsCopyIntegrity === "partial" || diagnosticsCopyIntegrity === "missing";
  const archiveIntegrity: ArchiveIntegrity =
    failedRoles.length > 0 || diagnosticsIncomplete ? "partial" : "complete";

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
    /**
     * E4-R63: the byte contract of the two log files.
     *
     * E4-R67 CAVEAT: `capturedBytes` is the number of bytes captured IN MEMORY.
     * It is NOT a claim that those bytes reached the disk — check
     * `evidence.archive.roles[].writtenBytes`, which is non-null only for a role
     * that was actually written.
     */
    capture: {
      stdout: input.outcome.capture.stdout,
      stderr: input.outcome.capture.stderr,
    },
    /**
     * E4-R64: what the tree kill achieved. Before this, a failed `taskkill` was
     * visible ONLY as a stderr line, so an archive reader could not tell whether
     * the tree was actually terminated.
     */
    treeKill: input.outcome.treeKill,
    /**
     * E4-R67: TWO layers, because a complete diagnostics copy does NOT imply a
     * complete archive.
     *   - `diagnostics` keeps the E4-R65 semantics: it describes ONLY the copied
     *     diagnostics tree (missing / partial / complete / not-requested).
     *   - `archive` describes EVERY requested role — the top-level logs and the
     *     raw report included — plus the per-role outcome list.
     */
    evidence: {
      diagnostics: {
        diagDir: input.diagDir ?? null,
        requested: copy !== null,
        integrity: diagnosticsCopyIntegrity,
        sourceMissing: copy?.sourceMissing ?? null,
        empty: copy?.empty ?? null,
        copiedCount: copy?.copied.length ?? 0,
        copied: copy?.copied ?? [],
        entries: copy?.entries ?? [],
      },
      archive: {
        integrity: archiveIntegrity,
        roles,
        failedRoles,
      },
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
  try {
    await writeFileImpl(join(dir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
    files.push("run.json");
  } catch (err) {
    // Without run.json the archive cannot explain itself, so it is NOT an
    // archive: report that instead of returning a usable-looking path. `dir` is
    // a LEFTOVER directory, not a successful archive.
    reportDegraded("e4-r55 evidence write run.json", err);
    return {
      ok: false,
      dir,
      files,
      diagnosticsCopyIntegrity,
      archiveIntegrity: "archive-failed",
      roles,
      copy,
      error: messageOf(err),
    };
  }

  return {
    ok: true,
    dir,
    files,
    diagnosticsCopyIntegrity,
    archiveIntegrity,
    roles,
    copy,
    error: null,
  };
}
