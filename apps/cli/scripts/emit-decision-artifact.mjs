/**
 * E3-14 post-eval: run the strict V3 champion eval and PERSIST the full
 * DecisionArtifactV3 to disk (the CLI only prints its digests).
 *
 * Run from apps/cli (so @ar/evaluation resolves via the junction):
 *   node scripts/emit-decision-artifact.mjs <baseline.json> <candidate.json> [candidateId] [outPath]
 *
 * Writes: <outPath> (default: alongside baseline as decision-artifact.json)
 * Prints: JSON summary { decision, reasonCodes, contentDigest, outPath }
 */
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const { runV3ChampionEval } = await import("@ar/evaluation");

const [baselineArg, candidateArg, candidateIdArg, outArg] = process.argv.slice(2);
if (!baselineArg || !candidateArg) {
  console.error("usage: node scripts/emit-decision-artifact.mjs <baseline.json> <candidate.json> [candidateId] [outPath]");
  process.exit(1);
}
const baselinePath = resolve(baselineArg);
const candidatePath = resolve(candidateArg);
const candidateId = candidateIdArg ?? "adaptive_recovery_v2";
const outPath = outArg ?? join(dirname(baselinePath), "decision-artifact.json");

const res = await runV3ChampionEval({ baselinePath, candidatePath, candidateId });
const artifact = res.decisionArtifact;

await writeFile(outPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");

console.log(JSON.stringify({
  decision: artifact.decision,
  reasonCodes: artifact.reasonCodes,
  schemaVersion: artifact.schemaVersion,
  policyVersion: artifact.policyVersion,
  candidateId: artifact.candidateId,
  planDigest: artifact.planDigest,
  baselineArtifactDigest: artifact.baselineArtifactDigest,
  candidateArtifactDigest: artifact.candidateArtifactDigest,
  contentDigest: artifact.contentDigest,
  statistics: artifact.statistics,
  gates: artifact.gates,
  outPath,
}, null, 2));
