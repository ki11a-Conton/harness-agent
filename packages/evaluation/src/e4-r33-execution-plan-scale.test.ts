/**
 * E4-R33 (H03) — execution-plan scale: refuse BEFORE the dangerous work.
 *
 * Pre-R33 the shared `parseExecutionPlan` was unusable for a large-but-LEGAL
 * plan and could not implement its own published cap:
 *
 *   - `caseIds.push(...caseIdsRaw)` hit the engine's argument-count limit and
 *     threw `RangeError: Maximum call stack size exceeded` for ~130k cases even
 *     though that is well under the documented 1,000,000 planned-sample cap;
 *   - the unplanned-fingerprint scan called `caseIds.includes(k)` — an
 *     O(caseCount × keyCount) quadratic membership query;
 *   - the capacity check ran LAST, after the whole O(caseCount) fingerprint
 *     binding, so an over-cap plan was only refused after the expensive work.
 *
 * The fix: an O(1) grid-cap guard immediately after the array type/length
 * check (refusing BEFORE any large copy, large loop, or grid expansion), a
 * spread-free copy, and an O(1) Set membership test — with the R28 budget
 * semantics and duplicate/missing/unplanned fingerprint semantics unchanged.
 *
 * Every plan is derived from a VALID fixture; only the factor under test changes.
 * All offline.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  parseExecutionPlan,
  computeExecutionPlanDigest,
  expectedSampleKeysFromExecutionPlan,
  EXECUTION_PLAN_MAX_PLANNED_SAMPLES,
} from "./execution-plan.js";
import { fixtureExecutionPlan, fixtureExecutionPlanDigest } from "./fixtures.js";
import { buildExperimentArtifactV3, writeExperimentArtifactV3 } from "./artifact-v3/index.js";
import type { ExperimentArtifactV3, CaseOutcomeV3, SecurityOutcomeV3 } from "./artifact-v3/types.js";
import { runV3ChampionEval } from "./champion-eval-v3.js";
import { DEFAULT_DECISION_POLICY_V3, computeThresholdDigestV3 } from "./decision-policy-v3.js";

const GIT = "c".repeat(40);
const CAND = "b".repeat(64);
const TD = computeThresholdDigestV3(DEFAULT_DECISION_POLICY_V3);
const CASES = ["ho-01", "ho-02", "ho-03"];
const REPS = [1, 2];
const GRID = REPS.flatMap((rep) => CASES.map((c) => `holdout\u0000${c}\u0000${rep}`));

const HEX64 = "a".repeat(64);
const fp = (id: string): string => createHash("sha256").update(`holdout:${id}`, "utf8").digest("hex");

/** A plan as a mutable record, built from the valid fixture. */
const planRecord = (): Record<string, unknown> =>
  fixtureExecutionPlan({ suite: "holdout", caseIds: CASES, repeat: 2 }) as unknown as Record<string, unknown>;

const accepts = (p: unknown): boolean => parseExecutionPlan(p).plan !== null;
const rejects = (p: unknown): string[] => {
  const r = parseExecutionPlan(p);
  expect(r.plan).toBeNull();
  return r.issues;
};

const createdDirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "e4-r33-"));
  createdDirs.push(d);
  await mkdir(d, { recursive: true });
  return d;
}
afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** The "large but legal" case set, built once and shared (130k distinct ids). */
let bigIdsCache: string[] | undefined;
function bigCaseIds(n: number): string[] {
  if (bigIdsCache === undefined || bigIdsCache.length !== n) {
    bigIdsCache = Array.from({ length: n }, (_, i) => `case-${i}`);
  }
  return bigIdsCache;
}
function fingerprintsFor(ids: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) out[id] = HEX64;
  return out;
}

describe("E4-R33 (H03) execution-plan scale — bounded before expansion", () => {
  it("R33-a: the canonical normal plan (3 cases × 2 repeats) still parses with 6 unique keys and an UNCHANGED digest", () => {
    const plan = fixtureExecutionPlan({ suite: "holdout", caseIds: CASES, repeat: 2 });
    const parsed = parseExecutionPlan(plan);
    expect(parsed.plan).not.toBeNull();
    expect(parsed.issues).toEqual([]);

    const keys = expectedSampleKeysFromExecutionPlan(parsed.plan!);
    expect(keys).toHaveLength(6);
    expect(new Set(keys).size).toBe(6);
    expect(keys.slice()).toEqual(GRID);

    // The digest protocol is untouched by the R33 refactor.
    expect(computeExecutionPlanDigest(parsed.plan!)).toBe(computeExecutionPlanDigest(plan));
    expect(computeExecutionPlanDigest(parsed.plan!)).toBe(fixtureExecutionPlanDigest({ suite: "holdout", caseIds: CASES, repeat: 2 }));
  });

  it("R33-b: a 130,000-case × 1-repeat plan (contract-valid: limit=null) PARSES — no RangeError, no stack overflow", () => {
    const ids = bigCaseIds(130_000);
    // Pre-R33 this threw `RangeError: Maximum call stack size exceeded` at
    // `caseIds.push(...caseIdsRaw)` even though 130k × 1 is under the cap.
    const plan = { ...planRecord(), caseIds: ids, caseFingerprints: fingerprintsFor(ids), limit: null, repeat: 1 };
    const r = parseExecutionPlan(plan);
    expect(r.issues).toEqual([]);
    expect(r.plan).not.toBeNull();
    // …and the derived grid is exactly the planned sample count.
    expect(expectedSampleKeysFromExecutionPlan(r.plan!).length).toBe(130_000);
  });

  it("R33-c: an over-cap product and an unsafe product are STRUCTURED rejections — no huge loop, no runtime exception", () => {
    // repeat × caseCount just over the documented cap (repeat is the factor).
    const overCap = { ...planRecord(), caseIds: ["a"], repeat: EXECUTION_PLAN_MAX_PLANNED_SAMPLES + 1, limit: null, caseFingerprints: { a: HEX64 } };
    const overIssues = rejects(overCap);
    expect(overIssues.some((i) => i.includes("planned-sample cap"))).toBe(true);
    expect(overIssues.some((i) => i.includes("refuse before expansion"))).toBe(true);

    // repeat × caseCount is not a SAFE INTEGER → refused as such.
    const unsafe = {
      ...planRecord(), caseIds: ["a", "b", "c"], repeat: Number.MAX_SAFE_INTEGER, limit: null,
      caseFingerprints: { a: HEX64, b: HEX64, c: HEX64 },
    };
    const unsafeIssues = rejects(unsafe);
    expect(unsafeIssues.some((i) => i.includes("overflows a safe integer"))).toBe(true);
  });

  it("R33-c2: the caseCount factor alone can exceed the cap (repeat=1) and is refused before ANY per-case work", () => {
    // build ~1M ids (≈40 MB, ~0.1 s) but NO fingerprint map: the O(1) guard must
    // fire before the fingerprint binding, so `{}` is never expanded.
    const ids = Array.from({ length: EXECUTION_PLAN_MAX_PLANNED_SAMPLES + 1 }, (_, i) => `c${i}`);
    const issues = rejects({ ...planRecord(), caseIds: ids, repeat: 1, limit: null, caseFingerprints: {} });
    expect(issues.some((i) => i.includes("planned-sample cap"))).toBe(true);
    // Decisive: ONLY the structured cap issue comes back. If the rejection had
    // happened after the per-case traversal, 1,000,001 fingerprint issues would
    // have been materialised first (refusal must precede the large work).
    expect(issues).toHaveLength(1);
    expect(issues.some((i) => i.includes("64-hex fingerprint for planned case"))).toBe(false);
  });

  it("R33-d: R28 budget semantics are preserved — fractional repeat, negative count, missing key, non-numeric cost are still refused", () => {
    expect(rejects({ ...planRecord(), repeat: 2.5 }).some((i) => i.includes("executionPlan.repeat must be a safe integer"))).toBe(true);
    expect(rejects({ ...planRecord(), maxModelCalls: -1 }).some((i) => i.includes("maxModelCalls must be null, a non-negative safe integer"))).toBe(true);
    const missing = planRecord();
    delete missing["maxLogicalRuns"];
    expect(rejects(missing).some((i) => i.includes("maxLogicalRuns key is missing"))).toBe(true);
    expect(rejects({ ...planRecord(), maxEstimatedCostUsd: "invalid" }).some((i) => i.includes("maxEstimatedCostUsd must be null or a finite non-negative number"))).toBe(true);
    // null / 0 semantics unchanged
    expect(accepts({ ...planRecord(), maxLogicalRuns: null, maxModelCalls: 0 })).toBe(true);
  });

  it("R33-e: duplicate caseIds, a MISSING fingerprint and an EXTRA fingerprint are all still refused", () => {
    const dup = { ...planRecord(), caseIds: ["a", "a"], caseFingerprints: { a: HEX64 }, limit: null, repeat: 1 };
    expect(rejects(dup).some((i) => i.includes("unique non-empty strings"))).toBe(true);

    const plan = planRecord();
    const fps = { ...(plan["caseFingerprints"] as Record<string, string>) };
    delete fps[CASES[1]!];
    expect(rejects({ ...plan, caseFingerprints: fps }).some((i) => i.includes("must carry a 64-hex fingerprint for planned case"))).toBe(true);

    expect(rejects({ ...plan, caseFingerprints: { ...fps, "unplanned-x": HEX64 } }).some((i) => i.includes("UNPLANNED case"))).toBe(true);
  });

  it("R33-f (real boundary): an over-cap plan is refused by the REAL evaluator with an explainable reason — no raw RangeError", async () => {    function outcome(caseId: string, armId: "baseline" | "candidate", rep: number, order: number, passed: boolean): CaseOutcomeV3 {
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
      for (const rep of REPS) for (const c of CASES) rows.push(outcome(c, armId, rep, order++, armId === "candidate"));
      const securityOutcomes: SecurityOutcomeV3[] = rows.map((o) => ({ caseId: o.securityOutcomeRef as string, kind: "clean", detail: "no attack (fixture)" }));
      return buildExperimentArtifactV3({
        arm: { armId, candidateId: armId === "candidate" ? "cand-x" : null, candidateConfigHash: armId === "candidate" ? CAND : null },
        manifest: {
          suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: GIT, dirty: false,
          // E4-R38 (J03): the REAL digest of the plan that is actually written —
          // never a `"0".repeat(64)` placeholder. A placeholder digest would make
          // the positive control fail for a reason unrelated to capacity (and
          // would let a DIGEST error masquerade as a plan-scale rejection).
          planDigest: computeExecutionPlanDigest(plan as never), promotionEligible: true, isolationStrength: "strong",
          runtimeConfigHash: CAND, expectedSampleKeys: GRID, runComplete: true,
          executionPlan: plan, thresholdDigest: TD,
        },
        outcomes: rows,
        activationEvidence: armId === "candidate" ? rows.map((o) => ({ id: o.activationRef as string, reasonCodes: ["memory.retrieved"], note: "activated" })) : [],
        securityOutcomes,
        provenance: { sourceManifestPath: null, gitSha: GIT, dirty: false, model: "deepseek-v4-flash", provider: "fake", runtimeConfigHash: CAND },
      });
    }

    const dir = await tempDir();
    // The plan is over the documented cap → the REAL evaluator must refuse with
    // the structured issue (never leak a RangeError / stack overflow).
    const overCapPlan = { ...planRecord(), caseIds: ["a"], repeat: EXECUTION_PLAN_MAX_PLANNED_SAMPLES + 5, limit: null, caseFingerprints: { a: HEX64 } };
    const basePath = join(dir, "baseline.json");
    const candPath = join(dir, "candidate.json");
    await writeExperimentArtifactV3(armArtifact("baseline", overCapPlan), basePath);
    await writeExperimentArtifactV3(armArtifact("candidate", overCapPlan), candPath);

    const res = await runV3ChampionEval({ baselinePath: basePath, candidatePath: candPath, candidateId: "cand-x" });
    expect(res.envelope.decision).toBe("INVALID");
    const violations = (res.derivedInputs as unknown as { pairingViolations?: string[] }).pairingViolations ?? [];
    expect(violations.some((v) => v.includes("planned-sample cap"))).toBe(true);
    expect(violations.some((v) => v.includes("RangeError"))).toBe(false);

    // Positive control through the SAME real path: a fully bound normal plan
    // reaches a real ACCEPT (E4-R38/J03 — asserting only "no cap issue" would
    // accept a plan that failed for any OTHER reason).
    const okPlan = fixtureExecutionPlan({ suite: "holdout", caseIds: CASES, repeat: 2, modelId: "deepseek-v4-flash" });
    const okBase = join(dir, "ok-baseline.json");
    const okCand = join(dir, "ok-candidate.json");
    await writeExperimentArtifactV3(armArtifact("baseline", okPlan), okBase);
    await writeExperimentArtifactV3(armArtifact("candidate", okPlan), okCand);
    const okRes = await runV3ChampionEval({ baselinePath: okBase, candidatePath: okCand, candidateId: "cand-x" });
    const okViolations = (okRes.derivedInputs as unknown as { pairingViolations?: string[] }).pairingViolations ?? [];
    expect(okViolations.some((v) => v.includes("planned-sample cap"))).toBe(false);
    expect(okViolations).toEqual([]);
    expect(okRes.envelope.decision).toBe("ACCEPT");
  }, 30_000);
});
