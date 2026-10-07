/** Open attempts have a durable checkpoint; sealed attempts retain immutable
 * indexes. Recovery never resets a budget or trusts an unrecorded dispatch. */
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert, campaignFiles, digest, readJson, stable, verifyCampaignRaw, verifyIndex, writeIndex, writeJson } from "./execution-common.mjs";

const coreFiles = (root) => campaignFiles(root).filter((file) => !file.path.startsWith("attempts/"));

export function startAttempt(root, attempt, header) {
  const state = { schemaVersion: "n7-open-attempt-v1", headerDigest: digest(header), initialFiles: coreFiles(root) };
  writeJson(join(attempt, "attempt-state.json"), state);
  recordCheckpoint(root, attempt);
}

export function recordCheckpoint(root, attempt) {
  const state = readJson(join(attempt, "attempt-state.json"));
  const body = { schemaVersion: "n7-attempt-checkpoint-v1", headerDigest: state.headerDigest, files: coreFiles(root) };
  const checkpoint = { ...body, checkpointDigest: digest(body) };
  const temporary = join(attempt, "checkpoint.json.tmp");
  const fd = openSync(temporary, "w", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(checkpoint, null, 2)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, join(attempt, "checkpoint.json"));
}

function verifyOpen(root, attempt, header) {
  const state = readJson(join(attempt, "attempt-state.json"));
  assert(state.schemaVersion === "n7-open-attempt-v1" && state.headerDigest === digest(header), "RESUME_ATTEMPT_IDENTITY_DRIFT");
  let expected = state.initialFiles;
  if (existsSync(join(attempt, "checkpoint.json"))) {
    const checkpoint = readJson(join(attempt, "checkpoint.json"));
    const { checkpointDigest, ...body } = checkpoint;
    assert(body.schemaVersion === "n7-attempt-checkpoint-v1" && body.headerDigest === state.headerDigest && digest(body) === checkpointDigest, "RESUME_CHECKPOINT_DRIFT");
    expected = checkpoint.files;
  }
  // A dispatch after the last committed checkpoint is not adopted blindly.
  // Budget-ledger reconciliation is still mandatory before any new request.
  assert(stable(expected) === stable(coreFiles(root)), "RESUME_UNCHECKPOINTED_DISPATCH");
}

export function validateResumeAttempts(root, header) {
  const names = readdirSync(join(root, "attempts")).sort();
  assert(names.length > 0 && names.every((name) => /^\d{4,}$/.test(name)), "RESUME_EVIDENCE_MISSING");
  let open;
  for (const [index, name] of names.entries()) {
    const attempt = join(root, "attempts", name);
    if (existsSync(join(attempt, "artifact-index.json"))) verifyIndex(attempt);
    else {
      assert(index === names.length - 1 && existsSync(join(attempt, "attempt-state.json")), "RESUME_CHECKPOINT_MISSING");
      verifyOpen(root, attempt, header);
      open = attempt;
    }
  }
  const latest = join(root, "attempts", names.at(-1));
  if (open === undefined) {
    if (existsSync(join(latest, "recovery-receipt.json"))) verifyOpen(root, latest, header);
    else verifyCampaignRaw(root, latest);
  }
  return open;
}

export function sealRecoveredAttempt(root, attempt, header) {
  verifyOpen(root, attempt, header);
  writeJson(join(attempt, "recovery-receipt.json"), {
    schemaVersion: "n7-recovered-attempt-v1", status: "ABANDONED_AFTER_CHECKPOINT",
    headerDigest: digest(header), recoveredAt: new Date().toISOString(),
    note: "Not a completed experiment; verified journals and existing budgets are resumed by a new attempt.",
  });
  writeIndex(attempt);
}
