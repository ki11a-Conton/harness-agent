/**
 * E4-R45 — deterministic regression for the diagnostic registration / save
 * ORDER that R40 introduced.
 *
 * R40's `e4-09-production-e2e.test.ts` used to register the decision/V3/paired
 * artifact paths only AFTER the benchmark exitCode assert, the evaluator call,
 * the ACCEPT assert, and the decision write — so a failure at any of those
 * points ran `afterEach` with NOTHING registered and the most decisive evidence
 * (the paired accounting, the REAL decision, the reasonCodes) was lost. The
 * main chain had the same shape: the decision file was written AND registered
 * only AFTER `expect(decision).toBe("ACCEPT")`.
 *
 * The production fix moves registration to BEFORE the calls and persists the
 * evaluator's REAL result BEFORE the ACCEPT assert. This test proves the
 * recorder-level contract those fixes rely on, deterministically and with a
 * normal exit-0 pass (deliberate-failure forensics live in
 * `e4-r40-forensics.test.ts`, which is run explicitly):
 *
 *   A. a path registered UP FRONT but never written is recorded `missing`
 *      (captured=false + a real read error), with stage pointing at the stage
 *      that failed — not silently dropped;
 *   B. a REAL non-ACCEPT decision is persisted verbatim with its reasonCodes
 *      (never rebuilt into a fabricated ACCEPT);
 *   C. an evaluator throw keeps stage=evaluate and does NOT fabricate a
 *      decision (the role stays `missing`, its summary stays null);
 *   E. without up-front registration the role is entirely ABSENT from the
 *      bundle — the discriminating signal a pre-fix run would have shown.
 *
 * These are recorder-UNIT proofs. The REAL production-chains-采集 the artifacts
 * is proven by `e4-09-production-e2e.test.ts` itself (its 5 tests run the
 * actually-produced files through the same recorder), which this file must
 * never be conflated with (see the E4-R45 report §evidence classification).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  E4DiagnosticRecorder,
  summarizeDecisionArtifact,
} from "./e4-09-diagnostics.js";

const TEST_FILE = "apps/cli/src/e4-r45-diagnostics-order.test.ts";
const TESTED_SHA = null; // this unit test does not require a git checkout

let root: string;
let prevDiagDir: string | undefined;

function recorder(label: string, testName: string): E4DiagnosticRecorder {
  return new E4DiagnosticRecorder({ label, testFile: TEST_FILE, testedSha: TESTED_SHA, testName });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "e4-r45-diag-"));
  prevDiagDir = process.env.E4_09_DIAG_DIR;
  process.env.E4_09_DIAG_DIR = root;
});

afterAll(async () => {
  if (prevDiagDir === undefined) delete process.env.E4_09_DIAG_DIR;
  else process.env.E4_09_DIAG_DIR = prevDiagDir;
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("E4-R45 diagnostic registration/save ordering (recorder unit)", () => {
  it("A: an up-front path never written is recorded `missing` with stage=benchmark", async () => {
    const rec = recorder("r45-a", "A: up-front missing path");
    rec.mark("benchmark"); // stage set BEFORE the (simulated) failing stage
    rec.registerArtifacts([
      { role: "paired-experiment", path: join(root, "never-written.json"), summarize: undefined },
    ]);
    const out = await rec.captureFailure({ error: new Error("benchmark exited non-zero") });
    expect(out).not.toBeNull();
    const arts = out!.bundle.artifacts as Array<Record<string, unknown>>;
    const paired = arts.find((a) => a.role === "paired-experiment");
    expect(paired).toBeDefined();
    expect(paired!["captured"]).toBe(false); // recorded missing, not dropped
    expect(typeof paired!["error"]).toBe("string");
    expect((out!.bundle.failure as Record<string, unknown>).stage).toBe("benchmark");
  });

  it("B: a REAL non-ACCEPT decision is persisted verbatim with its reasonCodes", async () => {
    const rec = recorder("r45-b", "B: real non-ACCEPT persisted");
    const daPath = join(root, "decision-artifact.json");
    await writeFile(daPath, JSON.stringify({ decision: "REJECT", reasonCodes: ["capacity"] }), "utf8");
    rec.mark("evaluate");
    rec.registerArtifacts([{ role: "decision-artifact", path: daPath, summarize: summarizeDecisionArtifact }]);
    const out = await rec.captureFailure({ error: new Error("expected ACCEPT, got REJECT") });
    expect(out).not.toBeNull();
    const summary = (out!.bundle.summary as Record<string, unknown>)["decision-artifact"] as Record<string, unknown>;
    expect(summary["decision"]).toBe("REJECT"); // the REAL result, never rebuilt ACCEPT
    expect(summary["reasonCodes"]).toEqual(["capacity"]);
  });

  it("C: an evaluator throw keeps stage=evaluate and does NOT fabricate a decision", async () => {
    const rec = recorder("r45-c", "C: evaluator throw");
    const absentPath = join(root, "unwritten-decision.json");
    rec.mark("evaluate");
    rec.registerArtifacts([{ role: "decision-artifact", path: absentPath, summarize: summarizeDecisionArtifact }]);
    const out = await rec.captureFailure({ error: new Error("evaluator threw before writing") });
    expect(out).not.toBeNull();
    expect((out!.bundle.failure as Record<string, unknown>).stage).toBe("evaluate");
    const arts = out!.bundle.artifacts as Array<Record<string, unknown>>;
    const da = arts.find((a) => a.role === "decision-artifact");
    expect(da!["captured"]).toBe(false); // no fabricated decision file
    expect((out!.bundle.summary as Record<string, unknown>)["decision-artifact"]).toBeNull();
  });

  it("E: without up-front registration the role is entirely ABSENT (the discriminating de-opt signal)", async () => {
    const rec = recorder("r45-e", "E: no registration");
    // NOTE: this recorder registers NOTHING — the point of the assertion below.
    const out = await rec.captureFailure({ error: new Error("failed before registerArtifacts ran") });
    expect(out).not.toBeNull();
    const arts = out!.bundle.artifacts as Array<Record<string, unknown>>;
    expect(arts.find((a) => a.role === "decision-artifact")).toBeUndefined();
    expect(arts.find((a) => a.role === "paired-experiment")).toBeUndefined();
  });
});