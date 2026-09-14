/**
 * E4-R55 (F55) — PARENT VERIFIER for the real production failure-wiring.
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
 * PRECONDITION — a clean working tree. The production benchmark refuses to
 * produce a promotion-eligible run on a tree that is not provably clean, so a
 * dirty tree makes every child case fail for an unrelated reason. That is
 * detected up front and reported explicitly instead of being mistaken for a
 * wiring defect.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { mutateChainOrdering, rewriteChainRelativeImport } from "./e4-09-real-chain.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const VITEST_BIN = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const CHILD_CONFIG = "apps/cli/test-infra/r55-vitest.config.ts";
const REAL_CHAIN = join(REPO_ROOT, "apps/cli", "src", "e4-09-real-chain.ts");
const REAL_DIAGNOSTICS = join(REPO_ROOT, "apps/cli", "src", "e4-09-diagnostics.ts");
/**
 * E4-R59 (G59): per-run mutation copies live here — OUTSIDE `apps/cli/tsconfig.json`'s
 * `include: ["src"]` (so never part of the production compile input) and outside
 * the root Vitest `include` (`apps/*\/src/**\/*.test.ts`). Each parent run gets its
 * own `mkdtemp` directory, so two concurrent runs can never share a path.
 */
const RUNS_ROOT = join(REPO_ROOT, "apps", "cli", "test-infra", "e4-r55-runs");
/** The pre-R59 fixed path. Narrow migration guard only — see `afterAll`. */
const LEGACY_GENERATED = join(REPO_ROOT, "apps", "cli", "src", "e4-r55-mutated-chain.generated.ts");

const NONACCEPT_TITLE =
  "R55 nonaccept: a REAL non-ACCEPT decision is persisted with its reasonCodes before the ACCEPT assert";
const SUCCESS_TITLE = "R55 success: a fully ACCEPTed chain produces NO failure bundle";
const THROW_TITLE =
  "R55 evaluator-throw: the injected fault keeps stage=evaluate and leaves the decision missing";
const BENCHFAIL_TITLE =
  "R55 benchmark-fail: the original benchmark exit and the missing output roles are visible";

let tempDirs: string[] = [];
afterAll(async () => {
  // E4-R59: NARROW migration guard for the pre-R59 fixed path only. A leftover
  // there would sit inside the production compile input, so it is removed if (and
  // only if) it exists. No batch deletion, no wildcard, no source scanning.
  await rm(LEGACY_GENERATED, { force: true }).catch(() => {});
  for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
  // Remove the runs root only if this run left it empty.
  await rm(RUNS_ROOT, { recursive: false, force: true }).catch(() => {});
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

interface ChildRun {
  exitCode: number | null;
  diagDir: string;
  bundles: Bundle[];
  results: { title: string; status: string }[];
  /** The chain module THIS run was bound to (path + digest). */
  chain: ChainModuleRef;
}

async function readBundles(diagDir: string): Promise<Bundle[]> {
  const out: Bundle[] = [];
  for (const entry of await readdir(diagDir)) {
    const dir = join(diagDir, entry);
    try {
      const parsed = JSON.parse(await readFile(join(dir, "diagnostic.json"), "utf8")) as Omit<Bundle, "dir">;
      out.push({ ...parsed, dir });
    } catch {
      // a directory without a readable bundle is not evidence of anything
    }
  }
  return out;
}

/** A chain module bound to one child run: where it lives and its digest. */
interface ChainModuleRef {
  path: string;
  sha256: string;
}

/**
 * E4-R59 (G59) — select the chain module for ONE run.
 *
 *   - `"real"`    -> the repository's own module; no copy is created at all.
 *   - `"mutated"` -> a fresh copy of the real module with the decision-save block
 *                    moved after the ACCEPT assert, written into a PER-RUN
 *                    directory outside the production compile input and outside
 *                    the default Vitest include. Its single relative import is
 *                    rewritten so the copy still loads the REAL diagnostics
 *                    module — not a stub, not a standalone fake implementation.
 *
 * The returned path is handed to the child through `E4_R55_CHAIN_MODULE`, which
 * the child config binds with an alias. The child loads exactly this path or
 * fails before running a test; nothing scans for "the newest file".
 */
async function prepareChainModule(runDir: string, mode: "real" | "mutated"): Promise<ChainModuleRef> {
  if (mode === "real") {
    return { path: REAL_CHAIN, sha256: sha256(await readFile(REAL_CHAIN)) };
  }
  await mkdir(runDir, { recursive: true });
  const mutated = mutateChainOrdering(await readFile(REAL_CHAIN, "utf8"));
  const rel = relative(runDir, REAL_DIAGNOSTICS).split("\\").join("/").replace(/\.ts$/, ".js");
  const specifier = rel.startsWith(".") ? rel : `./${rel}`;
  const source = rewriteChainRelativeImport(mutated, specifier);
  const path = join(runDir, "chain.ts");
  await writeFile(path, source, "utf8");
  return { path, sha256: sha256(Buffer.from(source, "utf8")) };
}

/** Spawn the isolated child and collect its REAL exit code, report and bundles. */
async function runChild(mode: "real" | "mutated"): Promise<ChildRun> {
  const diagDir = await mkdtemp(join(tmpdir(), "e4-r55-diag-"));
  const reportDir = await mkdtemp(join(tmpdir(), "e4-r55-report-"));
  tempDirs.push(diagDir, reportDir);
  // A PER-RUN directory owned by this invocation only.
  await mkdir(RUNS_ROOT, { recursive: true });
  const runDir = await mkdtemp(join(RUNS_ROOT, "run-"));
  try {
    const chain = await prepareChainModule(runDir, mode);
    const reportPath = join(reportDir, "report.json");
    const proc = spawnSync(
      process.execPath,
      [VITEST_BIN, "run", "--config", CHILD_CONFIG, "--reporter=json", `--outputFile=${reportPath}`],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          E4_09_DIAG_DIR: diagDir,
          // Binds THIS run's chain module (the child config aliases it).
          E4_R55_CHAIN_MODULE: chain.path,
          E4_R55_CHAIN_SHA: chain.sha256,
          // keep the child unnamed so no observation evidence is committed
          E2E_OBSERVATION_RUN_ID: "",
        },
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const report = JSON.parse(await readFile(reportPath, "utf8")) as {
      testResults?: { assertionResults?: { title?: string; status?: string }[] }[];
    };
    const results = (report.testResults ?? []).flatMap((f) =>
      (f.assertionResults ?? []).map((a) => ({ title: String(a.title ?? ""), status: String(a.status ?? "") })),
    );
    return { exitCode: proc.status, diagDir, bundles: await readBundles(diagDir), results, chain };
  } finally {
    // Each run cleans ONLY the resources it owns.
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

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

describe("E4-R55 real production failure wiring (parent verifier over an isolated child)", () => {
  it("drives the real chain, judges its failure evidence, and requires an order mutation to break the acceptance", async () => {
    // ── PRECONDITION: the production benchmark needs a provably clean tree ──
    const porcelain = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout ?? "";
    expect(
      porcelain.trim(),
      "E4-R55 requires a CLEAN committed working tree: the production benchmark refuses to produce a promotion-eligible run on a tree that is not provably clean, so every child case would fail for an unrelated reason. Commit or stash first.",
    ).toBe("");

    // E4-R59: nothing is written into the production source tree any more. The
    // mutated copy is generated into a per-run directory inside `runChild`, and
    // the child is bound to it by `E4_R55_CHAIN_MODULE` (asserted below).

    // ── RUN 1: the real wiring, unmodified ──
    const normal = await runChild("real");

    // The child's own report: EXACTLY the expected pass/fail set, nothing else.
    expect(normal.results.map((r) => `${r.status} ${r.title}`).sort()).toEqual(
      [`failed ${NONACCEPT_TITLE}`, `failed ${THROW_TITLE}`, `failed ${BENCHFAIL_TITLE}`, `passed ${SUCCESS_TITLE}`].sort(),
    );
    // vitest exits 1 because (and only because) those three cases failed. Any
    // other non-zero is not a pass condition.
    expect(normal.exitCode).toBe(1);

    // ── 1. the REAL non-ACCEPT decision, with its reasonCodes ──
    const nonaccept = byLabel(normal, "r55-nonaccept");
    const verdict = acceptance(nonaccept);
    expect(verdict.reasons, `non-ACCEPT acceptance failed: ${verdict.reasons.join("; ")}`).toEqual([]);
    expect(verdict.ok).toBe(true);
    const decisionSummary = nonaccept!.summary["decision-artifact"] as Record<string, unknown>;
    // The decision is the REAL evaluator's output, not a fixture: it is a
    // non-ACCEPT verdict carrying its own reason codes.
    expect(decisionSummary["decision"]).not.toBe("ACCEPT");
    expect((decisionSummary["reasonCodes"] as unknown[]).length).toBeGreaterThan(0);
    // the failure is attributed to the ACCEPT assertion at the evaluate stage
    expect(nonaccept!.failure.stage).toBe("evaluate");

    // ── 2. durability + byte fidelity of the copies, read AFTER the child died ──
    const integrity = await copyIntegrity(nonaccept!);
    expect(integrity.length).toBeGreaterThanOrEqual(4);
    for (const item of integrity) expect(item.ok, `${item.role}: ${item.detail}`).toBe(true);

    // ── 3. injected evaluator fault: labelled, correct stage, decision missing ──
    const thrown = byLabel(normal, "r55-throw");
    expect(thrown).toBeDefined();
    expect(thrown!.failure.stage).toBe("evaluate");
    expect(thrown!.failure.message).toContain("R55 injected evaluator failure");
    expect(thrown!.extra["evaluatorFaultInjection"]).toBe(true); // labelled, never passed off as real
    expect(roleOf(thrown!, "decision-artifact")!.captured).toBe(false);
    expect(thrown!.summary["decision-artifact"]).toBeNull();
    // artifacts written BEFORE the fault are still preserved
    expect(roleOf(thrown!, "paired-experiment")!.captured).toBe(true);
    expect(roleOf(thrown!, "v3-candidate")!.captured).toBe(true);

    // ── 4. benchmark precondition failure: real exit + missing output roles ──
    const benchfail = byLabel(normal, "r55-benchfail");
    expect(benchfail).toBeDefined();
    expect(benchfail!.failure.stage).toBe("benchmark");
    const cli = benchfail!.extra["benchmarkCli"] as { exitCode: number } | undefined;
    expect(cli?.exitCode).not.toBe(0);
    for (const role of ["paired-experiment", "v3-baseline", "v3-candidate", "decision-artifact"]) {
      const rec = roleOf(benchfail!, role)!;
      expect(rec.captured).toBe(false);
      expect(String(rec.error)).not.toBe("");
    }

    // ── 5. a successful chain produces NO bundle ──
    expect(byLabel(normal, "r55-success")).toBeUndefined();
    expect(normal.bundles).toHaveLength(3);

    // ── 5b. E4-R59: the control run loaded the REAL module, and every bundle
    //        records the chain identity it was bound to ──
    expect(normal.chain.path).toBe(REAL_CHAIN);
    for (const bundle of normal.bundles) {
      const recorded = bundle.extra["chainModule"] as { path: string; sha256: string } | undefined;
      expect(recorded, `${bundle.label}: chain identity must be recorded`).toBeDefined();
      expect(recorded!.path).toBe(normal.chain.path);
      expect(recorded!.sha256).toBe(normal.chain.sha256);
    }

    // ── 6. RUN 2: the SAME acceptance against the ORDER-MUTATED wiring ──
    const mutated = await runChild("mutated");
    // The mutated copy is a per-run file, NOT the repository's module, and it is
    // outside the production compile input (asserted structurally below).
    expect(mutated.chain.path).not.toBe(REAL_CHAIN);
    expect(mutated.chain.sha256).not.toBe(normal.chain.sha256);
    expect(mutated.chain.path.startsWith(RUNS_ROOT)).toBe(true);
    const mutatedNonaccept = byLabel(mutated, "r55-nonaccept");
    expect(mutatedNonaccept, "the mutated run must still produce a failure bundle").toBeDefined();
    // The child loaded exactly the copy this run selected — its identity is in the
    // bundle, and the alias (not a scan) is what bound it.
    const mutatedIdentity = mutatedNonaccept!.extra["chainModule"] as { path: string; sha256: string };
    expect(mutatedIdentity.path).toBe(mutated.chain.path);
    expect(mutatedIdentity.sha256).toBe(mutated.chain.sha256);
    // The mutated child still fails (at the ACCEPT assert), but the decision save
    // now runs AFTER it — so the decisive evidence is gone.
    const mutatedVerdict = acceptance(mutatedNonaccept);
    expect(
      mutatedVerdict.ok,
      "the acceptance MUST fail against the order-mutated wiring; if it passes, the acceptance is not bound to the production ordering",
    ).toBe(false);
    expect(mutatedVerdict.reasons.join("; ")).toMatch(/decision-artifact/);
    expect(roleOf(mutatedNonaccept!, "decision-artifact")!.captured).toBe(false);

    // ── 7. E4-R59: no per-run copy survives its own run ──
    const leftover = await readdir(RUNS_ROOT).catch(() => [] as string[]);
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

      // Each copy's rewritten import must RESOLVE to the real diagnostics module,
      // whatever directory depth the copy happens to sit at. The specifier uses
      // the ESM `.js` form (TypeScript resolves `.js` -> the `.ts` source), so the
      // comparison is made modulo that extension convention.
      for (const ref of [a, b]) {
        const src = await readFile(ref.path, "utf8");
        const spec = /from "([^"]*e4-09-diagnostics\.js)"/.exec(src)?.[1];
        expect(spec, `${ref.path}: the copy must import the diagnostics module`).toBeDefined();
        const resolved = resolve(dirname(ref.path), spec as string).replace(/\.js$/, "");
        expect(resolved).toBe(REAL_DIAGNOSTICS.replace(/\.ts$/, ""));
      }

      // Run A cleans ONLY its own directory: B's copy must survive intact.
      await rm(dirA, { recursive: true, force: true });
      expect(await readFile(a.path, "utf8").then(() => true, () => false)).toBe(false);
      expect(await readFile(b.path, "utf8").then(() => true, () => false)).toBe(true);
      expect(sha256(await readFile(b.path))).toBe(b.sha256);
    } finally {
      await rm(dirA, { recursive: true, force: true }).catch(() => {});
      await rm(dirB, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("R59: the per-run copy location stays outside the production compile input and the default test include", async () => {
    // Structural guard: if a future change ever widens `apps/cli/tsconfig.json`'s
    // include (or moves the runs root under `src`), this fails instead of silently
    // putting generated code back into the production build.
    const tsconfig = JSON.parse(
      await readFile(join(REPO_ROOT, "apps", "cli", "tsconfig.json"), "utf8"),
    ) as { include?: string[] };
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
