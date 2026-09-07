/**
 * E3-14: validate a V3 artifact pair via runV3ChampionEval (dry check).
 * Usage: node apps/cli/scripts/validate-v3.mjs <baseline> <candidate> [--json]
 */
import { readFile } from "node:fs/promises";

const [base, cand] = process.argv.slice(2);
if (!base || !cand) {
  console.error("usage: validate-v3.mjs <baseline.json> <candidate.json>");
  process.exit(1);
}
const { runV3ChampionEval } = await import("@ar/evaluation");
const r = await runV3ChampionEval({
  baselinePath: base,
  candidatePath: cand,
  candidateId: "adaptive_recovery_v2",
});
const out = {
  decision: r.envelope.decision,
  reasonCodes: r.envelope.reasonCodes,
  explanation: r.envelope.explanation,
  statistics: r.envelope.statistics,
  gates: r.envelope.gates,
};
console.log(JSON.stringify(out, null, 2));
