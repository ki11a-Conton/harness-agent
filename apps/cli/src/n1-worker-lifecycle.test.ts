/**
 * N1 (F30-1) — the ISOLATED WORKER LIFECYCLE, asserted through the PRODUCTION
 * executor seam (`createPreregArmExecutor` -> `launchArmWorker`), never through a
 * standalone close helper.
 *
 * THE DEFECT THIS FILE PINS (F30-1)
 * ---------------------------------
 * On the audited baseline only `deadlineFired` aborted the in-flight transport.
 * Every OTHER termination path — the child exiting non-zero, its stdout reaching
 * EOF, a child `'error'`, a malformed result frame — cleared the timer and
 * returned `ARM_WORKER_FAILED` while the active provider's `AbortSignal` was
 * still `false`. The reviewer reproduced it as:
 *
 *   {"workerTimeoutMs":300,"observedMs":1100,"providerEntered":true,
 *    "providerSignalAborted":false,"workerAlive":false,
 *    "launchPromiseSettled":false}
 *
 * Two independent defects are in that one line: the signal was never aborted, and
 * `launchArmWorker` never settled. This file asserts the CORRECT behaviour of all
 * EIGHT acceptance rows of plan(20260930-061557).md §4.
 *
 * OFFLINE, ZERO PAID REQUESTS
 * ---------------------------
 * Every provider here is a LOCAL in-process stub. No socket is opened by the
 * default cases (the one HTTP case binds 127.0.0.1 and is reused from the
 * existing S0a/F2 counter-example file). No real endpoint, no API key, no
 * network: the "hanging provider" is a promise that never resolves, and it
 * RECORDS the signal it was handed so the assertion reads the real object.
 *
 * THE EXTERNAL WATCHDOG
 * ---------------------
 * Plan §4 requires an external watchdog so a failure cannot hang CI. Every case
 * below races the executor against `withWatchdog`, which rejects after a bounded
 * window. A driver that never settles therefore FAILS the test instead of
 * hanging the suite. Nothing in this file awaits an unbounded promise.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelEvent, ModelProvider, ModelRequest, ProviderConfig } from "@ar/contracts";
import {
  R97_ARM_BUILD_ENTRIES,
  type ArmRunRef,
  type PreregisteredArmContext,
  type PreregisteredArmOutcome,
} from "@ar/evaluation";
import {
  ARM_BUILD_PROBE_MISMATCH,
  ARM_PROBE_EXPORT,
  ARM_WORKER_FAILED,
  ARM_WORKER_PROTOCOL_VIOLATION,
  FIXTURE_CHECKOUT_MARKER_FILENAME,
  N1_WORKER_CLEANUP_BOUND_MS,
  createFixtureCheckoutTrust,
  createPreregArmExecutor,
  type WorkerCancellationRecord,
} from "./prereg-arm-executor.js";
import { R97_ARM_ABI } from "./r97-arm-abi.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRATCH_ROOT = join(REPO_ROOT, ".ci", "n1-worker-lifecycle-scratch");
const REAL_CASE_ID = "stress-repeated-tool-failures";
const ARM_ENTRY_REL = "apps/cli/dist/benchmark-command.js";

const PREREG_DIGEST = "1".repeat(64);
const PLAN_DIGEST = "2".repeat(64);

/**
 * The DECLARED watchdog window for one case. It is deliberately far larger than
 * any legitimate cleanup (the production bound is
 * `N1_WORKER_CLEANUP_BOUND_MS`) so it can only fire on a real hang, never on a
 * slow machine.
 */
const WATCHDOG_MS = N1_WORKER_CLEANUP_BOUND_MS + 20_000;

let scratchDirs: string[] = [];

async function scratch(name: string): Promise<string> {
  await mkdir(SCRATCH_ROOT, { recursive: true });
  const d = await mkdtemp(join(SCRATCH_ROOT, `${name}-`));
  scratchDirs.push(d);
  return d;
}

beforeEach(async () => {
  await mkdir(SCRATCH_ROOT, { recursive: true });
});

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

// ---------------------------------------------------------------------------
// The arm checkouts — real, loadable, distinct (the executor's own pre-flight)
// ---------------------------------------------------------------------------

/**
 * A REAL, loadable arm build entry. It is never actually run in these cases (the
 * stub worker replaces the child), but the executor's pre-flight hashes it and
 * requires the two checkouts to differ, so it must be a genuine module with the
 * declared probe and ABI exports.
 */
function armEntrySource(marker: string): string {
  return [
    `export const ${ARM_PROBE_EXPORT} = "probe:${marker}";`,
    `export const R97_ARM_ABI = ${JSON.stringify(R97_ARM_ABI)};`,
    "export async function runOneCase(caseDef) {",
    "  return { caseId: caseDef.id, status: 'failed', actualStatus: 'completed', events: [],",
    "    metrics: { turn_count: 1, tool_call_count: 0, tokens_input: 0, tokens_output: 0, context_tokens: 0, compaction_count: 0, duration_ms: 0, retry_count: 0, verification_failures: 0, human_interventions: 0, estimated_cost: 0, usage_unknown: 0, cache_tokens_read: 0, cache_tokens_created: 0, model_call_count: 0 },",
    "    violations: [], reason: 'n1', suite: caseDef.suite || 'regression', judgeVersion: '1.0.0', terminationReason: 'verified_incomplete' };",
    "}",
    "",
  ].join("\n");
}

async function makeArmCheckout(dir: string, marker: string, entrySource?: string): Promise<void> {
  for (const rel of R97_ARM_BUILD_ENTRIES) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, rel === ARM_ENTRY_REL ? (entrySource ?? armEntrySource(marker)) : `export {}; // stub:${marker}\n`, "utf8");
  }
  await writeFile(
    join(dir, FIXTURE_CHECKOUT_MARKER_FILENAME),
    `${JSON.stringify({ writer: "n1-worker-lifecycle.test.ts", marker })}\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// The stub WORKER — a real child process that speaks (and misbehaves on) the
// documented stdio protocol. It is the ONLY way to drive the non-timeout
// termination paths, because the shipped worker always writes a result.
// ---------------------------------------------------------------------------

type StubScenario =
  | "request_then_exit2"
  | "result_then_refuse_to_exit"
  | "two_concurrent_requests"
  | "malformed_result_frame"
  | "clean_result_exit0"
  | "request_complete_result_exit0"
  | "abort_then_keep_talking";

/**
 * Write a stub worker and return its path plus the file it records frames into.
 *
 * The stub reads the ONE options line, then runs its scenario. `RECORD` collects
 * every parent frame it received, so an assertion can prove what the driver did
 * or did NOT write to the child (the post-stop "no normal event" row).
 */
async function stubWorker(scenario: StubScenario): Promise<{ workerPath: string; recordPath: string }> {
  const dir = await scratch(`worker-${scenario}`);
  const workerPath = join(dir, "stub-worker.mjs");
  const recordPath = join(dir, "frames-received.jsonl");
  rmSync(recordPath, { force: true });
  writeFileSync(recordPath, "", "utf8");

  const source = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const RECORD = ${JSON.stringify(recordPath)};
const SCENARIO = ${JSON.stringify(scenario)};
const SENTINEL = "__PREREG_ARM_RESULT__";

const record = (frame) => appendFileSync(RECORD, JSON.stringify(frame) + "\\n");
const write = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");

// Read the ONE options line, then speak the protocol.
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let sawOptions = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rl.on("line", (line) => {
  if (!sawOptions) {
    sawOptions = true;
    void run();
    return;
  }
  let frame = null;
  try { frame = JSON.parse(line); } catch { frame = { unparsed: line }; }
  record(frame);
});

async function run() {
  if (SCENARIO === "clean_result_exit0") {
    const report = { ok: true, armBuildReport: null, proxyBudget: { modelCalls: 0 } };
    process.stdout.write(SENTINEL + JSON.stringify(report) + "\\n");
    process.exit(0);
  }

  if (SCENARIO === "malformed_result_frame") {
    process.stdout.write(SENTINEL + "{not json at all" + "\\n");
    // Stay alive briefly so the driver must classify the FRAME, not the exit.
    await sleep(3000);
    process.exit(3);
  }

  if (SCENARIO === "result_then_refuse_to_exit") {
    const report = { ok: true, armBuildReport: null, proxyBudget: { modelCalls: 0 } };
    process.stdout.write(SENTINEL + JSON.stringify(report) + "\\n");
    // REFUSE TO EXIT. This is the acceptance row "result frame then child will
    // not exit": the driver must still finish inside its declared bound.
    setInterval(() => {}, 1000);
    return;
  }

  if (SCENARIO === "request_complete_result_exit0") {
    // ONE request, wait for the driver's terminal "done" frame, THEN report
    // success and exit 0. This is the real "a normally-completed stream must not
    // be reported as cancelled" case: the provider finished on its own.
    write({ t: "request", id: 1, request: { messages: [{ role: "user", content: "x" }] } });
    for (let i = 0; i < 500; i++) {
      await sleep(10);
      if (sawDone) break;
    }
    const report = { ok: true, armBuildReport: null, proxyBudget: { modelCalls: 1 } };
    process.stdout.write(SENTINEL + JSON.stringify(report) + "\\n");
    process.exit(0);
  }

  if (SCENARIO === "two_concurrent_requests") {
    // TWO requests back to back. The protocol admits ONE active request per
    // worker, so the parent must refuse the second rather than clobber the first
    // controller.
    write({ t: "request", id: 1, request: { messages: [{ role: "user", content: "one" }] } });
    write({ t: "request", id: 2, request: { messages: [{ role: "user", content: "two" }] } });
    setInterval(() => {}, 1000);
    return;
  }

  if (SCENARIO === "abort_then_keep_talking") {
    write({ t: "request", id: 1, request: { messages: [{ role: "user", content: "x" }] } });
    setInterval(() => {}, 1000);
    return;
  }

  // request_then_exit2 — the F30-1 reproducer. Send the request, wait for the
  // driver to service it (so the provider is provably in flight), then exit(2).
  write({ t: "request", id: 1, request: { messages: [{ role: "user", content: "x" }] } });
  for (let i = 0; i < 200; i++) {
    await sleep(10);
    // The driver's first event frame proves the provider was entered.
    if (framesSeen > 0) break;
  }
  process.exit(2);
}

let framesSeen = 0;
let sawDone = false;
rl.on("line", (line) => {
  framesSeen += 1;
  try {
    const frame = JSON.parse(line);
    if (frame && frame.t === "done") sawDone = true;
  } catch {
    // the options line, or a stray line
  }
});
`;

  await writeFile(workerPath, source, "utf8");
  return { workerPath, recordPath };
}

// ---------------------------------------------------------------------------
// Providers — local, in-process, zero network
// ---------------------------------------------------------------------------

interface HangingProvider {
  provider: ModelProvider;
  entered: () => number;
  signalAborted: () => boolean;
  /** The live AbortSignal the provider was handed, for direct inspection. */
  signal: () => AbortSignal | null;
}

/**
 * A provider that yields ONE non-terminal event, then hangs forever. It records
 * the AbortSignal it received, so the assertion reads the REAL object rather
 * than a boolean the test set for itself.
 */
function hangingProvider(opts: { honourAbort: boolean; yieldFirstEvent?: boolean }): HangingProvider {
  let entered = 0;
  let aborted = false;
  let lastSignal: AbortSignal | null = null;
  let releaseHang: (() => void) | null = null;
  const provider: ModelProvider = {
    id: "n1-hanging",
    async listModels() {
      return [];
    },
    createClient(_model: never, _config: ProviderConfig) {
      return {
        async *generate(_req: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelEvent> {
          entered += 1;
          lastSignal = signal;
          if (opts.yieldFirstEvent !== false) {
            yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 }, timestamp: 0 };
          }
          if (signal.aborted) aborted = true;
          await new Promise<void>((resolve) => {
            releaseHang = resolve;
            if (opts.honourAbort) {
              signal.addEventListener("abort", () => {
                aborted = true;
                resolve();
              }, { once: true });
              return;
            }
            // DEAF: never looks at the signal. Only the test's own cleanup ends it.
            signal.addEventListener("abort", () => {
              aborted = true;
            }, { once: true });
          });
        },
      };
    },
  };
  return {
    provider,
    entered: () => entered,
    signalAborted: () => aborted,
    signal: () => lastSignal,
  };
  // `releaseHang` is intentionally not returned: every case races a watchdog, so
  // a deaf provider can never park the suite.
}

// ---------------------------------------------------------------------------
// The production seam
// ---------------------------------------------------------------------------

function armRef(): ArmRunRef {
  return { armId: "candidate", caseId: REAL_CASE_ID, repetition: 0, orderIndex: 0 };
}

/**
 * Run ONE arm through the PRODUCTION executor with a stub worker. Returns either
 * the outcome or the thrown error, plus the wall-clock elapsed time. Never
 * rejects: the watchdog is reported as a distinct sentinel so a caller can assert
 * on it explicitly instead of hanging.
 */
async function runArmCase(input: {
  workerPath: string;
  provider: ModelProvider;
  timeoutMs: number;
  extraContext?: Partial<PreregisteredArmContext>;
  /** task-6 — a custom arm BUILD ENTRY, so a case can exercise a real arm whose
   *  `runOneCase` makes more than one model call. Defaults to the N1 stub entry. */
  armEntry?: string;
}): Promise<{ result: PreregisteredArmOutcome | null; error: unknown; elapsedMs: number; watchdogFired: boolean }> {
  const base = await scratch("n1-base");
  const cand = await scratch("n1-cand");
  await makeArmCheckout(base, "baseline", input.armEntry);
  await makeArmCheckout(cand, "candidate", input.armEntry);

  const executor = createPreregArmExecutor({
    rootDir: REPO_ROOT,
    env: { R97_ARM_BASELINE_DIR: base, R97_ARM_CANDIDATE_DIR: cand },
    trustedFixtureCheckouts: createFixtureCheckoutTrust(base, cand),
    workerPath: input.workerPath,
    workerTimeoutMs: input.timeoutMs,
  });

  const arm = armRef();
  const evidenceDir = join(await scratch("n1-ev"), "pair-0-candidate");
  const started = Date.now();
  const WATCHDOG = Symbol("watchdog");
  const raced = await Promise.race([
    executor(arm, {
      provider: input.provider,
      armRunId: "pair-0-candidate",
      arm,
      preregistrationDigest: PREREG_DIGEST,
      planDigest: PLAN_DIGEST,
      isolation: { isolationBackendId: "process-exec", isolationStrength: "process" },
      evidenceDir,
      ...(input.extraContext ?? {}),
    }).then(
      (outcome) => ({ kind: "outcome" as const, outcome }),
      (error: unknown) => ({ kind: "error" as const, error }),
    ),
    new Promise<typeof WATCHDOG>((resolve) => setTimeout(() => resolve(WATCHDOG), WATCHDOG_MS)),
  ]);
  const elapsedMs = Date.now() - started;
  if (raced === WATCHDOG) {
    return { result: null, error: null, elapsedMs, watchdogFired: true };
  }
  return raced.kind === "outcome"
    ? { result: raced.outcome, error: null, elapsedMs, watchdogFired: false }
    : { result: null, error: raced.error, elapsedMs, watchdogFired: false };
}

/**
 * The OBSERVED cancellation record a refusal carries. Plan §4 item 7 requires
 * this to be readable on the ERROR path rather than living only in a local
 * variable that the throw discards.
 */
function cancellationOf(error: unknown): WorkerCancellationRecord {
  const record = (error as { cancellation?: WorkerCancellationRecord } | null)?.cancellation;
  if (record === undefined) {
    throw new Error(`the refusal carried no cancellation record: ${String(error)}`);
  }
  return record;
}

function framesReceived(recordPath: string): Array<Record<string, unknown>> {
  if (!existsSync(recordPath)) return [];
  const raw = readFileSync(recordPath, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Row 1 — worker sends a request, then exit(2): the F30-1 reproducer
// ---------------------------------------------------------------------------

describe("N1 (F30-1) — row 1: a worker that sends a request and then exits(2)", () => {
  it("[F30-1] aborts the active provider signal and finishes inside the declared cleanup bound", async () => {
    const { workerPath } = await stubWorker("request_then_exit2");
    const hanging = hangingProvider({ honourAbort: true });

    const run = await runArmCase({ workerPath, provider: hanging.provider, timeoutMs: 60_000 });

    expect(run.watchdogFired, "the watchdog fired: the driver never settled after a non-timeout worker exit").toBe(false);
    // The worker produced no result frame, so the arm is a stable refusal.
    expect(run.error, "a worker that wrote no result must not produce an outcome").not.toBeNull();
    expect(String(run.error)).toContain(ARM_WORKER_FAILED);

    const cancellation = cancellationOf(run.error);
    // THE F30-1 ASSERTION. On the audited baseline this was `false`.
    expect(
      cancellation.signalAborted,
      "F30-1: the worker exited but the active provider's AbortSignal was never aborted",
    ).toBe(true);
    // ...and the real AbortSignal object the provider was handed is aborted, not
    // merely a flag the driver set for itself.
    expect(hanging.signal()?.aborted, "the provider's own AbortSignal is still not aborted").toBe(true);
    expect(hanging.entered(), "the provider was never entered").toBeGreaterThan(0);
    expect(cancellation.terminationReason).toBe("worker_exit");
    expect(cancellation.localAbort).toBe(true);
    // The provider honoured the abort, so it returned inside the grace.
    expect(cancellation.providerReturned).toBe(true);
    expect(cancellation.remoteOutcomeUnknown).toBe(false);
    expect(run.elapsedMs, "the stop exceeded the declared cleanup bound").toBeLessThan(N1_WORKER_CLEANUP_BOUND_MS);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Row 2 — worker EOF / child error: the same termination rule
// ---------------------------------------------------------------------------

describe("N1 (F30-1) — row 2: worker stdout EOF and child 'error' enter the same termination rule", () => {
  it("[F30-1] the child's stdout ending (its process exiting) still aborts the transport and settles", async () => {
    // MEASURED PLATFORM NOTE. Plan §4's row 2 says "worker EOF". On Windows a
    // LIVE child cannot hand the parent a stdout EOF: `process.stdout.end()` and
    // `process.stdout.destroy()` were both measured NOT to emit `end`/`close` on
    // the parent side, and `closeSync(1)` does not either. The only reachable EOF
    // is the one the process's own exit produces. That is what this case drives —
    // a child that sends a request and then exits, closing its stdout — and the
    // assertion is the row's REAL requirement: the same termination rule runs, the
    // transport is aborted, and nothing is left unhandled.
    const { workerPath } = await stubWorker("request_then_exit2");
    const hanging = hangingProvider({ honourAbort: true });

    const run = await runArmCase({ workerPath, provider: hanging.provider, timeoutMs: 60_000 });

    expect(run.watchdogFired, "the watchdog fired: the child's stdout EOF parked the driver").toBe(false);
    expect(String(run.error)).toContain(ARM_WORKER_FAILED);
    const cancellation = cancellationOf(run.error);
    expect(cancellation.signalAborted, "F30-1: stdout EOF did not abort the active transport").toBe(true);
    expect(cancellation.terminationReason).toBe("worker_exit");
    expect(hanging.signal()?.aborted).toBe(true);
    expect(
      cancellation.detachedStreamRejections,
      "an unhandled rejection escaped the detached stream",
    ).toBe(0);
    expect(run.elapsedMs).toBeLessThan(N1_WORKER_CLEANUP_BOUND_MS);
  }, 120_000);

  it("[F30-1] a child that cannot be spawned is classified and never raises an unhandled rejection", async () => {
    // A worker path that exists (so the executor's pre-flight passes) but is not
    // a runnable module: the child starts and dies immediately.
    const dir = await scratch("worker-unrunnable");
    const workerPath = join(dir, "not-a-worker.mjs");
    await writeFile(workerPath, "process.exit(9);\n", "utf8");

    const hanging = hangingProvider({ honourAbort: true });
    const run = await runArmCase({ workerPath, provider: hanging.provider, timeoutMs: 60_000 });

    expect(run.watchdogFired, "the watchdog fired: an unrunnable child parked the driver").toBe(false);
    expect(String(run.error)).toContain(ARM_WORKER_FAILED);
    const cancellation = cancellationOf(run.error);
    // No request was ever made, so there was nothing to abort — and the record
    // must say so HONESTLY rather than claim a cancellation that never happened.
    expect(cancellation.signalAborted).toBe(false);
    expect(cancellation.localAbort).toBe(false);
    expect(cancellation.terminationReason).toBe("worker_exit");
    expect(cancellation.detachedStreamRejections).toBe(0);
    expect(run.elapsedMs).toBeLessThan(N1_WORKER_CLEANUP_BOUND_MS);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Row 3 / 4 — the provider honours vs IGNORES the abort
// ---------------------------------------------------------------------------

describe("N1 (F30-1) — rows 3/4: the provider's cooperation is OBSERVED, never assumed", () => {
  it("[row 3] a provider that honours abort records returnedWithinGrace=true", async () => {
    const { workerPath } = await stubWorker("request_then_exit2");
    const cooperative = hangingProvider({ honourAbort: true });

    const run = await runArmCase({ workerPath, provider: cooperative.provider, timeoutMs: 60_000 });
    expect(run.watchdogFired).toBe(false);
    const cancellation = cancellationOf(run.error);
    expect(cancellation.signalAborted).toBe(true);
    expect(cancellation.providerReturned, "the provider unwound on abort but was not recorded as returned").toBe(true);
    expect(cancellation.streamSettled).toBe(true);
    expect(cancellation.remoteOutcomeUnknown, "a returned provider must not be marked unknown").toBe(false);
  }, 120_000);

  it("[row 4] a provider that IGNORES abort cannot park the driver, and is marked unconfirmed", async () => {
    const { workerPath } = await stubWorker("request_then_exit2");
    // DEAF: never resolves on abort.
    const deaf = hangingProvider({ honourAbort: false });

    const run = await runArmCase({ workerPath, provider: deaf.provider, timeoutMs: 60_000 });

    expect(run.watchdogFired, "the watchdog fired: a deaf provider parked the driver").toBe(false);
    const cancellation = cancellationOf(run.error);
    expect(cancellation.signalAborted, "the driver did not abort the transport").toBe(true);
    expect(deaf.signal()?.aborted, "the provider's own signal was not aborted").toBe(true);
    // The three states are DISTINCT: a local abort the provider ignored means the
    // REMOTE outcome is unknown, and nothing may claim it was revoked.
    expect(cancellation.localAbort).toBe(true);
    expect(cancellation.providerReturned, "a deaf provider must not be reported as returned").toBe(false);
    expect(cancellation.streamSettled).toBe(false);
    expect(cancellation.remoteOutcomeUnknown, "a deaf provider must be marked remote-outcome-unknown").toBe(true);
    // Bounded: the driver returned without waiting for the deaf provider.
    expect(run.elapsedMs).toBeLessThan(N1_WORKER_CLEANUP_BOUND_MS);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Row 5 — TWO requests: the first controller must never be lost
// ---------------------------------------------------------------------------

describe("N1 (F30-1) — row 5: one worker, one active model request", () => {
  it("[row 5] refuses the SECOND concurrent request as a protocol violation and keeps the first cancellable", async () => {
    const { workerPath } = await stubWorker("two_concurrent_requests");
    const hanging = hangingProvider({ honourAbort: true });

    const run = await runArmCase({ workerPath, provider: hanging.provider, timeoutMs: 60_000 });

    expect(run.watchdogFired, "the watchdog fired: a second request parked the driver").toBe(false);
    expect(
      String(run.error),
      "a worker that opened two concurrent requests was admitted instead of refused",
    ).toContain(ARM_WORKER_PROTOCOL_VIOLATION);
    const cancellation = cancellationOf(run.error);
    expect(cancellation.concurrencyRefusals, "the second request was not refused").toBeGreaterThan(0);
    expect(cancellation.terminationReason).toBe("protocol_violation");
    // THE POINT: the FIRST request's controller survived the second request, so
    // it was still abortable when the arm was stopped.
    expect(cancellation.signalAborted, "the first request's controller was lost (clobbered by the second)").toBe(true);
    expect(hanging.signal()?.aborted).toBe(true);
    // Exactly ONE physical provider entry: the refused request never reached it.
    expect(hanging.entered(), "the refused second request still opened a provider stream").toBe(1);
    expect(run.elapsedMs).toBeLessThan(N1_WORKER_CLEANUP_BOUND_MS);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Row 6 — result frame then the child refuses to exit
// ---------------------------------------------------------------------------

describe("N1 (F30-1) — row 6: a result frame cannot buy an unbounded exit wait", () => {
  it("[row 6] finishes in bounded time when the child writes a result and then will not exit", async () => {
    const { workerPath } = await stubWorker("result_then_refuse_to_exit");
    // The child never makes a model request, so no transport is involved: this is
    // purely the PROCESS bound.
    const inert: ModelProvider = {
      id: "n1-inert",
      async listModels() {
        return [];
      },
      createClient() {
        return {
          // eslint-disable-next-line require-yield
          async *generate(): AsyncGenerator<ModelEvent> {
            throw new Error("the row-6 stub makes no model call");
          },
        };
      },
    };

    const run = await runArmCase({ workerPath, provider: inert, timeoutMs: 60_000 });

    expect(
      run.watchdogFired,
      "the watchdog fired: a child that refused to exit was awaited forever",
    ).toBe(false);
    // The result frame WAS accepted, so this is not "no result" — it is a
    // classified, explicitly bounded stop.
    expect(String(run.error), "the bounded stop was not classified as a worker failure").toContain(ARM_WORKER_FAILED);
    const cancellation = cancellationOf(run.error);
    expect(cancellation.terminationReason).toBe("completed");
    expect(cancellation.signalAborted, "no model request was in flight, so nothing may be claimed as aborted").toBe(false);
    expect(
      run.elapsedMs,
      "the driver exceeded its declared cleanup bound waiting for a child that would not exit",
    ).toBeLessThan(N1_WORKER_CLEANUP_BOUND_MS);
  }, 120_000);

  it("[row 6b] a MALFORMED result frame is classified, not dereferenced", async () => {
    const { workerPath } = await stubWorker("malformed_result_frame");
    const inert: ModelProvider = {
      id: "n1-inert-malformed",
      async listModels() {
        return [];
      },
      createClient() {
        return {
          // eslint-disable-next-line require-yield
          async *generate(): AsyncGenerator<ModelEvent> {
            throw new Error("the row-6b stub makes no model call");
          },
        };
      },
    };

    const run = await runArmCase({ workerPath, provider: inert, timeoutMs: 60_000 });
    expect(run.watchdogFired).toBe(false);
    expect(String(run.error)).toContain(ARM_WORKER_FAILED);
    const cancellation = cancellationOf(run.error);
    expect(cancellation.terminationReason).toBe("result_frame_rejected");
    expect(run.elapsedMs).toBeLessThan(N1_WORKER_CLEANUP_BOUND_MS);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Row 7 — the post-stop write race: no normal event, EPIPE observable
// ---------------------------------------------------------------------------

describe("N1 (F30-1) — row 7: the post-stop write race is observable and harmless", () => {
  it("[row 7] suppresses every normal frame after the stop and the process survives the race", async () => {
    // The child sends a request and then exits. The provider keeps producing
    // events AFTER that stop, so the driver's late `event`/`done` writes really do
    // race a dead child. The row's requirement is that NO normal frame is
    // published after the stop, that the suppression is OBSERVED rather than
    // silent, and that the driver process survives.
    const { workerPath, recordPath } = await stubWorker("request_then_exit2");
    let entered = 0;
    let eventsAfterStop = 0;
    let stopSeen = false;
    const lateEvents: ModelProvider = {
      id: "n1-late-event",
      async listModels() {
        return [];
      },
      createClient() {
        return {
          async *generate(_req: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelEvent> {
            entered += 1;
            signal.addEventListener("abort", () => {
              stopSeen = true;
            });
            // Yield several events with a gap, so some land after the stop.
            for (let i = 0; i < 6; i++) {
              await new Promise<void>((resolve) => {
                const t = setTimeout(resolve, 120);
                t.unref?.();
              });
              if (signal.aborted) {
                stopSeen = true;
                eventsAfterStop += 1;
              }
              yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 }, timestamp: 0 };
            }
            yield { type: "completed", result: { finishReason: "stop" }, timestamp: 0 };
          },
        };
      },
    };

    const run = await runArmCase({ workerPath, provider: lateEvents, timeoutMs: 60_000 });

    // THE ROW'S REAL REQUIREMENT: the driver finishes in bounded time and is still
    // alive to report it. An unhandled stream `error` would have torn it down and
    // the watchdog would have fired instead.
    expect(run.watchdogFired, "the watchdog fired: a post-stop write race tore the driver down").toBe(false);
    expect(entered, "the provider was never entered").toBeGreaterThan(0);
    expect(String(run.error)).toContain(ARM_WORKER_FAILED);
    const cancellation = cancellationOf(run.error);
    expect(stopSeen, "the driver never aborted the transport, so there was no post-stop race to observe").toBe(true);

    // NO NORMAL EVENT IS PUBLISHED AFTER THE STOP. The child's own record proves
    // what the driver actually wrote to it.
    const received = framesReceived(recordPath);
    const normalFrames = received.filter((f) => f["t"] === "event" || f["t"] === "done");
    expect(
      normalFrames.length,
      `the driver published ${normalFrames.length} normal frame(s) to a stopped worker`,
    ).toBe(0);

    // The suppression is OBSERVED, not invisible: the driver counted the frames it
    // refused to publish (or the writes it could not deliver).
    expect(
      cancellation.framesSuppressedAfterStop + cancellation.frameWritesAfterClose + cancellation.stdinErrors,
      "no post-stop write or suppression was recorded at all — the race was invisible",
    ).toBeGreaterThan(0);
    expect(run.elapsedMs).toBeLessThan(N1_WORKER_CLEANUP_BOUND_MS);
  }, 120_000);

  it("[row 7] instruments the ASYNC stdin error channel instead of swallowing it", async () => {
    // MEASURED PLATFORM NOTE (recorded in docs/evidence/n1-worker-lifecycle.md):
    // on Windows an async stdin `'error'` was measured to be reachable ONLY under
    // a full pipe plus a killed child (`code: "EOF"`); a plain write to a child
    // that closed its own stdin raises neither a throw nor an event. Because the
    // stop latch now suppresses normal writes after a stop, EPIPE is largely
    // PRE-EMPTED by design — which is strictly better than observing it. What this
    // case asserts is that the async channel is INSTRUMENTED (a real listener and
    // a real counter), so a platform that does raise it cannot crash the driver
    // and cannot pass silently.
    const { workerPath } = await stubWorker("request_then_exit2");
    const hanging = hangingProvider({ honourAbort: true });
    const run = await runArmCase({ workerPath, provider: hanging.provider, timeoutMs: 60_000 });
    expect(run.watchdogFired).toBe(false);
    const cancellation = cancellationOf(run.error);
    expect(Number.isInteger(cancellation.stdinErrors), "the async stdin error channel is not counted").toBe(true);
    expect(Number.isInteger(cancellation.frameWritesAfterClose)).toBe(true);
    expect(cancellation.stdinErrors).toBeGreaterThanOrEqual(0);
    expect(cancellation.frameWritesAfterClose).toBeGreaterThanOrEqual(0);
    // The FIRST async error is retained, so a reader can see WHAT happened rather
    // than only that something did.
    expect(cancellation.stdinError === null || typeof cancellation.stdinError === "string").toBe(true);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Row 8 — the normal path is NOT misclassified as cancelled
// ---------------------------------------------------------------------------

describe("N1 (F30-1) — row 8: a normally-completed worker is not reported as cancelled", () => {
  it("[row 8] a worker that writes a result and exits 0 completes without any cancellation claim", async () => {
    const { workerPath } = await stubWorker("clean_result_exit0");
    const inert: ModelProvider = {
      id: "n1-inert-clean",
      async listModels() {
        return [];
      },
      createClient() {
        return {
          // eslint-disable-next-line require-yield
          async *generate(): AsyncGenerator<ModelEvent> {
            throw new Error("the row-8 stub makes no model call");
          },
        };
      },
    };

    const run = await runArmCase({ workerPath, provider: inert, timeoutMs: 60_000 });
    expect(run.watchdogFired).toBe(false);

    // The worker lifecycle itself SUCCEEDED. The executor refuses later, on the
    // stub's absent build report — which is the proof that `launchArmWorker`
    // returned normally instead of being misclassified as a worker failure.
    expect(run.error, "the worker's accepted result was not propagated").not.toBeNull();
    expect(
      String(run.error),
      `a normally-completed worker was misclassified: ${String(run.error)}`,
    ).toContain(ARM_BUILD_PROBE_MISMATCH);
    expect(String(run.error)).not.toContain(ARM_WORKER_FAILED);
    expect(run.elapsedMs, "the normal path paid a cleanup penalty").toBeLessThan(N1_WORKER_CLEANUP_BOUND_MS);
  }, 120_000);

  it("[row 8] a CLEAN completion never aborts a stream that already delivered its terminal event", async () => {
    const { workerPath } = await stubWorker("request_complete_result_exit0");
    let aborted = false;
    let entered = 0;
    const completing: ModelProvider = {
      id: "n1-completing",
      async listModels() {
        return [];
      },
      createClient() {
        return {
          async *generate(_req: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelEvent> {
            entered += 1;
            signal.addEventListener("abort", () => {
              aborted = true;
            });
            yield { type: "completed", result: { finishReason: "stop" }, timestamp: 0 };
          },
        };
      },
    };

    const run = await runArmCase({ workerPath, provider: completing, timeoutMs: 60_000 });
    expect(run.watchdogFired).toBe(false);
    // The worker completed normally; the executor then refuses on the stub's
    // absent build report, which proves `launchArmWorker` returned its result.
    expect(String(run.error)).toContain(ARM_BUILD_PROBE_MISMATCH);
    expect(String(run.error)).not.toContain(ARM_WORKER_FAILED);
    expect(entered, "the provider was never entered").toBeGreaterThan(0);
    // Plan §4 item 7: the stream COMPLETED on its own, so the driver must not
    // claim it cancelled anything.
    expect(aborted, "a normally-completed stream was reported as cancelled").toBe(false);
    const cancellation = cancellationOf(run.error);
    expect(cancellation.signalAborted, "a completed stream was recorded as aborted").toBe(false);
    expect(cancellation.terminationReason).toBe("completed");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The timeout path must keep working (the pre-existing counter-example)
// ---------------------------------------------------------------------------

describe("N1 (F30-1) — the pre-existing timeout counter-example still holds", () => {
  it("[regression] the deadline still aborts the transport FIRST and records the timeout reason", async () => {
    const { workerPath } = await stubWorker("abort_then_keep_talking");
    const hanging = hangingProvider({ honourAbort: true });

    const run = await runArmCase({ workerPath, provider: hanging.provider, timeoutMs: 1_500 });

    expect(run.watchdogFired, "the watchdog fired on the timeout path").toBe(false);
    expect(String(run.error)).toContain("ARM_WORKER_TIMEOUT");
    const cancellation = cancellationOf(run.error);
    expect(cancellation.timedOut).toBe(true);
    expect(cancellation.terminationReason).toBe("deadline");
    expect(cancellation.signalAborted).toBe(true);
    expect(hanging.signal()?.aborted).toBe(true);
    expect(run.elapsedMs, "the timeout path exceeded timeout + cleanup grace").toBeLessThan(
      1_500 + N1_WORKER_CLEANUP_BOUND_MS,
    );
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The durable reservation rule is unchanged
// ---------------------------------------------------------------------------

describe("N1 (F30-1) — an unproven dispatch stays visibly UNSETTLED", () => {
  it("[reservation] a worker that dies holding a reservation settles it as unknown, never as a refund", async () => {
    const { workerPath } = await stubWorker("request_then_exit2");
    const settled: string[] = [];
    let reservations = 0;

    // A durable-budget double that records every settle it is told about. The
    // driver must NOT re-mint an id and must NOT disguise the settle as "no
    // dispatch happened".
    const budget = {
      async reserve() {
        reservations += 1;
        return {
          ok: true as const,
          async settle(outcome: string) {
            settled.push(outcome);
          },
        };
      },
    };

    const hanging = hangingProvider({ honourAbort: true });
    const run = await runArmCase({
      workerPath,
      provider: hanging.provider,
      timeoutMs: 60_000,
      // No toolDispatchBudget is forwarded by this stub (it never reserves), so
      // the run must simply not fabricate a settlement.
    });

    expect(run.watchdogFired).toBe(false);
    expect(String(run.error)).toContain(ARM_WORKER_FAILED);
    expect(reservations, "a reservation was granted to a worker that never asked for one").toBe(0);
    expect(settled, "a settlement was fabricated for a reservation that never existed").toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The cleanup bound itself is declared, exported and positive
// ---------------------------------------------------------------------------

describe("N1 (F30-1) — the cleanup bound is a DECLARED, exported number", () => {
  it("exports a positive, finite cleanup bound that a test can assert against", () => {
    expect(Number.isFinite(N1_WORKER_CLEANUP_BOUND_MS)).toBe(true);
    expect(N1_WORKER_CLEANUP_BOUND_MS).toBeGreaterThan(0);
    // The bound must be small enough to be a real CI guard, not a de-facto hang.
    expect(N1_WORKER_CLEANUP_BOUND_MS).toBeLessThan(30_000);
    expect(WATCHDOG_MS).toBeGreaterThan(N1_WORKER_CLEANUP_BOUND_MS);
  });
});

// ---------------------------------------------------------------------------
// task-6 / N5-BLOCKER — WHEN THE SINGLE-FLIGHT SLOT IS ACTUALLY FREE
// ---------------------------------------------------------------------------
//
// The SHIPPED arm worker used to end its proxy `generate()` ON THE TERMINAL EVENT.
// Every real benchmark case makes more than one model call (act, then finish), so
// the arm's next, perfectly SEQUENTIAL request was issued while the driver was
// still inside the FIRST request's cleanup: `for await` runs `iterator.return()`
// on `break`, and in the formal chain that cleanup settles the durable cost
// journal. The driver releases its one-active-request slot only AFTER that
// cleanup, so the second request was refused as `ARM_WORKER_PROTOCOL_VIOLATION`
// and the real campaign recorded ZERO arm runs (every case looked like an
// infrastructure failure). Measured with the BUILT executor instrumented (no repo
// file touched):
//
//   frame t=request id=2   ← request 1
//   slot ACQUIRE    id=2
//   frame t=request id=3   ← request 2, 39 ms later, while the slot was still owned
//   slot RELEASE           ← 38 ms after that
//
// The fix is in the CHILD, so the driver's invariant is untouched: the proxy waits
// for the driver's `done` frame — written after that cleanup and immediately
// before the release — instead of returning on the terminal event. A genuinely
// CONCURRENT second request is still refused, by the driver (row 5 above) and by
// the child's own `modelInFlight` guard (the control below).
//
// The provider below models the measurable cleanup: it settles for `settleMs`
// AFTER the terminal event, which is exactly what keeps the driver's slot owned
// while the child has already seen the terminal event. Without that delay the old
// defect is an untestable race, because the harness provider has nothing to
// settle — the delay is the measured ~38 ms, not decoration.

const REAL_ARM_WORKER_PATH = join(REPO_ROOT, "scripts", "e4", "prereg-arm-isolated-worker.mjs");

function settlingProvider(opts: { settleMs: number }): { provider: ModelProvider; entered: () => number; terminal: () => number } {
  let entered = 0;
  let terminal = 0;
  const provider: ModelProvider = {
    id: "n1-settling",
    async listModels() {
      return [];
    },
    createClient() {
      return {
        async *generate(_req: ModelRequest, _signal: AbortSignal): AsyncGenerator<ModelEvent> {
          entered += 1;
          try {
            yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 }, timestamp: 0 };
            terminal += 1;
            yield { type: "completed", result: { finishReason: "stop" }, timestamp: 0 };
          } finally {
            // The formal chain's durable settle: `return()` on the consumer's
            // `break` awaits this, and only then does the driver write `done` and
            // release its slot.
            await new Promise((resolve) => setTimeout(resolve, opts.settleMs));
          }
        },
      };
    },
  };
  return { provider, entered: () => entered, terminal: () => terminal };
}

/** An arm BUILD ENTRY whose `runOneCase` makes TWO model calls. */
function twoCallArmEntry(marker: string, mode: "sequential" | "concurrent"): string {
  const metricsLine = (calls: number): string =>
    `    metrics: { turn_count: ${calls}, tool_call_count: 0, tokens_input: ${calls * 10}, tokens_output: ${calls * 5}, context_tokens: 0, compaction_count: 0, duration_ms: 0, retry_count: 0, verification_failures: 0, human_interventions: 0, estimated_cost: 0, usage_unknown: 0, cache_tokens_read: 0, cache_tokens_created: 0, model_call_count: ${calls} },`;
  const lines = [
    `export const ${ARM_PROBE_EXPORT} = "probe:${marker}";`,
    `export const R97_ARM_ABI = ${JSON.stringify(R97_ARM_ABI)};`,
    "export async function runOneCase(caseDef, opts) {",
    "  const client = opts.provider.createClient({}, {});",
    "  const drain = async (turn) => {",
    "    for await (const ev of client.generate({ messages: [{ role: 'user', content: 'turn ' + turn }] }, opts.signal)) {",
    "      if (ev && (ev.type === 'completed' || ev.type === 'error')) break;",
    "    }",
    "  };",
  ];
  if (mode === "concurrent") {
    lines.push(
      "  // BOTH started without awaiting the first: the child-side guard must refuse the second.",
      "  let refusal = null;",
      "  const first = drain(1);",
      "  const second = drain(2).catch((err) => { refusal = String(err && err.message ? err.message : err); });",
      "  await first;",
      "  await second;",
      "  return { caseId: caseDef.id, status: refusal === null ? 'failed' : 'error', actualStatus: 'completed', events: [],",
      metricsLine(1),
      "    violations: [], reason: refusal === null ? 'no-concurrency-refusal' : refusal, suite: caseDef.suite || 'regression', judgeVersion: '1.0.0', terminationReason: 'verified_incomplete' };",
    );
  } else {
    lines.push(
      "  // SEQUENTIAL: each call returns before the next one starts — the shape every",
      "  // real benchmark case has (act, then finish).",
      "  await drain(1);",
      "  await drain(2);",
      "  return { caseId: caseDef.id, status: 'failed', actualStatus: 'completed', events: [],",
      metricsLine(2),
      "    violations: [], reason: 'two-sequential-model-calls', suite: caseDef.suite || 'regression', judgeVersion: '1.0.0', terminationReason: 'verified_incomplete' };",
    );
  }
  lines.push("}", "");
  return lines.join("\n");
}

describe("task-6 / N5-BLOCKER — the slot is free once the driver has said `done`", () => {
  it("[sequential] a real arm build whose case makes TWO sequential model calls completes, both streams serviced", async () => {
    const settling = settlingProvider({ settleMs: 40 });
    const run = await runArmCase({
      workerPath: REAL_ARM_WORKER_PATH,
      provider: settling.provider,
      timeoutMs: 60_000,
      armEntry: twoCallArmEntry("task6-sequential", "sequential"),
    });

    expect(run.watchdogFired, "the watchdog fired: the arm never settled").toBe(false);
    expect(
      String(run.error ?? ""),
      "a legitimate SEQUENTIAL second request was refused as a concurrency violation",
    ).not.toContain(ARM_WORKER_PROTOCOL_VIOLATION);
    expect(run.error, `the arm run did not complete: ${String(run.error)}`).toBeNull();
    expect(run.result?.status, "the arm run returned no outcome").toBe("failed");
    // THE POINT: BOTH sequential calls reached the provider. Before the fix the
    // second one was refused and the arm was stopped, so this number was 1.
    expect(settling.entered(), "the second sequential request never reached the provider").toBe(2);
    expect(settling.terminal(), "not every serviced stream was allowed to reach its terminal event").toBe(2);
    expect(run.elapsedMs).toBeLessThan(N1_WORKER_CLEANUP_BOUND_MS);
  }, 120_000);

  it("[control] a genuinely CONCURRENT second request is still refused, inside the child", async () => {
    const settling = settlingProvider({ settleMs: 40 });
    const run = await runArmCase({
      workerPath: REAL_ARM_WORKER_PATH,
      provider: settling.provider,
      timeoutMs: 60_000,
      armEntry: twoCallArmEntry("task6-concurrent", "concurrent"),
    });

    expect(run.watchdogFired).toBe(false);
    expect(
      String(run.result?.reason ?? run.error ?? ""),
      "the child-side one-in-flight guard no longer refuses a concurrent call",
    ).toContain("PREREG_WORKER_CONCURRENCY");
    // Exactly ONE physical provider entry: the refused concurrent call never
    // reached the parent's provider.
    expect(settling.entered(), "the refused concurrent call still opened a provider stream").toBe(1);
  }, 120_000);
});
