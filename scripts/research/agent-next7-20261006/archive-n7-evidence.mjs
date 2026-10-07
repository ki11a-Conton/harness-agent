/** Archive immutable raw digests + recomputed judgment; never promote champion. */
import { copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { arg, assert, EVIDENCE, freshDirectory, main, readJson, REPO, stable, verifyIndex, writeIndex, writeJson } from "./execution-common.mjs";
import { loadJudgment, rawManifestFiles } from "./campaign-evidence.mjs";
import { packRawBundle } from "./raw-bundle.mjs";

await main(async () => {
  const role = arg("experiment", "main");
  const campaign = resolve(arg("campaign", join(REPO, ".ci/n7", role)));
  const judge = resolve(arg("judge", join(REPO, ".ci/n7", `${role}-judge`)));
  verifyIndex(judge);
  const { data, judgment, attempt } = await loadJudgment(role, campaign);
  assert(stable(readJson(join(judge, "judge-result.json"))) === stable(judgment), "FORGED_JUDGMENT");
  const out = freshDirectory(resolve(arg("out", join(EVIDENCE, "execution", role))));
  // Root namespaces keep e.g. artifact-index.json from colliding in the manifest.
  writeJson(join(out, "RAW-MANIFEST.json"), { schemaVersion: "n7-raw-manifest-v1", experiment: role,
    files: rawManifestFiles(campaign, judge),
    note: "All indexed raw bytes are preserved in raw-evidence.ndjson.gz; RAW-BUNDLE.json binds the compressed and original bytes." });
  for (const file of ["execution-binding.json", "execution-identity.json", "campaign-header.json", "soak-result.json"]) copyFileSync(join(campaign, file), join(out, file));
  copyFileSync(join(attempt, "campaign-result.json"), join(out, "campaign-result.json"));
  writeJson(join(out, "judge-result.json"), judgment);
  const arm = record => record === null || record === undefined ? null : {
    arm: record.arm, valid: record.valid, status: record.outcome?.status, grade: record.outcome?.grade,
    metrics: record.outcome?.metrics, modelCallAttempts: record.modelCallAttempts,
    securityOutcome: record.outcome?.securityOutcome, activationEvidenceV2: record.outcome?.activationEvidenceV2 };
  writeJson(join(out, "pairs-summary.json"), { experiment: role, evidenceKind: data.header.evidenceKind,
    finalized: data.finalized.map(p => ({ ...p, baseline: arm(p.baseline), candidate: arm(p.candidate) })),
    partial: data.partial.map(p => ({ ...p, baseline: arm(p.baseline), candidate: arm(p.candidate) })) });
  await packRawBundle(out, campaign, judge);
  writeIndex(out);
  process.stdout.write(`N7 archived ${role}: ${judgment.verdict}; champion unchanged\n`);
});
