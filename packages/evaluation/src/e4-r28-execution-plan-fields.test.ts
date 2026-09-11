/**
 * E4-R28 (G02) — execution-plan numeric/scale validation.
 *
 * Pre-R28 the parser DEFINED `nullableNum` but never CALLED it: `repeat` and
 * `limit` were checked only for finiteness (a fractional 2.5 or a non-integer
 * limit passed), `maxModelCalls: -1` passed, deleting the `maxLogicalRuns`
 * key passed, and `maxEstimatedCostUsd: "invalid"` passed. This suite proves
 * the completed contract:
 *
 *   - all four budget fields are ACTUALLY validated (count fields = safe
 *     integers; the USD cap allows reasonable finite decimals);
 *   - repeat/limit are SAFE INTEGERS with explicit semantics, aligned with the
 *     CLI's `--repeat` (positive int), `--limit` (non-negative int, 0 = all →
 *     null) and `--seed` (non-negative int) contracts — no parser relaxation
 *     vs executor rounding drift;
 *   - a plan whose non-null `limit` is SMALLER than its caseIds count is
 *     self-contradictory (the CLI slices BEFORE planning; the grid derives
 *     from caseIds) and is rejected;
 *   - grid scale (repeat × caseCount) is bounded BEFORE array expansion, so a
 *     pathological plan returns a structured error instead of a huge loop;
 *   - the canonical normal plan (3 cases × 2 repeats) still parses and yields
 *     exactly 6 unique pair keys / 12 logical arm runs;
 *   - invalid fields are ALSO blocked through the REAL file-parse paths
 *     (evaluator / promotion loader), not only the direct-JS helper.
 *
 * All offline.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseExecutionPlan,
  computeExecutionPlanDigest,
  expectedSampleKeysFromExecutionPlan,
  EXECUTION_PLAN_MAX_PLANNED_SAMPLES,
  type ExecutionPlanV1,
} from "./execution-plan.js";
import { fixtureExecutionPlan } from "./fixtures.js";
import { buildExperimentArtifactV3, writeExperimentArtifactV3 } from "./artifact-v3/index.js";
import type { ExperimentArtifactV3, CaseOutcomeV3, SecurityOutcomeV3 } from "./artifact-v3/types.js";
import { runV3ChampionEval } from "./champion-eval-v3.js";
import { loadPromotionEnvelope, buildPromotionEnvelope, type PromotionEnvelope } from "./promotion-envelope.js";
import { DEFAULT_DECISION_POLICY_V3, computeThresholdDigestV3 } from "./decision-policy-v3.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

const GIT = "c".repeat(40);
const CAND = "b".repeat(64);
const TD = computeThresholdDigestV3(DEFAULT_DECISION_POLICY_V3);
const CASES = ["ho-01", "ho-02", "ho-03"];
const REPS = [1, 2];
const GRID = REPS.flatMap((rep) => CASES.map((c) => `holdout\u0000${c}\u0000${rep}`));
const PLAN_ARGS = { suite: "holdout", caseIds: CASES, repeat: 2 };

const createdDirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "e4-r28-"));
  createdDirs.push(d);
  await mkdir(d, { recursive: true });
  return d;
}
afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A plan record as a plain object so single fields can be mutated. */
const planRecord = (): Record<string, unknown> => fixtureExecutionPlan(PLAN_ARGS) as unknown as Record<string, unknown>;

/** Parse accepts (plan !== null). */
const accepts = (p: unknown): boolean => parseExecutionPlan(p).plan !== null;
/** Parse rejects; returns the exact issue strings. */
const rejects = (p: unknown): string[] => {
  const r = parseExecutionPlan(p);
  expect(r.plan).toBeNull();
  return r.issues;
};

describe("E4-R28 (G02) numeric field contract", () => {
  it("POSITIVE: the canonical normal plan parses and its digest is stable", () => {
    const plan = fixtureExecutionPlan(PLAN_ARGS);
    const parsed = parseExecutionPlan(plan);
    expect(parsed.plan).not.toBeNull();
    expect(parsed.issues).toEqual([]);
    expect(computeExecutionPlanDigest(parsed.plan!)).toBe(computeExecutionPlanDigest(plan));
  });

  // --- the four plan-listed counter-examples --------------------------------
  it("G02 REPRO: repeat=2.5 is rejected (fractional repeat would silently change the grid)", () => {
    const issues = rejects({ ...planRecord(), repeat: 2.5 });
    expect(issues.some((i) => i.includes("executionPlan.repeat must be a safe integer"))).toBe(true);
  });

  it("G02 REPRO: maxModelCalls=-1 is rejected (negative budget)", () => {
    const issues = rejects({ ...planRecord(), maxModelCalls: -1 });
    expect(issues.some((i) => i.includes("maxModelCalls must be null, a non-negative safe integer"))).toBe(true);
  });

  it("G02 REPRO: deleting the maxLogicalRuns key is rejected (missing budget fails closed)", () => {
    const p = planRecord();
    delete p["maxLogicalRuns"];
    const issues = rejects(p);
    expect(issues.some((i) => i.includes("maxLogicalRuns key is missing"))).toBe(true);
  });

  it("G02 REPRO: maxEstimatedCostUsd=\"invalid\" is rejected (a string is not a number)", () => {
    const issues = rejects({ ...planRecord(), maxEstimatedCostUsd: "invalid" });
    expect(issues.some((i) => i.includes("maxEstimatedCostUsd must be null or a finite non-negative number"))).toBe(true);
  });

  // --- integer semantics -----------------------------------------------------
  it("repeat must be a positive SAFE integer (1, 2.0-ok-if-int, 0, -1, MAX_SAFE+1 rejected)", () => {
    expect(accepts(fixtureExecutionPlan({ suite: "holdout", caseIds: ["c"], repeat: 1 }))).toBe(true);
    expect(accepts({ ...planRecord(), repeat: 2.0 })).toBe(true); // 2.0 IS an integer
    const tooBig = (Number.MAX_SAFE_INTEGER + 1).toString();
    expect(rejects({ ...planRecord(), repeat: Number(tooBig) }).some((i) => i.includes("safe integer"))).toBe(true);
    expect(rejects({ ...planRecord(), repeat: 0 }).some((i) => i.includes("safe integer in [1"))).toBe(true);
    expect(rejects({ ...planRecord(), repeat: -3 }).some((i) => i.includes("safe integer in [1"))).toBe(true);
    expect(rejects({ ...planRecord(), repeat: NaN }).some((i) => i.includes("safe integer"))).toBe(true);
    expect(rejects({ ...planRecord(), repeat: Infinity }).length).toBeGreaterThan(0);
  });

  it("limit: null = unlimited; a literal 0 is rejected; a fractional limit is rejected", () => {
    const withLimit = (v: unknown) => ({ ...planRecord(), limit: v });
    // null is legal (no case-count cap; the grid is caseIds itself)
    const ok = parseExecutionPlan(withLimit(null));
    expect(ok.plan).not.toBeNull();
    // CLI `--limit 0` means ALL -> maps to null; a literal 0 contradicts "0 cases"
    expect(rejects(withLimit(0)).some((i) => i.includes("executionPlan.limit must be a safe integer in [1"))).toBe(true);
    expect(rejects(withLimit(2.5)).some((i) => i.includes("executionPlan.limit must be a safe integer"))).toBe(true);
    // a non-null limit that is SMALLER than caseIds.length contradicts itself
    const short = rejects(withLimit(2));
    expect(short.some((i) => i.includes("executionPlan.limit 2 < caseIds.length 3"))).toBe(true);
    // a non-null limit >= caseIds.length is fine
    expect(accepts(withLimit(3))).toBe(true);
    expect(accepts(withLimit(100))).toBe(true);
  });

  it("seed follows the CLI's non-negative integer PRNG contract", () => {
    expect(accepts({ ...planRecord(), seed: 0 })).toBe(true);
    expect(accepts({ ...planRecord(), seed: 7 })).toBe(true);
    expect(rejects({ ...planRecord(), seed: -1 }).some((i) => i.includes("seed must be a safe integer in [0"))).toBe(true);
    expect(rejects({ ...planRecord(), seed: 1.5 }).some((i) => i.includes("seed must be a safe integer"))).toBe(true);
  });

  // --- budget fields ---------------------------------------------------------
  it("null = unlimited, 0 = forbid, positive = cap, for every count budget field", () => {
    for (const field of ["maxLogicalRuns", "maxModelCalls", "maxEstimatedTokens"]) {
      expect(accepts({ ...planRecord(), [field]: null }), `${field}=null`).toBe(true);
      expect(accepts({ ...planRecord(), [field]: 0 }), `${field}=0 (forbid)`).toBe(true);
      expect(accepts({ ...planRecord(), [field]: 5 }), `${field}=5`).toBe(true);
      const frac = rejects({ ...planRecord(), [field]: 2.5 });
      expect(frac.some((i) => i.includes("non-negative safe integer")), `${field}=2.5`).toBe(true);
      const neg = rejects({ ...planRecord(), [field]: -1 });
      expect(neg.some((i) => i.includes("non-negative safe integer")), `${field}=-1`).toBe(true);
    }
  });

  it("the USD cost cap allows finite decimals but rejects NaN/Infinity/negative/string", () => {
    expect(accepts({ ...planRecord(), maxEstimatedCostUsd: 0 })).toBe(true);
    expect(accepts({ ...planRecord(), maxEstimatedCostUsd: 12.5 })).toBe(true);
    expect(accepts({ ...planRecord(), maxEstimatedCostUsd: 0.001 })).toBe(true);
    expect(accepts({ ...planRecord(), maxEstimatedCostUsd: null })).toBe(true);
    expect(rejects({ ...planRecord(), maxEstimatedCostUsd: NaN }).some((i) => i.includes("finite non-negative number"))).toBe(true);
    expect(rejects({ ...planRecord(), maxEstimatedCostUsd: Infinity }).some((i) => i.includes("finite non-negative number"))).toBe(true);
    expect(rejects({ ...planRecord(), maxEstimatedCostUsd: -0.01 }).some((i) => i.includes("finite non-negative number"))).toBe(true);
  });

  // --- scale / overflow ------------------------------------------------------
  it("grid scale (repeat × caseCount) is refused BEFORE expansion when it exceeds the documented cap", () => {
    const rep = Math.ceil(EXECUTION_PLAN_MAX_PLANNED_SAMPLES / CASES.length) + 10;
    const p = { ...planRecord(), repeat: rep, maxLogicalRuns: null, maxModelCalls: null, maxEstimatedTokens: null, maxEstimatedCostUsd: null };
    const issues = rejects(p);
    expect(issues.some((i) => i.includes("planned-sample cap"))).toBe(true);
    // the structured error comes back instantly, without a giant loop (the
    // caller never reaches expectedSampleKeysFromExecutionPlan).
  });

  it("normal 3 cases × 2 repeats -> 6 unique pair keys and 12 logical arm runs", () => {
    const plan = fixtureExecutionPlan(PLAN_ARGS);
    const keys = expectedSampleKeysFromExecutionPlan(plan);
    expect(keys).toHaveLength(6);
    expect(new Set(keys).size).toBe(6);
    // paired: 2 arms × 6 planned samples = 12 logical arm runs
    expect(keys.slice()).toEqual(REPS.flatMap((rep) => CASES.map((c) => `holdout\u0000${c}\u0000${rep}`)));
  });
});

// ---------------------------------------------------------------------------
// The REAL file-parse boundaries must reject the same invalid fields — a
// direct helper call is not a production path.
// ---------------------------------------------------------------------------

describe("E4-R28 (G02) real boundary: invalid fields blocked via evaluator and promotion loader", () => {
  function outcome(caseId: string, armId: "baseline" | "candidate", rep: number, order: number, passed: boolean): CaseOutcomeV3 {
    return {
      caseId, suite: "holdout", armId, attempt: 1, repetition: rep, order,
      passed, grade: passed ? "good" : "poor", verificationPassed: passed,
      terminationReason: "verified_complete", failureCategory: null,
      inputTokens: 1000, outputTokens: 500, costUsd: 0.01, latencyMs: 100, toolCalls: 3,
      recoveryDecisions: [],
      activationRef: armId === "candidate" ? `act-${rep}-${caseId}` : null,
      securityOutcomeRef: `holdout\u0000${caseId}\u0000${rep}\u0000${armId}`,
      outputDigest: null, workspaceDigest: null, judgeVersion: "1.0.0",
      evaluationContextHash: "a".repeat(64),
      candidateConfigHash: armId === "candidate" ? CAND : null,
    } as unknown as CaseOutcomeV3;
  }

  function armArtifact(armId: "baseline" | "candidate", plan: unknown): ExperimentArtifactV3 {
    const rows: CaseOutcomeV3[] = [];
    let order = 1;
    for (const rep of REPS) {
      for (const c of CASES) rows.push(outcome(c, armId, rep, order++, armId === "candidate"));
    }
    const securityOutcomes: SecurityOutcomeV3[] = rows.map((o) => ({
      caseId: o.securityOutcomeRef as string,
      kind: "clean",
      detail: "no attack (fixture)",
    }));
    return buildExperimentArtifactV3({
      arm: { armId, candidateId: armId === "candidate" ? "cand-x" : null, candidateConfigHash: armId === "candidate" ? CAND : null },
      manifest: {
        suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: GIT, dirty: false,
        planDigest: "0".repeat(64), promotionEligible: true, isolationStrength: "strong",
        runtimeConfigHash: CAND, expectedSampleKeys: GRID, runComplete: true,
        executionPlan: plan, thresholdDigest: TD,
      },
      outcomes: rows,
      activationEvidence: armId === "candidate" ? rows.map((o) => ({ id: o.activationRef as string, reasonCodes: ["memory.retrieved"], note: "activated" })) : [],
      securityOutcomes,
      provenance: { sourceManifestPath: null, gitSha: GIT, dirty: false, model: "deepseek-v4-flash", provider: "fake", runtimeConfigHash: CAND },
    });
  }

  it("a fractional-repeat plan is refused through the REAL evaluator (decision INVALID)", async () => {
    const dir = await tempDir();
    const plan = { ...(fixtureExecutionPlan(PLAN_ARGS) as unknown as Record<string, unknown>), repeat: 2.5 };
    const basePath = join(dir, "baseline.json");
    const candPath = join(dir, "candidate.json");
    await writeExperimentArtifactV3(armArtifact("baseline", plan), basePath);
    await writeExperimentArtifactV3(armArtifact("candidate", plan), candPath);
    const res = await runV3ChampionEval({ baselinePath: basePath, candidatePath: candPath, candidateId: "cand-x" });
    expect(res.envelope.decision).toBe("INVALID");
  });

  it("a negative/string budget field is refused through the REAL promotion loader", async () => {
    const dir = await tempDir();
    const plan = { ...(fixtureExecutionPlan(PLAN_ARGS) as unknown as Record<string, unknown>), maxModelCalls: -1 };
    const basePath = join(dir, "baseline.json");
    const candPath = join(dir, "candidate.json");
    await writeExperimentArtifactV3(armArtifact("baseline", plan), basePath);
    await writeExperimentArtifactV3(armArtifact("candidate", plan), candPath);
    const evalRes = await runV3ChampionEval({ baselinePath: basePath, candidatePath: candPath, candidateId: "cand-x" });
    const daPath = join(dir, "decision-artifact.json");
    await writeFile(daPath, JSON.stringify(evalRes.decisionArtifact), "utf8");
    const [da, base, cand] = await Promise.all([
      readFile(daPath, "utf8"), readFile(basePath, "utf8"), readFile(candPath, "utf8"),
    ]);
    const env: PromotionEnvelope = buildPromotionEnvelope({
      generatedBy: "e4-r28", decisionEnvelopeDigest: sha256("stats"), candidateId: "cand-x",
      parentLevel: "C0", parentStateDigest: sha256("c0"),
      decisionArtifactPath: "decision-artifact.json", decisionArtifactDigest: sha256(da),
      artifactRefs: [
        { role: "baseline", path: "baseline.json", digest: sha256(base) },
        { role: "candidate", path: "candidate.json", digest: sha256(cand) },
      ],
      sourceSha: GIT,
    });
    const envPath = join(dir, "envelope.json");
    await writeFile(envPath, JSON.stringify(env), "utf8");
    const loaded = await loadPromotionEnvelope(envPath, { bundleRoot: dir });
    expect(loaded.ok).toBe(false);
    expect(loaded.issues.some((i) => i.detail.includes("maxModelCalls") || i.code === "CANDIDATE_NOT_ELIGIBLE")).toBe(true);
  });
});