/**
 * E4-R02 — the evaluator must use the SAME strict validation as the loader.
 *
 * F03: a V3 artifact whose `contentDigest` had been overwritten (here: 64
 * zeros) was rejected by `loadExperimentArtifactV3` but still produced
 * `decision: ACCEPT` with `digestValid: true` from `runV3ChampionEval`, because
 * the evaluator only JSON-parsed its inputs and hardcoded the flag. A promotion
 * decision must never be computed from unverified bytes.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExperimentArtifactV3, writeExperimentArtifactV3 } from "./artifact-v3/index.js";
import { runV3ChampionEval, loadV3ArtifactPair } from "./champion-eval-v3.js";
import type { CaseOutcomeV3 } from "./artifact-v3/index.js";

function outcome(caseId: string, armId: "baseline" | "candidate", rep: number, order: number, passed: boolean, configHash: string | null, activationRef: string | null): CaseOutcomeV3 {
  return {
    caseId, suite: "holdout", armId, attempt: 1, repetition: rep, order, passed,
    grade: passed ? "good" : "poor", terminationReason: "verified_complete",
    verificationPassed: passed, failureCategory: null,
    inputTokens: 1000, outputTokens: 500, costUsd: 0.01, latencyMs: 100, toolCalls: 3,
    recoveryDecisions: [], activationRef, securityOutcomeRef: null,
    outputDigest: null, workspaceDigest: null, judgeVersion: "1.0.0",
    evaluationContextHash: "a".repeat(64), candidateConfigHash: configHash,
  } as unknown as CaseOutcomeV3;
}

/** 3 cases x 2 reps; candidate wins every paired sample (a genuine ACCEPT). */
function armArtifact(armId: "baseline" | "candidate", configHash: string | null) {
  const rows: CaseOutcomeV3[] = [];
  let order = 1;
  for (const rep of [1, 2]) {
    for (let c = 1; c <= 3; c += 1) {
      const candPassed = true;
      const basePassed = c === 1 ? false : true;
      const passed = armId === "candidate" ? candPassed : basePassed;
      rows.push(outcome(`ho-0${c}`, armId, rep, order++, passed, configHash,
        armId === "candidate" ? `act-${rep}-${c}` : null));
    }
  }
  return buildExperimentArtifactV3({
    arm: { armId, candidateId: armId === "candidate" ? "cand-x" : null, candidateConfigHash: configHash },
    manifest: {
      suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: "c".repeat(40), dirty: false,
      planDigest: "d".repeat(64), promotionEligible: true, isolationStrength: "strong", repeat: 2,
    },
    outcomes: rows,
    activationEvidence: armId === "candidate"
      ? [1, 2].flatMap((rep) => [1, 2, 3].map((c) => ({ id: `act-${rep}-${c}`, reasonCodes: ["memory.retrieved"], note: "activated" })))
      : [],
    securityOutcomes: [],
    provenance: { sourceManifestPath: null, gitSha: "c".repeat(40), dirty: false, model: "m", provider: "fake", runtimeConfigHash: "e".repeat(64) },
  });
}

let dir = "";
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "e4-r02-")); });
afterAll(async () => { if (dir !== "") await rm(dir, { recursive: true, force: true }); });

async function writeCleanPair(): Promise<{ b: string; c: string }> {
  const b = join(dir, "baseline.json");
  const c = join(dir, "candidate.json");
  await writeExperimentArtifactV3(armArtifact("baseline", null), b);
  await writeExperimentArtifactV3(armArtifact("candidate", "b".repeat(64)), c);
  return { b, c };
}

describe("E4-R02 evaluator and strict loader agree", () => {
  it("control: a clean pair is accepted by the evaluator", async () => {
    const { b, c } = await writeCleanPair();
    const r = await runV3ChampionEval({ baselinePath: b, candidatePath: c, candidateId: "cand-x" });
    expect(r.decisionArtifact.decision).toBe("ACCEPT");
  });

  it("F03: a zeroed candidate contentDigest is rejected by BOTH loader and evaluator", async () => {
    const { b, c } = await writeCleanPair();
    const art = JSON.parse(await readFile(c, "utf8")) as { contentDigest: string };
    art.contentDigest = "0".repeat(64);
    await writeFile(c, JSON.stringify(art), "utf8");

    // (1) the strict loader already rejects it — this half passed before R02.
    const { loadExperimentArtifactV3 } = await import("./artifact-v3/index.js");
    await expect(loadExperimentArtifactV3(c)).rejects.toThrow(/CONTENT_DIGEST_MISMATCH|contentDigest/);

    // (2) the evaluator must refuse too, not silently proceed to ACCEPT.
    await expect(runV3ChampionEval({ baselinePath: b, candidatePath: c, candidateId: "cand-x" })).rejects.toThrow();
    await expect(loadV3ArtifactPair(b, c)).rejects.toThrow();
  });

  it("F03: tampering a persisted summary is rejected by both readers", async () => {
    const { b, c } = await writeCleanPair();
    const art = JSON.parse(await readFile(c, "utf8")) as { summary: { passed: number } };
    art.summary.passed = 999; // forge the headline count
    await writeFile(c, JSON.stringify(art), "utf8");
    const { loadExperimentArtifactV3 } = await import("./artifact-v3/index.js");
    await expect(loadExperimentArtifactV3(c)).rejects.toThrow();
    await expect(runV3ChampionEval({ baselinePath: b, candidatePath: c, candidateId: "cand-x" })).rejects.toThrow();
  });

  it("F03: a dangling activation ref is rejected by both readers", async () => {
    const { b, c } = await writeCleanPair();
    const art = JSON.parse(await readFile(c, "utf8")) as { outcomes: { activationRef: string | null }[] };
    art.outcomes[0]!.activationRef = "ghost-not-in-evidence";
    await writeFile(c, JSON.stringify(art), "utf8");
    const { loadExperimentArtifactV3 } = await import("./artifact-v3/index.js");
    await expect(loadExperimentArtifactV3(c)).rejects.toThrow();
    await expect(runV3ChampionEval({ baselinePath: b, candidatePath: c, candidateId: "cand-x" })).rejects.toThrow();
  });
});
