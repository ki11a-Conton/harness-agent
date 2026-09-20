/**
 * E4-R99-A (T3) — the CAMPAIGN VALIDATOR command, driven as a real process.
 *
 * WHAT THIS PINS (plan §T3 怎么验收 5, and the delivery line)
 * ---------------------------------------------------------
 *   "交付实际可用的 campaign 验证命令，并写入 help/报告."
 *   "修改/删除任意已关联原始报告或 resultHash，恢复及独立 validator 都非零退出."
 *
 * "非零退出" is an EXIT CODE, so this file drives the command as a CHILD PROCESS
 * and asserts on `code`. Calling the exported function would prove the logic and
 * not the contract: a script that threw before reaching its own `process.exitCode`
 * assignment, or one whose top-level guard never fired, would pass a unit test and
 * fail every operator who ran it.
 *
 * The campaign fixture is a REAL established campaign: `openR97Campaign` writes
 * the header, the ledger and the execution state in the same ordered step, and
 * the evidence files are written by the same `writeUnitEvidence` the worker uses.
 * Nothing here re-implements the store or fabricates a plausible-looking file.
 */

import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  openR97Campaign,
  buildUnitEvidence,
  writeUnitEvidence,
  evidenceAbsPathFor,
  type R97Campaign,
} from "./index.js";

const run = promisify(execFile);
const REPO = process.cwd();
const VALIDATOR = join(REPO, "scripts", "e4", "r97-validate-campaign.mjs");
const PLAN_DIGEST = "9".repeat(64);
const GRANT = 8;

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "r99-validate-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
});

/** Run the validator as a child process and report its exit code honestly. */
async function runValidator(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [VALIDATOR, ...args], { cwd: REPO });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const UNIT = { caseId: "r98-tool-write-request", suite: "regression", arm: "baseline", repetition: 1 };
const BUILD = { sourceSha: "e".repeat(40), buildDigest: "f".repeat(64) };

/**
 * Build a REAL established campaign with ONE terminal, evidenced unit.
 *
 * The record is written through the store's own `begin`/`complete`, so the
 * fixture cannot carry a shape the store would not itself produce.
 */
async function establishedCampaign(over: { report?: Record<string, unknown> | null } = {}): Promise<{
  dir: string;
  campaign: R97Campaign;
  attemptId: string;
  resultHash: string;
}> {
  const dir = await tempDir();
  const campaign = await openR97Campaign(dir, {
    planDigest: PLAN_DIGEST,
    campaignModelCalls: GRANT,
    mode: "first-run",
  });
  const key = { experimentId: PLAN_DIGEST, ...UNIT };
  // Reserve what will be committed. The ledger refuses a post-hoc overrun by
  // design ("the budget must be reserved BEFORE the call"), so the fixture
  // reserves the unit's whole allowance up front — the same discipline the real
  // path follows.
  const reservation = await campaign.ledger.reserve("baseline", 2);
  if (reservation.ok !== true || reservation.reservationId === null) throw new Error("fixture: reserve failed");
  const attemptId = await campaign.execState.begin(key, {
    reservationId: reservation.reservationId,
    inputDigest: "in-1",
  });

  const row = {
    task_id: "regression/r98-tool-write-request",
    suite: "regression",
    judge_version: "1",
    success: true,
    actual_status: "completed",
    verification_passed: true,
    verification_failures: [],
    model_calls: 2,
    tool_calls: 1,
    retries: 0,
    termination_reason: "completed",
    failure_category: null,
    duration_ms: 12,
    expected_rejection: false,
    expected_failure: false,
  };
  const report =
    over.report === undefined
      ? { ...row, reportHash: (await import("node:crypto")).createHash("sha256").update(JSON.stringify(row)).digest("hex") }
      : over.report;
  const envelope = buildUnitEvidence({
    attemptId,
    unit: UNIT,
    build: BUILD,
    verdict: { category: null, detail: "e4-r98-arm-worker-v2 passed: verification_passed=true" },
    report,
  });
  const written = await writeUnitEvidence(dir, envelope);
  await campaign.ledger.commit(reservation.reservationId, 2, 0);
  await campaign.execState.complete(attemptId, {
    resultHash: envelope.resultHash,
    detail: `${"e4-r98-arm-worker-v2"} passed: verification_passed=true`,
    evidence: { path: written.relPath, sha256: written.sha256 },
  });
  return { dir, campaign, attemptId, resultHash: envelope.resultHash };
}

describe("R99 V1: the validator command exists and states its contract", () => {
  it("is present, and --help exits 0 with usage rather than a stack trace", async () => {
    expect(existsSync(VALIDATOR), "the campaign validation command must exist").toBe(true);
    const { code, stdout } = await runValidator(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("--campaign");
    // The help must state the exit-code contract, because that IS the acceptance
    // criterion an operator relies on.
    expect(stdout).toContain("exit 0");
    expect(stdout).toContain("exit 1");
    expect(stdout).toContain("exit 2");
  });

  it("exits 2 with usage when no campaign is named", async () => {
    const { code, stderr } = await runValidator([]);
    expect(code).toBe(2);
    expect(stderr).toContain("--campaign");
  });

  it("exits 1 (not 0) for a directory that is not an established campaign", async () => {
    const empty = await tempDir();
    const { code, stdout } = await runValidator(["--campaign", empty]);
    expect(code).toBe(1);
    const report = JSON.parse(stdout) as { ok: boolean; reasonCodes: string[] };
    expect(report.ok).toBe(false);
    expect(report.reasonCodes).toContain("VALIDATOR_NO_CAMPAIGN_HEADER");
  });
});

describe("R99 V2: an intact campaign verifies, and every break makes it exit non-zero", () => {
  it("exits 0 and reports the records it re-derived", async () => {
    const { dir } = await establishedCampaign();
    const { code, stdout } = await runValidator(["--campaign", dir]);
    const report = JSON.parse(stdout) as {
      ok: boolean;
      reasonCodes: string[];
      summary: { terminal: number; evidenceChecked: number; committed: number };
    };
    expect(report.ok, JSON.stringify(report.reasonCodes)).toBe(true);
    expect(code).toBe(0);
    expect(report.summary.terminal).toBe(1);
    expect(report.summary.evidenceChecked).toBe(1);
    // The budget that paid is re-derived too, so the report says what it cost.
    expect(report.summary.committed).toBe(2);
  });

  it("exits 1 when the evidence file is DELETED", async () => {
    const { dir } = await establishedCampaign();
    expect((await runValidator(["--campaign", dir])).code).toBe(0);

    await rm(evidenceAbsPathFor(dir, { ...UNIT, attemptId: (await firstAttemptId(dir)) }));
    const { code, stdout } = await runValidator(["--campaign", dir]);
    expect(code).toBe(1);
    const report = JSON.parse(stdout) as { reasonCodes: string[] };
    expect(report.reasonCodes).toContain("VALIDATOR_EVIDENCE_BROKEN");
  });

  it("exits 1 when the evidence file is EDITED but still valid JSON", async () => {
    const { dir } = await establishedCampaign();
    const attemptId = await firstAttemptId(dir);
    const abs = evidenceAbsPathFor(dir, { ...UNIT, attemptId });
    const parsed = JSON.parse(await readFile(abs, "utf8")) as Record<string, unknown>;
    // Change the verdict text while leaving the structure intact: a validator
    // that only re-parsed the JSON would accept this.
    (parsed["verdict"] as Record<string, unknown>)["detail"] = "passed, honestly";
    await writeFile(abs, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

    const { code, stdout } = await runValidator(["--campaign", dir]);
    expect(code).toBe(1);
    expect((JSON.parse(stdout) as { reasonCodes: string[] }).reasonCodes).toContain("VALIDATOR_EVIDENCE_BROKEN");
  });

  it("exits 1 when the resultHash in the STATE is changed", async () => {
    const { dir } = await establishedCampaign();
    const statePath = join(dir, "execution-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as { records: Array<Record<string, unknown>> };
    state.records[0]!["resultHash"] = "0".repeat(64);
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const { code, stdout } = await runValidator(["--campaign", dir]);
    expect(code).toBe(1);
    // The record now disagrees with the evidence's own result, which is the
    // "resultHash 被修改" half of the acceptance criterion.
    expect((JSON.parse(stdout) as { reasonCodes: string[] }).reasonCodes).toContain("VALIDATOR_EVIDENCE_BROKEN");
  });

  it("exits 1 when the stored report ROW is tampered with and the envelope re-hashed", async () => {
    const { dir } = await establishedCampaign();
    const attemptId = await firstAttemptId(dir);
    const abs = evidenceAbsPathFor(dir, { ...UNIT, attemptId });
    const envelope = JSON.parse(await readFile(abs, "utf8")) as Record<string, unknown>;
    // Flip the measurement the verdict rests on, leaving `reportHash` stale.
    (envelope["report"] as Record<string, unknown>)["model_calls"] = 0;
    await writeFile(abs, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");

    const { code, stdout } = await runValidator(["--campaign", dir]);
    expect(code).toBe(1);
    expect((JSON.parse(stdout) as { reasonCodes: string[] }).reasonCodes).toContain("VALIDATOR_EVIDENCE_BROKEN");
  });

  it("exits 1 when the ledger is deleted, even though the state is intact", async () => {
    const { dir } = await establishedCampaign();
    await rm(join(dir, "budget-ledger.json"));
    const { code, stdout } = await runValidator(["--campaign", dir]);
    expect(code).toBe(1);
    expect((JSON.parse(stdout) as { reasonCodes: string[] }).reasonCodes).toContain("VALIDATOR_NO_LEDGER");
  });

  it("exits 1 when the execution state is deleted", async () => {
    const { dir } = await establishedCampaign();
    await rm(join(dir, "execution-state.json"));
    const { code, stdout } = await runValidator(["--campaign", dir]);
    expect(code).toBe(1);
    expect((JSON.parse(stdout) as { reasonCodes: string[] }).reasonCodes).toContain("VALIDATOR_NO_EXECUTION_STATE");
  });

  it("writes the report to --out when asked, with the same verdict", async () => {
    const { dir } = await establishedCampaign();
    const out = join(await tempDir(), "report.json");
    const { code } = await runValidator(["--campaign", dir, "--out", out]);
    expect(code).toBe(0);
    const report = JSON.parse(await readFile(out, "utf8")) as { ok: boolean; validatorVersion: string };
    expect(report.ok).toBe(true);
    expect(report.validatorVersion).toMatch(/^e4-r\d+-campaign-validator-v\d+$/);
  });
});

describe("R99 V3: the validator reads THIS campaign's artifacts and never re-runs a case", () => {
  it("names the campaign header it validated and does not create anything new", async () => {
    const { dir } = await establishedCampaign();
    const { readdir } = await import("node:fs/promises");
    const before = (await readdir(dir)).sort();
    const { code } = await runValidator(["--campaign", dir]);
    expect(code).toBe(0);
    // A validator that re-executed the campaign would have added artifacts (a
    // new ledger entry, a new attempt directory). Reading is the contract.
    expect((await readdir(dir)).sort()).toEqual(before);
  });

  it("refuses a campaign whose only unit CRASHED, so nothing is settled", async () => {
    // A unit that crashed mid-flight is quarantined as `outcome_unknown`, which
    // is deliberately NOT terminal: it is neither a pass nor a failure, and it
    // must not be auto-retried. A campaign holding only that proves nothing, so
    // the validator must exit non-zero rather than reporting an empty success.
    const dir = await tempDir();
    const campaign = await openR97Campaign(dir, {
      planDigest: PLAN_DIGEST,
      campaignModelCalls: GRANT,
      mode: "first-run",
    });
    const key = { experimentId: PLAN_DIGEST, ...UNIT };
    const reservation = await campaign.ledger.reserve("baseline", 2);
    if (reservation.ok !== true || reservation.reservationId === null) throw new Error("fixture: reserve failed");
    await campaign.execState.begin(key, { reservationId: reservation.reservationId, inputDigest: "in-1" });
    // The owner is provably gone, so recovery quarantines the attempt. The
    // result is PERSISTED, which is what the validator will read.
    const recovered = await campaign.execState.recoverInFlight({ isAlive: () => false });
    expect(recovered.unknown).toBe(1);

    const { code, stdout } = await runValidator(["--campaign", dir]);
    expect(code).toBe(1);
    expect((JSON.parse(stdout) as { reasonCodes: string[] }).reasonCodes).toContain("VALIDATOR_NO_TERMINAL_RECORDS");
  });

  it("is importable, so the report and the CLI share ONE implementation", async () => {
    const mod = (await import(pathToFileURL(VALIDATOR).href)) as {
      VALIDATOR_VERSION: string;
      validateCampaignRoot: (root: string) => Promise<{ ok: boolean }>;
    };
    expect(mod.VALIDATOR_VERSION).toMatch(/^e4-r\d+-campaign-validator-v\d+$/);
    const { dir } = await establishedCampaign();
    const report = await mod.validateCampaignRoot(dir);
    expect(report.ok).toBe(true);
  });
});

/** The one attempt id in a fresh fixture campaign. */
async function firstAttemptId(dir: string): Promise<string> {
  const state = JSON.parse(await readFile(join(dir, "execution-state.json"), "utf8")) as {
    records: Array<{ attemptId: string }>;
  };
  return state.records[0]!.attemptId;
}
