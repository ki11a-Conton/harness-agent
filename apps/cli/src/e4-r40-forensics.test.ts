/**
 * E4-R40 (K01) — deterministic failure-forensics proof.
 *
 * This file is deliberately EXCLUDED from the default `pnpm test` run (see the
 * root `test` script and `test:forensics`): one test here FAILS BY DESIGN, to
 * prove the E4-09 attribution path actually persists a readable bundle on a real
 * failure. Run it explicitly:
 *
 *   env -u NODE_OPTIONS pnpm test:forensics     # exits non-zero on purpose
 *
 * What it proves (R39 lost all of this — only `expected 'INVALID' to be
 * 'ACCEPT'` survived, because the temp roots were deleted and no decision /
 * violation / paired / V3 payload was kept):
 *
 *   1. a real child-process gate failure is retained with its RAW stderr, not
 *      just the framework's `expected 2 to be 0`;
 *   2. the run's real artifacts (decision / paired / V3) are COPIED into the
 *      bundle before the temp roots are deleted, and reduced to matched values;
 *   3. the bundle is still readable AFTER the framework's cleanup;
 *   4. a second attempt of the same label lands in a DIFFERENT directory, so a
 *      retry or a second run can never overwrite the first attempt's evidence.
 */

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitHeadShaAt } from "./observation-evidence.js";
import {
  E4DiagnosticRecorder,
  E4_DIAGNOSTIC_SCHEMA_VERSION,
  summarizeDecisionArtifact,
  summarizePairedArtifact,
  summarizeV3Artifact,
} from "./e4-09-diagnostics.js";

const TEST_FILE = "apps/cli/src/e4-r40-forensics.test.ts";
const TESTED_SHA = gitHeadShaAt(process.cwd());
const CANDIDATE = "budget_aware_completion_v1";

let tempDirs: string[] = [];
let activeDiag: E4DiagnosticRecorder | null = null;
/** The dir the most recent failure bundle was written to, so the verification
 *  test reads the SAME bundle the failing test produced (no newest-dir guessing). */
let lastDiagnosticDir: string | null = null;

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "e4-r40-forensics-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async (ctx) => {
  if (ctx.task.result?.state === "fail" && activeDiag !== null) {
    const first = ctx.task.result.errors?.[0];
    const captured = await activeDiag.captureFailure({ error: first ?? new Error("e4-r40 forensics failed") });
    if (captured !== null) lastDiagnosticDir = captured.dir;
  }
  activeDiag = null;
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

describe("E4-R40 diagnostic attribution", () => {
  it("a real decision-stage gate failure persists a readable bundle with matched V3/paired/decision data", async () => {
    const root = await scratchDir();
    const recorder = new E4DiagnosticRecorder({
      label: "e4-r40", testFile: TEST_FILE, testedSha: TESTED_SHA,
      testName: "R40 decision-stage gate failure",
    });
    activeDiag = recorder;
    // REAL artifacts on disk with the exact shapes the production stages write;
    // capture copies their BYTES and reduces them, so a mismatched summary would
    // be caught by the verification test below.
    const daPath = join(root, "decision-artifact.json");
    await writeFile(daPath, JSON.stringify({ decision: "ACCEPT", reasonCodes: [], statistics: { netPassedDelta: 3 }, contentDigest: "d1" }), "utf8");
    const pairedPath = join(root, "paired-experiment.json");
    await writeFile(pairedPath, JSON.stringify({
      kind: "paired-experiment", complete: true, promotionEligible: true, isolationStrength: "strong",
      finalizedPairs: [{ pairId: "p1", caseId: "a", repetition: 0 }], partialPairs: [],
    }), "utf8");
    const v3Path = join(root, "v3-candidate.json");
    await writeFile(v3Path, JSON.stringify({
      manifest: { promotionEligible: true, isolationStrength: "strong", complete: true, candidateId: CANDIDATE },
      outcomes: [{ passed: true }, { passed: true }],
    }), "utf8");
    recorder.registerArtifacts([
      { role: "decision-artifact", path: daPath, summarize: summarizeDecisionArtifact },
      { role: "paired-experiment", path: pairedPath, summarize: summarizePairedArtifact },
      { role: "v3-candidate", path: v3Path, summarize: summarizeV3Artifact },
    ]);
    recorder.mark("decision-stage-gate");

    // A REAL child process that exits non-zero with a message on stderr — the
    // release-gate failure mode R40 must retain as evidence.
    let exitCode: number | null = null;
    let stderr = "";
    let stdout = "";
    try {
      stdout = execFileSync(process.execPath, ["-e", "process.stderr.write('gate-budget-exceeded'); process.exit(2)"], {
        encoding: "utf8", stdio: "pipe",
      });
    } catch (err) {
      const e = err as { status?: number; stderr?: unknown; stdout?: unknown };
      exitCode = typeof e.status === "number" ? e.status : null;
      stderr = String(e.stderr ?? "");
      stdout = String(e.stdout ?? stdout);
    }
    recorder.recordGate("decision-stage-gate", {
      gate: "capability_audit",
      command: [process.execPath, "-e", "process.exit(2)"],
      exitCode,
      passed: exitCode === 0,
      state: exitCode === 0 ? "passed" : "failed",
      ...(TESTED_SHA !== null ? { gitSha: TESTED_SHA } : {}),
      errorSummary: stderr.trim() !== "" ? stderr.trim().split("\n")[0]! : "child exited non-zero (see stderrExcerpt)",
    }, { stderr, stdout });

    // Deterministic, data-PRESERVING failure: every real artifact exists, but a
    // real gate exited 2 — asserting it passed MUST fail, and the afterEach hook
    // must still persist the whole bundle before the temp roots are deleted.
    expect(exitCode).toBe(0);
  }, 30_000);

  it("the captured bundle is readable, matched to the ACCEPT decision, and a second attempt never overwrites", async () => {
    // The previous test failed on purpose; its afterEach hook persisted a bundle
    // AFTER the assertions but BEFORE the temp roots were deleted.
    expect(lastDiagnosticDir).not.toBeNull();
    const bundle = JSON.parse(await readFile(join(lastDiagnosticDir!, "diagnostic.json"), "utf8")) as Record<string, any>;

    // Identity + honest capture: the bundle names the real test and stage.
    expect(bundle["schemaVersion"]).toBe(E4_DIAGNOSTIC_SCHEMA_VERSION);
    expect(bundle["kind"]).toBe("e4-09-diagnostic");
    expect(bundle["test"]["name"]).toContain("R40 decision-stage gate failure");
    expect(bundle["failure"]["stage"]).toBe("decision-stage-gate");
    expect(typeof bundle["failure"]["message"]).toBe("string");
    expect(bundle["source"]["headSha"]).toBe(TESTED_SHA);

    // THE R39 REGRESSION: the ACCEPT decision + complete pair accounting are in
    // the bundle, captured before the temp roots were deleted.
    const artifacts = bundle["artifacts"] as Array<Record<string, unknown>>;
    expect(artifacts.find((a) => a["role"] === "decision-artifact")?.["captured"]).toBe(true);
    expect(artifacts.find((a) => a["role"] === "paired-experiment")?.["captured"]).toBe(true);
    expect((bundle["summary"]["decision-artifact"] as Record<string, unknown>)["decision"]).toBe("ACCEPT");
    expect((bundle["summary"]["paired-experiment"] as Record<string, unknown>)["complete"]).toBe(true);
    expect((bundle["summary"]["v3-candidate"] as Record<string, unknown>)["promotionEligible"]).toBe(true);

    // The REAL gate child failure survived with its stderr, not just a boolean.
    const gate = (bundle["gateEvidence"] as Array<Record<string, unknown>>).find((g) => g["label"] === "decision-stage-gate");
    expect(gate?.["exitCode"]).toBe(2);
    expect(gate?.["passed"]).toBe(false);
    expect(String(gate?.["stderrExcerpt"])).toContain("gate-budget-exceeded");

    // Two attempts of the same label must land in DISTINCT directories (a retry
    // or a second run can never overwrite the previous attempt's evidence).
    const scratch = await scratchDir();
    const marker = join(scratch, "decision-artifact.json");
    await writeFile(marker, JSON.stringify({ decision: "ACCEPT" }), "utf8");
    const r1 = new E4DiagnosticRecorder({ label: "e4-r40-nooverwrite", testFile: TEST_FILE, testedSha: TESTED_SHA, testName: "attempt A" });
    const r2 = new E4DiagnosticRecorder({ label: "e4-r40-nooverwrite", testFile: TEST_FILE, testedSha: TESTED_SHA, testName: "attempt B" });
    expect(r1.attempt).not.toBe(r2.attempt);
    const b1 = await r1.captureFailure({ stage: "a", error: new Error("boom A"), artifacts: [{ role: "decision-artifact", path: marker }] });
    const b2 = await r2.captureFailure({ stage: "b", error: new Error("boom B"), artifacts: [{ role: "decision-artifact", path: marker }] });
    expect(b1?.dir).toBeDefined();
    expect(b2?.dir).toBeDefined();
    expect(b1?.dir).not.toBe(b2?.dir);
    expect(b1?.bundle["attempt"]).toBe(r1.attempt);
    expect(b2?.bundle["attempt"]).toBe(r2.attempt);
    expect((b1?.bundle["artifacts"] as Array<Record<string, unknown>>)[0]?.["captured"]).toBe(true);
    // Both live on disk simultaneously — the first was never clobbered.
    await expect(readFile(join(b1!.dir, "diagnostic.json"), "utf8")).resolves.toContain("boom A");
    await expect(readFile(join(b2!.dir, "diagnostic.json"), "utf8")).resolves.toContain("boom B");
  }, 30_000);
});
