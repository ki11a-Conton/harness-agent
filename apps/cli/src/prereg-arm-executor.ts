/**
 * A5 — the PRODUCTION paired-arm executor for the v2 pre-registered campaign.
 *
 * WHY THIS EXISTS
 * ---------------
 * `createProductionPreregRunner` used to answer every `runArm` with
 * `ARM_EXECUTOR_NOT_WIRED`: no shipped executor existed, so the release CLI
 * could admit a legal experiment and then never execute it (F1). That refusal
 * was the correct fail-closed stop, but a campaign that only ever refuses is not
 * a runner. This module supplies the executor seam.
 *
 * WHAT IT ACTUALLY DOES (per `(case, repetition, arm, orderIndex)`)
 * -----------------------------------------------------------------
 *   1. Resolve the arm's FROZEN checkout from `R97_ARM_BASELINE_DIR` /
 *      `R97_ARM_CANDIDATE_DIR` and derive its real build digest. A missing
 *      checkout is `ARM_CHECKOUT_MISSING`, a checkout whose declared execution
 *      closure cannot be established is `ARM_BUILD_UNRESOLVABLE`, and two arms
 *      resolving to the SAME build digest is `ARM_BUILD_IDENTICAL` — an
 *      experiment that runs one build twice is not a paired experiment.
 *   2. Locate the case in the FROZEN selection (never from a caller claim),
 *      load its real `request.md`/`expected.md`/`fixture`/`case.json`, and run
 *      it through the REAL benchmark harness (`runOneCase`) in an isolated
 *      workspace — the same `ToolOrchestrator` / sandbox policy / real
 *      `TaskVerifier` production uses. The arm's mechanism difference is wired
 *      by the resolved arm (`candidate` for the candidate arm, `undefined` for
 *      the baseline), never by a flag on the command line.
 *   3. Write the IMMUTABLE per-run evidence artifacts (`manifest.json`,
 *      `verifier.json`, `security.json`, and `activation.json` for an activated
 *      candidate) into the driver-created evidence directory, and return the
 *      declared evidence whose digests are the sha256 of EXACTLY those bytes.
 *      A6 re-reads them; a fabricated digest has nothing to hash.
 *
 * THE PROVIDER IS INJECTED, NEVER CONSTRUCTED. `ctx.provider` is the
 * budget-wrapped provider the A4 gate built — this executor never reads a key,
 * never resolves an env provider and never opens a second network path. If the
 * driver does not hand one over, the run refuses rather than fabricating a call.
 *
 * HONEST LIMITS (not claimed here)
 * --------------------------------
 *   - The harness runs IN this process (the driver's build) with the arm's
 *     mechanism wiring; it does not spawn the arm checkout's own compiled
 *     `benchmark-command.js` in a child process. Cross-process arm-build
 *     isolation is the R97 worker path and remains a separate item.
 *   - Hashing a manifest is an INTEGRITY check, not proof of honest execution;
 *     binding the manifest to the trusted budget journal is a further A6 item.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
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
  type EvalSuite,
  type PreregisteredArmContext,
  type PreregisteredArmEvidence,
  type PreregisteredArmOutcome,
  type PreregisteredArmRunner,
} from "@ar/evaluation";
import { runOneCase, type RunOneCaseOptions } from "./benchmark-command.js";
import { formalExecutionProfile } from "./prereg-execution-identity.js";

/** A stable, machine-readable reason code for every fail-closed refusal here. */
export const ARM_EXECUTOR_NOT_WIRED = "ARM_EXECUTOR_NOT_WIRED";
export const ARM_CHECKOUT_MISSING = "ARM_CHECKOUT_MISSING";
export const ARM_BUILD_UNRESOLVABLE = "ARM_BUILD_UNRESOLVABLE";
export const ARM_BUILD_IDENTICAL = "ARM_BUILD_IDENTICAL";
export const ARM_CASE_NOT_FOUND = "ARM_CASE_NOT_FOUND";
export const ARM_EVIDENCE_DIR_MISSING = "ARM_EVIDENCE_DIR_MISSING";

/** The activation artifact schema (only written for an activated candidate). */
export const PREREG_RUN_ACTIVATION_SCHEMA = "prereg-run-activation-v1";

/** Identity stamped on every manifest this executor writes. */
export const PREREG_ARM_EXECUTOR_ID = "prereg-arm-executor-v1";

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
    // The underlying identity error embeds an absolute path; it is deliberately
    // NOT echoed into a refusal message (plan §A1/A2: no absolute paths in
    // public output).
    refuse(
      ARM_BUILD_UNRESOLVABLE,
      `the ${armId} arm checkout exists but its declared execution closure (${R97_ARM_BUILD_ENTRIES.length} entries, R97_ARM_${armId.toUpperCase()}_DIR) cannot be established — the checkout is not a built tree`,
    );
  }
}

export interface PreregArmExecutorDeps {
  /** Repository root the frozen selection and the real cases are read from. */
  rootDir: string;
  /** Environment the arm checkouts and the execution profile are read from. */
  env: NodeJS.ProcessEnv;
  /** Override the per-case runner (tests inject a deterministic one). The
   *  default is the REAL benchmark harness. */
  runCase?: (caseDef: BenchmarkCase, opts: RunOneCaseOptions, suite: EvalSuite) => Promise<EvalOutcome>;
}

/**
 * Build the real `runArm`. Every prerequisite the executor cannot establish —
 * a frozen checkout, two distinct arm builds, a real case, an evidence
 * directory, a budgeted provider — is a refusal with a stable code, never a
 * fabricated `{ status: "passed" }`.
 */
export function createPreregArmExecutor(deps: PreregArmExecutorDeps): PreregisteredArmRunner {
  const root = deps.rootDir;
  const env = deps.env;
  const runCase = deps.runCase ?? ((caseDef, opts, suite) => runOneCase(caseDef, opts, suite));
  const profile = formalExecutionProfile(env);

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
    const caseDef = await loadBenchmarkCase(caseDir);

    // --- 4. run it through the real harness with the INJECTED provider ------
    const evaluated = await runCase(
      caseDef,
      {
        provider: ctx.provider,
        modelId: profile.provider.modelId,
        budgetTokens: profile.budgetTokens,
        // The mechanism difference IS the arm: candidate → the pre-registered
        // mechanism, baseline → the champion wiring. Never a CLI flag.
        ...(arm.armId === "candidate" ? { candidate: TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2 } : {}),
        armId: arm.armId,
        repetition: arm.repetition + 1,
        attempt: 1,
      },
      (caseDef.suite ?? "regression") as EvalSuite,
    );

    return writeArmEvidence({ arm, ctx, armBuildDigest, evaluated });
  };
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
  evaluated: EvalOutcome;
}): Promise<PreregisteredArmOutcome> {
  const { arm, ctx, armBuildDigest, evaluated } = input;
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
    reason: `harness: verified=${verifiedCompletion} violations=${securityViolations} termination=${evaluated.terminationReason ?? "unknown"} arm=${armBuildDigest.slice(0, 12)}`,
    evidence,
  };
}