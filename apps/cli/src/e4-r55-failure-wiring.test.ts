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
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { basename, dirname, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { mutateChainOrdering, relocateChainImports } from "./e4-09-real-chain.js";
import type { ChildProcess } from "node:child_process";
import type { Dirent } from "node:fs";
import {
  createStreamCapture,
  judgeChildProcess,
  killTree,
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
  CopyEntry,
  EvidenceRoleRecord,
  EvidenceSeam,
  ExpectedChildRun,
  PreserveEvidenceInput,
  PreservedEvidence,
  ReportRead,
  StreamCapture,
  TreeKillResult,
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
 * E4-R62 (H62): the four `dist` outputs a real `tsc -b apps/cli` emits for the
 * legacy module. MEASURED, not guessed: the isolated-copy build in
 * `docs/E4-R62-report.md` §2 produced exactly `.js`, `.js.map`, `.d.ts` and
 * `.d.ts.map`. Adding the tsconfig `exclude` stops NEW emission, but `tsc` never
 * removes a stale output, so a developer who ran the pre-R59 test keeps these
 * forever. They are named EXACTLY — no glob, no `dist` sweep.
 */
const LEGACY_GENERATED_OUTPUTS = ["js", "js.map", "d.ts", "d.ts.map"].map((ext) =>
  join(REPO_ROOT, "apps", "cli", "dist", `e4-r55-mutated-chain.generated.${ext}`),
);

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
  // E4-R62 (H62): the tsconfig `exclude` stops NEW emission of the legacy
  // module, but `tsc` cannot remove outputs a pre-R59 run already wrote into
  // `dist` (measured: the exclude alone leaves all four behind). Remove exactly
  // those four names, and only when they exist — no glob, no `dist` sweep, no
  // source deletion. A clean CI checkout never has them: the legacy SOURCE only
  // ever existed on a developer machine that ran the pre-R59 test.
  for (const orphan of LEGACY_GENERATED_OUTPUTS) {
    try {
      if (existsSync(orphan)) await rm(orphan, { force: true });
    } catch (err) {
      reportDegraded(`e4-r55 legacy dist-output cleanup of ${orphan}`, err);
    }
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
  /** E4-R70: the EXACT per-run directory this run allocated and must release. */
  runDir: string;
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
  // A PER-RUN directory owned by this invocation only. Ownership is recorded at
  // ALLOCATION time (E4-R70), so a later init failure still leaves it verifiable.
  const runDir = await allocateOwnedRunDir();

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
      // E4-R70: the EXACT path this run owns, so the final verification can check
      // ownership instead of demanding the whole shared root be empty.
      runDir,
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

// ---------------------------------------------------------------------------
// E4-R70 (K70-A / K70-B) — cleanup is verified by OWNERSHIP, not by global emptiness
// ---------------------------------------------------------------------------

/**
 * Every per-run directory THIS PROCESS allocated under the shared runs root.
 *
 * Ownership is recorded at ALLOCATION time from the exact `mkdtemp` path — never
 * inferred from a `run-*` name, a global directory diff, or a timestamp. That is
 * what makes "a directory allocated before a later init failure" (K70-A, plan
 * §3.A.4) still covered by the final verification.
 */
const ownedRunDirs: string[] = [];

/** Allocate a per-run directory and record ownership of its exact path. */
async function allocateOwnedRunDir(): Promise<string> {
  await mkdir(RUNS_ROOT, { recursive: true });
  const dir = await mkdtemp(join(RUNS_ROOT, "run-"));
  ownedRunDirs.push(dir);
  return dir;
}

/** `unknown` is a FIRST-CLASS outcome: an unreadable probe is not "cleaned up". */
type PathState = "absent" | "present" | "unknown";

interface PathProbeResult {
  state: PathState;
  operation: string;
  errorCode: string | null;
  reason: string | null;
}

type LstatLike = (path: string) => Promise<{ isDirectory?: () => boolean }>;

/**
 * Probe whether a path still exists, WITHOUT following links (K70-B).
 *
 * The ENOENT rule and its PARENT-DIRECTORY CONSTRAINT, stated explicitly so it
 * cannot be read as "any failure means absent":
 *   - `lstat` (not `stat`) is used so a DANGLING SYMLINK still counts as a
 *     leftover: the link itself is a path this run allocated.
 *   - ONLY `ENOENT` is a candidate for "absent"; every other code (EACCES, EIO,
 *     EBUSY, ...) is `unknown` and FAILS the acceptance.
 *   - ENOENT alone is NOT sufficient on every platform. Windows has no ENOTDIR,
 *     so a parent component that is a FILE also reports ENOENT (measured here).
 *     The parent is therefore probed too: if the parent exists but is not a
 *     directory, "not found" cannot mean "cleaned up", so the result is `unknown`.
 */
async function probePathState(path: string, lstatImpl: LstatLike = lstat): Promise<PathProbeResult> {
  try {
    await lstatImpl(path);
    return { state: "present", operation: "lstat", errorCode: null, reason: null };
  } catch (err) {
    const code = (err as { code?: string }).code ?? null;
    if (code !== "ENOENT") {
      return { state: "unknown", operation: "lstat", errorCode: code, reason: messageOf(err) };
    }
    const parent = dirname(path);
    try {
      const parentStat = await lstatImpl(parent);
      const isDir = parentStat.isDirectory?.() ?? true;
      if (!isDir) {
        return {
          state: "unknown",
          operation: "lstat(parent)",
          errorCode: code,
          reason: `the parent ${parent} is not a directory, so "not found" cannot mean "cleaned up"`,
        };
      }
    } catch (parentErr) {
      const parentCode = (parentErr as { code?: string }).code ?? null;
      if (parentCode !== "ENOENT") {
        return {
          state: "unknown",
          operation: "lstat(parent)",
          errorCode: parentCode,
          reason: messageOf(parentErr),
        };
      }
      // The parent is gone as well — the whole tree was removed. That IS absent.
    }
    return { state: "absent", operation: "lstat", errorCode: code, reason: null };
  }
}

/**
 * Verify that every directory THIS run owns is gone.
 *
 * Returns the reasons it is not — never a boolean, and never an empty list
 * produced by swallowing a probe error (the pre-R70 `.catch(() => [])` did
 * exactly that and certified an unreadable root as a successful cleanup).
 */
async function verifyOwnedCleanup(
  owned: string[],
  lstatImpl: LstatLike = lstat,
): Promise<string[]> {
  const reasons: string[] = [];
  for (const path of owned) {
    const probe = await probePathState(path, lstatImpl);
    if (probe.state === "present") {
      reasons.push(
        `this run's own per-run directory was NOT cleaned up: ${path} (owner: this process, recorded at allocation)`,
      );
    } else if (probe.state === "unknown") {
      reasons.push(
        `the cleanup of ${path} could not be CONFIRMED: ${probe.operation} failed with ` +
          `${probe.errorCode ?? "no code"} — an unreadable probe is not a successful cleanup` +
          (probe.reason === null ? "" : ` (${probe.reason})`),
      );
    }
  }
  return reasons;
}

/**
 * Report entries under the shared runs root that this run does NOT own.
 *
 * NON-BLOCKING BY DESIGN (plan §3.B.5): a foreign historical leftover or another
 * process's active directory is information, never a cleanup failure of this run
 * and never an authorization to delete it.
 */
async function listForeignEntries(root: string, owned: string[]): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return [];
    reportDegraded("e4-r55 runs-root foreign listing", err);
    return [];
  }
  const ownedNames = new Set(owned.map((p) => basename(p)));
  return names.filter((n) => !ownedNames.has(n)).sort();
}


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
      // E4-R65/E4-R67: the message must state BOTH where the evidence is and
      // whether the archive is complete, and must never advertise a location
      // when the archive could not be written at all. The ARCHIVE integrity
      // leads; the diagnostics copy is reported as the separate, narrower fact
      // it is, so a package with a complete diagnostics copy but a missing log
      // never reads as a complete package.
      if (preserved.ok) {
        process.stderr.write(
          `[e4-r55] the ${run.mode} run was not decidable — evidence preserved at ${preserved.dir} ` +
            `(${preserved.files.length} files, archive integrity=${preserved.archiveIntegrity}, ` +
            `diagnostics=${preserved.diagnosticsCopyIntegrity})\n`,
        );
      } else {
        process.stderr.write(
          `[e4-r55] the ${run.mode} run was not decidable — the evidence archive could NOT be written ` +
            `(${preserved.archiveIntegrity}: ${preserved.error ?? "unknown reason"}); no downloadable location\n`,
        );
      }
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
  const stdout = over.stdout ?? "";
  const stderr = over.stderr ?? "";
  // Keep the E4-R63 byte accounting consistent with the text overrides.
  const captureOf = (text: string): StreamCapture => {
    const bytes = Buffer.byteLength(text, "utf8");
    return { text, receivedBytes: bytes, capturedBytes: bytes, truncated: false };
  };
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
    stdout,
    stderr,
    capture: { stdout: captureOf(stdout), stderr: captureOf(stderr) },
    outputOverflow: false,
    durationMs: 1,
    killAttempted: false,
    treeKill: null,
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
    const chainReasons: string[] = [];
    try {
      await conclude(normal, await judgeRealRun(normal));
    } catch (err) {
      chainReasons.push(messageOf(err));
    }

    // ── RUN 2: the SAME acceptance against the ORDER-MUTATED wiring ──
    const mutated = await runChild("mutated");
    try {
      await conclude(mutated, await judgeMutatedRun(mutated, normal.chain.sha256), {
        controlChainSha: normal.chain.sha256,
      });
    } catch (err) {
      chainReasons.push(messageOf(err));
    }

    // ── 7. E4-R70: cleanup is verified by OWNERSHIP, not by global emptiness ──
    // The shared runs root may legitimately hold ANOTHER run's active directory
    // or a historical leftover. Demanding that it be empty conflated "this run
    // cleaned up after itself" with "nobody else's directory exists" (K70-A), and
    // the old `.catch(() => [])` turned an UNREADABLE root into a PASS (K70-B).
    // We now verify the exact directories THIS process allocated, and a probe
    // that cannot answer FAILS the acceptance instead of passing by default.
    const cleanupReasons = await verifyOwnedCleanup(ownedRunDirs);
    const foreign = await listForeignEntries(RUNS_ROOT, ownedRunDirs);
    if (foreign.length > 0) {
      // Diagnostic ONLY: never a cleanup failure of this run, and never ours to
      // delete. Other processes' resources and historical leftovers stay put.
      process.stderr.write(
        `[e4-r55] ${foreign.length} entry/entries under the shared runs root are NOT owned by this run ` +
          `(${foreign.join(", ")}) — left untouched, and NOT a cleanup failure of this run\n`,
      );
    }

    // Both classes of failure are reported TOGETHER, so a cleanup failure can
    // never mask the original chain failure, nor the other way round.
    expect(
      [...chainReasons, ...cleanupReasons],
      "the real chain verdict and this run's own cleanup",
    ).toEqual([]);
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

  it("R62: the legacy fixed mutation path is excluded from the production compile input, narrowly", async () => {
    // H62: `include: ["src"]` DOES cover the pre-R59 fixed path, and every gate
    // entry (`pnpm test` / `pnpm test:coverage`) runs `tsc -b` BEFORE any test
    // executes — so the parent test's `afterAll` cleanup was structurally too
    // late to keep it out of the build. The `exclude` entry below is what
    // actually keeps it out. Remove that entry and this test fails, which is
    // what makes the counterexample discriminating.
    const tsconfig = JSON.parse(
      await readFile(join(REPO_ROOT, "apps", "cli", "tsconfig.json"), "utf8"),
    ) as { include?: string[]; exclude?: string[] };
    const include = tsconfig.include ?? [];
    const exclude = tsconfig.exclude ?? [];

    // 1. The legacy path really IS inside the include glob — that is why an
    //    exclude is needed at all.
    const legacyRel = relative(join(REPO_ROOT, "apps", "cli"), LEGACY_GENERATED).split("\\").join("/");
    expect(legacyRel).toBe("src/e4-r55-mutated-chain.generated.ts");
    expect(include).toContain("src");

    // 2. It is excluded, by its exact path.
    expect(
      exclude,
      `apps/cli tsconfig exclude must name the legacy fixed path, got ${JSON.stringify(exclude)}`,
    ).toContain(legacyRel);

    // 3. The exclusion stays NARROW: no directory entry, no broad
    //    `*.generated.ts` wildcard. The only wildcard allowed is the pre-existing
    //    R24 fixture pattern this file already documented.
    for (const entry of exclude) {
      expect(
        entry.includes("*") && entry !== "src/e4-r24-fixture-*.test.ts",
        `unexpected broad exclude entry: ${entry}`,
      ).toBe(false);
      expect(entry.endsWith("/"), `exclude must name files, not directories: ${entry}`).toBe(false);
    }
    for (const realSource of [
      "src/e4-09-real-chain.ts",
      "src/e4-r55-failure-wiring.test.ts",
      "src/benchmark-command.ts",
      "src/e4-r55-child-harness.ts",
    ]) {
      expect(exclude, `${realSource} must stay in the production compile input`).not.toContain(realSource);
    }

    // 4. The dist orphans we clean up are exactly the legacy module's, with the
    //    same basename — the cleanup can never touch another module's output.
    expect(LEGACY_GENERATED_OUTPUTS).toHaveLength(4);
    const distRoot = join(REPO_ROOT, "apps", "cli", "dist");
    for (const out of LEGACY_GENERATED_OUTPUTS) {
      expect(relative(distRoot, out).split("\\").join("/")).toMatch(
        /^e4-r55-mutated-chain\.generated\.(js|js\.map|d\.ts|d\.ts\.map)$/,
      );
    }
  });
});

describe("E4-R63 bounded log capture (byte-budget contract)", () => {
  const capture = (chunks: (Buffer | string)[], cap: number): StreamCapture => {
    const c = createStreamCapture(cap);
    for (const chunk of chunks) c.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    return c.finish();
  };

  it("A: a budget smaller than one character yields EMPTY text, never an over-budget replacement char", () => {
    // The pre-R63 implementation cut the encoded buffer mid-codepoint and decoded
    // the fragment: cap=1 on "中" saved U+FFFD — THREE bytes against a 1-byte cap.
    for (const cap of [1, 2]) {
      const r = capture(["中"], cap);
      expect(r.text, `cap=${cap} must not invent a replacement char`).toBe("");
      expect(r.capturedBytes, `cap=${cap}`).toBe(0);
      expect(r.capturedBytes).toBeLessThanOrEqual(cap);
      expect(r.receivedBytes).toBe(3);
      expect(r.truncated).toBe(true);
    }
  });

  it("B: a budget that exactly fits one character captures it whole and is not truncated", () => {
    const r = capture(["中"], 3);
    expect(r.text).toBe("中");
    expect(r.capturedBytes).toBe(3);
    expect(r.receivedBytes).toBe(3);
    expect(r.truncated).toBe(false);
  });

  it("C: the four-byte emoji boundary", () => {
    const emoji = "😀";
    expect(Buffer.byteLength(emoji, "utf8")).toBe(4);
    const short = capture([emoji], 3);
    expect(short.text).toBe("");
    expect(short.capturedBytes).toBe(0);
    const exact = capture([emoji], 4);
    expect(exact.text).toBe(emoji);
    expect(exact.capturedBytes).toBe(4);
    expect(exact.truncated).toBe(false);
  });

  it("D: an ASCII + CJK mix stops on a character boundary instead of splitting it", () => {
    // "ab" is 2 bytes and "中" is 3, so at cap 4 the CJK char cannot fit whole.
    const r = capture(["ab中cd"], 4);
    expect(r.text).toBe("ab");
    expect(r.capturedBytes).toBe(2);
    expect(r.capturedBytes).toBeLessThanOrEqual(4);
    expect(r.truncated).toBe(true);
  });

  it("E: empty output is complete, not truncated", () => {
    const r = capture([], 8);
    expect(r.text).toBe("");
    expect(r.capturedBytes).toBe(0);
    expect(r.receivedBytes).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it("F: one character split across several data chunks decodes identically to a single chunk", () => {
    const whole = capture(["中"], 3);
    const split = capture([Buffer.from([0xe4]), Buffer.from([0xb8]), Buffer.from([0xad])], 3);
    expect(split.text).toBe(whole.text);
    expect(split.text).toBe("中");
    expect(split.capturedBytes).toBe(3);
    expect(split.truncated).toBe(false);
    // Per-chunk decoding is exactly what used to corrupt this: three U+FFFD.
    expect(split.text.includes("\uFFFD")).toBe(false);
  });

  it("G: invalid UTF-8 has ONE documented policy — transcoded text, marked truncated, budget still honoured", () => {
    const raw = Buffer.from([0xff, 0xfe, 0x61]);
    const r = capture([raw], 3);
    expect(r.capturedBytes).toBeLessThanOrEqual(3);
    // The contract is text, so we must never claim the raw bytes back.
    expect(Buffer.from(r.text, "utf8").equals(raw)).toBe(false);
    expect(r.truncated).toBe(true);
  });

  it("H: the budget is PER STREAM — one overflowing stream never eats the other's budget", () => {
    const out = createStreamCapture(3);
    const err = createStreamCapture(3);
    out.push(Buffer.from("中中中", "utf8"));
    err.push(Buffer.from("中", "utf8"));
    const o = out.finish();
    const e = err.finish();
    expect(o.capturedBytes).toBeLessThanOrEqual(3);
    expect(o.truncated).toBe(true);
    expect(e.text).toBe("中");
    expect(e.capturedBytes).toBe(3);
    expect(e.truncated).toBe(false);
  });

  it("I: a REAL child writing a 3-byte character under a 1-byte budget reports empty, bounded output", async () => {
    const script = await writeTempScript("e4-r63-echo.js", "process.stdout.write('中');\n");
    const outcome = await runControlledChild({
      label: "r63-budget",
      command: process.execPath,
      args: [script],
      cwd: REPO_ROOT,
      env: { ...process.env },
      timeoutMs: 60_000,
      maxOutputBytes: 1,
    });
    expect(outcome.termination).toBe("exited");
    expect(outcome.stdout).toBe("");
    expect(outcome.capture.stdout.capturedBytes).toBe(0);
    expect(outcome.capture.stdout.receivedBytes).toBe(3);
    expect(outcome.capture.stdout.truncated).toBe(true);
    expect(outcome.outputOverflow).toBe(true);
  });

  it("J: the preserved log files' on-disk byte counts equal the declared capturedBytes", async () => {
    const outcome = syntheticOutcome({ stdout: "中", stderr: "ok" });
    const preserved = await preserveEvidence({
      label: "r63-bytes",
      outcome,
      report: syntheticReport([]),
      reasons: ["probe: byte-budget contract"],
    });
    try {
      const outBytes = (await stat(join(preserved.dir, "child.stdout.txt"))).size;
      const errBytes = (await stat(join(preserved.dir, "child.stderr.txt"))).size;
      expect(outBytes).toBe(outcome.capture.stdout.capturedBytes);
      expect(outBytes).toBe(3);
      expect(errBytes).toBe(outcome.capture.stderr.capturedBytes);
      const record = JSON.parse(await readFile(join(preserved.dir, "run.json"), "utf8")) as {
        capture: { stdout: StreamCapture; stderr: StreamCapture };
      };
      expect(record.capture.stdout.capturedBytes).toBe(outBytes);
      expect(record.capture.stderr.capturedBytes).toBe(errBytes);
    } finally {
      await rm(preserved.dir, { recursive: true, force: true });
    }
  });
});

describe("E4-R64 process-tree kill failure handling", () => {
  /** A fake `taskkill` handle we can drive by hand (no PATH/system changes). */
  const fakeKiller = (): ChildProcess => {
    const killer = new EventEmitter() as unknown as ChildProcess;
    (killer as unknown as { unref: () => void }).unref = () => {};
    return killer;
  };
  /** A fake child that counts how many times a direct kill was requested. */
  const fakeChild = (pid: number | undefined) => {
    let kills = 0;
    const child = {
      pid,
      kill: () => {
        kills += 1;
        return true;
      },
    } as unknown as ChildProcess;
    return { child, kills: () => kills };
  };
  const depsFor = (
    spawnKiller: (
      command: string,
      args: string[],
      options: { stdio: "ignore"; windowsHide: boolean },
    ) => ChildProcess,
    killDirect: (child: ChildProcess) => boolean,
  ) => ({ platform: "win32" as NodeJS.Platform, spawnKiller, killDirect });
  const directKill = (child: ChildProcess): boolean => {
    child.kill("SIGKILL");
    return true;
  };
  const emit = (killer: ChildProcess, event: string, arg?: unknown): void => {
    (killer as unknown as EventEmitter).emit(event, arg);
  };

  it("A: an ASYNC taskkill launch failure performs the promised direct fallback (pre-R64 it only logged)", () => {
    const killer = fakeKiller();
    const { child, kills } = fakeChild(4242);
    const result = killTree(child, depsFor(() => killer, directKill));

    // The launch failure arrives through the 'error' EVENT, which the try/catch
    // around spawn() structurally cannot see.
    emit(killer, "error", new Error("spawn taskkill ENOENT"));

    expect(result.commandLaunched).toBe(false);
    expect(result.commandError).toContain("ENOENT");
    expect(result.directFallbackAttempted).toBe(true);
    expect(result.directChildSignalled).toBe(true);
    expect(kills()).toBe(1);
  });

  it("B: a NON-ZERO taskkill exit is a failure and enters the fallback path", () => {
    const killer = fakeKiller();
    const { child, kills } = fakeChild(4243);
    const result = killTree(child, depsFor(() => killer, directKill));
    expect(result.directFallbackAttempted).toBe(false);

    emit(killer, "close", 1);

    expect(result.commandExitCode).toBe(1);
    expect(result.commandError).toContain("taskkill exited with 1");
    expect(result.directFallbackAttempted).toBe(true);
    expect(kills()).toBe(1);
  });

  it("C: a successful taskkill (exit 0) does NOT trigger the error fallback", () => {
    const killer = fakeKiller();
    const { child, kills } = fakeChild(4244);
    const result = killTree(child, depsFor(() => killer, directKill));

    emit(killer, "close", 0);

    expect(result.commandExitCode).toBe(0);
    expect(result.commandError).toBeNull();
    expect(result.directFallbackAttempted).toBe(false);
    expect(kills()).toBe(0);
  });

  it("D: an error followed by a non-zero exit signals the direct child EXACTLY once", () => {
    const killer = fakeKiller();
    const { child, kills } = fakeChild(4245);
    const result = killTree(child, depsFor(() => killer, directKill));

    emit(killer, "error", new Error("boom"));
    emit(killer, "close", 1);

    expect(result.directFallbackAttempted).toBe(true);
    expect(kills(), "a second failure must not kill twice").toBe(1);
    expect(result.commandError, "the FIRST reason is kept").toContain("boom");
  });

  it("E: a STUCK taskkill reports an unconfirmed command state instead of inventing an exit code", () => {
    const killer = fakeKiller();
    const { child, kills } = fakeChild(4246);
    const result = killTree(child, depsFor(() => killer, directKill));

    // Never emits anything at all.
    expect(result.requested).toBe(true);
    expect(result.mechanism).toBe("taskkill");
    expect(result.commandLaunched).toBe(true);
    expect(result.commandExitCode).toBeNull();
    expect(result.commandError).toBeNull();
    expect(result.directFallbackAttempted).toBe(false);
    expect(kills()).toBe(0);
  });

  it("F: a child with no pid requests nothing and signals nothing", () => {
    const { child, kills } = fakeChild(undefined);
    const result = killTree(child, depsFor(() => fakeKiller(), directKill));
    expect(result.requested).toBe(false);
    expect(result.mechanism).toBe("none");
    expect(result.command).toBeNull();
    expect(kills()).toBe(0);
  });

  it("G: a synchronous spawn throw falls back immediately and is recorded", () => {
    const { child, kills } = fakeChild(4247);
    const result = killTree(
      child,
      depsFor(() => {
        throw new Error("sync spawn failure");
      }, directKill),
    );
    expect(result.commandLaunched).toBe(false);
    expect(result.commandError).toContain("sync spawn failure");
    expect(result.directFallbackAttempted).toBe(true);
    expect(kills()).toBe(1);
  });

  it("H: the direct kill is named 'signalled' — never presented as proof the whole tree died", () => {
    const killer = fakeKiller();
    const { child } = fakeChild(4248);
    const result = killTree(child, depsFor(() => killer, directKill));
    emit(killer, "error", new Error("nope"));
    expect(result.directChildSignalled).toBe(true);
    // There is deliberately no `treeKilled` / `descendantsGone` field to over-read.
    expect(Object.keys(result)).not.toContain("treeKilled");
    expect(Object.keys(result)).not.toContain("descendantsGone");
  });

  it("I: a kill that never produces a terminal event resolves as UNCONFIRMED instead of hanging", async () => {
    // The child outlives the deadline by seconds, the injected taskkill fails
    // asynchronously and the injected direct kill does nothing. The parent must
    // still return promptly, report reaped=false, and release the handles.
    const script = await writeTempScript("e4-r64-unkillable.js", "setTimeout(() => process.exit(0), 4000);\n");
    const started = Date.now();
    const outcome = await runControlledChild({
      label: "r64-unconfirmed",
      command: process.execPath,
      args: [script],
      cwd: REPO_ROOT,
      env: { ...process.env },
      timeoutMs: 400,
      killGraceMs: 50,
      killDeps: {
        platform: "win32",
        spawnKiller: () => {
          const killer = fakeKiller();
          setTimeout(() => emit(killer, "error", new Error("injected taskkill failure")), 10);
          return killer;
        },
        killDirect: () => false,
      },
    });
    const elapsed = Date.now() - started;
    expect(elapsed, "the parent must not wait for an un-reaped child").toBeLessThan(3000);
    expect(outcome.termination).toBe("timeout");
    expect(outcome.timedOut).toBe(true);
    expect(outcome.reaped).toBe(false);
    expect(outcome.treeKill?.requested).toBe(true);
    expect(outcome.treeKill?.directFallbackAttempted).toBe(true);
    expect(outcome.treeKill?.directChildSignalled).toBe(false);
    expect(outcome.treeKill?.commandExitCode).toBeNull();
    expect(outcome.treeKill?.commandError).toContain("injected taskkill failure");
  });

  it("J: the tree-kill facts reach run.json, not only stderr", async () => {
    const treeKill: TreeKillResult = {
      requested: true,
      mechanism: "taskkill",
      command: "taskkill /pid 1 /t /f",
      commandLaunched: false,
      commandExitCode: null,
      commandError: "spawn taskkill ENOENT",
      directFallbackAttempted: true,
      directChildSignalled: true,
      settled: true,
    };
    const preserved = await preserveEvidence({
      label: "r64-treekill",
      outcome: syntheticOutcome({ treeKill, killAttempted: true }),
      report: syntheticReport([]),
      reasons: ["probe: tree kill"],
    });
    try {
      const record = JSON.parse(await readFile(join(preserved.dir, "run.json"), "utf8")) as {
        treeKill: TreeKillResult;
      };
      expect(record.treeKill).toEqual(treeKill);
      expect(record.treeKill.commandError).toContain("ENOENT");
    } finally {
      await rm(preserved.dir, { recursive: true, force: true });
    }
  });

  it("K: the REAL Windows taskkill path launches and terminates the tree without a fallback", async () => {
    if (platform() !== "win32") {
      // POSIX coverage stays with the existing real process-group tests; this
      // assertion is Windows-specific by construction.
      return;
    }
    const script = await writeTempScript("e4-r64-real-kill.js", "setInterval(() => {}, 1000);\n");
    const outcome = await runControlledChild({
      label: "r64-real-taskkill",
      command: process.execPath,
      args: [script],
      cwd: REPO_ROOT,
      env: { ...process.env },
      timeoutMs: 700,
      killGraceMs: 10_000,
    });
    expect(outcome.termination).toBe("timeout");
    expect(outcome.reaped).toBe(true);
    expect(outcome.treeKill?.mechanism).toBe("taskkill");
    expect(outcome.treeKill?.commandLaunched).toBe(true);
    expect(outcome.treeKill?.directFallbackAttempted).toBe(false);
    // The parent may observe the CHILD's terminal event before taskkill's own
    // exit, so a null exit code here means "not observed yet", not "failed".
    expect([0, null]).toContain(outcome.treeKill?.commandExitCode);
  });
});

describe("E4-R65 evidence-copy completeness protocol", () => {
  interface EvidenceRecord {
    reasons: string[];
    evidence: {
      // E4-R67: layer 1 — describes ONLY the diagnostics tree copy.
      diagnostics: {
        diagDir: string | null;
        requested: boolean;
        integrity: string;
        sourceMissing: boolean | null;
        empty: boolean | null;
        copiedCount: number;
        copied: string[];
        entries: CopyEntry[];
      };
      // E4-R67: layer 2 — describes EVERY requested archive role.
      archive: {
        integrity: string;
        roles: EvidenceRoleRecord[];
        failedRoles: string[];
      };
    };
  }

  const preserve = async (diagDir: string | undefined, label: string): Promise<PreservedEvidence> =>
    preserveEvidence({
      label,
      outcome: syntheticOutcome(),
      report: syntheticReport([]),
      reasons: ["probe: the ORIGINAL business failure must survive"],
      diagDir,
    });

  const readRecord = async (dir: string): Promise<EvidenceRecord> =>
    JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as EvidenceRecord;

  it("A: a diagnostics dir that was never requested is 'not-requested', NOT a copy failure", async () => {
    const preserved = await preserve(undefined, "r65-not-requested");
    try {
      expect(preserved.ok).toBe(true);
      expect(preserved.copy).toBeNull();
      expect(preserved.diagnosticsCopyIntegrity).toBe("not-requested");
      const record = await readRecord(preserved.dir);
      expect(record.evidence.diagnostics.requested).toBe(false);
      expect(record.evidence.diagnostics.integrity).toBe("not-requested");
      expect(record.evidence.diagnostics.entries).toEqual([]);
    } finally {
      await rm(preserved.dir, { recursive: true, force: true });
    }
  });

  it("B: an existing EMPTY directory is provably empty, not mistaken for a missing one", async () => {
    const src = await tempDir("e4-r65-empty-");
    const preserved = await preserve(src, "r65-empty");
    try {
      const record = await readRecord(preserved.dir);
      expect(record.evidence.diagnostics.requested).toBe(true);
      expect(record.evidence.diagnostics.empty).toBe(true);
      expect(record.evidence.diagnostics.sourceMissing).toBe(false);
      expect(record.evidence.diagnostics.integrity).toBe("complete");
      expect(record.evidence.diagnostics.copied).toEqual([]);
      expect(record.evidence.diagnostics.entries).toEqual([]);
    } finally {
      await rm(preserved.dir, { recursive: true, force: true });
    }
  });

  it("C: a specified directory that does not exist archives 'missing' with an ENOENT entry", async () => {
    const missing = join(await tempDir("e4-r65-parent-"), "does-not-exist");
    const preserved = await preserve(missing, "r65-missing");
    try {
      const record = await readRecord(preserved.dir);
      expect(record.evidence.diagnostics.integrity).toBe("missing");
      expect(record.evidence.diagnostics.sourceMissing).toBe(true);
      expect(record.evidence.diagnostics.empty).toBe(false);
      const enoent = record.evidence.diagnostics.entries.find((e) => e.errorCode === "ENOENT");
      expect(enoent, "the ENOENT must be recoverable from run.json alone").toBeDefined();
      expect(enoent?.status).toBe("missing");
      expect(enoent?.operation).toBe("readdir");
    } finally {
      await rm(preserved.dir, { recursive: true, force: true });
    }
  });

  it("D: a directory that exists but cannot be read archives 'partial' with the operation and code", async () => {
    // A regular FILE where a directory is expected: `readdir` fails ENOTDIR.
    const notADir = join(await tempDir("e4-r65-notadir-"), "a-file");
    await writeFile(notADir, "not a directory\n", "utf8");
    const preserved = await preserve(notADir, "r65-unreadable");
    try {
      const record = await readRecord(preserved.dir);
      expect(record.evidence.diagnostics.integrity).toBe("partial");
      expect(record.evidence.diagnostics.sourceMissing).toBe(false);
      const bad = record.evidence.diagnostics.entries[0];
      expect(bad).toBeDefined();
      expect(bad?.status).toBe("unreadable");
      expect(bad?.operation).toBe("readdir");
      expect(bad?.errorCode).toBeTruthy();
      expect(bad?.reason).toBeTruthy();
    } finally {
      await rm(preserved.dir, { recursive: true, force: true });
    }
  });

  it("E: a successful nested copy is complete, its files are readable, and they are listed under diagnostics/", async () => {
    const src = await tempDir("e4-r65-good-");
    await mkdir(join(src, "nested"), { recursive: true });
    await writeFile(join(src, "top.json"), '{"a":1}\n', "utf8");
    await writeFile(join(src, "nested", "inner.json"), '{"b":2}\n', "utf8");

    const preserved = await preserve(src, "r65-good");
    try {
      expect(preserved.diagnosticsCopyIntegrity).toBe("complete");
      expect(preserved.files).toContain("diagnostics/top.json");
      expect(preserved.files).toContain("diagnostics/nested/inner.json");
      expect(await readFile(join(preserved.dir, "diagnostics", "top.json"), "utf8")).toBe('{"a":1}\n');
      expect(await readFile(join(preserved.dir, "diagnostics", "nested", "inner.json"), "utf8")).toBe('{"b":2}\n');
      const record = await readRecord(preserved.dir);
      // Deterministic (sorted) manifest: "nested/..." sorts before "top.json".
      expect(record.evidence.diagnostics.copied).toEqual(["nested/inner.json", "top.json"]);
      expect(record.evidence.diagnostics.copiedCount).toBe(2);
      expect(record.evidence.diagnostics.entries).toEqual([]);
    } finally {
      await rm(preserved.dir, { recursive: true, force: true });
    }
  });

  it("F: a non-regular entry is SKIPPED — never counted as a copied file, and never degrading integrity", async () => {
    const src = await tempDir("e4-r65-skip-");
    await writeFile(join(src, "real.json"), "{}\n", "utf8");
    const link = join(src, "link.json");
    let linkUsable = false;
    try {
      await symlink(join(src, "real.json"), link);
      // The sandbox sometimes makes `fs.symlink` a SILENT no-op, so verify that
      // a link really exists instead of trusting the absence of a throw.
      linkUsable = (await lstat(link)).isSymbolicLink();
    } catch (err) {
      reportDegraded("e4-r65 symlink fixture unavailable in this environment", err);
    }
    if (!linkUsable) {
      // The agent sandbox blocks (or silently ignores) symlink creation, so the
      // skip branch can only be exercised on real CI, which allows links. Here we
      // assert the weaker invariant that no skipped entry can appear among the
      // copies — and that the archive still reports a complete regular-file copy.
      const preserved = await preserve(src, "r65-skip-fallback");
      try {
        const record = await readRecord(preserved.dir);
        expect(record.evidence.diagnostics.copied).toEqual(["real.json"]);
        expect(record.evidence.diagnostics.entries.every((e) => e.status !== "copied")).toBe(true);
        expect(record.evidence.diagnostics.integrity).toBe("complete");
      } finally {
        await rm(preserved.dir, { recursive: true, force: true });
      }
      return;
    }
    const preserved = await preserve(src, "r65-skip");
    try {
      const record = await readRecord(preserved.dir);
      expect(record.evidence.diagnostics.copied).toEqual(["real.json"]);
      const skipped = record.evidence.diagnostics.entries.find((e) => e.status === "skipped");
      expect(skipped?.path).toBe("link.json");
      expect(skipped?.reason).toContain("not followed");
      // Not following a link is policy, not failure.
      expect(record.evidence.diagnostics.integrity).toBe("complete");
      expect(preserved.files).not.toContain("diagnostics/link.json");
    } finally {
      await rm(preserved.dir, { recursive: true, force: true });
    }
  });

  it("G: an unusable archive ROOT is reported as archive-failed, never as a downloadable location", async () => {
    const holder = join(await tempDir("e4-r65-root-"), "a-file");
    await writeFile(holder, "not a directory\n", "utf8");
    const previous = process.env.E4_R55_PARENT_DIAG_DIR;
    process.env.E4_R55_PARENT_DIAG_DIR = join(holder, "child");
    try {
      const preserved = await preserve(undefined, "r65-archive-failed");
      expect(preserved.ok).toBe(false);
      expect(preserved.archiveIntegrity).toBe("archive-failed");
      expect(preserved.error).toBeTruthy();
      expect(preserved.files).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.E4_R55_PARENT_DIAG_DIR;
      else process.env.E4_R55_PARENT_DIAG_DIR = previous;
    }
  });

  it("H: the ORIGINAL failure reasons survive every archive outcome", async () => {
    const cases: (string | undefined)[] = [undefined, await tempDir("e4-r65-reasons-")];
    for (const [index, diagDir] of cases.entries()) {
      const preserved = await preserve(diagDir, `r65-reasons-${index}`);
      try {
        expect(preserved.ok).toBe(true);
        const record = await readRecord(preserved.dir);
        expect(record.reasons).toEqual(["probe: the ORIGINAL business failure must survive"]);
      } finally {
        await rm(preserved.dir, { recursive: true, force: true });
      }
    }
  });

  it("I: after the source is gone, the archive ALONE still distinguishes empty / missing / partial", async () => {
    const parent = await tempDir("e4-r65-distinguish-");
    const emptySrc = join(parent, "empty");
    const missingSrc = join(parent, "missing");
    await mkdir(emptySrc, { recursive: true });

    const emptyArchive = await preserve(emptySrc, "r65-dist-empty");
    const missingArchive = await preserve(missingSrc, "r65-dist-missing");
    try {
      // The sources are already irrelevant to the verdicts; assert the archives
      // still answer the question without them.
      const empty = await readRecord(emptyArchive.dir);
      const missing = await readRecord(missingArchive.dir);
      expect(empty.evidence.diagnostics.integrity).toBe("complete");
      expect(empty.evidence.diagnostics.empty).toBe(true);
      expect(missing.evidence.diagnostics.integrity).toBe("missing");
      expect(missing.evidence.diagnostics.sourceMissing).toBe(true);
      expect(empty.evidence.diagnostics.integrity).not.toBe(missing.evidence.diagnostics.integrity);
    } finally {
      await rm(emptyArchive.dir, { recursive: true, force: true });
      await rm(missingArchive.dir, { recursive: true, force: true });
    }
  });
});

describe("E4-R67 archive integrity vs diagnostics-copy integrity", () => {
  interface ArchiveRecord {
    reasons: string[];
    report: { kind: string; error: string | null };
    capture: { stdout: StreamCapture; stderr: StreamCapture };
    evidence: {
      diagnostics: { integrity: string; copied: string[] };
      archive: { integrity: string; roles: EvidenceRoleRecord[]; failedRoles: string[] };
    };
  }

  /** Fail exactly ONE role's write with a real errno-shaped error. */
  const seamFailingWrite = (fileName: string, code: string): EvidenceSeam => ({
    writeFile: async (path: string, data: string) => {
      if (path.endsWith(fileName)) {
        const err = new Error(`${code}: injected write failure for ${fileName}`) as Error & {
          code?: string;
        };
        err.code = code;
        throw err;
      }
      await writeFile(path, data, "utf8");
    },
  });

  const preserve = async (
    over: Partial<PreserveEvidenceInput>,
  ): Promise<PreservedEvidence> =>
    preserveEvidence({
      label: "r67-archive",
      outcome: syntheticOutcome({ stdout: "hello", stderr: "warn" }),
      report: { path: "child-report.json", kind: "ok", error: null, results: [], rawText: '{"ok":1}\n' },
      reasons: ["probe: the ORIGINAL business failure must survive"],
      ...over,
    });

  const readRecord = async (dir: string): Promise<ArchiveRecord> =>
    JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as ArchiveRecord;

  const roleOf = (roles: EvidenceRoleRecord[], role: string): EvidenceRoleRecord | undefined =>
    roles.find((r) => r.role === role);

  it("A: every requested role succeeds — complete, and the role list matches the disk", async () => {
    const diag = await tempDir("e4-r67-diag-");
    await writeFile(join(diag, "bundle.json"), "{}\n", "utf8");
    const preserved = await preserve({ diagDir: diag });
    try {
      expect(preserved.ok).toBe(true);
      expect(preserved.archiveIntegrity).toBe("complete");
      expect(preserved.diagnosticsCopyIntegrity).toBe("complete");
      expect(preserved.roles.map((r) => r.status)).toEqual(["written", "written", "written"]);
      expect(preserved.files).toContain("child.stdout.txt");
      expect(preserved.files).toContain("child.stderr.txt");
      expect(preserved.files).toContain("child-report.json");
      expect(preserved.files).toContain("run.json");
      // writtenBytes is a DISK fact: check it against the real file sizes.
      for (const role of preserved.roles) {
        expect(role.path).not.toBeNull();
        expect((await stat(join(preserved.dir, role.path!))).size).toBe(role.writtenBytes);
      }
      expect((await stat(join(preserved.dir, "child.stdout.txt"))).size).toBe(5);
    } finally {
      await rm(preserved.dir, { recursive: true, force: true });
    }
  });

  it("B: an EIO on stdout makes the ARCHIVE partial even though the diagnostics copy is complete", async () => {
    const diag = await tempDir("e4-r67-diag-b-");
    await writeFile(join(diag, "bundle.json"), "{}\n", "utf8");
    const preserved = await preserve({ diagDir: diag, seam: seamFailingWrite("child.stdout.txt", "EIO") });
    try {
      expect(preserved.ok).toBe(true); // a readable archive still exists
      expect(preserved.archiveIntegrity).toBe("partial"); // ... but it is NOT complete
      expect(preserved.diagnosticsCopyIntegrity).toBe("complete"); // the narrow layer is fine
      expect(preserved.files).not.toContain("child.stdout.txt");

      const stdoutRole = roleOf(preserved.roles, "stdout");
      expect(stdoutRole?.status).toBe("failed");
      expect(stdoutRole?.operation).toBe("writeFile");
      expect(stdoutRole?.errorCode).toBe("EIO");
      expect(stdoutRole?.writtenBytes).toBeNull();
      expect(stdoutRole?.reason).toContain("EIO");

      // The other roles survived and are readable.
      expect(await readFile(join(preserved.dir, "child.stderr.txt"), "utf8")).toBe("warn");
      expect(await readFile(join(preserved.dir, "child-report.json"), "utf8")).toBe('{"ok":1}\n');
      expect(await readFile(join(preserved.dir, "diagnostics", "bundle.json"), "utf8")).toBe("{}\n");

      const record = await readRecord(preserved.dir);
      expect(record.evidence.archive.integrity).toBe("partial");
      expect(record.evidence.archive.failedRoles).toEqual(["stdout"]);
      expect(record.evidence.archive.roles.find((r) => r.role === "stdout")?.errorCode).toBe("EIO");
    } finally {
      await rm(preserved.dir, { recursive: true, force: true });
    }
  });

  it("C: an EACCES on stderr names the stderr role, not stdout", async () => {
    const preserved = await preserve({ seam: seamFailingWrite("child.stderr.txt", "EACCES") });
    try {
      expect(preserved.archiveIntegrity).toBe("partial");
      expect(preserved.diagnosticsCopyIntegrity).toBe("not-requested");
      const record = await readRecord(preserved.dir);
      expect(record.evidence.archive.failedRoles).toEqual(["stderr"]);
      expect(roleOf(record.evidence.archive.roles, "stderr")?.errorCode).toBe("EACCES");
      expect(roleOf(record.evidence.archive.roles, "stdout")?.status).toBe("written");
    } finally {
      await rm(preserved.dir, { recursive: true, force: true });
    }
  });

  it("D: a failed RAW-REPORT write is reported as a write failure, never as a missing source report", async () => {
    const preserved = await preserve({ seam: seamFailingWrite("child-report.json", "EIO") });
    try {
      const record = await readRecord(preserved.dir);
      const role = roleOf(record.evidence.archive.roles, "raw-report");
      expect(role?.status).toBe("failed");
      expect(role?.requested).toBe(true);
      expect(role?.errorCode).toBe("EIO");
      expect(record.evidence.archive.failedRoles).toEqual(["raw-report"]);
      // The source report's own state is untouched — it was NOT missing.
      expect(record.report.kind).toBe("ok");
      expect(record.report.error).toBeNull();
      expect(preserved.archiveIntegrity).toBe("partial");
    } finally {
      await rm(preserved.dir, { recursive: true, force: true });
    }
  });

  it("E: rawText=null is 'not-requested' — not a fake success and not an unconditional failure", async () => {
    const preserved = await preserve({
      report: { path: "child-report.json", kind: "missing", error: "ENOENT", results: [], rawText: null },
    });
    try {
      const record = await readRecord(preserved.dir);
      const role = roleOf(record.evidence.archive.roles, "raw-report");
      expect(role?.status).toBe("not-requested");
      expect(role?.requested).toBe(false);
      expect(role?.path).toBeNull();
      expect(role?.writtenBytes).toBeNull();
      expect(role?.reason).toContain("report.kind=missing");
      // Not a failure: the archive is still complete for what was requested.
      expect(record.evidence.archive.integrity).toBe("complete");
      expect(record.report.kind).toBe("missing"); // the real kind is preserved
      expect(preserved.files).not.toContain("child-report.json");
    } finally {
      await rm(preserved.dir, { recursive: true, force: true });
    }
  });

  it("F: successful logs must NOT cover a missing diagnostics dir — the two layers stay separate", async () => {
    const missing = join(await tempDir("e4-r67-parent-"), "gone");
    const preserved = await preserve({ diagDir: missing });
    try {
      expect(preserved.diagnosticsCopyIntegrity).toBe("missing");
      expect(preserved.archiveIntegrity).toBe("partial");
      const record = await readRecord(preserved.dir);
      expect(record.evidence.diagnostics.integrity).toBe("missing");
      expect(record.evidence.archive.integrity).toBe("partial");
      expect(record.evidence.archive.failedRoles).toEqual([]); // no ROLE failed...
      expect(roleOf(record.evidence.archive.roles, "stdout")?.status).toBe("written");
    } finally {
      await rm(preserved.dir, { recursive: true, force: true });
    }
  });

  it("G: a failed run.json write stays archive-failed and never claims a readable archive", async () => {
    const preserved = await preserve({ seam: seamFailingWrite("run.json", "EIO") });
    try {
      expect(preserved.ok).toBe(false);
      expect(preserved.archiveIntegrity).toBe("archive-failed");
      expect(preserved.error).toContain("EIO");
      // `dir` is a LEFTOVER, not a successful archive.
      expect(existsSync(join(preserved.dir, "run.json"))).toBe(false);
      expect(preserved.files).not.toContain("run.json");
      // The role outcomes are still returned, so the caller can explain itself.
      expect(preserved.roles.map((r) => r.status)).toEqual(["written", "written", "written"]);
    } finally {
      await rm(preserved.dir, { recursive: true, force: true });
    }
  });

  it("H: after the source is gone, run.json ALONE still recovers the top-level write error", async () => {
    const diag = await tempDir("e4-r67-diag-h-");
    await writeFile(join(diag, "bundle.json"), "{}\n", "utf8");
    const preserved = await preserve({ diagDir: diag, seam: seamFailingWrite("child.stdout.txt", "EIO") });
    try {
      // Delete every source we copied from, leaving only the archive.
      await rm(diag, { recursive: true, force: true });
      const record = await readRecord(preserved.dir);
      const role = roleOf(record.evidence.archive.roles, "stdout");
      expect(role?.status).toBe("failed");
      expect(role?.operation).toBe("writeFile");
      expect(role?.errorCode).toBe("EIO");
      expect(role?.reason).toContain("injected write failure");
      expect(record.evidence.archive.integrity).toBe("partial");
      expect(record.reasons).toEqual(["probe: the ORIGINAL business failure must survive"]);
      // capture.*.capturedBytes is an IN-MEMORY number and must not be readable
      // as "5 bytes are on disk".
      expect(record.capture.stdout.capturedBytes).toBe(5);
      expect(role?.writtenBytes).toBeNull();
    } finally {
      await rm(preserved.dir, { recursive: true, force: true });
    }
  });
});

/**
 * E4-R68: probe ONCE whether this environment can really create a symlink.
 *
 * The agent sandbox was measured to make `fs.symlink` a SILENT no-op (no throw,
 * no link). Presenting that as "the link branch passed" would be a false claim,
 * so the platform-real link test is explicitly SKIPPED when this probe fails,
 * and the probe's own result is asserted by a test that always runs.
 */
const R68_SYMLINK_CAPABILITY = await (async (): Promise<{ ok: boolean; detail: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "e4-r68-capability-"));
  try {
    const target = join(dir, "target.txt");
    const link = join(dir, "link.txt");
    await writeFile(target, "x", "utf8");
    await symlink(target, link);
    const isLink = await lstat(link).then(
      (s) => s.isSymbolicLink(),
      () => false,
    );
    return isLink
      ? { ok: true, detail: "fs.symlink created a link that lstat reports as a symlink" }
      : { ok: false, detail: "fs.symlink did not throw but created no link (silent no-op)" };
  } catch (err) {
    return {
      ok: false,
      detail: `fs.symlink failed: ${(err as { code?: string }).code ?? messageOf(err)}`,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})();

describe("E4-R68 mixed-copy and link-skip acceptance", () => {
  interface R68Record {
    evidence: {
      diagnostics: { integrity: string; copied: string[]; entries: CopyEntry[] };
      archive: { integrity: string };
    };
  }

  /** A Dirent that is neither a directory nor a regular file. */
  const fakeNonRegular = (name: string): Dirent =>
    ({
      name,
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => true,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    }) as unknown as Dirent;

  /**
   * A seam that (a) fixes the traversal ORDER so the "first / last visited"
   * cases are deterministic, and (b) fails exactly ONE named copy with EIO while
   * every other copy runs for real.
   */
  const orderedFailingCopy = (failOn: string, order: string[]) => {
    const attempted: string[] = [];
    const seam: EvidenceSeam = {
      readdir: async (dir: string) => {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
      },
      copyFile: async (from: string, to: string) => {
        const name = basename(from);
        attempted.push(name);
        if (name === failOn) {
          const err = new Error(`EIO: injected copy failure for ${name}`) as Error & {
            code?: string;
          };
          err.code = "EIO";
          throw err;
        }
        await copyFile(from, to);
      },
    };
    return { seam, attempted };
  };

  const preserve = async (over: Partial<PreserveEvidenceInput>): Promise<PreservedEvidence> =>
    preserveEvidence({
      label: "r68",
      outcome: syntheticOutcome(),
      report: syntheticReport([]),
      reasons: ["probe: the original failure"],
      ...over,
    });

  const readRecord = async (dir: string): Promise<R68Record> =>
    JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as R68Record;

  it("A: in ONE tree a real copy SUCCEEDS while an injected EIO copy FAILS", async () => {
    const src = await tempDir("e4-r68-mixed-");
    await writeFile(join(src, "good.json"), '{"good":true}\n', "utf8");
    await writeFile(join(src, "bad.json"), '{"bad":true}\n', "utf8");
    const { seam } = orderedFailingCopy("bad.json", ["good.json", "bad.json"]);
    const preserved = await preserve({ diagDir: src, seam });
    try {
      expect(preserved.diagnosticsCopyIntegrity).toBe("partial");
      expect(preserved.archiveIntegrity, "the whole archive is not complete either").toBe("partial");
      // The successful copy is REAL and byte-identical to its source.
      expect(await readFile(join(preserved.dir, "diagnostics", "good.json"), "utf8")).toBe(
        '{"good":true}\n',
      );
      expect(preserved.files).toContain("diagnostics/good.json");
      expect(preserved.files).not.toContain("diagnostics/bad.json");

      const record = await readRecord(preserved.dir);
      expect(record.evidence.diagnostics.copied).toEqual(["good.json"]);
      const bad = record.evidence.diagnostics.entries.find((e) => e.path === "bad.json");
      expect(bad?.status).toBe("unreadable");
      expect(bad?.operation).toBe("copyFile");
      expect(bad?.errorCode).toBe("EIO");
      expect(bad?.reason).toContain("injected copy failure");
      // The failed file is never counted as copied.
      expect(record.evidence.diagnostics.copied).not.toContain("bad.json");
    } finally {
      await rm(preserved.dir, { recursive: true, force: true });
    }
  });

  it("B: after the SOURCE is deleted, the archive alone still proves success AND failure", async () => {
    const src = await tempDir("e4-r68-recover-");
    await writeFile(join(src, "good.json"), '{"good":true}\n', "utf8");
    await writeFile(join(src, "bad.json"), '{"bad":true}\n', "utf8");
    const { seam } = orderedFailingCopy("bad.json", ["good.json", "bad.json"]);
    const preserved = await preserve({ diagDir: src, seam });
    try {
      await rm(src, { recursive: true, force: true });
      const record = await readRecord(preserved.dir);
      expect(record.evidence.diagnostics.copied).toEqual(["good.json"]);
      expect(
        record.evidence.diagnostics.entries.find((e) => e.path === "bad.json")?.errorCode,
      ).toBe("EIO");
      expect(record.evidence.diagnostics.integrity).toBe("partial");
      // The archived copy is still readable and its digest independently recomputes.
      const archived = await readFile(join(preserved.dir, "diagnostics", "good.json"));
      expect(archived.toString("utf8")).toBe('{"good":true}\n');
      expect(createHash("sha256").update(archived).digest("hex")).toBe(
        createHash("sha256").update('{"good":true}\n').digest("hex"),
      );
    } finally {
      await rm(preserved.dir, { recursive: true, force: true });
    }
  });

  it("C: a failure on the FIRST-visited file does not block the LATER copies", async () => {
    const src = await tempDir("e4-r68-first-");
    for (const n of ["a.json", "b.json", "c.json"]) {
      await writeFile(join(src, n), `${n}\n`, "utf8");
    }
    const { seam, attempted } = orderedFailingCopy("a.json", ["a.json", "b.json", "c.json"]);
    const preserved = await preserve({ diagDir: src, seam });
    try {
      // Deterministic traversal order: the seam pins it, so this is not incidental.
      expect(attempted).toEqual(["a.json", "b.json", "c.json"]);
      const record = await readRecord(preserved.dir);
      expect(record.evidence.diagnostics.copied).toEqual(["b.json", "c.json"]);
      expect(await readFile(join(preserved.dir, "diagnostics", "b.json"), "utf8")).toBe("b.json\n");
      expect(await readFile(join(preserved.dir, "diagnostics", "c.json"), "utf8")).toBe("c.json\n");
      // The failure is still recorded with its path, operation and error.
      expect(record.evidence.diagnostics.integrity).toBe("partial");
      const failed = record.evidence.diagnostics.entries.find((e) => e.path === "a.json");
      expect(failed?.status).toBe("unreadable");
      expect(failed?.operation).toBe("copyFile");
      expect(failed?.errorCode).toBe("EIO");
    } finally {
      await rm(preserved.dir, { recursive: true, force: true });
    }
  });

  it("D: a failure on the LAST-visited file does not lose the EARLIER copies", async () => {
    const src = await tempDir("e4-r68-last-");
    for (const n of ["a.json", "b.json", "c.json"]) {
      await writeFile(join(src, n), `${n}\n`, "utf8");
    }
    const { seam, attempted } = orderedFailingCopy("c.json", ["a.json", "b.json", "c.json"]);
    const preserved = await preserve({ diagDir: src, seam });
    try {
      expect(attempted).toEqual(["a.json", "b.json", "c.json"]);
      const record = await readRecord(preserved.dir);
      expect(record.evidence.diagnostics.copied).toEqual(["a.json", "b.json"]);
      expect(await readFile(join(preserved.dir, "diagnostics", "a.json"), "utf8")).toBe("a.json\n");
      expect(await readFile(join(preserved.dir, "diagnostics", "b.json"), "utf8")).toBe("b.json\n");
      // Symmetric to case C: the LAST failure is recorded too.
      expect(record.evidence.diagnostics.integrity).toBe("partial");
      const failed = record.evidence.diagnostics.entries.find((e) => e.path === "c.json");
      expect(failed?.status).toBe("unreadable");
      expect(failed?.operation).toBe("copyFile");
      expect(failed?.errorCode).toBe("EIO");
    } finally {
      await rm(preserved.dir, { recursive: true, force: true });
    }
  });

  it("E: the SKIP branch itself — a non-regular entry, deterministically, with no symlink privilege", async () => {
    const src = await tempDir("e4-r68-skip-branch-");
    await writeFile(join(src, "real.json"), '{"real":true}\n', "utf8");
    const seam: EvidenceSeam = {
      readdir: async (dir: string) => {
        const entries = await readdir(dir, { withFileTypes: true });
        if (dir === src) entries.push(fakeNonRegular("ghost.link"));
        return entries;
      },
    };
    const preserved = await preserve({ diagDir: src, seam });
    try {
      const record = await readRecord(preserved.dir);
      // The real file was copied for real.
      expect(record.evidence.diagnostics.copied).toEqual(["real.json"]);
      expect(await readFile(join(preserved.dir, "diagnostics", "real.json"), "utf8")).toBe(
        '{"real":true}\n',
      );
      // The non-regular entry is classified as skipped, carries a reason, and is
      // NEVER listed as a copied file.
      const skipped = record.evidence.diagnostics.entries.find((e) => e.path === "ghost.link");
      expect(skipped?.status).toBe("skipped");
      expect(skipped?.reason).toContain("not followed");
      expect(skipped?.reason).toContain("symbolic link");
      expect(preserved.files).not.toContain("diagnostics/ghost.link");
      expect(existsSync(join(preserved.dir, "diagnostics", "ghost.link"))).toBe(false);
      // Policy, not failure: regular-file integrity is untouched.
      expect(record.evidence.diagnostics.integrity).toBe("complete");
      expect(record.evidence.archive.integrity).toBe("complete");
    } finally {
      await rm(preserved.dir, { recursive: true, force: true });
    }
  });

  it("F: this environment's real-symlink capability is a recorded fact, not an assumption", () => {
    process.stdout.write(`\nR68_SYMLINK_CAPABILITY=${JSON.stringify(R68_SYMLINK_CAPABILITY)}\n`);
    expect(typeof R68_SYMLINK_CAPABILITY.ok).toBe("boolean");
    expect(R68_SYMLINK_CAPABILITY.detail.length).toBeGreaterThan(0);
  });

  it.skipIf(!R68_SYMLINK_CAPABILITY.ok)(
    "G: a REAL symlink is not followed and lands in the skipped list (platform-real)",
    async () => {
      const src = await tempDir("e4-r68-real-link-");
      const target = join(src, "target.json");
      await writeFile(target, '{"target":true}\n', "utf8");
      const link = join(src, "link.json");
      await symlink(target, link);
      // PRECONDITION: the link must really exist, otherwise this test would be
      // asserting nothing (a silent no-op `fs.symlink` is a known hazard here).
      expect((await lstat(link)).isSymbolicLink(), "precondition: the symlink must exist").toBe(true);

      const preserved = await preserve({ diagDir: src });
      try {
        const record = await readRecord(preserved.dir);
        // Record the PLATFORM's own classification instead of assuming it: a
        // filesystem that does not surface the link as a link to `readdir` cannot
        // express the no-follow policy, and that must be visible, not hidden.
        const linkDirent = (await readdir(src, { withFileTypes: true })).find(
          (e) => e.name === "link.json",
        );
        expect(linkDirent, "precondition: the link must be listed").toBeDefined();
        process.stdout.write(
          `\nR68_LINK_DIRENT=${JSON.stringify({
            isSymbolicLink: linkDirent?.isSymbolicLink() ?? null,
            isFile: linkDirent?.isFile() ?? null,
          })}\n`,
        );

        if (linkDirent?.isSymbolicLink() === true) {
          // The intended branch: not followed, not copied, listed as skipped.
          expect(record.evidence.diagnostics.copied).toEqual(["target.json"]);
          const skipped = record.evidence.diagnostics.entries.find((e) => e.path === "link.json");
          expect(skipped?.status).toBe("skipped");
          expect(skipped?.reason).toContain("not followed");
          expect(existsSync(join(preserved.dir, "diagnostics", "link.json"))).toBe(false);
          expect(preserved.files).not.toContain("diagnostics/link.json");
          expect(record.evidence.diagnostics.integrity).toBe("complete");
        } else {
          // This platform reports the link as a regular file, so copyTree
          // legitimately treats it as one. Assert THAT, and say so out loud.
          expect(record.evidence.diagnostics.copied).toContain("link.json");
          expect(
            record.evidence.diagnostics.entries.find((e) => e.path === "link.json"),
          ).toBeUndefined();
        }
      } finally {
        await rm(preserved.dir, { recursive: true, force: true });
      }
    },
  );
});

describe("E4-R70 cleanup verification is ownership-based", () => {
  /** A root that only THIS suite creates and only THIS suite cleans. */
  const freshRoot = (prefix: string): Promise<string> => tempDir(prefix);

  const mkdirp = async (p: string): Promise<void> => {
    await mkdir(p, { recursive: true });
  };
  const remove = async (p: string): Promise<void> => rm(p, { recursive: true, force: true });
  const digestOf = async (p: string): Promise<string> =>
    createHash("sha256").update(await readFile(p)).digest("hex");

  it("A: this run's directories are gone and nothing else is present — verified", async () => {
    const root = await freshRoot("e4-r70-a-");
    const owned = [join(root, "run-one"), join(root, "run-two")];
    for (const d of owned) await mkdirp(d);
    for (const d of owned) await remove(d);

    expect(await verifyOwnedCleanup(owned)).toEqual([]);
    expect(await listForeignEntries(root, owned)).toEqual([]);
  });

  it("B: a FOREIGN historical leftover does not fail this run, and its bytes are untouched", async () => {
    const root = await freshRoot("e4-r70-b-");
    const mine = join(root, "run-mine");
    const owned = [mine];
    await mkdirp(mine);
    // The exact shape R69 recorded as causing a same-version suite failure.
    const foreign = join(root, "run-YtCeW3");
    await mkdirp(foreign);
    const marker = join(foreign, "diagnostic.json");
    await writeFile(marker, '{"historical":true}\n', "utf8");
    const before = await digestOf(marker);

    await remove(mine);

    expect(await verifyOwnedCleanup(owned), "a foreign dir is NOT our cleanup failure").toEqual([]);
    expect(await listForeignEntries(root, owned)).toEqual(["run-YtCeW3"]);
    expect(await digestOf(marker), "foreign content must be byte-identical").toBe(before);
    expect(existsSync(foreign)).toBe(true);

    // DISCRIMINATING: the pre-R70 rule ("the shared root must be EMPTY") fails on
    // this very fixture — which is exactly why ownership is the right predicate.
    expect(await readdir(root), "the old global rule would have failed here").not.toEqual([]);
  });

  it("C: another run's ACTIVE directory is neither a failure nor cleaned", async () => {
    const root = await freshRoot("e4-r70-c-");
    const mine = join(root, "run-mine");
    const owned = [mine];
    await mkdirp(mine);

    // A second "run" holds this directory for the WHOLE duration of our cleanup:
    // an open handle keeps it genuinely in use, so "it existed while we cleaned"
    // is a fact and not a timing assumption.
    const active = join(root, "run-other-active");
    await mkdirp(active);
    const activeMarker = join(active, "in-flight.json");
    await writeFile(activeMarker, '{"active":true}\n', "utf8");
    const hold = await open(activeMarker, "r");
    try {
      expect(existsSync(active), "the active dir must exist before our cleanup").toBe(true);
      await remove(mine);
      const reasons = await verifyOwnedCleanup(owned);
      const foreign = await listForeignEntries(root, owned);

      expect(reasons).toEqual([]);
      expect(foreign).toEqual(["run-other-active"]);
      expect(existsSync(active), "the active dir must survive our cleanup").toBe(true);
      expect(await readFile(activeMarker, "utf8")).toBe('{"active":true}\n');
    } finally {
      await hold.close();
    }
  });

  it("D: a LEAKED owned directory fails the acceptance and is named", async () => {
    const root = await freshRoot("e4-r70-d-");
    const leaked = join(root, "run-leaked");
    const cleaned = join(root, "run-cleaned");
    await mkdirp(leaked);
    await mkdirp(cleaned);
    await remove(cleaned);

    const reasons = await verifyOwnedCleanup([leaked, cleaned]);
    expect(reasons, "only the leaked one is a reason").toHaveLength(1);
    expect(reasons[0]).toContain(leaked);
    expect(reasons[0]).toContain("NOT cleaned up");
    // A leaked OWN directory is ours — it must never be reported as foreign.
    expect(await listForeignEntries(root, [leaked, cleaned])).toEqual([]);
  });

  it.skipIf(!R68_SYMLINK_CAPABILITY.ok)(
    "E: a DANGLING link at the owned path is a leftover, not a successful cleanup",
    async () => {
      const root = await freshRoot("e4-r70-e-");
      const link = join(root, "run-dangling");
      await symlink(join(root, "no-such-target"), link);
      // PRECONDITION: a real dangling link, not a silent no-op.
      expect((await lstat(link)).isSymbolicLink()).toBe(true);

      // lstat (not stat) is what makes this work: the link itself is the leftover.
      expect((await probePathState(link)).state).toBe("present");
      const reasons = await verifyOwnedCleanup([link]);
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toContain("NOT cleaned up");
    },
  );

  it("F: an unreadable probe is UNKNOWN — never certified as a successful cleanup", async () => {
    const root = await freshRoot("e4-r70-f-");
    const mine = join(root, "run-unreadable");
    const owned = [mine];
    await mkdirp(mine);
    await remove(mine);

    for (const code of ["EACCES", "EIO"]) {
      const failing: LstatLike = async () => {
        const err = new Error(`${code}: injected probe failure`) as Error & { code?: string };
        err.code = code;
        throw err;
      };
      expect((await probePathState(mine, failing)).state, `code=${code}`).toBe("unknown");
      const reasons = await verifyOwnedCleanup(owned, failing);
      expect(reasons, `code=${code}`).toHaveLength(1);
      expect(reasons[0]).toContain("could not be CONFIRMED");
      expect(reasons[0]).toContain(code);

      // DISCRIMINATING: the pre-R70 shape swallowed the error into an empty list
      // (or into "absent") and therefore PASSED. That is the defect, not a fix.
      const swallow = async (): Promise<PathState> => {
        try {
          await failing(mine);
          return "present";
        } catch {
          return "absent"; // the old, wrong classification
        }
      };
      expect(await swallow()).toBe("absent");
      expect(reasons).toHaveLength(1);
    }

    // A REAL parent-constraint hazard: the parent is a FILE. Windows has no
    // ENOTDIR (it reports ENOENT — measured here), so the parent probe is what
    // stops "not found" from being read as "cleaned up".
    const aFile = join(root, "a-file");
    await writeFile(aFile, "x\n", "utf8");
    const notUnderADir = await probePathState(join(aFile, "child"));
    expect(notUnderADir.state, "a file as parent must NOT read as 'absent'").toBe("unknown");
    expect(notUnderADir.operation).toBe("lstat(parent)");
    expect(notUnderADir.reason).toContain("not a directory");

    // And ENOENT under a real directory IS absent.
    expect((await probePathState(join(root, "never-existed"))).state).toBe("absent");
  });

  it("G: a directory allocated BEFORE a later init failure is still tracked and verified", async () => {
    const before = ownedRunDirs.length;
    let allocated: string | undefined;
    try {
      allocated = await allocateOwnedRunDir();
      throw new Error("simulated init failure AFTER allocation");
    } catch {
      // Exactly what `runChild`'s catch path does for an early failure.
      if (allocated !== undefined) await remove(allocated);
    }
    const mine = ownedRunDirs.slice(before);
    expect(mine, "ownership must be recorded at ALLOCATION, not after success").toEqual([allocated]);
    expect(await verifyOwnedCleanup(mine)).toEqual([]);
  });

  it("H: a cleanup failure and the ORIGINAL chain failure are both preserved", async () => {
    const root = await freshRoot("e4-r70-h-");
    const leaked = join(root, "run-leaked");
    await mkdirp(leaked);

    const chainReasons = ["the real chain failed: decision-artifact was never persisted"];
    const cleanupReasons = await verifyOwnedCleanup([leaked]);
    expect(cleanupReasons).toHaveLength(1);

    // The exact combined shape the parent verifier now asserts.
    const combined = [...chainReasons, ...cleanupReasons];
    expect(combined).toHaveLength(2);
    expect(combined[0]).toContain("chain failed");
    expect(combined[1]).toContain("NOT cleaned up");
  });
});
