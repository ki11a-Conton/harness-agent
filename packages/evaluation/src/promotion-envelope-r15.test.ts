/**
 * E4-R15 — N11 + N09-defense regressions for the promotion bundle loader.
 *
 *   N11  the decision artifact must be read through the SAME single path as
 *        every other bundle ref (resolve against bundleRoot, containment
 *        guard, read-once cache) — a RELATIVE decisionArtifactPath must never
 *        be resolved against process.cwd() (pre-fix: DECISION_ARTIFACT_MISSING
 *        when cwd != bundle dir), and it is never read a second time by an
 *        old direct-read branch.
 *   N09  the candidate's promotion-eligibility CLAIM is not authority: a
 *        promotion-eligible candidate must carry the full R13 execution plan
 *        and the R14 runComplete marker, else CANDIDATE_NOT_ELIGIBLE.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  buildExperimentArtifactV3,
  writeExperimentArtifactV3,
  runV3ChampionEval,
  buildPromotionEnvelope,
  loadPromotionEnvelope,
  computeExecutionPlanDigest,
  DEFAULT_DECISION_POLICY_V3,
  computeThresholdDigestV3,
  fixtureExecutionPlan,
} from "@ar/evaluation";
import type { CaseOutcomeV3, SecurityOutcomeV3, ExperimentArtifactV3 } from "@ar/evaluation";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const GIT = "c".repeat(40);
const CAND = "b".repeat(64);
const TD = computeThresholdDigestV3(DEFAULT_DECISION_POLICY_V3);

/** E4-R22 (F02): the COMPLETE confirmed plan (3 cases × 2 reps) — the recorded
 *  planDigest is its recomputed digest, so the loader's cross-binding holds. */
const EXECUTION_PLAN = fixtureExecutionPlan({
  suite: "holdout",
  caseIds: ["ho-01", "ho-02", "ho-03"],
  repeat: 2,
  providerId: "fake",
  modelId: "m",
  sourceSha: GIT,
});
const PLAN = computeExecutionPlanDigest(EXECUTION_PLAN);

function outcome(caseId: string, armId: "baseline" | "candidate", rep: number, order: number, passed: boolean, activationRef: string | null): CaseOutcomeV3 {
  return {
    caseId, suite: "holdout", armId, attempt: 1, repetition: rep, order,
    passed, grade: passed ? "good" : "poor", verificationPassed: passed,
    terminationReason: "verified_complete", failureCategory: null,
    inputTokens: 1000, outputTokens: 500, costUsd: 0.01, latencyMs: 100, toolCalls: 3,
    recoveryDecisions: [], activationRef,
    securityOutcomeRef: `holdout\u0000${caseId}\u0000${rep}\u0000${armId}`,
    outputDigest: null, workspaceDigest: null, judgeVersion: "1.0.0",
    evaluationContextHash: "a".repeat(64), candidateConfigHash: armId === "candidate" ? CAND : null,
  } as unknown as CaseOutcomeV3;
}

/** 3 cases × 2 reps; candidate wins every paired sample → a genuine ACCEPT. */
function armArtifact(armId: "baseline" | "candidate", manifestExtra: Record<string, unknown> = {}): ExperimentArtifactV3 {
  const rows: CaseOutcomeV3[] = [];
  let order = 1;
  for (const rep of [1, 2]) {
    for (let c = 1; c <= 3; c += 1) {
      rows.push(outcome(`ho-0${c}`, armId, rep, order++, armId === "candidate", armId === "candidate" ? `act-${rep}-${c}` : null));
    }
  }
  const grid = [1, 2].flatMap((rep) => [1, 2, 3].map((c) => `holdout\u0000ho-0${c}\u0000${rep}`));
  const securityOutcomes: SecurityOutcomeV3[] = rows.map((o) => ({
    caseId: o.securityOutcomeRef as string,
    kind: "clean",
    detail: "no attack (fixture)",
  }));
  return buildExperimentArtifactV3({
    arm: { armId, candidateId: armId === "candidate" ? "cand-x" : null, candidateConfigHash: armId === "candidate" ? CAND : null },
    manifest: {
      suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: GIT, dirty: false,
      planDigest: PLAN, promotionEligible: true, isolationStrength: "strong", runtimeConfigHash: CAND,
      expectedSampleKeys: grid, runComplete: true,
      executionPlan: EXECUTION_PLAN,
      thresholdDigest: TD,
      ...manifestExtra,
    },
    outcomes: rows,
    activationEvidence: armId === "candidate"
      ? rows.map((o) => ({ id: o.activationRef as string, reasonCodes: ["memory.retrieved"], note: "activated" }))
      : [],
    securityOutcomes,
    provenance: { sourceManifestPath: null, gitSha: GIT, dirty: false, model: "m", provider: "fake", runtimeConfigHash: CAND },
  });
}

/** Write a genuine ACCEPT bundle; every ref is RELATIVE on purpose. */
async function buildValidBundle(dir: string, candidateManifestExtra: Record<string, unknown> = {}): Promise<{
  envPath: string;
}> {
  const baselinePath = join(dir, "baseline.json");
  const candidatePath = join(dir, "candidate.json");
  await writeExperimentArtifactV3(armArtifact("baseline"), baselinePath);
  await writeExperimentArtifactV3(armArtifact("candidate", candidateManifestExtra), candidatePath);
  const evalResult = await runV3ChampionEval({ baselinePath, candidatePath, candidateId: "cand-x" });
  // NOTE: no unconditional ACCEPT assertion here — the N09 negative tests pass
  // a MUTATED manifest (missing executionPlan / runComplete=false), which must
  // evaluate to INVALID. The control test asserts ACCEPT separately.
  const decisionArtifactPath = join(dir, "decision-artifact.json");
  const decisionText = JSON.stringify(evalResult.decisionArtifact);
  await writeFile(decisionArtifactPath, decisionText, "utf8");
  const env = buildPromotionEnvelope({
    generatedBy: "e4-r15",
    decisionEnvelopeDigest: sha("stats"),
    candidateId: "cand-x",
    parentLevel: "C0",
    parentStateDigest: sha("c0-state"),
    decisionArtifactPath: "decision-artifact.json", // RELATIVE — must resolve against bundleRoot
    decisionArtifactDigest: sha(decisionText),
    artifactRefs: [
      { role: "baseline", path: "baseline.json", digest: sha(await readFile(baselinePath, "utf8")) },
      { role: "candidate", path: "candidate.json", digest: sha(await readFile(candidatePath, "utf8")) },
    ],
    sourceSha: GIT,
  });
  const envPath = join(dir, "envelope.json");
  await writeFile(envPath, JSON.stringify(env), "utf8");
  return { envPath };
}

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "e4-r15-"));
  await mkdir(d, { recursive: true });
  return d;
}

describe("E4-R15 promotion loader single read path (N11) + eligibility authority (N09)", () => {
  it("control: a genuine bundle with RELATIVE refs (including the decision artifact) loads OK against bundleRoot", async () => {
    const dir = await tempDir();
    try {
      const { envPath } = await buildValidBundle(dir);
      const result = await loadPromotionEnvelope(envPath, {
        parentStateDigest: sha("c0-state"),
        candidateId: "cand-x",
        bundleRoot: dir,
      });
      expect(result.ok).toBe(true);
      expect(result.issues).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("N11: a RELATIVE decisionArtifactPath must never resolve against process.cwd()", async () => {
    // The bundle lives in a temp dir, far from the repo cwd the OLD code
    // would have read `decision-artifact.json` from. Pre-fix this produced
    // DECISION_ARTIFACT_MISSING; post-fix the bundleRoot resolution works.
    const dir = await tempDir();
    try {
      const { envPath } = await buildValidBundle(dir);
      const result = await loadPromotionEnvelope(envPath, {
        parentStateDigest: sha("c0-state"),
        candidateId: "cand-x",
        bundleRoot: dir,
      });
      expect(result.ok).toBe(true);
      expect(result.issues.some((i) => i.code === "DECISION_ARTIFACT_MISSING")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("N09: promotionEligible=true WITHOUT the full execution plan -> CANDIDATE_NOT_ELIGIBLE", async () => {
    const dir = await tempDir();
    try {
      const { envPath } = await buildValidBundle(dir, { executionPlan: undefined });
      const result = await loadPromotionEnvelope(envPath, {
        parentStateDigest: sha("c0-state"),
        candidateId: "cand-x",
        bundleRoot: dir,
      });
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === "CANDIDATE_NOT_ELIGIBLE")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("N09: runComplete=false cannot promote (CANDIDATE_NOT_ELIGIBLE)", async () => {
    const dir = await tempDir();
    try {
      const { envPath } = await buildValidBundle(dir, { runComplete: false });
      const result = await loadPromotionEnvelope(envPath, {
        parentStateDigest: sha("c0-state"),
        candidateId: "cand-x",
        bundleRoot: dir,
      });
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === "CANDIDATE_NOT_ELIGIBLE")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("N11: a tampered decision artifact (bytes changed after minting) is rejected, not silently replayed", async () => {
    const dir = await tempDir();
    try {
      const { envPath } = await buildValidBundle(dir);
      // Tamper the decision artifact content WITHOUT updating the recorded
      // digest — the single read path must catch DECISION_ARTIFACT_DIGEST_CHANGED.
      const daPath = join(dir, "decision-artifact.json");
      const text = await readFile(daPath, "utf8");
      await writeFile(daPath, text.replace(/"(decision)":\s*"ACCEPT"/, '"decision":"REJECT"'), "utf8");
      const result = await loadPromotionEnvelope(envPath, {
        parentStateDigest: sha("c0-state"),
        candidateId: "cand-x",
        bundleRoot: dir,
      });
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === "DECISION_ARTIFACT_DIGEST_CHANGED")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
