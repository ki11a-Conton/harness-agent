/**
 * E4-R99-A (T3) — THE EVIDENCE CHAIN: a stored verdict must be re-derivable.
 *
 * WHAT THIS PINS (plan §T3 做什么 1/4/6, 怎么验收 1/5)
 * --------------------------------------------------
 * The previous worker deleted the arm's only report in `finally` (finding N5),
 * so after a campaign ended there was NOTHING on disk that could substantiate a
 * verdict: a resume could only trust `status`, and an independent validator had
 * no artifact to re-derive from. Plan §T3 怎么验收 states the requirement twice:
 *
 *   "修改/删除任意已关联原始报告或 resultHash，恢复及独立 validator 都非零退出."
 *   "worker 结束后原报告仍存在；validator 读的是本次 driver 的产物."
 *
 * This module is the missing link. One terminal unit produces ONE evidence file
 * under the campaign root, in an attempt directory that cannot be confused with
 * another attempt's (`attempts/<arm>/<caseId>/<repetition>/<attemptId>.json`),
 * and the record stores its BYTE hash and its POSIX-relative path. The file is a
 * self-describing envelope: it carries the unit, the observed build, the verdict
 * and the arm's own report row, so every hash in the chain can be RECOMPUTED
 * from the evidence alone rather than trusted.
 *
 * The chain, and why each link is not redundant:
 *
 *   bytes ──sha256──▶ record.evidence.sha256   (was the file changed/deleted?)
 *   envelope ──▶ resultHash                    (was the RESULT changed?)
 *   report row ──▶ reportHash                  (was the EVIDENCE row changed?)
 *   report.task_id/suite vs unit               (is this even the right case?)
 *
 * A test that only checked "the file exists" would pass for a file containing
 * another case's row, so the case/suite binding is asserted too.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  R97_EVIDENCE_SCHEMA,
  R97_EVIDENCE_DIR,
  R97_EVIDENCE_MISSING,
  R97_EVIDENCE_HASH_MISMATCH,
  R97_EVIDENCE_INVALID,
  R97_EVIDENCE_RESULT_MISMATCH,
  R97_EVIDENCE_REPORT_MISMATCH,
  R97_EVIDENCE_CASE_MISMATCH,
  R97_EVIDENCE_NOT_LINKED,
  evidenceRelPathFor,
  evidenceAbsPathFor,
  buildUnitEvidence,
  writeUnitEvidence,
  readUnitEvidence,
  verifyUnitEvidence,
  verifyCampaignEvidence,
  type R97UnitEvidenceEnvelope,
} from "./r97-campaign-evidence.js";

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "r99-evidence-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
});

const UNIT = { caseId: "r98-tool-write-request", suite: "regression", arm: "baseline", repetition: 1 };
const BUILD = { sourceSha: "e".repeat(40), buildDigest: "f".repeat(64) };
const ATTEMPT = "a-1700000000000-4242-12345-1";

/** A real-shaped arm report row, as `reportRowFor` stores it. */
function reportRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  const row: Record<string, unknown> = {
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
    ...over,
  };
  return { ...row, reportHash: createHash("sha256").update(JSON.stringify(row)).digest("hex") };
}

function makeEnvelope(over: Record<string, unknown> = {}): R97UnitEvidenceEnvelope {
  return buildUnitEvidence({
    attemptId: ATTEMPT,
    unit: UNIT,
    build: BUILD,
    verdict: { category: null, detail: "e4-r98-arm-worker-v2 passed: verification_passed=true" },
    report: reportRow(),
    ...over,
  });
}

/** Write one envelope and return the record-shaped view the store persists. */
async function stored(root: string, over: Record<string, unknown> = {}) {
  const envelope = makeEnvelope(over);
  const written = await writeUnitEvidence(root, envelope);
  return {
    envelope,
    written,
    // The record mirrors the ENVELOPE, so an `over` that changes the unit or the
    // attempt changes both sides — otherwise a test would be asserting a
    // mismatch it created itself.
    record: {
      ...envelope.unit,
      attemptId: envelope.attemptId,
      resultHash: envelope.resultHash,
      evidence: { path: written.relPath, sha256: written.sha256 },
    },
  };
}

describe("R99 E1: the evidence envelope is self-describing and stable", () => {
  it("names one schema, one directory, and one attempt-scoped path", () => {
    expect(R97_EVIDENCE_SCHEMA).toMatch(/^e4-r\d+-unit-evidence-v\d+$/);
    expect(R97_EVIDENCE_DIR).toBe("attempts");
    // The path carries arm, case, repetition AND attempt, so a new attempt at
    // the same unit can never land on the previous attempt's file (plan §T3
    // 怎么做 5: "并发 attempt 和 repetition 使用不同路径").
    const rel = evidenceRelPathFor({ ...UNIT, attemptId: ATTEMPT });
    expect(rel).toBe("attempts/baseline/r98-tool-write-request/1/a-1700000000000-4242-12345-1.json");
    expect(rel.includes("\\")).toBe(false);
  });

  it("gives two DIFFERENT attempts two different paths", () => {
    const a = evidenceRelPathFor({ ...UNIT, attemptId: ATTEMPT });
    const b = evidenceRelPathFor({ ...UNIT, attemptId: "a-1700000000001-4242-12345-2" });
    expect(a).not.toBe(b);
    const c = evidenceRelPathFor({ ...UNIT, repetition: 2, attemptId: ATTEMPT });
    expect(c).not.toBe(a);
  });

  it("binds the result hash to the verdict AND to the report row", () => {
    const base = makeEnvelope();
    // The same verdict over a DIFFERENT report row is a different result: the
    // row is what substantiates the verdict, so it is inside the hash.
    const otherRow = makeEnvelope({ report: reportRow({ model_calls: 3 }) });
    expect(otherRow.resultHash).not.toBe(base.resultHash);
    // ...and a different verdict is a different result, obviously.
    const otherVerdict = makeEnvelope({ verdict: { category: "case_failed", detail: "different" } });
    expect(otherVerdict.resultHash).not.toBe(base.resultHash);
  });

  it("is deterministic: the same inputs produce the same result hash", () => {
    expect(makeEnvelope().resultHash).toBe(makeEnvelope().resultHash);
    expect(makeEnvelope().resultHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("R99 E2: writing the evidence is atomic and hashed over REAL bytes", () => {
  it("writes the file, reports its POSIX-relative path, and hashes the bytes it wrote", async () => {
    const root = await tempDir();
    const { envelope, written } = await stored(root);

    const abs = evidenceAbsPathFor(root, { ...UNIT, attemptId: ATTEMPT });
    expect(written.relPath).toBe(evidenceRelPathFor({ ...UNIT, attemptId: ATTEMPT }));
    expect(existsSync(abs)).toBe(true);
    // The hash is over the bytes ON DISK, not over a re-serialization: that is
    // what makes it a tamper check rather than a self-consistency check.
    const onDisk = await readFile(abs);
    expect(createHash("sha256").update(onDisk).digest("hex")).toBe(written.sha256);
    expect(JSON.parse(onDisk.toString("utf8"))).toEqual(envelope);
  });

  it("leaves no temporary file behind", async () => {
    const root = await tempDir();
    await stored(root);
    const dir = join(root, R97_EVIDENCE_DIR, UNIT.arm, UNIT.caseId, String(UNIT.repetition));
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    expect(entries.filter((e) => e.includes(".tmp-"))).toEqual([]);
    expect(entries).toEqual([`${ATTEMPT}.json`]);
  });

  it("reads back the same bytes and hash it wrote", async () => {
    const root = await tempDir();
    const { written } = await stored(root);
    const back = await readUnitEvidence(root, written.relPath);
    expect(back.sha256).toBe(written.sha256);
    expect(back.envelope?.resultHash).toBe(makeEnvelope().resultHash);
  });

  it("returns null (not a throw) for an absent file, so 'missing' is a value", async () => {
    const root = await tempDir();
    const back = await readUnitEvidence(root, "attempts/nobody/nowhere/1/none.json");
    expect(back.envelope).toBeNull();
    expect(back.sha256).toBeNull();
  });
});

describe("R99 E3: the verification chain accepts a genuine record and nothing else", () => {
  it("accepts an untouched record", async () => {
    const root = await tempDir();
    const { record } = await stored(root);
    const verdict = await verifyUnitEvidence(root, record);
    expect(verdict.ok, verdict.ok ? "" : verdict.detail).toBe(true);
  });

  it("REFUSES a record that was never linked to evidence", async () => {
    const root = await tempDir();
    const { record } = await stored(root);
    const unlinked = { ...record, evidence: null };
    const verdict = await verifyUnitEvidence(root, unlinked);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.code).toBe(R97_EVIDENCE_NOT_LINKED);
  });

  it("REFUSES a DELETED evidence file", async () => {
    const root = await tempDir();
    const { record, written } = await stored(root);
    await rm(evidenceAbsPathFor(root, { ...UNIT, attemptId: ATTEMPT }));
    const verdict = await verifyUnitEvidence(root, record);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.code).toBe(R97_EVIDENCE_MISSING);
    void written;
  });

  it("REFUSES a MODIFIED evidence file, naming the byte hash", async () => {
    const root = await tempDir();
    const { record } = await stored(root);
    const abs = evidenceAbsPathFor(root, { ...UNIT, attemptId: ATTEMPT });
    const parsed = JSON.parse(await readFile(abs, "utf8")) as Record<string, unknown>;
    // A one-field change that leaves the JSON valid — the case a parser that
    // only re-read the JSON would happily accept.
    (parsed["verdict"] as Record<string, unknown>)["category"] = "passed";
    await writeFile(abs, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

    const verdict = await verifyUnitEvidence(root, record);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.code).toBe(R97_EVIDENCE_HASH_MISMATCH);
    expect(verdict.ok === false && verdict.detail).toContain(record.evidence!.sha256);
  });

  it("REFUSES a re-hashed file whose RESULT no longer matches the record", async () => {
    const root = await tempDir();
    const { record } = await stored(root);
    const abs = evidenceAbsPathFor(root, { ...UNIT, attemptId: ATTEMPT });
    // An attacker who rewrites the envelope AND fixes the byte hash still cannot
    // make the record's `resultHash` agree, because the record is the authority.
    const envelope = JSON.parse(await readFile(abs, "utf8")) as Record<string, unknown>;
    envelope["resultHash"] = "0".repeat(64);
    const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    await writeFile(abs, bytes);
    const fixed = { ...record, evidence: { path: record.evidence!.path, sha256: createHash("sha256").update(bytes).digest("hex") } };

    const verdict = await verifyUnitEvidence(root, fixed);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.code).toBe(R97_EVIDENCE_RESULT_MISMATCH);
  });

  it("REFUSES a tampered report ROW even when the envelope's own result hash is recomputed", async () => {
    const root = await tempDir();
    const { record, envelope } = await stored(root);
    const abs = evidenceAbsPathFor(root, { ...UNIT, attemptId: ATTEMPT });
    // Flip `verification_passed` in the row and REBUILD the envelope honestly.
    // The row's own `reportHash` now disagrees, which is the only thing that can
    // catch a change that a full re-derivation would otherwise accept.
    const tampered = buildUnitEvidence({
      attemptId: ATTEMPT,
      unit: UNIT,
      build: BUILD,
      verdict: envelope.verdict,
      report: { ...envelope.report!, verification_passed: false },
    });
    const bytes = Buffer.from(`${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    await writeFile(abs, bytes);
    const relinked = {
      ...record,
      resultHash: tampered.resultHash,
      evidence: { path: record.evidence!.path, sha256: createHash("sha256").update(bytes).digest("hex") },
    };

    const verdict = await verifyUnitEvidence(root, relinked);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.code).toBe(R97_EVIDENCE_REPORT_MISMATCH);
  });

  it("REFUSES evidence for the WRONG case, however well hashed", async () => {
    const root = await tempDir();
    // The file is written at the path for the SECOND case but its envelope (and
    // its row) describe the FIRST. Everything hashes; the binding is wrong.
    const other = { ...UNIT, caseId: "r98-tool-write-second" };
    const envelope = buildUnitEvidence({
      attemptId: ATTEMPT,
      unit: UNIT,
      build: BUILD,
      verdict: { category: null, detail: "passed" },
      report: reportRow(),
    });
    const written = await writeUnitEvidence(root, envelope);
    const wrongRecord = { ...other, attemptId: ATTEMPT, resultHash: envelope.resultHash, evidence: { path: written.relPath, sha256: written.sha256 } };

    const verdict = await verifyUnitEvidence(root, wrongRecord);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.code).toBe(R97_EVIDENCE_CASE_MISMATCH);
  });

  it("REFUSES a structurally invalid envelope rather than trusting its fields", async () => {
    const root = await tempDir();
    const { record } = await stored(root);
    const abs = evidenceAbsPathFor(root, { ...UNIT, attemptId: ATTEMPT });
    const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: "wrong" }, null, 2)}\n`, "utf8");
    await writeFile(abs, bytes);
    const relinked = { ...record, evidence: { path: record.evidence!.path, sha256: createHash("sha256").update(bytes).digest("hex") } };

    const verdict = await verifyUnitEvidence(root, relinked);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.code).toBe(R97_EVIDENCE_INVALID);
  });

  it("REFUSES an evidence path that escapes the campaign root", async () => {
    const root = await tempDir();
    const { record } = await stored(root);
    const escaping = { ...record, evidence: { path: "../outside.json", sha256: "0".repeat(64) } };
    const verdict = await verifyUnitEvidence(root, escaping);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.code).toBe(R97_EVIDENCE_INVALID);
  });
});

describe("R99 E4: the whole campaign is verified in one pass", () => {
  it("reports every terminal record and fails on the FIRST broken link", async () => {
    const root = await tempDir();
    const a = await stored(root);
    const b = await stored(root, { unit: { ...UNIT, arm: "candidate" }, attemptId: "a-1700000000002-4242-12345-3" });

    const good = await verifyCampaignEvidence(root, [a.record, b.record]);
    expect(good.ok, good.ok ? "" : good.detail).toBe(true);
    expect(good.checked).toBe(2);

    await rm(evidenceAbsPathFor(root, { ...UNIT, attemptId: ATTEMPT }));
    const bad = await verifyCampaignEvidence(root, [a.record, b.record]);
    expect(bad.ok).toBe(false);
    expect(bad.checked).toBe(2);
    expect(bad.failures.length).toBe(1);
    expect(bad.failures[0]!.code).toBe(R97_EVIDENCE_MISSING);
  });

  it("an EMPTY record list is not a pass: a campaign with no evidence proves nothing", async () => {
    const root = await tempDir();
    const empty = await verifyCampaignEvidence(root, []);
    expect(empty.ok).toBe(false);
    expect(empty.checked).toBe(0);
  });
});
