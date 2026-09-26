/**
 * A5/B3 — the PRODUCTION paired-arm executor for the v2 pre-registered campaign.
 *
 * WHY THIS EXISTS
 * ---------------
 * `createProductionPreregRunner` used to answer every `runArm` with
 * `ARM_EXECUTOR_NOT_WIRED`: no shipped executor existed, so the release CLI
 * could admit a legal experiment and then never execute it (F1). That refusal
 * was the correct fail-closed stop, but a campaign that only ever refuses is not
 * a runner. This module supplies the executor seam.
 *
 * MEASURED GAP G1 (plan(20260926-070459).md §G1) — NOW CLOSED
 * -----------------------------------------------------------
 * The first A5 executor computed two checkout DIGESTS and then ran the DRIVER
 * process's own `runOneCase` with a `candidate` flag. Two different digests did
 * not mean two different builds ran: both arms were ONE build under two names,
 * so the "pair" was not a pair. B3 replaces that with a real ISOLATED WORKER:
 *
 *   1. The driver resolves each arm's FROZEN checkout and PRE-FLIGHT verifies it
 *      before any request: the declared execution closure must resolve
 *      (`computeArmBuildDigestV1`), the entry file must exist, and — when
 *      `R97_ARM_REQUIRE_GIT=1` — the checkout must be a git work tree with a
 *      readable HEAD and a clean `status --porcelain`. Two arms resolving to the
 *      SAME build digest is `ARM_BUILD_IDENTICAL`; an unsupported isolation
 *      backend is `ARM_ISOLATION_UNSUPPORTED`.
 *   2. The driver spawns `scripts/e4/prereg-arm-isolated-worker.mjs` as a real
 *      CHILD PROCESS and hands it the ONE case plus the checkout to load. The
 *      child loads `apps/cli/dist/benchmark-command.js` FROM ITS OWN CHECKOUT,
 *      reads the versioned mechanism probe that build exports, hashes the entry
 *      bytes it actually loaded, and runs the case through THAT build's own
 *      `runOneCase`.
 *   3. Every model request the child's build makes is a stdio frame back to the
 *      driver, serviced by the ONE budget-wrapped `ctx.provider` (the A4/B2
 *      channel). The child owns no provider and reads no key; the physical-call
 *      count is measured where the call really happens.
 *   4. The driver INDEPENDENTLY compares the child's reported entry hash + probe
 *      to its own pre-flight values. A mismatch is `ARM_BUILD_PROBE_MISMATCH`, so
 *      a driver-only flag can no longer make two arms look different.
 *   5. The IMMUTABLE per-run evidence (`manifest.json`, `verifier.json`,
 *      `security.json`, and `activation.json` for an activated candidate) is
 *      written into the driver-created evidence directory, and A6 re-reads it.
 *
 * HONEST LIMITS (not claimed here)
 * --------------------------------
 *   - Hashing a manifest is an INTEGRITY check, not proof of honest execution;
 *     binding the manifest to the trusted budget journal is a further B4 item.
 *   - `R97_ARM_REQUIRE_GIT=1` is the strict git-identity switch. Off by default
 *     so an offline fixture checkout (a plain directory, not a work tree) can
 *     still exercise the worker protocol; a production run turns it on.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelEvent, ModelProvider } from "@ar/contracts";
import {
  PREREG_RUN_EVIDENCE_FILENAMES,
  PREREG_RUN_MANIFEST_SCHEMA,
  PREREG_RUN_SECURITY_SCHEMA,
  PREREG_RUN_VERIFIER_SCHEMA,
  R97_ARM_BUILD_ENTRIES,
  TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
  computeArmBuildDigestV1,
  loadBenchmarkCase,
  resolveBenchmarkCaseDir,
  selectionFromFrozenEvidence,
  stableStringify,
  type BenchmarkCase,
  type EvalOutcome,
  type PreregisteredArmContext,
  type PreregisteredArmEvidence,
  type PreregisteredArmOutcome,
  type PreregisteredArmRunner,
} from "@ar/evaluation";
import { formalExecutionProfile } from "./prereg-execution-identity.js";

/** A stable, machine-readable reason code for every fail-closed refusal here. */
export const ARM_EXECUTOR_NOT_WIRED = "ARM_EXECUTOR_NOT_WIRED";
export const ARM_CHECKOUT_MISSING = "ARM_CHECKOUT_MISSING";
export const ARM_BUILD_UNRESOLVABLE = "ARM_BUILD_UNRESOLVABLE";
export const ARM_BUILD_IDENTICAL = "ARM_BUILD_IDENTICAL";
export const ARM_CASE_NOT_FOUND = "ARM_CASE_NOT_FOUND";
export const ARM_EVIDENCE_DIR_MISSING = "ARM_EVIDENCE_DIR_MISSING";
/** B3 — the pre-registration's isolation backend cannot be honoured here. */
export const ARM_ISOLATION_UNSUPPORTED = "ARM_ISOLATION_UNSUPPORTED";
/** B3 — the arm's own build entry is missing/unreadable in its checkout. */
export const ARM_WORKER_ENTRY_MISSING = "ARM_WORKER_ENTRY_MISSING";
/** B3 — the child reported a build identity the driver cannot corroborate. */
export const ARM_BUILD_PROBE_MISMATCH = "ARM_BUILD_PROBE_MISMATCH";
/** B3 — the child process failed, exited early, or produced no result. */
export const ARM_WORKER_FAILED = "ARM_WORKER_FAILED";
/** B3 — the child exceeded its wall-clock bound and was killed. */
export const ARM_WORKER_TIMEOUT = "ARM_WORKER_TIMEOUT";

/** The activation artifact schema (only written for an activated candidate). */
export const PREREG_RUN_ACTIVATION_SCHEMA = "prereg-run-activation-v1";

/** Identity stamped on every manifest this executor writes. */
export const PREREG_ARM_EXECUTOR_ID = "prereg-arm-executor-v1";

/** B3 — the shipped child worker, relative to the repo root. */
export const PREREG_ARM_WORKER_REL = join("scripts", "e4", "prereg-arm-isolated-worker.mjs");
/** The one result line the child writes on stdout. */
export const ARM_WORKER_RESULT_SENTINEL = "__PREREG_ARM_RESULT__";

/** B3 — the isolation backends this executor can actually honour. A pre-registered
 *  experiment naming anything else is refused before any request. */
const SUPPORTED_ISOLATION: Record<string, readonly string[]> = {
  "process-exec": ["process"],
};

/** B3 — the mechanism probe export every real arm build carries. */
export const ARM_PROBE_EXPORT = "R97_ARM_PROBE";

/** Environment variables the worker must NOT inherit: it owns no provider and
 *  reads no key. Stripping them is defence in depth on top of the proxy design. */
const PROVIDER_ENV_KEYS = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "RUN_PAID_BENCHMARKS"] as const;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isDir(path: string | undefined): path is string {
  if (path === undefined || path === "") return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function refuse(code: string, message: string): never {
  const err = new Error(`${code}: ${message}`);
  (err as { code?: string }).code = code;
  throw err;
}

function git(root: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * The arm's real build digest, or a STABLE refusal. A directory that exists but
 * whose declared execution closure cannot be established (a missing/moved
 * `apps/cli/dist/…`, an import that escapes the checkout) must not surface as an
 * opaque internal identity error: an arm that cannot PROVE its build is not an
 * arm this executor may run.
 */
function armBuildDigestOrRefuse(armId: "baseline" | "candidate", dir: string): string {
  try {
    return computeArmBuildDigestV1(dir);
  } catch {
    refuse(
      ARM_BUILD_UNRESOLVABLE,
      `the ${armId} arm checkout exists but its declared execution closure (${R97_ARM_BUILD_ENTRIES.length} entries, R97_ARM_${armId.toUpperCase()}_DIR) cannot be established — the checkout is not a built tree`,
    );
  }
}

/** The arm's own build entry, hashed. Missing/unreadable → the arm cannot run. */
function armEntryPathOrRefuse(armId: "baseline" | "candidate", dir: string): { path: string; sha256: string } {
  // `R97_ARM_BUILD_ENTRIES[1]` is `apps/cli/dist/benchmark-command.js`, the entry
  // the worker loads. Reading the position from the shared constant keeps the
  // worker's target and the driver's pre-flight the same file.
  const rel = R97_ARM_BUILD_ENTRIES.find((e) => e.endsWith("benchmark-command.js"));
  if (rel === undefined) refuse(ARM_WORKER_ENTRY_MISSING, "the shared arm build entry list names no benchmark-command.js");
  const path = join(dir, rel);
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
  } catch {
    refuse(ARM_WORKER_ENTRY_MISSING, `the ${armId} arm has no readable build entry ${rel} in its checkout — the arm cannot be launched`);
  }
  return { path, sha256: sha256Hex(readFileSync(path, "utf8")) };
}

/** The worker must not inherit provider credentials: it uses the driver's channel. */
function sanitizedWorkerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of PROVIDER_ENV_KEYS) delete out[k];
  return out;
}

/** A line-delimited reader over a child stream that never loses a frame. */
function createLineReader(stream: NodeJS.ReadableStream): { next: () => Promise<string | null> } {
  let buffer = "";
  const queued: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let ended = false;
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim() === "") continue;
      if (waiters.length > 0) waiters.shift()!(line);
      else queued.push(line);
    }
  });
  stream.on("end", () => {
    ended = true;
    while (waiters.length > 0) waiters.shift()!(null);
  });
  stream.on("error", () => {
    ended = true;
    while (waiters.length > 0) waiters.shift()!(null);
  });
  return {
    next(): Promise<string | null> {
      if (queued.length > 0) return Promise.resolve(queued.shift()!);
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

interface WorkerReport {
  ok: boolean;
  code?: string;
  error?: string;
  armBuildReport?: { entryRel: string; entrySha256: string; probe: string } | null;
  outcome?: EvalOutcome;
  proxyBudget?: { modelCalls: number };
}

export interface PreregArmExecutorDeps {
  /** Repository root the frozen selection and the real cases are read from. */
  rootDir: string;
  /** Environment the arm checkouts and the execution profile are read from. */
  env: NodeJS.ProcessEnv;
  /** B3 — the pre-registration's isolation contract. Defaults to the shipped
   *  `process-exec`/`process` backend; anything else is refused. */
  isolation?: { isolationBackendId?: string; isolationStrength?: string };
  /** B3 — override the child worker path (tests). Defaults to the shipped one. */
  workerPath?: string;
  /** B3 — the wall-clock bound on one arm-run child process. */
  workerTimeoutMs?: number;
}

/**
 * Build the real `runArm`. Every prerequisite the executor cannot establish —
 * a frozen checkout, two distinct arm builds, a real case, an evidence
 * directory, a budgeted provider, a supported isolation backend, a child that
 * actually ran the arm's own build — is a refusal with a stable code, never a
 * fabricated `{ status: "passed" }`.
 */
export function createPreregArmExecutor(deps: PreregArmExecutorDeps): PreregisteredArmRunner {
  const root = deps.rootDir;
  const env = deps.env;
  const profile = formalExecutionProfile(env);
  const workerPath = deps.workerPath ?? join(root, PREREG_ARM_WORKER_REL);
  const workerTimeoutMs = deps.workerTimeoutMs ?? 600_000;
  const requireGit = env["R97_ARM_REQUIRE_GIT"] === "1";

  // The frozen selection is the ONLY source of `caseId -> suite`. It is read
  // once, lazily, so construction stays free of I/O.
  let suiteByCaseId: Map<string, string> | null = null;
  const suiteOf = (caseId: string): string | null => {
    if (suiteByCaseId === null) {
      const resolved = selectionFromFrozenEvidence({ root });
      suiteByCaseId = new Map(resolved.frozen.cases.map((c) => [c.caseId, c.suite]));
    }
    return suiteByCaseId.get(caseId) ?? null;
  };

  return async (arm, ctx: PreregisteredArmContext): Promise<PreregisteredArmOutcome> => {
    // --- 0. the isolation contract the pre-registration actually named ------
    const backendId = deps.isolation?.isolationBackendId ?? "process-exec";
    const strength = deps.isolation?.isolationStrength ?? "process";
    const allowed = SUPPORTED_ISOLATION[backendId];
    if (allowed === undefined || !allowed.includes(strength)) {
      refuse(
        ARM_ISOLATION_UNSUPPORTED,
        `the pre-registered isolation backend ${backendId}/${strength} cannot be honoured by this build (supported: ${Object.entries(SUPPORTED_ISOLATION)
          .map(([b, s]) => `${b}/${s.join("|")}`)
          .join(", ")})`,
      );
    }

    // --- 1. the frozen arm checkout and its real build digest ---------------
    const armDir = arm.armId === "candidate" ? env["R97_ARM_CANDIDATE_DIR"] : env["R97_ARM_BASELINE_DIR"];
    if (!isDir(armDir)) {
      refuse(
        ARM_CHECKOUT_MISSING,
        `the ${arm.armId} arm has no frozen checkout (set R97_ARM_${arm.armId.toUpperCase()}_DIR) — an arm without its build cannot be run`,
      );
    }
    const otherDir = arm.armId === "candidate" ? env["R97_ARM_BASELINE_DIR"] : env["R97_ARM_CANDIDATE_DIR"];
    const armBuildDigest = armBuildDigestOrRefuse(arm.armId, armDir);
    if (isDir(otherDir) && armBuildDigestOrRefuse(arm.armId === "candidate" ? "baseline" : "candidate", otherDir) === armBuildDigest) {
      refuse(
        ARM_BUILD_IDENTICAL,
        `${arm.armId} and its counterpart resolve to the SAME build digest (${armBuildDigest.slice(0, 12)}…) — an experiment with one build is not a paired experiment`,
      );
    }
    // Pre-flight the entry the worker will load, and (when required) the git
    // identity of BOTH checkouts — all BEFORE any request leaves.
    const entry = armEntryPathOrRefuse(arm.armId, armDir);
    if (requireGit) {
      for (const [id, dir] of [
        [arm.armId, armDir],
        [arm.armId === "candidate" ? "baseline" : "candidate", otherDir],
      ] as const) {
        if (!isDir(dir)) continue;
        const head = git(dir, ["rev-parse", "HEAD"]);
        const porcelain = git(dir, ["status", "--porcelain"]);
        if (head === null || !/^[0-9a-f]{40}$/.test(head) || porcelain !== "") {
          refuse(
            ARM_BUILD_UNRESOLVABLE,
            `R97_ARM_REQUIRE_GIT=1 but the ${id} arm checkout is not a clean git work tree (head=${head === null ? "unreadable" : head.slice(0, 12)}, dirty=${porcelain !== ""})`,
          );
        }
      }
    }

    // --- 2. the evidence directory the A6 re-verification reads back --------
    if (typeof ctx.evidenceDir !== "string" || ctx.evidenceDir.length === 0) {
      refuse(
        ARM_EVIDENCE_DIR_MISSING,
        "the driver did not provide an evidence directory — a run whose raw artifacts have nowhere to be written cannot be verified",
      );
    }

    // --- 3. the REAL case, located from the frozen selection ----------------
    const suite = suiteOf(arm.caseId);
    if (suite === null) {
      refuse(ARM_CASE_NOT_FOUND, `case ${arm.caseId} is not part of the frozen selection`);
    }
    const caseDir = resolveBenchmarkCaseDir(root, suite, arm.caseId);
    if (caseDir === null) {
      refuse(ARM_CASE_NOT_FOUND, `case ${suite}/${arm.caseId} is not a readable benchmarks/<suite>/<caseId> directory`);
    }
    if (!existsSync(workerPath)) {
      refuse(ARM_WORKER_ENTRY_MISSING, `the isolated arm worker ${PREREG_ARM_WORKER_REL} is not present in this checkout`);
    }
    const caseDef = await loadBenchmarkCase(caseDir);

    // --- 4. run the arm's OWN build in an isolated child process ------------
    const launched = await launchArmWorker({
      workerPath,
      env,
      timeoutMs: workerTimeoutMs,
      checkoutDir: armDir,
      caseDef,
      runOptions: {
        modelId: profile.provider.modelId,
        budgetTokens: profile.budgetTokens,
        // The mechanism difference IS the arm: candidate → the pre-registered
        // mechanism, baseline → the champion wiring. Never a CLI flag.
        ...(arm.armId === "candidate" ? { candidate: TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2 } : {}),
        armId: arm.armId,
        repetition: arm.repetition + 1,
        attempt: 1,
      },
      provider: ctx.provider,
    });

    // --- 5. independently corroborate the reported build identity ----------
    const report = launched.report;
    if (report.armBuildReport === null || report.armBuildReport === undefined) {
      refuse(ARM_BUILD_PROBE_MISMATCH, `the ${arm.armId} worker ran no arm build (no build report was returned)`);
    }
    if (report.armBuildReport.entrySha256 !== entry.sha256) {
      refuse(
        ARM_BUILD_PROBE_MISMATCH,
        `the ${arm.armId} worker loaded a build entry (${report.armBuildReport.entrySha256.slice(0, 12)}…) that is not the pre-flight verified entry (${entry.sha256.slice(0, 12)}…)`,
      );
    }
    if (report.armBuildReport.entryRel !== R97_ARM_BUILD_ENTRIES.find((e) => e.endsWith("benchmark-command.js"))) {
      refuse(ARM_BUILD_PROBE_MISMATCH, `the ${arm.armId} worker loaded ${report.armBuildReport.entryRel}, not the declared build entry`);
    }
    if (report.outcome === undefined) {
      refuse(ARM_WORKER_FAILED, `the ${arm.armId} worker ran the build but returned no case outcome`);
    }

    return writeArmEvidence({
      arm,
      ctx,
      armBuildDigest,
      armEntrySha256: entry.sha256,
      armProbe: report.armBuildReport.probe,
      workerModelCalls: report.proxyBudget?.modelCalls ?? null,
      evaluated: report.outcome,
    });
  };
}

// ---------------------------------------------------------------------------
// The child-process boundary
// ---------------------------------------------------------------------------

interface LaunchArmWorkerOptions {
  workerPath: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  checkoutDir: string;
  caseDef: BenchmarkCase;
  runOptions: Record<string, unknown>;
  /** The ONE budget-wrapped provider. The child owns none. */
  provider: ModelProvider;
}

interface LaunchArmWorkerResult {
  report: WorkerReport;
  /** MEASURED physical provider entries this driver serviced for the child. */
  physicalProviderCalls: number;
  exitCode: number | null;
}

/**
 * Spawn the isolated worker, service every model request it makes with the ONE
 * budget-wrapped provider, and return the single result frame it writes.
 *
 * The child is given a SANITIZED environment (no provider keys), so it cannot
 * open a second, unbudgeted transport even by accident. A child that dies, times
 * out, or writes no result is a stable refusal — never a fabricated outcome.
 */
async function launchArmWorker(opts: LaunchArmWorkerOptions): Promise<LaunchArmWorkerResult> {
  const child = spawn(process.execPath, [opts.workerPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: sanitizedWorkerEnv(opts.env),
    windowsHide: true,
  });
  const reader = createLineReader(child.stdout);
  let physicalProviderCalls = 0;
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, opts.timeoutMs);
  timer.unref?.();

  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
    child.on("error", () => resolve(null));
  });

  // Kick the child off with its single options line.
  child.stdin?.write(
    `${JSON.stringify({ checkoutDir: opts.checkoutDir, case: opts.caseDef, runOptions: opts.runOptions })}\n`,
  );

  let report: WorkerReport | null = null;
  let sawResult = false;
  try {
    for (;;) {
      const line = await reader.next();
      if (line === null) break;
      if (line.startsWith(ARM_WORKER_RESULT_SENTINEL)) {
        sawResult = true;
        report = JSON.parse(line.slice(ARM_WORKER_RESULT_SENTINEL.length)) as WorkerReport;
        break;
      }
      let frame: { t?: string; id?: number; request?: unknown };
      try {
        frame = JSON.parse(line) as typeof frame;
      } catch {
        continue; // a non-frame line is ignored
      }
      if (frame.t !== "request" || typeof frame.id !== "number") continue;
      // Service the call with the ONE budget channel and stream the events back.
      try {
        const client = opts.provider.createClient({ id: opts.runOptions["modelId"] as string } as never, {} as never);
        physicalProviderCalls += 1;
        for await (const event of client.generate(frame.request as never, new AbortController().signal)) {
          child.stdin?.write(`${JSON.stringify({ t: "event", id: frame.id, event })}\n`);
          if ((event as ModelEvent).type === "completed" || (event as ModelEvent).type === "error") break;
        }
        child.stdin?.write(`${JSON.stringify({ t: "done", id: frame.id })}\n`);
      } catch (err) {
        child.stdin?.write(
          `${JSON.stringify({ t: "error", id: frame.id, message: err instanceof Error ? err.message : String(err) })}\n`,
        );
      }
    }
  } finally {
    clearTimeout(timer);
    child.stdin?.end();
  }
  const exitCode = await exited;

  if (timedOut) {
    refuse(ARM_WORKER_TIMEOUT, `the arm worker exceeded its ${opts.timeoutMs} ms bound and was killed`);
  }
  if (!sawResult || report === null) {
    refuse(
      ARM_WORKER_FAILED,
      `the arm worker produced no result (exit=${exitCode ?? "unreadable"})${stderr.trim() === "" ? "" : `: ${stderr.trim().slice(0, 200)}`}`,
    );
  }
  if (!report.ok) {
    refuse(report.code ?? ARM_WORKER_FAILED, `the arm worker refused: ${report.error ?? "unknown error"}`);
  }
  if (exitCode !== 0) {
    refuse(ARM_WORKER_FAILED, `the arm worker reported a result but exited ${exitCode}`);
  }
  return { report, physicalProviderCalls, exitCode };
}

/**
 * Derive the declared evidence from the REAL outcome and persist the raw bytes
 * it references. The manifest is the trace: its sha256 IS `traceDigest`, so a
 * digest with no matching manifest cannot be re-produced.
 */
async function writeArmEvidence(input: {
  arm: PreregisteredArmContext["arm"];
  ctx: PreregisteredArmContext;
  armBuildDigest: string;
  armEntrySha256: string;
  armProbe: string;
  workerModelCalls: number | null;
  evaluated: EvalOutcome;
}): Promise<PreregisteredArmOutcome> {
  const { arm, ctx, armBuildDigest, armEntrySha256, armProbe, workerModelCalls, evaluated } = input;
  const status: PreregisteredArmOutcome["status"] =
    evaluated.status === "error" ? "error" : evaluated.status === "passed" ? "passed" : "failed";
  const tokensUsed = evaluated.metrics.tokens_input + evaluated.metrics.tokens_output;

  // An error outcome carries NO verifier verdict (there was nothing verified to
  // report) — its evidence is absent, and the aggregate excludes it from the pair.
  if (status === "error") {
    return {
      status,
      ...(evaluated.failureCategory !== undefined ? { failureCategory: evaluated.failureCategory } : {}),
      tokensUsed,
      reason: evaluated.reason ?? "the harness reported an infrastructure-level failure",
    };
  }

  const verifiedCompletion = evaluated.status === "passed";
  const securityViolations = evaluated.violations.length;

  const manifestText = `${stableStringify({
    schemaVersion: PREREG_RUN_MANIFEST_SCHEMA,
    executorId: PREREG_ARM_EXECUTOR_ID,
    preregistrationDigest: ctx.preregistrationDigest,
    planDigest: ctx.planDigest,
    armRunId: ctx.armRunId,
    armId: arm.armId,
    caseId: arm.caseId,
    repetition: arm.repetition,
    orderIndex: arm.orderIndex,
    armBuildDigest,
    // B3 — the identity of the arm build that ACTUALLY ran in the child.
    armEntrySha256,
    armProbe,
  })}\n`;
  const traceDigest = sha256Hex(manifestText);

  const verifierText = `${stableStringify({
    schemaVersion: PREREG_RUN_VERIFIER_SCHEMA,
    verifiedCompletion,
    status: evaluated.status,
    grade: evaluated.grade ?? null,
    violations: evaluated.violations,
  })}\n`;
  const securityText = `${stableStringify({
    schemaVersion: PREREG_RUN_SECURITY_SCHEMA,
    violations: securityViolations,
  })}\n`;

  // Activation evidence exists IFF the candidate arm really observed the
  // mechanism activation; a baseline run never carries one (that would be
  // CONTAMINATION, which the aggregate detects).
  let activationText: string | null = null;
  if (arm.armId === "candidate" && evaluated.activationEvidenceV2 !== undefined && evaluated.activationEvidenceV2.events.length > 0) {
    activationText = `${stableStringify({
      schemaVersion: PREREG_RUN_ACTIVATION_SCHEMA,
      caseId: arm.caseId,
      armId: arm.armId,
      repetition: arm.repetition,
      orderIndex: arm.orderIndex,
      events: evaluated.activationEvidenceV2.events,
    })}\n`;
  }

  await mkdir(ctx.evidenceDir, { recursive: true });
  await writeFile(join(ctx.evidenceDir, PREREG_RUN_EVIDENCE_FILENAMES.manifest), manifestText, "utf8");
  await writeFile(join(ctx.evidenceDir, PREREG_RUN_EVIDENCE_FILENAMES.verifier), verifierText, "utf8");
  await writeFile(join(ctx.evidenceDir, PREREG_RUN_EVIDENCE_FILENAMES.security), securityText, "utf8");
  if (activationText !== null) {
    await writeFile(join(ctx.evidenceDir, PREREG_RUN_EVIDENCE_FILENAMES.activation), activationText, "utf8");
  }

  const evidence: PreregisteredArmEvidence = {
    executorId: PREREG_ARM_EXECUTOR_ID,
    traceDigest,
    verifiedCompletion,
    securityViolations,
    activationEvidenceDigest: activationText === null ? null : sha256Hex(activationText),
  };

  return {
    status,
    ...(evaluated.failureCategory !== undefined ? { failureCategory: evaluated.failureCategory } : {}),
    tokensUsed,
    reason: `harness: verified=${verifiedCompletion} violations=${securityViolations} termination=${evaluated.terminationReason ?? "unknown"} arm=${armBuildDigest.slice(0, 12)} probe=${armProbe} workerCalls=${workerModelCalls ?? "unknown"}`,
    evidence,
  };
}