/**
 * E4-R55 (F55) — PARENT VERIFIER for the real production failure-wiring.
 * E4-R60 (G60) — rewritten onto an explicit child lifecycle + evidence protocol.
 *
 * The gap this closes: the R45 acceptance was recorder-UNIT only. It constructed
 * an `E4DiagnosticRecorder` by hand and hand-wrote a `{decision:'REJECT'}` JSON,
 * and its "E" case asserted the missing role against a recorder that registered
 * nothing by construction. Reverting the PRODUCTION registration / decision-save
 * order to its pre-R45 shape would therefore not have failed a single R45
 * assertion — the acceptance was bound to the recorder, not to the wiring.
 *
 * This file drives the REAL wiring through an ISOLATED CHILD process
 * (`apps/cli/test-infra/e4-r55-fixtures/failure-wiring.child.test.ts`, selected
 * by `r55-vitest.config.ts`) and then judges the evidence the child's own
 * failure-capture path left behind:
 *
 *   1. a REAL non-ACCEPT decision (the real evaluator, driven by a candidate arm
 *      that does not outperform the baseline — no hand-written decision JSON)
 *      must appear in the bundle with its reasonCodes, alongside the
 *      production-generated paired + V3 artifacts;
 *   2. the copies must still be readable AFTER the child exited and its own temp
 *      roots were deleted, and each copy's sha256 must equal its declared
 *      `headDigest` (the R52 contract, applied to real evidence);
 *   3. an injected evaluator fault must keep stage=evaluate, preserve the real
 *      exception, keep the artifacts written BEFORE the fault, and leave the
 *      decision explicitly missing — and be LABELLED as fault injection;
 *   4. a benchmark precondition failure must expose the benchmark's own exit
 *      code and the output roles as missing;
 *   5. a successful chain must produce NO bundle at all;
 *   6. the SAME acceptance applied to an ORDER-MUTATED copy of the wiring (the
 *      decision save moved back to AFTER the ACCEPT assert) MUST FAIL — which is
 *      what proves this acceptance is bound to the wiring, not to the recorder.
 *
 * E4-R60 (G60) — WHAT CHANGED, and why the run is now DECIDABLE.
 *
 * The child used to be driven by `spawnSync` with no `timeout`, its
 * `error`/`signal`/`stdout`/`stderr` were dropped, and its JSON report was read
 * with a bare `JSON.parse(await readFile(...))`. So a hung child hung the whole
 * suite, a child that never launched surfaced as "report.json ENOENT", and a
 * failing parent verification deleted its own diagnostics in `afterAll`.
 *
 * Every child run now goes through `runControlledChild` (async spawn, real
 * deadline, process-TREE kill, bounded logs) and `readChildReport` (classifies
 * instead of throwing). The judgement for a run is COLLECTED as a list of
 * reasons — never asserted inline — so that when a run is undecidable the
 * verifier first PRESERVES its logs, report and diagnostic bundles outside the
 * swept temp roots, prints where, and only then fails. Both the control and the
 * mutated branch get the SAME process/exit/assertion-set contract, and the
 * mutated branch additionally has to prove it is a VALID counterexample: it
 * reached the evaluator, it died on the target ACCEPT assertion, the decision
 * role was registered but its file was never saved, and the other artifacts are
 * still present and byte-faithful. An import error, a timeout or a stray
 * exception can no longer masquerade as an order counterexample.
 *
 * PRECONDITION — a clean working tree. The production benchmark refuses to
 * produce a promotion-eligible run on a tree that is not provably clean, so a
 * dirty tree makes every child case fail for an unrelated reason. That is
 * detected up front and reported explicitly instead of being mistaken for a
 * wiring defect.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { mutateChainOrdering, relocateChainImports } from "./e4-09-real-chain.js";
import {
  judgeChildProcess,
  messageOf,
  parentEvidenceRoot,
  preserveEvidence,
  readChildReport,
  reportDegraded,
  runControlledChild,
} from "./e4-r55-child-harness.js";
import type {
  ChildTermination,
  ControlledChildOutcome,
  ExpectedChildRun,
  ReportRead,
} from "./e4-r55-child-harness.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const VITEST_BIN = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const CHILD_CONFIG = "apps/cli/test-infra/r55-vitest.config.ts";
const REAL_CHAIN = join(REPO_ROOT, "apps/cli", "src", "e4-09-real-chain.ts");
const REAL_DIAGNOSTICS = join(REPO_ROOT, "apps/cli", "src", "e4-09-diagnostics.ts");
/** E4-R60: the module the chain imports DYNAMICALLY — the specifier R59 left
 *  behind, which made the order counterexample vacuous. */
const REAL_BENCHMARK_COMMAND = join(REPO_ROOT, "apps/cli", "src", "benchmark-command.ts");
/**
 * E4-R59 (G59): per-run mutation copies live here — OUTSIDE `apps/cli/tsconfig.json`'s
 * `include: ["src"]` (so never part of the production compile input) and outside
 * the root Vitest `include` (`apps/*\/src/**\/*.test.ts`). Each parent run gets its
 * own `mkdtemp` directory, so two concurrent runs can never share a path.
 */
const RUNS_ROOT = join(REPO_ROOT, "apps", "cli", "test-infra", "e4-r55-runs");
/** The pre-R59 fixed path. Narrow migration guard only — see `afterAll`. */
const LEGACY_GENERATED = join(REPO_ROOT, "apps", "cli", "src", "e4-r55-mutated-chain.generated.ts");

/**
 * E4-R60: the child's real deadline. The four child cases take ~15-30s together
 * (measured 54.8s / 76.9s for the whole file), so this is generous headroom —
 * but it is BOUNDED, which is the point: `spawnSync` had no deadline at all and
 * the enclosing `it(..., 900_000)` could not interrupt a blocking call.
 */
const CHILD_TIMEOUT_MS = 360_000;

const NONACCEPT_TITLE =
  "R55 nonaccept: a REAL non-ACCEPT decision is persisted with its reasonCodes before the ACCEPT assert";
const SUCCESS_TITLE = "R55 success: a fully ACCEPTed chain produces NO failure bundle";
const THROW_TITLE =
  "R55 evaluator-throw: the injected fault keeps stage=evaluate and leaves the decision missing";
const BENCHFAIL_TITLE =
  "R55 benchmark-fail: the original benchmark exit and the missing output roles are visible";

/** The EXACT assertion set the child must report — extra, renamed or flipped
 *  results all reject the run (E4-R60 §5: an import error must not pass). */
const EXPECTED_CHILD_RESULTS = [
  `failed ${NONACCEPT_TITLE}`,
  `failed ${THROW_TITLE}`,
  `failed ${BENCHFAIL_TITLE}`,
  `passed ${SUCCESS_TITLE}`,
];
const EXPECTED_CHILD_RUN: ExpectedChildRun = {
  expectedResults: EXPECTED_CHILD_RESULTS,
  expectedExitCode: 1,
};

/**
 * The failure the non-ACCEPT case MUST die on: the production ACCEPT assertion,
 * not an import/collection error and not a timeout. Tolerant of the framework's
 * quoting style, strict about the subject.
 */
const ACCEPT_ASSERT_FAILURE = /expected[\s\S]*ACCEPT/;

let tempDirs: string[] = [];

afterAll(async () => {
  // E4-R59: NARROW migration guard for the pre-R59 fixed path only. A leftover
  // there would sit inside the production compile input, so it is removed if (and
  // only if) it exists. No batch deletion, no wildcard, no source scanning.
  try {
    await rm(LEGACY_GENERATED, { force: true });
  } catch (err) {
    reportDegraded("e4-r55 legacy mutation-path cleanup", err);
  }
  for (const d of tempDirs.splice(0)) {
    try {
      await rm(d, { recursive: true, force: true });
    } catch (err) {
      // E4-R60: cleanup failures are REPORTED, never silently swallowed (the
      // pre-R60 `.catch(() => {})` hid exactly this class of problem).
      reportDegraded(`e4-r55 temp-root cleanup of ${d}`, err);
    }
  }
  // Remove the runs root only if this run left it EMPTY. `rmdir` is the right
  // primitive: it succeeds on an empty directory and fails ENOTEMPTY when a
  // concurrent run still owns it. (Pre-R60 this used `rm(..., {recursive:false})`,
  // which can never remove a directory at all — EISDIR — and the failure was
  // swallowed by `.catch(() => {})`, so the root silently stayed behind.)
  try {
    await rmdir(RUNS_ROOT);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") {
      reportDegraded("e4-r55 runs-root cleanup", err);
    }
  }
});

interface ArtifactRecord {
  role: string;
  sourcePath: string;
  captured: boolean;
  error?: string;
  capturedPath?: string;
  headBytes?: number;
  headDigest?: string;
  sourceBytes?: number;
  sourceDigest?: string;
  truncated?: boolean;
  parseError?: string;
}

interface Bundle {
  label: string;
  test: { file: string; name: string };
  failure: { stage: string; name: string; message: string };
  artifacts: ArtifactRecord[];
  summary: Record<string, Record<string, unknown> | null>;
  extra: Record<string, unknown>;
  /** The on-disk bundle directory this record was read from. */
  dir: string;
}

/** A chain module bound to one child run: where it lives and its digest. */
interface ChainModuleRef {
  path: string;
  sha256: string;
  /**
   * E4-R60: the relative specifiers this run's copy had rewritten, so the
   * preserved evidence shows exactly how the copy reaches the real modules.
   * Empty for the control run (it IS the repository module).
   */
  relocatedImports: { from: string; to: string }[];
}

/** Everything one child run produced, INCLUDING the right to clean it up. */
interface ChildRun {
  mode: "real" | "mutated";
  chain: ChainModuleRef;
  outcome: ControlledChildOutcome;
  report: ReportRead;
  diagDir: string;
  bundles: Bundle[];
  /** Bundle directories that exist but could not be read — evidence of a problem. */
  unreadableBundles: { dir: string; error: string }[];
  /** Removes ONLY the resources this run owns. Idempotent, never silent. */
  cleanup: () => Promise<void>;
}

/**
 * Read the child's diagnostic bundles. A directory without a readable bundle is
 * NOT silently skipped any more (E4-R60): it is returned so the verdict can
 * reject the run, because unreadable evidence is a defect, not an absence.
 */
async function readBundles(
  diagDir: string,
): Promise<{ bundles: Bundle[]; unreadable: { dir: string; error: string }[] }> {
  const bundles: Bundle[] = [];
  const unreadable: { dir: string; error: string }[] = [];
  let entries: string[];
  try {
    entries = await readdir(diagDir);
  } catch (err) {
    return { bundles, unreadable: [{ dir: diagDir, error: messageOf(err) }] };
  }
  for (const entry of entries) {
    const dir = join(diagDir, entry);
    try {
      const parsed = JSON.parse(await readFile(join(dir, "diagnostic.json"), "utf8")) as Omit<Bundle, "dir">;
      bundles.push({ ...parsed, dir });
    } catch (err) {
      unreadable.push({ dir, error: messageOf(err) });
    }
  }
  return { bundles, unreadable };
}

/**
 * E4-R59 (G59) — select the chain module for ONE run.
 *
 *   - `"real"`    -> the repository's own module; no copy is created at all.
 *   - `"mutated"` -> a fresh copy of the real module with the decision-save block
 *                    moved after the ACCEPT assert, written into a PER-RUN
 *                    directory outside the production compile input and outside
 *                    the default Vitest include. Its relative specifiers are
 *                    rewritten so the copy still loads the REAL modules — not
 *                    stubs, not a standalone fake implementation.
 *
 * E4-R60 (G60): ALL relative specifiers are rewritten, not just the static
 * diagnostics import. The dynamic benchmark-command import was previously left
 * pointing at the old location, so the copy could not load at all and the order
 * counterexample was vacuous (see `relocateChainImports`). The helper verifies
 * that the set of absolute import targets is unchanged, so a future relative
 * import cannot silently break the copy again.
 *
 * The returned path is handed to the child through `E4_R55_CHAIN_MODULE`, which
 * the child config binds with an alias. The child loads exactly this path or
 * fails before running a test; nothing scans for "the newest file".
 */
async function prepareChainModule(runDir: string, mode: "real" | "mutated"): Promise<ChainModuleRef> {
  if (mode === "real") {
    return { path: REAL_CHAIN, sha256: sha256(await readFile(REAL_CHAIN)), relocatedImports: [] };
  }
  await mkdir(runDir, { recursive: true });
  const mutated = mutateChainOrdering(await readFile(REAL_CHAIN, "utf8"));
  const { source, rewrites } = relocateChainImports(mutated, dirname(REAL_CHAIN), runDir);
  const path = join(runDir, "chain.ts");
  await writeFile(path, source, "utf8");
  return { path, sha256: sha256(Buffer.from(source, "utf8")), relocatedImports: rewrites };
}

/**
 * Spawn the isolated child under the E4-R60 lifecycle contract and collect its
 * REAL process facts, its report (classified, never thrown) and its bundles.
 *
 * This never throws for an expected failure mode: a child that hangs, fails to
 * launch, exits oddly or writes no report all come back as structured data, so
 * the caller can PRESERVE the evidence before deciding.
 */
async function runChild(mode: "real" | "mutated"): Promise<ChildRun> {
  const diagDir = await mkdtemp(join(tmpdir(), "e4-r55-diag-"));
  const reportDir = await mkdtemp(join(tmpdir(), "e4-r55-report-"));
  tempDirs.push(diagDir, reportDir);
  // A PER-RUN directory owned by this invocation only.
  await mkdir(RUNS_ROOT, { recursive: true });
  const runDir = await mkdtemp(join(RUNS_ROOT, "run-"));

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      await rm(runDir, { recursive: true, force: true });
    } catch (err) {
      reportDegraded(`e4-r55 per-run cleanup of ${runDir}`, err);
    }
  };

  try {
    const chain = await prepareChainModule(runDir, mode);
    const reportPath = join(reportDir, "report.json");
    const outcome = await runControlledChild({
      label: `r55-${mode}`,
      command: process.execPath,
      args: [VITEST_BIN, "run", "--config", CHILD_CONFIG, "--reporter=json", `--outputFile=${reportPath}`],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        E4_09_DIAG_DIR: diagDir,
        // Binds THIS run's chain module (the child config aliases it).
        E4_R55_CHAIN_MODULE: chain.path,
        E4_R55_CHAIN_SHA: chain.sha256,
        // keep the child unnamed so no observation evidence is committed
        E2E_OBSERVATION_RUN_ID: "",
      },
      timeoutMs: CHILD_TIMEOUT_MS,
    });
    const report = await readChildReport(reportPath);
    const read = await readBundles(diagDir);
    return {
      mode,
      chain,
      outcome,
      report,
      diagDir,
      bundles: read.bundles,
      unreadableBundles: read.unreadable,
      cleanup,
    };
  } catch (err) {
    // A failure BEFORE the child could be judged (e.g. the mutation refused to
    // build) still releases this run's directory and must not be mistaken for a
    // child verdict.
    await cleanup();
    throw err;
  }
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/**
 * E4-R60: compare module paths modulo the platform separator and the TypeScript
 * ESM `.js`-specifier convention (a `.js` specifier denotes the `.ts` source),
 * so a resolved copy specifier can be compared to a repository source path.
 */
const normalizeModulePath = (p: string): string => p.split("\\").join("/").replace(/\.(ts|js)$/, "");

const byLabel = (run: ChildRun, label: string): Bundle | undefined => run.bundles.find((b) => b.label === label);
const roleOf = (bundle: Bundle, role: string): ArtifactRecord | undefined =>
  bundle.artifacts.find((a) => a.role === role);

/**
 * THE ACCEPTANCE. Judged against a bundle; returns every reason it does not
 * hold, so a failing verdict is readable rather than a bare boolean.
 *
 * It requires the REAL decision to be present, non-ACCEPT, and accompanied by
 * reasonCodes, plus the production-generated paired + V3 evidence.
 */
function acceptance(bundle: Bundle | undefined): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (bundle === undefined) return { ok: false, reasons: ["no bundle was produced at all"] };
  const decision = roleOf(bundle, "decision-artifact");
  if (decision === undefined) {
    reasons.push("the decision-artifact role is ABSENT from the bundle (nothing was registered for it)");
  } else if (decision.captured !== true) {
    reasons.push(`the decision-artifact was NOT captured: ${decision.error ?? "no error recorded"}`);
  }
  const decisionSummary = bundle.summary["decision-artifact"];
  if (decisionSummary === null || decisionSummary === undefined) {
    reasons.push("the decision summary is null — the REAL decision was not persisted");
  } else {
    if (decisionSummary["decision"] === "ACCEPT") reasons.push("the decision is ACCEPT — this was not a non-ACCEPT run");
    const codes = decisionSummary["reasonCodes"];
    if (!Array.isArray(codes) || codes.length === 0) reasons.push("reasonCodes are missing or empty");
  }
  for (const role of ["paired-experiment", "v3-candidate"]) {
    const rec = roleOf(bundle, role);
    if (rec === undefined || rec.captured !== true) reasons.push(`the ${role} role was not captured`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** Verify a captured copy is byte-faithful to its declared digest (R52 contract). */
async function copyIntegrity(bundle: Bundle): Promise<{ role: string; ok: boolean; detail: string }[]> {
  const out: { role: string; ok: boolean; detail: string }[] = [];
  for (const art of bundle.artifacts) {
    if (art.captured !== true || art.capturedPath === undefined) continue;
    const bytes = await readFile(join(bundle.dir, art.capturedPath));
    const digest = sha256(bytes);
    out.push({
      role: art.role,
      ok: digest === art.headDigest && bytes.byteLength === art.headBytes,
      detail: `copy=${bytes.byteLength}B/${digest.slice(0, 12)} declared=${art.headBytes}B/${String(art.headDigest).slice(0, 12)}`,
    });
  }
  return out;
}

/**
 * E4-R60 §6: the run must really have died on the TARGET ACCEPT assertion, at
 * the evaluate stage. This is what separates a valid counterexample from "the
 * mutated copy failed to import" or "the child timed out".
 */
function assertAcceptAssertionFailure(bundle: Bundle, what: string): string[] {
  const reasons: string[] = [];
  if (bundle.failure.stage !== "evaluate") {
    reasons.push(`${what} failed at stage "${bundle.failure.stage}", expected "evaluate" (it never reached the evaluator)`);
  }
  if (!ACCEPT_ASSERT_FAILURE.test(bundle.failure.message)) {
    reasons.push(
      `${what} did not die on the ACCEPT assertion — the real message was ${JSON.stringify(bundle.failure.message)}`,
    );
  }
  return reasons;
}

/** Every reason the CONTROL (unmutated) run is not decidable. */
async function judgeRealRun(run: ChildRun): Promise<string[]> {
  const reasons = judgeChildProcess(run.outcome, run.report, EXPECTED_CHILD_RUN);

  if (run.chain.path !== REAL_CHAIN) {
    reasons.push(`the control run was bound to ${run.chain.path}, not the repository's own module`);
  }
  for (const u of run.unreadableBundles) {
    reasons.push(`a diagnostic directory exists but is unreadable: ${u.dir}: ${u.error}`);
  }

  // ── 1. the REAL non-ACCEPT decision, with its reasonCodes ──
  const nonaccept = byLabel(run, "r55-nonaccept");
  if (nonaccept === undefined) {
    reasons.push("no r55-nonaccept bundle was produced");
  } else {
    reasons.push(...acceptance(nonaccept).reasons.map((r) => `non-ACCEPT acceptance: ${r}`));
    const decisionSummary = nonaccept.summary["decision-artifact"];
    if (decisionSummary === null || decisionSummary === undefined) {
      reasons.push("the decision summary is null — the REAL decision was not persisted");
    } else {
      if (decisionSummary["decision"] === "ACCEPT") {
        reasons.push("the decision is ACCEPT — this was not a non-ACCEPT run");
      }
      const codes = decisionSummary["reasonCodes"];
      if (!Array.isArray(codes) || codes.length === 0) reasons.push("reasonCodes are missing or empty");
    }
    reasons.push(...assertAcceptAssertionFailure(nonaccept, "the non-ACCEPT case"));
    // ── 2. durability + byte fidelity of the copies, read AFTER the child died ──
    const integrity = await copyIntegrity(nonaccept);
    if (integrity.length < 4) {
      reasons.push(`only ${integrity.length} captured copies could be re-read (expected at least 4)`);
    }
    for (const item of integrity) {
      if (!item.ok) reasons.push(`copy integrity for ${item.role}: ${item.detail}`);
    }
  }

  // ── 3. injected evaluator fault: labelled, correct stage, decision missing ──
  const thrown = byLabel(run, "r55-throw");
  if (thrown === undefined) {
    reasons.push("no r55-throw bundle was produced");
  } else {
    if (thrown.failure.stage !== "evaluate") {
      reasons.push(`r55-throw stage is "${thrown.failure.stage}", expected "evaluate"`);
    }
    if (!thrown.failure.message.includes("R55 injected evaluator failure")) {
      reasons.push("r55-throw does not carry the real injected exception message");
    }
    if (thrown.extra["evaluatorFaultInjection"] !== true) {
      reasons.push("r55-throw is not LABELLED as fault injection");
    }
    const decision = roleOf(thrown, "decision-artifact");
    if (decision === undefined) {
      reasons.push("r55-throw has no decision-artifact role registered");
    } else if (decision.captured !== false) {
      reasons.push("r55-throw captured a decision even though the evaluator threw");
    }
    if (thrown.summary["decision-artifact"] !== null) {
      reasons.push("r55-throw's decision summary is not null");
    }
    // artifacts written BEFORE the fault are still preserved
    for (const role of ["paired-experiment", "v3-candidate"]) {
      const rec = roleOf(thrown, role);
      if (rec === undefined || rec.captured !== true) reasons.push(`r55-throw lost the pre-fault ${role} artifact`);
    }
  }

  // ── 4. benchmark precondition failure: real exit + missing output roles ──
  const benchfail = byLabel(run, "r55-benchfail");
  if (benchfail === undefined) {
    reasons.push("no r55-benchfail bundle was produced");
  } else {
    if (benchfail.failure.stage !== "benchmark") {
      reasons.push(`r55-benchfail stage is "${benchfail.failure.stage}", expected "benchmark"`);
    }
    const cli = benchfail.extra["benchmarkCli"] as { exitCode?: unknown } | undefined;
    if (cli === undefined || cli.exitCode === 0) {
      reasons.push("r55-benchfail does not expose the benchmark's real non-zero CLI exit");
    }
    for (const role of ["paired-experiment", "v3-baseline", "v3-candidate", "decision-artifact"]) {
      const rec = roleOf(benchfail, role);
      if (rec === undefined) {
        reasons.push(`r55-benchfail has no ${role} role registered`);
        continue;
      }
      if (rec.captured !== false) reasons.push(`r55-benchfail captured ${role} although the benchmark refused to run`);
      if (String(rec.error ?? "") === "") reasons.push(`r55-benchfail records no error for the missing ${role}`);
    }
  }

  // ── 5. a successful chain produces NO bundle ──
  if (byLabel(run, "r55-success") !== undefined) {
    reasons.push("a bundle was produced for the successful chain");
  }
  if (run.bundles.length !== 3) {
    reasons.push(`expected exactly 3 failure bundles, found ${run.bundles.length}`);
  }

  // ── 5b. E4-R59: every bundle records the chain identity it was bound to ──
  for (const bundle of run.bundles) {
    const recorded = bundle.extra["chainModule"] as { path?: unknown; sha256?: unknown } | undefined;
    if (recorded === undefined) {
      reasons.push(`${bundle.label}: the chain identity it loaded is not recorded`);
      continue;
    }
    if (recorded.path !== run.chain.path) {
      reasons.push(`${bundle.label}: recorded chain path ${String(recorded.path)} != ${run.chain.path}`);
    }
    if (recorded.sha256 !== run.chain.sha256) {
      reasons.push(`${bundle.label}: recorded chain digest is not the module this run loaded`);
    }
  }

  return reasons;
}

/**
 * Every reason the ORDER-MUTATED run is not a VALID counterexample.
 *
 * E4-R60 §5/§6: the same process/exit/assertion-set contract as the control run
 * applies, and the run additionally has to prove it reached the evaluator, died
 * on the ACCEPT assert, kept the decision role registered while never saving its
 * file, and still produced the other artifacts.
 */
async function judgeMutatedRun(run: ChildRun, realChainSha: string): Promise<string[]> {
  const reasons = judgeChildProcess(run.outcome, run.report, EXPECTED_CHILD_RUN);

  if (run.chain.path === REAL_CHAIN) {
    reasons.push("the mutated run was bound to the repository module — nothing was mutated");
  }
  if (!run.chain.path.startsWith(RUNS_ROOT)) {
    reasons.push(`the mutated copy does not live under the per-run root: ${run.chain.path}`);
  }
  if (run.chain.sha256 === realChainSha) {
    reasons.push("the mutated copy is byte-identical to the repository module — the mutation did not apply");
  }
  for (const u of run.unreadableBundles) {
    reasons.push(`a diagnostic directory exists but is unreadable: ${u.dir}: ${u.error}`);
  }

  const nonaccept = byLabel(run, "r55-nonaccept");
  if (nonaccept === undefined) {
    reasons.push("the mutated run produced no r55-nonaccept bundle");
    return reasons;
  }

  // The child loaded exactly the copy this run selected (bound by alias, never
  // by a "newest file" scan).
  const identity = nonaccept.extra["chainModule"] as { path?: unknown; sha256?: unknown } | undefined;
  if (identity === undefined) {
    reasons.push("the mutated bundle does not record the chain identity it loaded");
  } else {
    if (identity.path !== run.chain.path) {
      reasons.push("the mutated bundle's chain path is not the copy this run selected");
    }
    if (identity.sha256 !== run.chain.sha256) {
      reasons.push("the mutated bundle's chain digest is not the copy this run selected");
    }
  }

  // E4-R60: the relocation must reach EVERY real module the copy depends on.
  // R59 left the DYNAMIC benchmark import pointing at the old location, so the
  // copy could not load, and a run that never reached the evaluator still looked
  // like a valid "decision not persisted" counterexample. Resolving the copy's
  // own specifiers guards against that exact regression.
  const copySpecifiers = [
    ...(await readFile(run.chain.path, "utf8")).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)"(\.\.?\/[^"]*)"/g),
  ].map((m) => normalizeModulePath(resolve(dirname(run.chain.path), String(m[1]))));
  for (const target of [REAL_DIAGNOSTICS, REAL_BENCHMARK_COMMAND].map(normalizeModulePath)) {
    if (!copySpecifiers.includes(target)) {
      reasons.push(`the mutated copy does not resolve to ${target} — its relative imports were not fully relocated`);
    }
  }

  // It really reached the evaluator and really died on the ACCEPT assertion.
  reasons.push(...assertAcceptAssertionFailure(nonaccept, "the mutated non-ACCEPT case"));

  // The decision role is REGISTERED but its file was never saved: the persistence
  // block now runs after the assert, which threw first.
  const decision = roleOf(nonaccept, "decision-artifact");
  if (decision === undefined) {
    reasons.push("the mutated bundle has no decision-artifact role at all — the registration itself was lost");
  } else {
    if (decision.captured !== false) {
      reasons.push("the mutated run still captured a decision artifact — the decision was persisted despite the mutation");
    }
    if (String(decision.error ?? "") === "") {
      reasons.push("the mutated decision role records no error explaining why it is missing");
    }
  }
  if (nonaccept.summary["decision-artifact"] !== null) {
    reasons.push("the mutated run's decision summary is not null — a decision was persisted despite the mutation");
  }

  // The acceptance MUST fail here: that is the whole negative control.
  const verdict = acceptance(nonaccept);
  if (verdict.ok) {
    reasons.push("the acceptance PASSED against the order-mutated wiring — it is not bound to the production ordering");
  } else if (!verdict.reasons.join("; ").includes("decision-artifact")) {
    reasons.push(`the mutated run was rejected for the wrong reason: ${verdict.reasons.join("; ")}`);
  }

  // The other necessary artifacts must still be present and byte-faithful.
  for (const role of ["paired-experiment", "v3-candidate"]) {
    const rec = roleOf(nonaccept, role);
    if (rec === undefined || rec.captured !== true) reasons.push(`the mutated run lost the ${role} artifact`);
  }
  const integrity = await copyIntegrity(nonaccept);
  if (integrity.length < 2) {
    reasons.push(`only ${integrity.length} captured copies could be re-read in the mutated run (expected at least 2)`);
  }
  for (const item of integrity) {
    if (!item.ok) reasons.push(`mutated copy integrity for ${item.role}: ${item.detail}`);
  }

  return reasons;
}

/**
 * E4-R60 §7 — close out ONE run. If it is undecidable, preserve its logs, report
 * and diagnostic bundles OUTSIDE the swept temp roots and print where, THEN
 * release the run's own resources, and only then fail. On success the run is
 * simply cleaned up.
 */
async function conclude(run: ChildRun, reasons: string[], extra?: Record<string, unknown>): Promise<void> {
  if (reasons.length > 0) {
    try {
      const preserved = await preserveEvidence({
        label: `r55-${run.mode}`,
        outcome: run.outcome,
        report: run.report,
        reasons,
        diagDir: run.diagDir,
        extra: {
          chain: run.chain,
          bundleLabels: run.bundles.map((b) => b.label),
          unreadableBundles: run.unreadableBundles,
          ...extra,
        },
      });
      process.stderr.write(
        `[e4-r55] the ${run.mode} run was not decidable — evidence preserved at ${preserved.dir} (${preserved.files.length} files)\n`,
      );
    } catch (err) {
      reportDegraded("e4-r55 evidence preservation", err);
    }
  }
  await run.cleanup();
  expect(reasons, `the ${run.mode} child run was not decidable:\n  - ${reasons.join("\n  - ")}`).toEqual([]);
}

// ---------------------------------------------------------------------------
// E4-R60 — lightweight controlled children for the lifecycle/evidence protocol
// ---------------------------------------------------------------------------

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeTempScript(name: string, body: string): Promise<string> {
  const dir = await tempDir("e4-r60-script-");
  const path = join(dir, name);
  await writeFile(path, body, "utf8");
  return path;
}

/** Is a pid still alive? EPERM means it exists but is not ours — still alive. */
async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
  }
}

/** Wait for a real death instead of assuming the kill was instant. */
async function waitForProcessGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isProcessAlive(pid))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !(await isProcessAlive(pid));
}

/** A synthetic outcome/report pair for the pure verdict tests. */
function syntheticOutcome(over: Partial<ControlledChildOutcome> = {}): ControlledChildOutcome {
  return {
    label: "synthetic",
    command: "node",
    args: [],
    cwd: REPO_ROOT,
    termination: "exited" as ChildTermination,
    exitCode: 1,
    signal: null,
    timedOut: false,
    spawnError: null,
    launchFailureCode: null,
    stdout: "",
    stderr: "",
    outputOverflow: false,
    durationMs: 1,
    killAttempted: false,
    reaped: true,
    ...over,
  };
}

const resultsOf = (lines: string[]): { title: string; status: string }[] =>
  lines.map((line) => {
    const i = line.indexOf(" ");
    return { status: line.slice(0, i), title: line.slice(i + 1) };
  });

const syntheticReport = (results: { title: string; status: string }[]): ReportRead => ({
  path: "synthetic-report.json",
  kind: "ok",
  error: null,
  results,
  rawText: "{}",
});

describe("E4-R60 child lifecycle + evidence protocol (lightweight controlled children)", () => {
  it("terminates a never-ending child's whole tree at the deadline and returns a structured timeout", async () => {
    const pidFile = join(await tempDir("e4-r60-timeout-"), "descendant.pid");
    const script = await writeTempScript(
      "never-ending.mjs",
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        "const pidFile = process.argv[2];",
        "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {",
        '  stdio: "ignore",',
        "  windowsHide: true,",
        "});",
        "writeFileSync(pidFile, String(descendant.pid));",
        'process.stdout.write(`DESCENDANT_PID=${descendant.pid}\\n`);',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );

    const outcome = await runControlledChild({
      label: "r60-never-ending",
      command: process.execPath,
      args: [script, pidFile],
      cwd: REPO_ROOT,
      env: { ...process.env },
      timeoutMs: 4_000,
    });

    expect(outcome.termination).toBe("timeout");
    expect(outcome.timedOut).toBe(true);
    expect(outcome.killAttempted).toBe(true);
    expect(outcome.spawnError).toBeNull();
    // the parent must have observed the child's terminal state before reporting
    expect(outcome.reaped, "the parent must observe a terminal state before it reports a timeout").toBe(true);

    const match = /DESCENDANT_PID=(\d+)/.exec(outcome.stdout);
    expect(match, `the child's stdout did not name its descendant: ${JSON.stringify(outcome.stdout)}`).not.toBeNull();
    const descendantPid = Number(match?.[1]);
    expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
    expect(
      await waitForProcessGone(descendantPid, 15_000),
      `descendant process ${descendantPid} survived the tree kill`,
    ).toBe(true);
  }, 90_000);

  it("preserves the REAL launch error instead of reporting a missing report", async () => {
    const outcome = await runControlledChild({
      label: "r60-spawn-error",
      command: join(REPO_ROOT, `e4-r60-no-such-binary-${process.pid}`),
      args: [],
      cwd: REPO_ROOT,
      env: { ...process.env },
      timeoutMs: 5_000,
    });

    expect(outcome.termination).toBe("spawn-error");
    expect(outcome.spawnError).not.toBeNull();
    expect(String(outcome.spawnError)).toMatch(/ENOENT|not found|cannot find/i);
    expect(outcome.timedOut).toBe(false);
    // No process ever exited, so there is no exit code — the platform's own
    // launch-failure number is kept separately and must not be read as one.
    expect(outcome.exitCode).toBeNull();
    expect(outcome.launchFailureCode === null || typeof outcome.launchFailureCode === "number").toBe(true);

    // A child that never launched produces no report — and the report reader must
    // say so WITHOUT replacing the launch error above.
    const report = await readChildReport(join(await tempDir("e4-r60-noreport-"), "report.json"));
    expect(report.kind).toBe("missing");

    const reasons = judgeChildProcess(outcome, report, EXPECTED_CHILD_RUN).join("; ");
    expect(reasons).toMatch(/could not be launched/);
    expect(reasons).toMatch(/unusable \(missing\)/);
  }, 60_000);

  it("recovers the real exit code and stderr from a non-zero exit", async () => {
    const script = await writeTempScript(
      "failing.mjs",
      [
        'process.stdout.write("child stdout marker\\n");',
        'process.stderr.write("child stderr marker\\n");',
        "process.exit(3);",
      ].join("\n"),
    );
    const outcome = await runControlledChild({
      label: "r60-nonzero-exit",
      command: process.execPath,
      args: [script],
      cwd: REPO_ROOT,
      env: { ...process.env },
      timeoutMs: 20_000,
    });

    expect(outcome.termination).toBe("exited");
    expect(outcome.exitCode).toBe(3);
    expect(outcome.signal).toBeNull();
    expect(outcome.reaped).toBe(true);
    expect(outcome.stderr).toContain("child stderr marker");
    expect(outcome.stdout).toContain("child stdout marker");
    expect(outcome.outputOverflow).toBe(false);
  }, 60_000);

  it("flags an output-budget overrun instead of silently truncating the log", async () => {
    const script = await writeTempScript("flood.mjs", 'process.stdout.write("x".repeat(8192));\n');
    const outcome = await runControlledChild({
      label: "r60-output-overflow",
      command: process.execPath,
      args: [script],
      cwd: REPO_ROOT,
      env: { ...process.env },
      timeoutMs: 20_000,
      maxOutputBytes: 1_024,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.outputOverflow).toBe(true);
    expect(Buffer.byteLength(outcome.stdout, "utf8")).toBeLessThanOrEqual(1_024);
  }, 60_000);

  it("distinguishes a missing report, an invalid-JSON report and an unexpected shape", async () => {
    const dir = await tempDir("e4-r60-report-");

    const missing = await readChildReport(join(dir, "absent.json"));
    expect(missing.kind).toBe("missing");
    expect(missing.error).not.toBeNull();

    const badPath = join(dir, "bad.json");
    await writeFile(badPath, "{ this is not json", "utf8");
    const invalid = await readChildReport(badPath);
    expect(invalid.kind).toBe("invalid-json");
    expect(invalid.error).not.toBeNull();
    expect(invalid.rawText).toBe("{ this is not json");

    const shapedPath = join(dir, "shaped.json");
    await writeFile(shapedPath, JSON.stringify({ numTotalTests: 3 }), "utf8");
    expect((await readChildReport(shapedPath)).kind).toBe("unexpected-shape");

    const okPath = join(dir, "ok.json");
    await writeFile(
      okPath,
      JSON.stringify({ testResults: [{ assertionResults: [{ title: "t", status: "failed" }] }] }),
      "utf8",
    );
    const ok = await readChildReport(okPath);
    expect(ok.kind).toBe("ok");
    expect(ok.results).toEqual([{ title: "t", status: "failed" }]);
  }, 60_000);

  it("relocates EVERY relative specifier of a chain copy and preserves the target set", async () => {
    const realSource = await readFile(REAL_CHAIN, "utf8");
    // The helper is PURE (string in, string out), so the destination does not
    // need to exist — it only has to be on the same volume as the repository.
    const toDir = join(RUNS_ROOT, "probe-relocate", "deep", "nested");

    const { source, rewrites } = relocateChainImports(realSource, dirname(REAL_CHAIN), toDir);
    // both the static diagnostics import and the DYNAMIC benchmark import
    expect(rewrites.length).toBeGreaterThanOrEqual(2);
    const resolved = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)"(\.\.?\/[^"]*)"/g)]
      .map((m) => normalizeModulePath(resolve(toDir, String(m[1]))))
      .sort();
    expect(resolved).toEqual([REAL_DIAGNOSTICS, REAL_BENCHMARK_COMMAND].map(normalizeModulePath).sort());

    // the self-check refuses a source with nothing to relocate rather than
    // emitting a copy that would resolve its dependencies from the wrong place
    expect(() => relocateChainImports("export const x = 1;\n", dirname(REAL_CHAIN), toDir)).toThrow(
      /no relative specifier/,
    );

    // A copy on a DIFFERENT VOLUME cannot be expressed as a relative specifier.
    // `path.relative` would hand back an absolute path, so the helper must refuse
    // instead of silently emitting an unresolvable copy (the R59 defect again).
    if (parse(tmpdir()).root !== parse(REPO_ROOT).root) {
      expect(() => relocateChainImports(realSource, dirname(REAL_CHAIN), tmpdir())).toThrow(/cannot express/);
    }
  });

  it("rejects an extra failure, a renamed title, an unexpected success or the wrong signal", () => {
    const expected = resultsOf(EXPECTED_CHILD_RESULTS);
    expect(judgeChildProcess(syntheticOutcome(), syntheticReport(expected), EXPECTED_CHILD_RUN)).toEqual([]);

    const extraFailure = syntheticReport([...expected, { status: "failed", title: "a test that should not be here" }]);
    expect(judgeChildProcess(syntheticOutcome(), extraFailure, EXPECTED_CHILD_RUN).join("; ")).toMatch(
      /assertion set is not the expected one/,
    );

    const renamed = syntheticReport(
      expected.map((r) => (r.title === THROW_TITLE ? { status: "failed", title: "renamed" } : r)),
    );
    expect(judgeChildProcess(syntheticOutcome(), renamed, EXPECTED_CHILD_RUN).join("; ")).toMatch(
      /assertion set is not the expected one/,
    );

    const unexpectedSuccess = syntheticReport(
      expected.map((r) => (r.title === SUCCESS_TITLE ? { status: "failed", title: r.title } : r)),
    );
    expect(judgeChildProcess(syntheticOutcome(), unexpectedSuccess, EXPECTED_CHILD_RUN).join("; ")).toMatch(
      /assertion set is not the expected one/,
    );

    const signalled = judgeChildProcess(
      syntheticOutcome({ termination: "signalled", exitCode: null, signal: "SIGKILL" }),
      syntheticReport(expected),
      EXPECTED_CHILD_RUN,
    ).join("; ");
    expect(signalled).toMatch(/killed by signal SIGKILL/);
    expect(signalled).toMatch(/exited with no code/);

    expect(
      judgeChildProcess(syntheticOutcome({ exitCode: 0 }), syntheticReport(expected), EXPECTED_CHILD_RUN).join("; "),
    ).toMatch(/expected 1/);

    expect(
      judgeChildProcess(syntheticOutcome({ reaped: false }), syntheticReport(expected), EXPECTED_CHILD_RUN).join("; "),
    ).toMatch(/terminal state was never observed/);
  });

  it("preserves a failing run's evidence somewhere its own cleanup cannot reach", async () => {
    const diagDir = await tempDir("e4-r60-evidence-");
    const bundleDir = join(diagDir, "r55-nonaccept__probe__run__abc");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "diagnostic.json"), JSON.stringify({ label: "r55-nonaccept" }), "utf8");
    await writeFile(join(bundleDir, "decision-artifact.json"), '{"decision":"INCONCLUSIVE"}', "utf8");

    const reasons = ["the child did not finish before its 4000ms deadline — a TIMEOUT is not a verdict"];
    const preserved = await preserveEvidence({
      label: "r60-evidence-probe",
      outcome: syntheticOutcome({
        termination: "timeout",
        exitCode: null,
        timedOut: true,
        killAttempted: true,
        stdout: "child out",
        stderr: "child err",
        durationMs: 4_000,
      }),
      report: {
        path: join(diagDir, "report.json"),
        kind: "missing",
        error: "ENOENT: no such file or directory",
        results: [],
        rawText: null,
      },
      reasons,
      diagDir,
      extra: { probe: true },
    });

    try {
      // the run's own cleanup now happens — the evidence must survive it
      await rm(diagDir, { recursive: true, force: true });

      const record = JSON.parse(await readFile(join(preserved.dir, "run.json"), "utf8")) as {
        kind: string;
        reasons: string[];
        process: { termination: string; timedOut: boolean };
        extra: { probe: boolean };
      };
      expect(record.kind).toBe("e4-r55-parent-evidence");
      expect(record.reasons).toEqual(reasons);
      expect(record.process.termination).toBe("timeout");
      expect(record.process.timedOut).toBe(true);
      expect(record.extra.probe).toBe(true);

      expect(await readFile(join(preserved.dir, "child.stdout.txt"), "utf8")).toBe("child out");
      expect(await readFile(join(preserved.dir, "child.stderr.txt"), "utf8")).toBe("child err");

      // the diagnostic bundles were COPIED, not referenced
      const copied = JSON.parse(
        await readFile(join(preserved.dir, "diagnostics", "r55-nonaccept__probe__run__abc", "diagnostic.json"), "utf8"),
      ) as { label: string };
      expect(copied.label).toBe("r55-nonaccept");
      expect(
        await readFile(join(preserved.dir, "diagnostics", "r55-nonaccept__probe__run__abc", "decision-artifact.json"), "utf8"),
      ).toContain("INCONCLUSIVE");

      // and it lives outside every root this verifier sweeps
      expect(preserved.dir.startsWith(parentEvidenceRoot())).toBe(true);
      expect(preserved.dir.startsWith(RUNS_ROOT)).toBe(false);
      expect(tempDirs.some((d) => preserved.dir.startsWith(d))).toBe(false);
    } finally {
      await rm(preserved.dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("E4-R55 real production failure wiring (parent verifier over an isolated child)", () => {
  it("drives the real chain, judges its failure evidence, and requires an order mutation to break the acceptance", async () => {
    // ── PRECONDITION: the production benchmark needs a provably clean tree ──
    // E4-R60: even this probe goes through the controlled child, so it has a real
    // deadline and its real exit code — no un-timeout'ed blocking call remains.
    const git = await runControlledChild({
      label: "r55-precondition-git-status",
      command: "git",
      args: ["status", "--porcelain"],
      cwd: REPO_ROOT,
      env: { ...process.env },
      timeoutMs: 60_000,
    });
    expect(git.termination, `git status could not be run: ${git.spawnError ?? git.stderr}`).toBe("exited");
    expect(git.exitCode).toBe(0);
    // E4-R60: name the dirty entries. "the tree is not clean" alone cannot
    // distinguish a real uncommitted change from a stray artifact dropped by the
    // developer tooling (measured here: the agent sandbox's safe-delete shim
    // leaves zero-byte `_tmp_<pid>_<hash>` files in the repo root, which makes
    // this precondition fail for a reason that has nothing to do with the code).
    const dirtyEntries = git.stdout.trim() === "" ? [] : git.stdout.trim().split("\n");
    expect(
      git.stdout.trim(),
      `E4-R55 requires a CLEAN committed working tree: the production benchmark refuses to produce a promotion-eligible run on a tree that is not provably clean, so every child case would fail for an unrelated reason. Commit or stash first.\n      dirty entries (${dirtyEntries.length}):\n        ${dirtyEntries.join("\n        ")}`,
    ).toBe("");

    // E4-R59: nothing is written into the production source tree any more. The
    // mutated copy is generated into a per-run directory inside `runChild`, and
    // the child is bound to it by `E4_R55_CHAIN_MODULE` (asserted below).

    // ── RUN 1: the real wiring, unmodified ──
    const normal = await runChild("real");
    await conclude(normal, await judgeRealRun(normal));

    // ── RUN 2: the SAME acceptance against the ORDER-MUTATED wiring ──
    const mutated = await runChild("mutated");
    await conclude(mutated, await judgeMutatedRun(mutated, normal.chain.sha256), {
      controlChainSha: normal.chain.sha256,
    });

    // ── 7. E4-R59: no per-run copy survives its own run ──
    const leftover = await readdir(RUNS_ROOT).catch((err) => {
      reportDegraded("e4-r55 runs-root listing", err);
      return [] as string[];
    });
    expect(leftover, `each run must clean only its own directory; leftovers: ${leftover.join(", ")}`).toEqual([]);
  }, 900_000);

  it("R59: two concurrent runs own distinct per-run copies and never clobber each other", async () => {
    await mkdir(RUNS_ROOT, { recursive: true });
    const dirA = await mkdtemp(join(RUNS_ROOT, "run-"));
    const dirB = await mkdtemp(join(RUNS_ROOT, "run-"));
    try {
      expect(dirA).not.toBe(dirB); // per-run allocation, not a fixed global path

      // A barrier: BOTH copies are materialised before either is cleaned up, so
      // this is the interleaving two parallel parent verifications would produce.
      const [a, b] = await Promise.all([
        prepareChainModule(dirA, "mutated"),
        prepareChainModule(dirB, "mutated"),
      ]);
      expect(a.path).not.toBe(b.path);
      // Same source -> same mutation, so the copies are interchangeable in content.
      expect(a.sha256).toBe(b.sha256);

      // Each copy's rewritten imports must RESOLVE to the real repository
      // modules, whatever directory depth the copy happens to sit at. The
      // specifiers use the ESM `.js` form (TypeScript resolves `.js` -> the `.ts`
      // source), so the comparison is made modulo that extension convention.
      // E4-R60: BOTH the static diagnostics import and the dynamic benchmark
      // import must be relocated — R59 missed the latter, which is what made the
      // order counterexample vacuous.
      const expectedTargets = [REAL_DIAGNOSTICS, REAL_BENCHMARK_COMMAND].map(normalizeModulePath).sort();
      for (const ref of [a, b]) {
        const src = await readFile(ref.path, "utf8");
        const specs = [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)"(\.\.?\/[^"]*)"/g)].map((m) => String(m[1]));
        expect(specs.length, `${ref.path}: the copy must keep every relative import`).toBeGreaterThanOrEqual(2);
        const resolved = specs
          .map((spec) => normalizeModulePath(resolve(dirname(ref.path), spec)))
          .sort();
        expect(resolved, `${ref.path}: every relative import must reach a REAL module`).toEqual(expectedTargets);
        expect(ref.relocatedImports.length).toBeGreaterThanOrEqual(2);
      }

      // Run A cleans ONLY its own directory: B's copy must survive intact.
      await rm(dirA, { recursive: true, force: true });
      expect(await readFile(a.path, "utf8").then(() => true, () => false)).toBe(false);
      expect(await readFile(b.path, "utf8").then(() => true, () => false)).toBe(true);
      expect(sha256(await readFile(b.path))).toBe(b.sha256);
    } finally {
      for (const dir of [dirA, dirB]) {
        try {
          await rm(dir, { recursive: true, force: true });
        } catch (err) {
          reportDegraded(`e4-r55 concurrent-run cleanup of ${dir}`, err);
        }
      }
    }
  });

  it("R59: the per-run copy location stays outside the production compile input and the default test include", async () => {
    // Structural guard: if a future change ever widens `apps/cli/tsconfig.json`'s
    // include (or moves the runs root under `src`), this fails instead of silently
    // putting generated code back into the production build.
    const tsconfig = JSON.parse(await readFile(join(REPO_ROOT, "apps", "cli", "tsconfig.json"), "utf8")) as {
      include?: string[];
    };
    const include = tsconfig.include ?? [];
    expect(include).toContain("src");
    expect(
      include.some((p) => p === "test-infra" || p.startsWith("test-infra/") || p === "**" || p === "."),
      `apps/cli tsconfig include must not cover test-infra, got ${JSON.stringify(include)}`,
    ).toBe(false);

    const relToApp = relative(join(REPO_ROOT, "apps", "cli"), RUNS_ROOT).split("\\").join("/");
    expect(relToApp.startsWith("test-infra/")).toBe(true);
    // The root Vitest include only collects `apps/*/src/**/*.test.ts`, so a path
    // without a `src` segment can never be collected by the default run.
    expect(relToApp.includes("/src/")).toBe(false);
    const rootVitest = await readFile(join(REPO_ROOT, "vitest.config.ts"), "utf8");
    expect(rootVitest).toContain("apps/*/src/**/*.test.ts");
  });
});
