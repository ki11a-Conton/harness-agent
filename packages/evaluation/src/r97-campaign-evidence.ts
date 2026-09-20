/**
 * E4-R99-A (T3) — THE UNIT EVIDENCE CHAIN.
 *
 * WHY THIS MODULE EXISTS (plan §T3 做什么 1/4/6, 怎么验收 5)
 * -------------------------------------------------------
 * MEASURED DEFECT N5 (plan §0.2):
 *
 *   "`classifyReport` … finally 删除报告 … resultHash 仅摘要化描述文本."
 *
 * The worker deleted the arm's only report in `finally`, so once a campaign
 * ended NOTHING on disk could substantiate a verdict. A resume could only trust
 * a `status` string, and an independent validator had no artifact to re-derive
 * from — which is exactly what plan §T3 怎么验收 refuses:
 *
 *   "修改/删除任意已关联原始报告或 resultHash，恢复及独立 validator 都非零退出."
 *   "worker 结束后原报告仍存在；validator 读的是本次 driver 的产物."
 *
 * WHAT AN ENVELOPE IS, AND WHAT IT IS NOT
 * ---------------------------------------
 * It is a self-describing record of ONE terminal unit: which unit, which build,
 * which verdict, and the arm's OWN report row. Every hash in the chain can be
 * RECOMPUTED from the envelope, so the validator never has to trust a field it
 * is supposed to be checking.
 *
 *   bytes      ──sha256──▶ record.evidence.sha256   (was the FILE changed?)
 *   envelope   ──▶ resultHash                       (was the RESULT changed?)
 *   report row ──▶ reportHash                       (was the EVIDENCE ROW changed?)
 *   envelope.unit vs record                         (is this the RIGHT case?)
 *
 * It is NOT a copy of the whole report: one row per unit is stored, bounded and
 * redacted, so a campaign keeps the evidence that produced each verdict without
 * storing a report per unit. And it is NOT a signature: an actor who rewrites
 * the envelope, its report row, its `reportHash`, its `resultHash` AND the
 * execution state consistently has rewritten all durable state, which is the
 * same boundary the plan draws for deleting the entire campaign directory
 * (§T1 怎么做 9). What this module guarantees is the stated requirement: changing
 * or deleting ANY ONE linked artifact makes the resume and the validator fail.
 *
 * ORDER IS THE CONTRACT, again: the evidence file is written and hashed BEFORE
 * the terminal record that names it is written, so a terminal record whose
 * evidence is absent is a named loss (`R97_EVIDENCE_MISSING`) rather than a
 * record that was never linked in the first place.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

export const R97_EVIDENCE_SCHEMA = "e4-r99-unit-evidence-v1";
/** The campaign-root-relative directory every evidence file lives under. */
export const R97_EVIDENCE_DIR = "attempts";

/** The record names no evidence: it cannot substantiate its own verdict. */
export const R97_EVIDENCE_NOT_LINKED = "EVIDENCE_NOT_LINKED";
/** The record names an evidence file that is not there. */
export const R97_EVIDENCE_MISSING = "EVIDENCE_MISSING";
/** The bytes on disk are not the bytes the record was linked to. */
export const R97_EVIDENCE_HASH_MISMATCH = "EVIDENCE_HASH_MISMATCH";
/** The file is unreadable, not JSON, or not a well-formed envelope. */
export const R97_EVIDENCE_INVALID = "EVIDENCE_INVALID";
/** The envelope's result does not agree with the record's `resultHash`. */
export const R97_EVIDENCE_RESULT_MISMATCH = "EVIDENCE_RESULT_MISMATCH";
/** The stored report row's own hash does not cover the row as stored. */
export const R97_EVIDENCE_REPORT_MISMATCH = "EVIDENCE_REPORT_MISMATCH";
/** The envelope describes a different unit than the record does. */
export const R97_EVIDENCE_CASE_MISMATCH = "EVIDENCE_CASE_MISMATCH";

export interface R97EvidenceUnit {
  caseId: string;
  suite: string;
  arm: string;
  repetition: number;
}

export interface R97EvidenceBuild {
  sourceSha: string | null;
  buildDigest: string | null;
}

export interface R97UnitEvidenceEnvelope {
  schemaVersion: string;
  attemptId: string;
  unit: R97EvidenceUnit;
  build: R97EvidenceBuild;
  verdict: { category: string | null; detail: string };
  /** The arm's own report row, redacted and bounded, or `null` when the run
   *  produced no report (which is itself the fact the verdict rests on). */
  report: Record<string, unknown> | null;
  /** Digest of everything above. Recomputed by the validator. */
  resultHash: string;
}

/** The link a terminal execution-state record carries to its evidence. */
export interface R97EvidenceLink {
  /** POSIX-relative to the campaign root. Never absolute. */
  path: string;
  /** sha256 of the bytes ON DISK. */
  sha256: string;
}

/**
 * The canonical hash of a stored report ROW.
 *
 * The worker's `reportRowFor` and this function must agree byte for byte; the
 * contract is pinned by a cross-check test rather than by convention, because a
 * validator whose idea of "the row's hash" differs from the writer's would
 * report a mismatch on every honest campaign.
 *
 * `JSON.stringify` on the parsed object reproduces the writer's serialization
 * because `JSON.parse` preserves key insertion order for string keys.
 */
export function reportRowHash(row: Record<string, unknown>): string {
  const { reportHash: _ignored, ...rest } = row;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

/** A path component safe to embed in a campaign-relative evidence path. */
function safeComponent(value: string): string {
  return value.replace(/[\\/]/g, "-");
}

/** The campaign-relative path of one attempt's evidence file. */
export function evidenceRelPathFor(opts: {
  arm: string;
  caseId: string;
  repetition: number;
  attemptId: string;
}): string {
  return [
    R97_EVIDENCE_DIR,
    safeComponent(opts.arm),
    safeComponent(opts.caseId),
    String(opts.repetition),
    `${safeComponent(opts.attemptId)}.json`,
  ].join("/");
}

/**
 * Is this relative path a legal evidence path?
 *
 * Exported because BOTH the writer and the validator must apply the same rule:
 * a path that escapes the campaign root would let a record point its evidence
 * at an arbitrary file, and "the hash matched" would then mean nothing.
 */
export function isSafeEvidenceRelPath(rel: string): boolean {
  if (typeof rel !== "string" || rel === "") return false;
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return false;
  const parts = rel.split("/");
  if (parts.some((p) => p === ".." || p === "")) return false;
  // A backslash in a POSIX-relative path is a Windows separator smuggled in.
  if (rel.includes("\\")) return false;
  const normalized = normalize(rel).split(sep).join("/");
  return normalized === rel && normalized.startsWith(`${R97_EVIDENCE_DIR}/`);
}

export function evidenceAbsPathFor(
  root: string,
  opts: { arm: string; caseId: string; repetition: number; attemptId: string },
): string {
  return join(resolve(root), ...evidenceRelPathFor(opts).split("/"));
}

/** The material `resultHash` commits to. Kept as one function so the writer and
 *  the validator can never disagree about what "the same result" means. */
function resultMaterial(envelope: Omit<R97UnitEvidenceEnvelope, "resultHash">): string {
  return [
    "e4-r99-unit-evidence-result-v1",
    `attempt:${envelope.attemptId}`,
    `unit:${envelope.unit.caseId}|${envelope.unit.suite}|${envelope.unit.arm}|${envelope.unit.repetition}`,
    `build:${envelope.build.sourceSha ?? "unknown"}|${envelope.build.buildDigest ?? "unknown"}`,
    `verdict:${envelope.verdict.category ?? "passed"}`,
    `detail:${envelope.verdict.detail}`,
    `report:${envelope.report === null ? "none" : JSON.stringify(envelope.report)}`,
  ].join("\n");
}

/** Build the envelope for one terminal unit, computing its `resultHash`. */
export function buildUnitEvidence(opts: {
  attemptId: string;
  unit: R97EvidenceUnit;
  build: R97EvidenceBuild;
  verdict: { category: string | null; detail: string };
  report: Record<string, unknown> | null;
}): R97UnitEvidenceEnvelope {
  const bare: Omit<R97UnitEvidenceEnvelope, "resultHash"> = {
    schemaVersion: R97_EVIDENCE_SCHEMA,
    attemptId: opts.attemptId,
    unit: {
      caseId: opts.unit.caseId,
      suite: opts.unit.suite,
      arm: opts.unit.arm,
      repetition: opts.unit.repetition,
    },
    build: { sourceSha: opts.build.sourceSha, buildDigest: opts.build.buildDigest },
    verdict: { category: opts.verdict.category, detail: opts.verdict.detail },
    report: opts.report,
  };
  return { ...bare, resultHash: createHash("sha256").update(resultMaterial(bare)).digest("hex") };
}

/**
 * Write the envelope atomically and return its path plus the sha256 of the
 * bytes written.
 *
 * The hash is computed over the EXACT buffer that is renamed into place, so the
 * value the record stores describes the file that exists — not a re-serialization
 * that merely ought to be identical.
 */
export async function writeUnitEvidence(
  root: string,
  envelope: R97UnitEvidenceEnvelope,
): Promise<{ relPath: string; absPath: string; sha256: string }> {
  const relPath = evidenceRelPathFor({
    arm: envelope.unit.arm,
    caseId: envelope.unit.caseId,
    repetition: envelope.unit.repetition,
    attemptId: envelope.attemptId,
  });
  if (!isSafeEvidenceRelPath(relPath)) {
    throw new Error(`E4-R99: ${R97_EVIDENCE_INVALID}: refusing to write evidence to unsafe path ${relPath}`);
  }
  const absPath = join(resolve(root), ...relPath.split("/"));
  const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  await mkdir(dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, bytes);
  try {
    await rename(tmp, absPath);
  } catch (err) {
    // A failed rename must not leave a half-written sibling behind: the temp
    // file is not evidence and its presence would make the attempt directory
    // ambiguous. The cleanup is best-effort and REPORTED, never swallowed.
    await rm(tmp, { force: true }).catch((cleanupErr) => {
      process.stderr.write(
        `[degraded] r97-campaign-evidence.tmp-cleanup: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}\n`,
      );
    });
    throw err;
  }
  return { relPath, absPath, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Read one evidence file. An absent file is a VALUE (`null`), not a throw:
 *  "the evidence is gone" is the finding, and it must be reportable. */
export async function readUnitEvidence(
  root: string,
  relPath: string,
): Promise<{ envelope: R97UnitEvidenceEnvelope | null; sha256: string | null; issue: string | null }> {
  if (!isSafeEvidenceRelPath(relPath)) {
    return { envelope: null, sha256: null, issue: `${R97_EVIDENCE_INVALID}: unsafe evidence path ${JSON.stringify(relPath)}` };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(join(resolve(root), ...relPath.split("/")));
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return { envelope: null, sha256: null, issue: `${R97_EVIDENCE_MISSING}: no evidence file at ${relPath}` };
    }
    throw err;
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { envelope: null, sha256, issue: `${R97_EVIDENCE_INVALID}: ${relPath} is not valid JSON` };
  }
  const checked = asEnvelope(parsed);
  if (checked === null) {
    return { envelope: null, sha256, issue: `${R97_EVIDENCE_INVALID}: ${relPath} is not a well-formed evidence envelope` };
  }
  return { envelope: checked, sha256, issue: null };
}

/** Structural validation. Returns `null` (never a partially-trusted object) so a
 *  caller cannot read a field the shape did not actually guarantee. */
function asEnvelope(raw: unknown): R97UnitEvidenceEnvelope | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o["schemaVersion"] !== R97_EVIDENCE_SCHEMA) return null;
  const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
  if (!nonEmpty(o["attemptId"]) || !nonEmpty(o["resultHash"])) return null;
  const unit = o["unit"];
  if (typeof unit !== "object" || unit === null || Array.isArray(unit)) return null;
  const u = unit as Record<string, unknown>;
  if (!nonEmpty(u["caseId"]) || !nonEmpty(u["suite"]) || !nonEmpty(u["arm"])) return null;
  if (typeof u["repetition"] !== "number" || !Number.isSafeInteger(u["repetition"]) || u["repetition"] < 1) return null;
  const build = o["build"];
  if (typeof build !== "object" || build === null || Array.isArray(build)) return null;
  const b = build as Record<string, unknown>;
  for (const field of ["sourceSha", "buildDigest"] as const) {
    const v = b[field];
    if (v !== null && !nonEmpty(v)) return null;
  }
  const verdict = o["verdict"];
  if (typeof verdict !== "object" || verdict === null || Array.isArray(verdict)) return null;
  const v = verdict as Record<string, unknown>;
  const category = v["category"];
  if (category !== null && !nonEmpty(category)) return null;
  if (typeof v["detail"] !== "string") return null;
  const report = o["report"];
  if (report !== null && (typeof report !== "object" || Array.isArray(report))) return null;
  return {
    schemaVersion: R97_EVIDENCE_SCHEMA,
    attemptId: o["attemptId"] as string,
    unit: {
      caseId: u["caseId"] as string,
      suite: u["suite"] as string,
      arm: u["arm"] as string,
      repetition: u["repetition"] as number,
    },
    build: {
      sourceSha: typeof b["sourceSha"] === "string" ? b["sourceSha"] : null,
      buildDigest: typeof b["buildDigest"] === "string" ? b["buildDigest"] : null,
    },
    verdict: { category: typeof category === "string" ? category : null, detail: v["detail"] as string },
    report: report === null ? null : (report as Record<string, unknown>),
    resultHash: o["resultHash"] as string,
  };
}

/** What the verifier needs off a terminal record. Deliberately structural: the
 *  execution state's own type is not importable from a `.mjs` validator. */
export interface R97EvidenceBearingRecord {
  caseId: string;
  suite: string;
  arm: string;
  repetition: number;
  attemptId: string;
  resultHash: string | null;
  evidence?: R97EvidenceLink | null;
}

export type R97EvidenceVerdict =
  | { ok: true; envelope: R97UnitEvidenceEnvelope; relPath: string; sha256: string }
  | { ok: false; code: string; detail: string };

/**
 * Verify ONE record's evidence chain, in the order the links must hold.
 *
 * Every failure names a distinct code so a caller (or a report) can say WHICH
 * link broke rather than "the campaign is invalid".
 */
export async function verifyUnitEvidence(
  root: string,
  record: R97EvidenceBearingRecord,
): Promise<R97EvidenceVerdict> {
  const label = `${record.arm}/${record.caseId}#${record.repetition}@${record.attemptId}`;
  const link = record.evidence;
  if (
    link === null ||
    link === undefined ||
    typeof link.path !== "string" ||
    link.path === "" ||
    typeof link.sha256 !== "string" ||
    link.sha256 === ""
  ) {
    return {
      ok: false,
      code: R97_EVIDENCE_NOT_LINKED,
      detail: `${label}: the terminal record names no evidence file, so its verdict cannot be re-derived`,
    };
  }
  if (!isSafeEvidenceRelPath(link.path)) {
    return {
      ok: false,
      code: R97_EVIDENCE_INVALID,
      detail: `${label}: evidence path ${JSON.stringify(link.path)} is not a legal campaign-relative path under ${R97_EVIDENCE_DIR}/`,
    };
  }
  const read = await readUnitEvidence(root, link.path);
  if (read.envelope === null && read.sha256 === null) {
    return { ok: false, code: R97_EVIDENCE_MISSING, detail: `${label}: ${read.issue ?? `no evidence at ${link.path}`}` };
  }
  if (read.sha256 !== link.sha256) {
    return {
      ok: false,
      code: R97_EVIDENCE_HASH_MISMATCH,
      detail: `${label}: ${link.path} hashes to ${String(read.sha256)} but the record was linked to ${link.sha256}`,
    };
  }
  if (read.envelope === null) {
    return { ok: false, code: R97_EVIDENCE_INVALID, detail: `${label}: ${read.issue ?? `${link.path} is not a valid envelope`}` };
  }
  const envelope = read.envelope;
  if (
    envelope.attemptId !== record.attemptId ||
    envelope.unit.caseId !== record.caseId ||
    envelope.unit.suite !== record.suite ||
    envelope.unit.arm !== record.arm ||
    envelope.unit.repetition !== record.repetition
  ) {
    return {
      ok: false,
      code: R97_EVIDENCE_CASE_MISMATCH,
      detail: `${label}: the evidence at ${link.path} describes ${envelope.unit.arm}/${envelope.unit.caseId}#${envelope.unit.repetition}@${envelope.attemptId}`,
    };
  }
  if (record.resultHash === null || record.resultHash !== envelope.resultHash) {
    return {
      ok: false,
      code: R97_EVIDENCE_RESULT_MISMATCH,
      detail: `${label}: the record asserts result ${String(record.resultHash)} but the evidence asserts ${envelope.resultHash}`,
    };
  }
  // Re-derive the digest from the envelope's own fields: a record and an
  // envelope that were BOTH edited to agree still have to survive this.
  const { resultHash: _drop, ...bare } = envelope;
  const recomputed = createHash("sha256").update(resultMaterial(bare)).digest("hex");
  if (recomputed !== envelope.resultHash) {
    return {
      ok: false,
      code: R97_EVIDENCE_RESULT_MISMATCH,
      detail: `${label}: the evidence's own resultHash ${envelope.resultHash} does not cover its contents (recomputed ${recomputed})`,
    };
  }
  if (envelope.report !== null) {
    const stored = envelope.report["reportHash"];
    if (typeof stored !== "string" || stored !== reportRowHash(envelope.report)) {
      return {
        ok: false,
        code: R97_EVIDENCE_REPORT_MISMATCH,
        detail: `${label}: the stored report row's reportHash ${JSON.stringify(stored)} does not cover the row as stored`,
      };
    }
  }
  return { ok: true, envelope, relPath: link.path, sha256: link.sha256 };
}

export interface R97CampaignEvidenceResult {
  ok: boolean;
  /** How many records were examined — NOT how many passed. */
  checked: number;
  failures: Array<{ code: string; detail: string }>;
  detail: string;
}

/**
 * Verify every terminal record of a campaign in one pass.
 *
 * An EMPTY record list is NOT a pass. Plan §T3 怎么做 8 exists precisely because
 * an empty view used to look like a clean campaign: "不能用本次 unitResults=[]
 * 得出历史没有失败". A campaign that presents no records proves nothing.
 */
export async function verifyCampaignEvidence(
  root: string,
  records: readonly R97EvidenceBearingRecord[],
): Promise<R97CampaignEvidenceResult> {
  const failures: Array<{ code: string; detail: string }> = [];
  for (const record of records) {
    const verdict = await verifyUnitEvidence(root, record);
    if (!verdict.ok) failures.push({ code: verdict.code, detail: verdict.detail });
  }
  if (records.length === 0) {
    return {
      ok: false,
      checked: 0,
      failures: [{ code: R97_EVIDENCE_NOT_LINKED, detail: "the campaign presents no terminal records, so no verdict can be re-derived" }],
      detail: "no terminal records to verify",
    };
  }
  return {
    ok: failures.length === 0,
    checked: records.length,
    failures,
    detail:
      failures.length === 0
        ? `every one of ${records.length} terminal record(s) is backed by intact, matching evidence`
        : `${failures.length} of ${records.length} terminal record(s) failed evidence verification: ${failures.slice(0, 5).map((f) => `${f.code} ${f.detail}`).join("; ")}`,
  };
}
