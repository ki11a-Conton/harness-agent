#!/usr/bin/env node
/**
 * E4-R99-A (T3) — `r97-validate-campaign.mjs`: re-derive a campaign's verdicts
 * from the artifacts the campaign itself left behind.
 *
 * WHY THIS EXISTS (plan §T3 怎么做 4/7, 怎么验收 5, and the delivery line)
 * ---------------------------------------------------------------------
 *   "交付实际可用的 campaign 验证命令，并写入 help/报告。优先扩展现有 validator."
 *   "修改/删除任意已关联原始报告或 resultHash，恢复及独立 validator 都非零退出."
 *   "worker 结束后原报告仍存在；validator 读的是本次 driver 的产物，没有另跑 R87
 *    replay 来代替验收."
 *
 * It REUSES the evaluation package's existing validator surface rather than
 * building a second verification system (which the plan forbids):
 *
 *   - `readR97CampaignHeader` / `readR97LedgerFile` establish that this really is
 *     an established campaign root, and that the budget it describes is present.
 *   - `readR97ExecutionStateFile` reads the durable per-unit records.
 *   - `verifyCampaignEvidence` walks the evidence chain for every terminal unit.
 *
 * The last clause above is why this does NOT re-run the arms: the validator reads
 * THE ARTIFACTS THIS CAMPAIGN PRODUCED. A validator that re-executed the cases
 * would be testing a fresh run, not the one whose numbers were reported.
 *
 * EXIT CODES: 0 = the campaign verifies · 1 = it does not · 2 = usage/config.
 * A non-zero exit is the CONTRACT the acceptance criterion names, so every
 * refusal path here exits 1 with a stable code rather than a stack trace.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");

export const VALIDATOR_VERSION = "e4-r99-campaign-validator-v1";

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_CONFIG = 2;

/** Stable codes, so a caller (or CI) can assert on WHICH check failed. */
export const VALIDATOR_CODES = {
  ROOT_MISSING: "VALIDATOR_ROOT_MISSING",
  NO_HEADER: "VALIDATOR_NO_CAMPAIGN_HEADER",
  NO_LEDGER: "VALIDATOR_NO_LEDGER",
  NO_STATE: "VALIDATOR_NO_EXECUTION_STATE",
  STATE_CORRUPT: "VALIDATOR_STATE_CORRUPT",
  NO_RECORDS: "VALIDATOR_NO_TERMINAL_RECORDS",
  EVIDENCE_BROKEN: "VALIDATOR_EVIDENCE_BROKEN",
  RESULT_HASH_MISSING: "VALIDATOR_RESULT_HASH_MISSING",
  DETAIL_MISSING: "VALIDATOR_DETAIL_MISSING",
  USAGE: "VALIDATOR_USAGE",
};

/**
 * Validate one campaign root.
 *
 * Returns a report object and never throws for a bad campaign: a validator that
 * crashed on damaged input would be indistinguishable from one that found a
 * problem, and only one of those is a verdict.
 */
export async function validateCampaignRoot(root, opts = {}) {
  const dir = resolve(root);
  const evaluation = opts.evaluation ?? (await loadEvaluation());
  const codes = [];
  const checks = [];
  const check = (code, passed, detail) => {
    checks.push({ code, passed, detail });
    if (!passed) codes.push(code);
  };

  // ---- 1. The root, the header and the ledger. ---------------------------
  const header = await evaluation.readR97CampaignHeader(dir).catch((err) => {
    check(VALIDATOR_CODES.NO_HEADER, false, `the campaign header could not be read: ${errText(err)}`);
    return undefined;
  });
  if (header === undefined) return finish(dir, codes, checks, null);
  check(
    VALIDATOR_CODES.NO_HEADER,
    header !== null,
    header === null
      ? `${dir} holds no campaign header, so it is not an established campaign root`
      : `campaign ${header.campaignId} (plan ${header.planDigest}, grant ${header.campaignModelCalls})`,
  );
  if (header === null) return finish(dir, codes, checks, null);

  const ledger = await evaluation.readR97LedgerFile(dir).catch(() => null);
  // `committed` is a DERIVED figure, not a stored field: it is recomputed from
  // the entries by the ledger's own view function, so the validator asks for the
  // view rather than reading a number that does not exist on the file.
  const budget = ledger === null ? null : evaluation.viewOfR97Ledger(ledger);
  check(
    VALIDATOR_CODES.NO_LEDGER,
    ledger !== null,
    ledger === null
      ? `${dir} holds a campaign header but no budget ledger — the budget that paid for these results is gone`
      : `budget ledger present: ${budget.committed} committed, ${budget.remaining} of ${budget.granted} remaining`,
  );

  // ---- 2. The durable records. ------------------------------------------
  const state = await evaluation.readR97ExecutionStateFile(dir).catch((err) => {
    check(VALIDATOR_CODES.STATE_CORRUPT, false, `the execution state could not be read: ${errText(err)}`);
    return undefined;
  });
  if (state === undefined) return finish(dir, codes, checks, null);
  check(
    VALIDATOR_CODES.NO_STATE,
    state !== null,
    state === null
      ? `${dir} holds no execution state — an established campaign always has one, so its absence is a LOSS`
      : `execution state present with ${state.records.length} record(s)`,
  );
  if (state === null) return finish(dir, codes, checks, null);

  // ---- 3. Terminal records and their result hashes. ---------------------
  const terminal = state.records.filter(
    (r) => (r.status === "completed" || r.status === "failed") && r.reconciledForRetry !== true,
  );
  const unhashed = terminal.filter((r) => typeof r.resultHash !== "string" || r.resultHash === "");
  check(
    VALIDATOR_CODES.RESULT_HASH_MISSING,
    unhashed.length === 0,
    unhashed.length === 0
      ? `every terminal record carries a resultHash (${terminal.length} record(s))`
      : `${unhashed.length} terminal record(s) carry no resultHash: ${unhashed.slice(0, 5).map((r) => `${r.arm}/${r.caseId}`).join(", ")}`,
  );
  // The verdict TEXT must be present as well as the hash.
  //
  // `verifyCampaignEvidence` checks that a detail AGREES with the evidence, but it
  // can only compare a detail that exists. Deleting the field would dodge the
  // comparison and turn a pass into `unitCategoryOf(undefined) === null` — i.e. a
  // unit that "measured nothing" rather than a forged pass. That is still a silent
  // erasure of a result, so presence is enforced HERE, at the same level as
  // `resultHash` presence, for the same reason.
  const untexted = terminal.filter((r) => typeof r.detail !== "string" || r.detail === "");
  check(
    VALIDATOR_CODES.DETAIL_MISSING,
    untexted.length === 0,
    untexted.length === 0
      ? `every terminal record carries its verdict text (${terminal.length} record(s))`
      : `${untexted.length} terminal record(s) carry no verdict text, so the aggregate that reads it cannot be reconciled: ${untexted.slice(0, 5).map((r) => `${r.arm}/${r.caseId}`).join(", ")}`,
  );
  check(
    VALIDATOR_CODES.NO_RECORDS,
    terminal.length > 0,
    terminal.length > 0
      ? `${terminal.length} terminal record(s) to re-derive`
      : "the campaign holds no terminal records, so it proves nothing — an empty campaign is never VALID",
  );

  // ---- 4. The evidence chain, for every terminal unit. -----------------
  const evidence = await evaluation.verifyCampaignEvidence(dir, terminal);
  check(VALIDATOR_CODES.EVIDENCE_BROKEN, evidence.ok, evidence.detail);

  return finish(dir, codes, checks, {
    campaignId: header.campaignId,
    planDigest: header.planDigest,
    campaignModelCalls: header.campaignModelCalls,
    committed: budget === null ? null : budget.committed,
    records: state.records.length,
    terminal: terminal.length,
    evidenceChecked: evidence.checked,
    evidenceFailures: evidence.failures,
  });
}

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

function finish(dir, codes, checks, summary) {
  const unique = [...new Set(codes)].sort();
  return {
    validatorVersion: VALIDATOR_VERSION,
    root: dir,
    ok: unique.length === 0,
    reasonCodes: unique,
    checks,
    summary,
  };
}

async function loadEvaluation() {
  const url = pathToFileURL(join(REPO_ROOT, "packages", "evaluation", "dist", "index.js")).href;
  try {
    return await import(url);
  } catch (err) {
    throw new Error(
      `E4-R99: the built evaluation package is required at ${url} — run \`pnpm build\` first (${errText(err)})`,
    );
  }
}

const USAGE =
  "usage: node scripts/e4/r97-validate-campaign.mjs --campaign <dir> [--out <report.json>]\n" +
  "\n" +
  "Re-derives every verdict in an established campaign from the artifacts it left\n" +
  "behind (campaign header + budget ledger + execution state + per-attempt\n" +
  "evidence). It never runs a model and never re-executes a case.\n" +
  "\n" +
  "exit 0 — the campaign verifies; every terminal record is backed by intact,\n" +
  "         matching evidence.\n" +
  "exit 1 — it does not (see reasonCodes; e.g. VALIDATOR_EVIDENCE_BROKEN).\n" +
  "exit 2 — usage or configuration error.\n";

export async function main(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  const campaign = flag("--campaign");
  const out = flag("--out");
  if (campaign === undefined) {
    process.stderr.write(USAGE);
    return EXIT_CONFIG;
  }

  const report = await validateCampaignRoot(campaign);
  if (out !== undefined) {
    await mkdir(dirname(resolve(out)), { recursive: true });
    await writeFile(resolve(out), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? EXIT_OK : EXIT_REFUSED;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
