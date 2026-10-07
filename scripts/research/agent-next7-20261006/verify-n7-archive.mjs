import { join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { arg, assert, EVIDENCE, flag, main, REPO } from "./execution-common.mjs";
import { verifyArchive } from "./campaign-evidence.mjs";
import { unpackRawBundle } from "./raw-bundle.mjs";
import { verifyHistoricalArchive } from "./historical-archive.mjs";

await main(async () => {
  const role = arg("experiment", "main");
  const archive = resolve(arg("archive", join(EVIDENCE, "execution", role)));
  const campaign = arg("campaign"), judge = arg("judge");
  assert(Boolean(campaign) === Boolean(judge), "BOTH_RAW_ROOTS_REQUIRED");
  let scratch;
  try {
    let raw;
    if (campaign) raw = { campaign: resolve(campaign), judge: resolve(judge) };
    else { scratch = await mkdtemp(join(tmpdir(), "n7-verify-")); raw = await unpackRawBundle(archive, join(scratch, "raw")); }
    const historical = flag("historical-source") ? await verifyHistoricalArchive({ role, archive, ...raw, sourceRepo: arg("source-repo", REPO) }) : undefined;
    const judgment = historical?.judgment ?? await verifyArchive(role, archive, raw.campaign, raw.judge);
    process.stdout.write(`N7 archive verified: ${role} ${judgment.verdict}\n`);
    if (historical) process.stdout.write(`Recorded source rebuilt and verified: ${historical.sourceSha}; paidCalls=0\n`);
  } finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
});
