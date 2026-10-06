import { join, resolve } from "node:path";
import { arg, EVIDENCE, main, REPO } from "./execution-common.mjs";
import { verifyArchive } from "./campaign-evidence.mjs";

await main(async () => {
  const role = arg("experiment", "main");
  const judgment = await verifyArchive(role, resolve(arg("archive", join(EVIDENCE, "execution", role))),
    resolve(arg("campaign", join(REPO, ".ci/n7", role))), resolve(arg("judge", join(REPO, ".ci/n7", `${role}-judge`)));
  process.stdout.write(`N7 archive verified: ${role} ${judgment.verdict}\n`);
});
