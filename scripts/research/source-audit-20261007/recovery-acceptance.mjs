/** Real SIGKILL/dead-owner recovery against the production checkpoint, lock,
 * call ledger and cost budget. Synthetic offline journals, no model/provider. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { openBudgets } from "../agent-next7-20261006/execution-budget.mjs";
import { readJson, writeJson } from "../agent-next7-20261006/execution-common.mjs";
import { recordCheckpoint, sealRecoveredAttempt, startAttempt, validateResumeAttempts } from "../agent-next7-20261006/attempt-checkpoint.mjs";
import { withR97CampaignLock } from "../../../packages/evaluation/dist/index.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const prereg = readJson(join(root, "docs/evidence/agent-next7-20261006/main-preregistration.json"));
const binding = { pricing: { amountUsdMicros: 0 } };

if (process.argv[2] === "--child") {
  const [, , , out, mode, campaignDigest] = process.argv;
  await withR97CampaignLock(out, async () => {
    await mkdir(join(out, "requests")); await mkdir(join(out, "attempts", "0001"), { recursive: true });
    const header = { schemaVersion: "offline-fault-injection-v1", campaignDigest, mode };
    writeJson(join(out, "campaign-header.json"), header);
    const budgets = await openBudgets(out, binding, prereg, campaignDigest);
    const attempt = join(out, "attempts", "0001"); startAttempt(out, attempt, header);
    const reservation = await budgets.ledger.reserve("offline-fixture", 1); assert(reservation.ok);
    if (mode !== "unknown") {
      await budgets.ledger.commit(reservation.reservationId, 1);
      writeJson(join(out, "requests", "0000001.json"), { evidenceKind: "SYNTHETIC_OFFLINE", paidProviderCalls: 0 });
    }
    recordCheckpoint(out, attempt);
    process.stdout.write("READY\n");
    await new Promise(() => { setInterval(() => {}, 1000); });
  });
} else {
  const temporary = await mkdtemp(join(tmpdir(), "audit-crash-recovery-")); const records = [];
  try {
    for (const mode of ["committed", "unknown", "tampered"]) {
      const out = join(temporary, mode); await mkdir(out); const campaignDigest = randomBytes(32).toString("hex");
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", out, mode, campaignDigest], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
      const closed = once(child, "close"); let diagnostics = "";
      child.stderr.on("data", (chunk) => { diagnostics += chunk; });
      let timer;
      try {
        await Promise.race([
          new Promise((resolve) => child.stdout.on("data", (chunk) => { if (chunk.toString().includes("READY")) resolve(); })),
          closed.then(() => { throw new Error(`child exited before checkpoint: ${diagnostics}`); }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`checkpoint timeout: ${diagnostics}`)), 30_000); }),
        ]);
      } finally { clearTimeout(timer); child.kill("SIGKILL"); await closed; }
      const header = readJson(join(out, "campaign-header.json"));
      const before = await readFile(join(out, "budget", "budget-ledger.json"));
      await withR97CampaignLock(out, async () => {
        if (mode === "tampered") {
          await writeFile(join(out, "requests", "0000001.json"), "tampered");
          assert.throws(() => validateResumeAttempts(out, header), /RESUME_UNCHECKPOINTED_DISPATCH/);
          assert.deepEqual(await readFile(join(out, "budget", "budget-ledger.json")), before);
          records.push({ id: mode, passed: true, refusedBeforeBudgetMutation: true }); return;
        }
        const attempt = validateResumeAttempts(out, header); assert(attempt);
        if (mode === "unknown") {
          await assert.rejects(openBudgets(out, binding, prereg, campaignDigest, { resume: true }), /UNKNOWN_DISPATCH_REQUIRES_RECONCILIATION/);
          const ledger = readJson(join(out, "budget", "budget-ledger.json"));
          assert.equal(ledger.entries.length, 1); assert.equal(ledger.entries[0].status, "unknown");
          records.push({ id: mode, passed: true, unknownCalls: 1, refundedCalls: 0, newDispatches: 0 }); return;
        }
        const resumed = await openBudgets(out, binding, prereg, campaignDigest, { resume: true });
        const view = await resumed.ledger.view(); assert.equal(view.committed, 1); assert.equal(view.remaining, view.granted - 1);
        sealRecoveredAttempt(out, attempt, header);
        assert.equal(validateResumeAttempts(out, header), undefined);
        assert.equal(readJson(join(attempt, "recovery-receipt.json")).status, "ABANDONED_AFTER_CHECKPOINT");
        records.push({ id: mode, passed: true, deadOwnerLockReclaimed: true, committed: view.committed, remaining: view.remaining, grantReset: false, fabricatedCompletion: false });
      });
    }
    const result = { schemaVersion: "source-audit-recovery-acceptance-v1", paidProviderCalls: 0, modelCalls: 0, evidenceKind: "OFFLINE_FAULT_INJECTION", records };
    const output = process.env.HARNESS_SOURCE_AUDIT_OUT ?? join(root, ".ci/source-fix-20261007"); await mkdir(output, { recursive: true });
    await writeFile(join(output, "recovery-acceptance-results.json"), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
