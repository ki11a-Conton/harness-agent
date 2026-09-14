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
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { mutateChainOrdering } from "./e4-09-real-chain.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const VITEST_BIN = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const CHILD_CONFIG = "apps/cli/test-infra/r55-vitest.config.ts";
const REAL_CHAIN = join(REPO_ROOT, "apps/cli", "src", "e4-09-real-chain.ts");
const GENERATED_MUTATION = join(REPO_ROOT, "apps", "cli", "src", "e4-r55-mutated-chain.generated.ts");

const NONACCEPT_TITLE =
  "R55 nonaccept: a REAL non-ACCEPT decision is persisted with its reasonCodes before the ACCEPT assert";
const SUCCESS_TITLE = "R55 success: a fully ACCEPTed chain produces NO failure bundle";
const THROW_TITLE =
  "R55 evaluator-throw: the injected fault keeps stage=evaluate and leaves the decision missing";
const BENCHFAIL_TITLE =
  "R55 benchmark-fail: the original benchmark exit and the missing output roles are visible";

let tempDirs: string[] = [];
afterAll(async () => {
  // The generated mutation copy must never outlive this file: a stray `.ts` in
  // `src` would be compiled by `tsc -b`.
  await rm(GENERATED_MUTATION, { force: true }).catch(() => {});
  for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
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

/** Spawn the isolated child and collect its REAL exit code, report and bundles. */
async function runChild(mutation: boolean): Promise<ChildRun> {
  const diagDir = await mkdtemp(join(tmpdir(), "e4-r55-diag-"));
  const reportDir = await mkdtemp(join(tmpdir(), "e4-r55-report-"));
  tempDirs.push(diagDir, reportDir);
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
        E4_R55_MUTATION: mutation ? "1" : "0",
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
  return { exitCode: proc.status, diagDir, bundles: await readBundles(diagDir), results };
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

    // The mutated copy is generated from the REAL module by string surgery, so it
    // cannot drift; it is gitignored and removed in afterAll.
    const realSource = await readFile(REAL_CHAIN, "utf8");
    const mutatedSource = mutateChainOrdering(realSource);
    expect(mutatedSource).not.toBe(realSource);
    await writeFile(GENERATED_MUTATION, mutatedSource, "utf8");

    // ── RUN 1: the real wiring, unmodified ──
    const normal = await runChild(false);

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

    // ── RUN 2: the SAME acceptance against the ORDER-MUTATED wiring ──
    const mutated = await runChild(true);
    const mutatedNonaccept = byLabel(mutated, "r55-nonaccept");
    expect(mutatedNonaccept, "the mutated run must still produce a failure bundle").toBeDefined();
    // The mutated child still fails (at the ACCEPT assert), but the decision save
    // now runs AFTER it — so the decisive evidence is gone.
    const mutatedVerdict = acceptance(mutatedNonaccept);
    expect(
      mutatedVerdict.ok,
      "the acceptance MUST fail against the order-mutated wiring; if it passes, the acceptance is not bound to the production ordering",
    ).toBe(false);
    expect(mutatedVerdict.reasons.join("; ")).toMatch(/decision-artifact/);
    expect(roleOf(mutatedNonaccept!, "decision-artifact")!.captured).toBe(false);
  }, 900_000);
});
