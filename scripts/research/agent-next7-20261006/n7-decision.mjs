/** Read both indexed raw campaigns and recompute their joint N7 decision. */
import { join, resolve } from "node:path";
import { arg, freshDirectory, main, REPO, writeIndex, writeJson } from "./execution-common.mjs";
import { loadJudgment } from "./campaign-evidence.mjs";
import { combineJudgments } from "./n7-decision-core.mjs";

await main(async () => {
  const mainCampaign = resolve(arg("main", join(REPO, ".ci/n7/main")));
  const holdoutCampaign = resolve(arg("holdout", join(REPO, ".ci/n7/holdout")));
  const mainResult = await loadJudgment("main", mainCampaign);
  const holdoutResult = await loadJudgment("holdout", holdoutCampaign);
  const decision = combineJudgments(mainResult.judgment, holdoutResult.judgment);
  const out = freshDirectory(resolve(arg("out", join(REPO, ".ci/n7/joint-decision"))));
  writeJson(join(out, "main-judge-result.json"), mainResult.judgment);
  writeJson(join(out, "holdout-judge-result.json"), holdoutResult.judgment);
  writeJson(join(out, "decision.json"), decision);
  writeIndex(out);
  process.stdout.write(`N7 joint decision: ${decision.verdict}; promotion=${decision.promotion}\n`);
  process.exitCode = decision.verdict === "BOTH_EXPERIMENT_GATES_PASSED" ? 0 : 1;
});
