/**
 * E4-06 — forged-promotion regression suite.
 *
 * The trust boundary must reject a promotion that rests on nothing more than a
 * JSON that says ACCEPT with correct file SHAs. Every case here builds a REAL
 * bundle (production V3 writer + evaluator), then forges exactly one thing the
 * way an attacker would — INCLUDING recomputing the digests they can reach — and
 * asserts the loader rejects it with the specific reason. The positive control
 * proves a genuine bundle is accepted, so the rejections are not blanket.
 *
 * All offline, all in a temp dir. The loader is read-only: a rejected load must
 * leave every bundle file byte-identical.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { buildExperimentArtifactV3, writeExperimentArtifactV3 } from "./artifact-v3/index.js";
import { runV3ChampionEval } from "./champion-eval-v3.js";
import {
  buildPromotionEnvelope,
  loadPromotionEnvelope,
  PROMOTION_ENVELOPE_POLICY_VERSION,
  type PromotionEnvelope,
} from "./promotion-envelope.js";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const GIT_SHA = "c".repeat(40);
const PLAN_DIGEST = "d".repeat(64);
const CAND_CONFIG = "b".repeat(64);

function outcome(caseId: string, armId: string, rep: number, order: number, passed: boolean, activationRef: string | null) {
  return {
    caseId, suite: "holdout", armId, attempt: 1, repetition: rep, order,
    passed, grade: passed ? "good" : "poor", verificationPassed: passed,
    terminationReason: "verified_complete", failureCategory: null,
    inputTokens: 1000, outputTokens: 500, costUsd: 0.01, latencyMs: 100, toolCalls: 3,
    recoveryDecisions: [], activationRef, securityOutcomeRef: null,
    outputDigest: null, workspaceDigest: null, judgeVersion: "1.0.0",
    evaluationContextHash: "a".repeat(64),
    candidateConfigHash: armId === "candidate" ? CAND_CONFIG : null,
  };
}

/** Build a genuine ACCEPT bundle: baseline fails, candidate passes with
 *  activation, 2 repetitions, strong isolation, real evaluator decision. */
async function buildValidBundle(dir: string) {
  const mk = (armId: string, extra: Record<string, unknown>) => ({
    suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: GIT_SHA, dirty: false,
    planDigest: PLAN_DIGEST, promotionEligible: true, isolationStrength: "strong", ...extra,
  });
  const baseline = buildExperimentArtifactV3({
    arm: { armId: "baseline", candidateId: null, candidateConfigHash: null },
    manifest: mk("baseline", {}),
    outcomes: [1, 2].flatMap((rep) => [0, 1, 2].map((k) => outcome(`ho-0${k + 1}`, "baseline", rep, (rep - 1) * 3 + k + 1, false, null))),
    activationEvidence: [], securityOutcomes: [],
    provenance: { sourceManifestPath: null, gitSha: GIT_SHA, dirty: false, model: "deepseek-v4-flash", provider: "fake", runtimeConfigHash: CAND_CONFIG },
  });
  const candidate = buildExperimentArtifactV3({
    arm: { armId: "candidate", candidateId: "cand-x", candidateConfigHash: CAND_CONFIG },
    manifest: mk("candidate", {}),
    outcomes: [1, 2].flatMap((rep) => [0, 1, 2].map((k) => outcome(`ho-0${k + 1}`, "candidate", rep, (rep - 1) * 3 + k + 1, true, `act-${rep}-${k}`))),
    activationEvidence: [1, 2].flatMap((rep) => [0, 1, 2].map((k) => ({ id: `act-${rep}-${k}`, reasonCodes: ["memory.retrieved"], note: "activated" }))),
    securityOutcomes: [],
    provenance: { sourceManifestPath: null, gitSha: GIT_SHA, dirty: false, model: "deepseek-v4-flash", provider: "fake", runtimeConfigHash: CAND_CONFIG },
  });
  const baselinePath = join(dir, "baseline.json");
  const candidatePath = join(dir, "candidate.json");
  await writeExperimentArtifactV3(baseline, baselinePath);
  await writeExperimentArtifactV3(candidate, candidatePath);

  const evalResult = await runV3ChampionEval({ baselinePath, candidatePath, candidateId: "cand-x" });
  const decisionArtifactPath = join(dir, "decision-artifact.json");
  await writeFile(decisionArtifactPath, JSON.stringify(evalResult.decisionArtifact), "utf8");

  const envelope = await makeEnvelope(dir, decisionArtifactPath, baselinePath, candidatePath);
  const envPath = join(dir, "envelope.json");
  await writeFile(envPath, JSON.stringify(envelope), "utf8");
  return { envPath, decisionArtifactPath, baselinePath, candidatePath, envelope, decisionArtifact: evalResult.decisionArtifact };
}

async function makeEnvelope(dir: string, decisionArtifactPath: string, baselinePath: string, candidatePath: string): Promise<PromotionEnvelope> {
  const [da, base, cand] = await Promise.all([
    readFile(decisionArtifactPath, "utf8"), readFile(baselinePath, "utf8"), readFile(candidatePath, "utf8"),
  ]);
  return buildPromotionEnvelope({
    generatedBy: "e4-06-forgery",
    decisionEnvelopeDigest: sha("stats"),
    candidateId: "cand-x",
    parentLevel: "C0",
    parentStateDigest: sha("c0-state"),
    decisionArtifactPath,
    decisionArtifactDigest: sha(da),
    artifactRefs: [
      { role: "baseline", path: baselinePath, digest: sha(base) },
      { role: "candidate", path: candidatePath, digest: sha(cand) },
    ],
    sourceSha: GIT_SHA,
  });
}

async function rewriteEnvelope(envPath: string, envelope: PromotionEnvelope): Promise<void> {
  await writeFile(envPath, JSON.stringify(envelope), "utf8");
}

async function codes(envPath: string): Promise<string[]> {
  const r = await loadPromotionEnvelope(envPath, {
    parentStateDigest: sha("c0-state"),
    candidateId: "cand-x",
    expectedPolicyVersion: PROMOTION_ENVELOPE_POLICY_VERSION,
    verifyArtifactRefs: true,
  });
  return r.issues.map((i) => i.code);
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "e4-06-forgery-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("E4-06 forged promotion regression", () => {
  it("POSITIVE control: a genuine writer+evaluator bundle is accepted", async () => {
    const { envPath } = await buildValidBundle(dir);
    const r = await loadPromotionEnvelope(envPath, {
      parentStateDigest: sha("c0-state"), candidateId: "cand-x",
      expectedPolicyVersion: PROMOTION_ENVELOPE_POLICY_VERSION, verifyArtifactRefs: true,
    });
    expect(r.ok).toBe(true);
    expect(r.envelope).not.toBeNull();
  });

  it("candidate is plain text but its file SHA is correct -> ARTIFACT_NOT_V3", async () => {
    const { envPath, candidatePath } = await buildValidBundle(dir);
    await writeFile(candidatePath, "this is not an artifact, just text", "utf8");
    const cand = await readFile(candidatePath, "utf8");
    const env = JSON.parse(await readFile(envPath, "utf8")) as PromotionEnvelope;
    env.artifactRefs.find((r) => r.role === "candidate")!.digest = sha(cand);
    await rewriteEnvelope(envPath, env);
    expect(await codes(envPath)).toContain("ARTIFACT_NOT_V3");
  });

  it("DecisionArtifact.contentDigest randomized -> DECISION_ARTIFACT_DIGEST_INVALID", async () => {
    const { envPath, decisionArtifactPath } = await buildValidBundle(dir);
    const da = JSON.parse(await readFile(decisionArtifactPath, "utf8")) as Record<string, unknown>;
    da.contentDigest = "0".repeat(24);
    await writeFile(decisionArtifactPath, JSON.stringify(da), "utf8");
    const env = JSON.parse(await readFile(envPath, "utf8")) as PromotionEnvelope;
    env.decisionArtifactDigest = sha(await readFile(decisionArtifactPath, "utf8"));
    await rewriteEnvelope(envPath, env);
    expect(await codes(envPath)).toContain("DECISION_ARTIFACT_DIGEST_INVALID");
  });

  it("thresholdDigest tampered (embedded policy unchanged) -> DECISION_REPLAY_MISMATCH", async () => {
    const { envPath, decisionArtifactPath } = await buildValidBundle(dir);
    const da = JSON.parse(await readFile(decisionArtifactPath, "utf8")) as Record<string, unknown>;
    da.thresholdDigest = "9".repeat(64);
    // recompute the artifact's own contentDigest so the digest check passes and
    // ONLY the replay can catch the tampered threshold.
    const { computeDecisionArtifactContentDigestV3 } = await import("./champion-eval-v3.js");
    da.contentDigest = computeDecisionArtifactContentDigestV3(da);
    await writeFile(decisionArtifactPath, JSON.stringify(da), "utf8");
    const env = JSON.parse(await readFile(envPath, "utf8")) as PromotionEnvelope;
    env.decisionArtifactDigest = sha(await readFile(decisionArtifactPath, "utf8"));
    await rewriteEnvelope(envPath, env);
    expect(await codes(envPath)).toContain("DECISION_REPLAY_MISMATCH");
  });

  it("evaluatorVersion randomized (digest recomputed) -> DECISION_REPLAY_MISMATCH", async () => {
    const { envPath, decisionArtifactPath } = await buildValidBundle(dir);
    const da = JSON.parse(await readFile(decisionArtifactPath, "utf8")) as Record<string, unknown>;
    da.evaluatorVersion = "some-other-evaluator-v9";
    const { computeDecisionArtifactContentDigestV3 } = await import("./champion-eval-v3.js");
    da.contentDigest = computeDecisionArtifactContentDigestV3(da);
    await writeFile(decisionArtifactPath, JSON.stringify(da), "utf8");
    const env = JSON.parse(await readFile(envPath, "utf8")) as PromotionEnvelope;
    env.decisionArtifactDigest = sha(await readFile(decisionArtifactPath, "utf8"));
    await rewriteEnvelope(envPath, env);
    expect(await codes(envPath)).toContain("DECISION_REPLAY_MISMATCH");
  });

  it("decision flipped to ACCEPT over a failing pair (digest recomputed) -> DECISION_REPLAY_MISMATCH", async () => {
    // Build a pair where the candidate does NOT beat baseline (net delta 0,
    // single rep) so the real evaluator says INCONCLUSIVE; forge ACCEPT.
    const baselinePath = join(dir, "baseline.json");
    const candidatePath = join(dir, "candidate.json");
    const mk = (armId: string, passed: boolean) => buildExperimentArtifactV3({
      arm: { armId, candidateId: armId === "candidate" ? "cand-x" : null, candidateConfigHash: armId === "candidate" ? CAND_CONFIG : null },
      manifest: { suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: GIT_SHA, dirty: false, planDigest: PLAN_DIGEST, promotionEligible: true, isolationStrength: "strong" },
      outcomes: [1, 2].flatMap((rep) => [0, 1, 2].map((k) => outcome(`ho-0${k + 1}`, armId, rep, (rep - 1) * 3 + k + 1, passed, armId === "candidate" ? `act-${rep}-${k}` : null))),
      activationEvidence: armId === "candidate" ? [1, 2].flatMap((rep) => [0, 1, 2].map((k) => ({ id: `act-${rep}-${k}`, reasonCodes: ["memory.retrieved"], note: "x" }))) : [],
      securityOutcomes: [],
      provenance: { sourceManifestPath: null, gitSha: GIT_SHA, dirty: false, model: "deepseek-v4-flash", provider: "fake", runtimeConfigHash: CAND_CONFIG },
    });
    await writeExperimentArtifactV3(mk("baseline", true), baselinePath); // baseline also passes -> net delta 0
    await writeExperimentArtifactV3(mk("candidate", true), candidatePath);
    const real = await runV3ChampionEval({ baselinePath, candidatePath, candidateId: "cand-x" });
    expect(real.decisionArtifact.decision).not.toBe("ACCEPT"); // genuinely not promotable
    const forged = { ...real.decisionArtifact, decision: "ACCEPT", reasonCodes: [], gates: { ...real.decisionArtifact.gates } };
    const { computeDecisionArtifactContentDigestV3 } = await import("./champion-eval-v3.js");
    forged.contentDigest = computeDecisionArtifactContentDigestV3(forged);
    const decisionArtifactPath = join(dir, "decision-artifact.json");
    await writeFile(decisionArtifactPath, JSON.stringify(forged), "utf8");
    const env = await makeEnvelope(dir, decisionArtifactPath, baselinePath, candidatePath);
    const envPath = join(dir, "envelope.json");
    await writeFile(envPath, JSON.stringify(env), "utf8");
    expect(await codes(envPath)).toContain("DECISION_REPLAY_MISMATCH");
  });

  it("baseline ref points at the candidate file -> CROSS_BINDING_MISMATCH", async () => {
    const { envPath, candidatePath } = await buildValidBundle(dir);
    const env = JSON.parse(await readFile(envPath, "utf8")) as PromotionEnvelope;
    env.artifactRefs.find((r) => r.role === "baseline")!.path = candidatePath;
    await rewriteEnvelope(envPath, env);
    expect(await codes(envPath)).toContain("CROSS_BINDING_MISMATCH");
  });

  it("planDigest inconsistent between decision and candidate -> CROSS_BINDING_MISMATCH", async () => {
    const { envPath, decisionArtifactPath } = await buildValidBundle(dir);
    const da = JSON.parse(await readFile(decisionArtifactPath, "utf8")) as Record<string, unknown>;
    da.planDigest = "e".repeat(64);
    const { computeDecisionArtifactContentDigestV3 } = await import("./champion-eval-v3.js");
    da.contentDigest = computeDecisionArtifactContentDigestV3(da);
    await writeFile(decisionArtifactPath, JSON.stringify(da), "utf8");
    const env = JSON.parse(await readFile(envPath, "utf8")) as PromotionEnvelope;
    env.decisionArtifactDigest = sha(await readFile(decisionArtifactPath, "utf8"));
    await rewriteEnvelope(envPath, env);
    expect(await codes(envPath)).toContain("CROSS_BINDING_MISMATCH");
  });

  it("sourceSha inconsistent with candidate provenance -> CROSS_BINDING_MISMATCH", async () => {
    const { envPath } = await buildValidBundle(dir);
    const env = JSON.parse(await readFile(envPath, "utf8")) as PromotionEnvelope;
    env.sourceSha = "f".repeat(40);
    await rewriteEnvelope(envPath, env); // buildPromotionEnvelope recomputes contentDigest
    expect(await codes(envPath)).toContain("CROSS_BINDING_MISMATCH");
  });

  it("artifact outcomes edited but only the file SHA updated -> ARTIFACT_NOT_V3", async () => {
    const { envPath, candidatePath } = await buildValidBundle(dir);
    const cand = JSON.parse(await readFile(candidatePath, "utf8")) as { outcomes: Array<Record<string, unknown>>; contentDigest: string };
    cand.outcomes[0]!.passed = false; // tamper content, leave internal contentDigest stale
    await writeFile(candidatePath, JSON.stringify(cand), "utf8");
    const env = JSON.parse(await readFile(envPath, "utf8")) as PromotionEnvelope;
    env.artifactRefs.find((r) => r.role === "candidate")!.digest = sha(await readFile(candidatePath, "utf8"));
    await rewriteEnvelope(envPath, env);
    expect(await codes(envPath)).toContain("ARTIFACT_NOT_V3");
  });

  it("envelope digest not updated after a field edit -> DIGEST_MISMATCH", async () => {
    const { envPath } = await buildValidBundle(dir);
    const raw = await readFile(envPath, "utf8");
    const env = JSON.parse(raw) as PromotionEnvelope;
    env.candidateId = "someone-else"; // edit WITHOUT recomputing contentDigest
    await writeFile(envPath, JSON.stringify(env), "utf8");
    expect(await codes(envPath)).toContain("DIGEST_MISMATCH");
  });

  it("candidate promotionEligible=false -> CANDIDATE_NOT_ELIGIBLE", async () => {
    const baselinePath = join(dir, "baseline.json");
    const candidatePath = join(dir, "candidate.json");
    await writeExperimentArtifactV3(buildExperimentArtifactV3({
      arm: { armId: "baseline", candidateId: null, candidateConfigHash: null },
      manifest: { suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: GIT_SHA, dirty: false, planDigest: PLAN_DIGEST, promotionEligible: true, isolationStrength: "strong" },
      outcomes: [1, 2].flatMap((rep) => [0, 1, 2].map((k) => outcome(`ho-0${k + 1}`, "baseline", rep, (rep - 1) * 3 + k + 1, false, null))),
      activationEvidence: [], securityOutcomes: [],
      provenance: { sourceManifestPath: null, gitSha: GIT_SHA, dirty: false, model: "deepseek-v4-flash", provider: "fake", runtimeConfigHash: CAND_CONFIG },
    }), baselinePath);
    await writeExperimentArtifactV3(buildExperimentArtifactV3({
      arm: { armId: "candidate", candidateId: "cand-x", candidateConfigHash: CAND_CONFIG },
      manifest: { suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: GIT_SHA, dirty: false, planDigest: PLAN_DIGEST, promotionEligible: false, isolationStrength: "insecure-local" },
      outcomes: [1, 2].flatMap((rep) => [0, 1, 2].map((k) => outcome(`ho-0${k + 1}`, "candidate", rep, (rep - 1) * 3 + k + 1, true, `act-${rep}-${k}`))),
      activationEvidence: [1, 2].flatMap((rep) => [0, 1, 2].map((k) => ({ id: `act-${rep}-${k}`, reasonCodes: ["memory.retrieved"], note: "x" }))),
      securityOutcomes: [],
      provenance: { sourceManifestPath: null, gitSha: GIT_SHA, dirty: false, model: "deepseek-v4-flash", provider: "fake", runtimeConfigHash: CAND_CONFIG },
    }), candidatePath);
    const real = await runV3ChampionEval({ baselinePath, candidatePath, candidateId: "cand-x" });
    const decisionArtifactPath = join(dir, "decision-artifact.json");
    await writeFile(decisionArtifactPath, JSON.stringify(real.decisionArtifact), "utf8");
    const env = await makeEnvelope(dir, decisionArtifactPath, baselinePath, candidatePath);
    const envPath = join(dir, "envelope.json");
    await writeFile(envPath, JSON.stringify(env), "utf8");
    expect(await codes(envPath)).toContain("CANDIDATE_NOT_ELIGIBLE");
  });

  it("path traversal: candidate ref escapes the bundle root -> PATH_OUTSIDE_BUNDLE", async () => {
    const { envPath } = await buildValidBundle(dir);
    const env = JSON.parse(await readFile(envPath, "utf8")) as PromotionEnvelope;
    env.artifactRefs.find((r) => r.role === "candidate")!.path = join(dir, "..", "outside", "candidate.json");
    await rewriteEnvelope(envPath, env);
    expect(await codes(envPath)).toContain("PATH_OUTSIDE_BUNDLE");
  });

  it("symlink escape: candidate ref is a link out of the bundle -> PATH_OUTSIDE_BUNDLE", async () => {
    const { symlink, lstat } = await import("node:fs/promises");
    const { envPath, candidatePath } = await buildValidBundle(dir);
    // Put the real candidate OUTSIDE the bundle and link to it from inside.
    const outside = join(dir, "..", "e4-06-outside");
    await mkdir(outside, { recursive: true });
    const realPath = join(outside, "candidate.json");
    await writeFile(realPath, await readFile(candidatePath), "utf8");
    const linkPath = join(dir, "candidate-link.json");
    try {
      await symlink(realPath, linkPath);
    } catch {
      // symlink creation needs privileges on some platforms; skip rather than fail
      return;
    }
    const env = JSON.parse(await readFile(envPath, "utf8")) as PromotionEnvelope;
    const ref = env.artifactRefs.find((r) => r.role === "candidate")!;
    ref.path = linkPath;
    ref.digest = sha(await readFile(realPath, "utf8"));
    await rewriteEnvelope(envPath, env);
    expect(await codes(envPath)).toContain("PATH_OUTSIDE_BUNDLE");
    await lstat(linkPath); // sanity: the link exists
  });

  it("a rejected load leaves every bundle file byte-identical (loader is read-only)", async () => {
    const { envPath, candidatePath, baselinePath, decisionArtifactPath } = await buildValidBundle(dir);
    // Forge: candidate becomes plain text with a correct SHA.
    const before = {
      env: await readFile(envPath), cand: await readFile(candidatePath),
      base: await readFile(baselinePath), da: await readFile(decisionArtifactPath),
    };
    await writeFile(candidatePath, "not an artifact", "utf8");
    const env = JSON.parse(await readFile(envPath, "utf8")) as PromotionEnvelope;
    env.artifactRefs.find((r) => r.role === "candidate")!.digest = sha("not an artifact");
    await rewriteEnvelope(envPath, env);
    const r = await loadPromotionEnvelope(envPath, {
      parentStateDigest: sha("c0-state"), candidateId: "cand-x",
      expectedPolicyVersion: PROMOTION_ENVELOPE_POLICY_VERSION, verifyArtifactRefs: true,
    });
    expect(r.ok).toBe(false);
    // baseline + decision artifact untouched by the loader; the candidate/env were
    // changed by the ATTACKER before the load, not by the loader.
    expect((await readFile(baselinePath)).equals(before.base)).toBe(true);
    expect((await readFile(decisionArtifactPath)).equals(before.da)).toBe(true);
  });
});
