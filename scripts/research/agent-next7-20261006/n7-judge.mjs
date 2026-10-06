/** Adjudicate the latest indexed N7 attempt. Archive failed attempts honestly. */
import { join, resolve } from "node:path";
import { arg, freshDirectory, main, REPO, writeIndex, writeJson } from "./execution-common.mjs";
import { loadJudgment } from "./campaign-evidence.mjs";

await main(async () => {
  const role = arg("experiment", "main");
  const root = resolve(arg("campaign", join(REPO, ".ci/n7", role)));
  const { judgment } = await loadJudgment(role, root);
  const out = freshDirectory(resolve(arg("out", join(REPO, ".ci/n7", `${role}-judge`))));
  writeJson(join(out, "judge-result.json"), judgment);
  writeIndex(out);
  process.stdout.write(`N7 judge ${role}: ${judgment.verdict}; promotion=${judgment.promotion}\n`);
  for (const g of judgment.gates) process.stdout.write(`${g.passed ? "PASS" : "FAIL"} ${g.gate}\n`);
  process.exitCode = judgment.verdict === "ALL_GATES_PASSED" ? 0 : 1;
});
