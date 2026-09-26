/**
 * A1 — the PRODUCTION, frozen case-selection source for
 * `tool_call_efficiency_v1`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The v2 pre-registration builder (`buildToolCallEfficiencyPreregistrationV2`)
 * faithfully binds whatever `catalog`/`selection` it is handed — but it cannot
 * tell whether those were DERIVED or merely SELF-DECLARED by a JSON config. The
 * N5 fixture's `content-reg-01` / `r87-selection-digest` are placeholders that
 * no committed rule produced, and the R87 selection is bound to a DIFFERENT
 * mechanism (the H2 stall/progress-blind gate). So "the artifact binds a
 * dataset" did not mean "the dataset is a real, mechanism-relevant sample".
 *
 * This module closes that gap on the READ path (the writer is
 * `scripts/e4/tool-call-case-selection.mjs`):
 *
 *   - `selectionFromFrozenEvidence` reads a committed, digest-bound selection
 *     artifact (`docs/evidence/tool-call-efficiency-case-selection.json`), then
 *     READ-ONLY re-derives every case's CONTENT digest from the real
 *     `benchmarks/<suite>/<caseId>/` files and every case's ELIGIBILITY from the
 *     committed R85 taxonomy it was frozen against — refusing any mismatch;
 *   - the selection's own `selectionProvenanceDigest` is RECOMPUTED from its
 *     body, never trusted;
 *   - the taxonomy bytes are bound by digest, so an edited taxonomy fails closed;
 *   - every case path is resolved inside `benchmarks/` ONLY: separators,
 *     `..`, absolute segments, cross-suite ids and symlink escapes are refused,
 *     and `holdout` is never digestible. No file content or absolute path is
 *     ever echoed into an error message.
 *
 * PURE / OFFLINE: no provider, no key, no network. Reads local committed files.
 */

import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { stableStringify } from "./manifest.js";
import {
  catalogEntryFromCase,
  TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
  type PreregCatalogEntryV2,
} from "./tool-call-efficiency-preregistration-v2.js";

export const TOOL_CALL_EFFICIENCY_CASE_SELECTION_SCHEMA = "tool-call-efficiency-case-selection-v1";
/** Repo-relative default location of the frozen selection artifact. */
export const TOOL_CALL_EFFICIENCY_CASE_SELECTION_PATH = "docs/evidence/tool-call-efficiency-case-selection.json";
/** Repo-relative default location of the committed eligibility evidence. */
export const TOOL_CALL_EFFICIENCY_TAXONOMY_PATH = "docs/evidence/e4-r85-failure-taxonomy.json";

export type CaseSelectionErrorCode =
  | "SELECTION_INVALID"
  | "SELECTION_DIGEST_MISMATCH"
  | "EVIDENCE_DIGEST_MISMATCH"
  | "CASE_PATH_ESCAPE"
  | "HOLDOUT_CASE_REJECTED"
  | "ELIGIBILITY_UNPROVEN"
  | "CASE_NOT_FOUND"
  | "INSUFFICIENT_ELIGIBLE_CASES"
  | "UNKNOWN_CANDIDATE";

export class CaseSelectionError extends Error {
  readonly code: CaseSelectionErrorCode;
  constructor(code: CaseSelectionErrorCode, message: string) {
    super(`tool-call-efficiency-case-selection[${code}]: ${message}`);
    this.name = "CaseSelectionError";
    this.code = code;
  }
}

export interface FrozenCaseRef {
  caseId: string;
  suite: string;
}

/** The frozen selection artifact (source body + one derived digest). */
export interface FrozenCaseSelectionV1 {
  schemaVersion: string;
  candidateId: string;
  suiteId: string;
  suiteVersion: string;
  ruleVersion: string;
  selectionRule: string;
  eligibilityRule: string;
  holdoutPolicy: string;
  evidenceKind: string;
  evidencePath: string;
  evidenceDigest: string;
  cases: FrozenCaseRef[];
  selectionProvenanceDigest: string;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Path boundary — the ONLY place a case directory is resolved
// ---------------------------------------------------------------------------

/** A path segment that can never escape its parent directory. */
function isSafeSegment(segment: unknown): segment is string {
  return (
    typeof segment === "string" &&
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("/") &&
    !segment.includes("\\") &&
    !segment.includes("\0")
  );
}

/**
 * Resolve `benchmarks/<suite>/<caseId>` to a REAL directory, or `null`.
 *
 * `null` covers: an unsafe segment (`..`, `/`, absolute, NUL), the `holdout`
 * suite, a component that is missing/not-a-directory, and a symlink whose real
 * target escapes the benchmarks root. `null` is a refusal — the caller omits
 * the case, which makes the observed id set differ from the bound set, so the
 * formal gate refuses (never a fabricated digest).
 */
export function resolveBenchmarkCaseDir(root: string, suite: unknown, caseId: unknown): string | null {
  if (!isSafeSegment(suite) || !isSafeSegment(caseId)) return null;
  // Holdout per-case data is never read into an artifact.
  if (suite === "holdout") return null;
  const benchmarksRoot = resolve(root, "benchmarks");
  const candidate = resolve(benchmarksRoot, suite, caseId);
  const rel = relative(benchmarksRoot, candidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  try {
    if (!statSync(candidate).isDirectory()) return null;
  } catch {
    return null;
  }
  try {
    const realRoot = realpathSync(benchmarksRoot);
    const realCandidate = realpathSync(candidate);
    const realRel = relative(realRoot, realCandidate);
    if (realRel === "" || realRel.startsWith("..") || isAbsolute(realRel)) return null;
  } catch {
    return null;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Frozen-selection parsing (fail closed)
// ---------------------------------------------------------------------------

function asObject(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new CaseSelectionError("SELECTION_INVALID", `${what} must be an object`);
  }
  return v as Record<string, unknown>;
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new CaseSelectionError("SELECTION_INVALID", `${what} must be a non-empty string`);
  }
  return v;
}

function expectKeys(o: Record<string, unknown>, keys: readonly string[], what: string): void {
  const got = Object.keys(o);
  const extra = got.filter((k) => !keys.includes(k));
  if (extra.length > 0) throw new CaseSelectionError("SELECTION_INVALID", `${what} has unknown key(s): ${extra.join(", ")}`);
  for (const k of keys) if (!(k in o)) throw new CaseSelectionError("SELECTION_INVALID", `${what} is missing ${k}`);
}

/** The frozen body (everything except the derived `selectionProvenanceDigest`). */
function frozenBody(f: FrozenCaseSelectionV1): Record<string, unknown> {
  return {
    schemaVersion: f.schemaVersion,
    candidateId: f.candidateId,
    suiteId: f.suiteId,
    suiteVersion: f.suiteVersion,
    ruleVersion: f.ruleVersion,
    selectionRule: f.selectionRule,
    eligibilityRule: f.eligibilityRule,
    holdoutPolicy: f.holdoutPolicy,
    evidenceKind: f.evidenceKind,
    evidencePath: f.evidencePath,
    evidenceDigest: f.evidenceDigest,
    cases: f.cases.map((c) => ({ caseId: c.caseId, suite: c.suite })),
  };
}

export function computeFrozenSelectionDigest(f: Omit<FrozenCaseSelectionV1, "selectionProvenanceDigest">): string {
  return sha256Hex(stableStringify(frozenBody(f as FrozenCaseSelectionV1)));
}

/** Strict parse: unknown keys, wrong types and a wrong derived digest all refuse. */
export function parseFrozenCaseSelectionV1(json: string): FrozenCaseSelectionV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CaseSelectionError("SELECTION_INVALID", "selection artifact is not valid JSON");
  }
  const o = asObject(parsed, "selection artifact");
  expectKeys(
    o,
    [
      "schemaVersion",
      "candidateId",
      "suiteId",
      "suiteVersion",
      "ruleVersion",
      "selectionRule",
      "eligibilityRule",
      "holdoutPolicy",
      "evidenceKind",
      "evidencePath",
      "evidenceDigest",
      "cases",
      "selectionProvenanceDigest",
    ],
    "selection artifact",
  );
  const schemaVersion = str(o.schemaVersion, "schemaVersion");
  if (schemaVersion !== TOOL_CALL_EFFICIENCY_CASE_SELECTION_SCHEMA) {
    throw new CaseSelectionError("SELECTION_INVALID", `unknown schemaVersion ${schemaVersion}`);
  }
  const candidateId = str(o.candidateId, "candidateId");
  if (candidateId !== TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2) {
    throw new CaseSelectionError("UNKNOWN_CANDIDATE", `selection is for ${candidateId}, not ${TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2}`);
  }
  if (!Array.isArray(o.cases)) throw new CaseSelectionError("SELECTION_INVALID", "cases must be an array");
  const seen = new Set<string>();
  const cases: FrozenCaseRef[] = [];
  for (let i = 0; i < o.cases.length; i += 1) {
    const c = asObject(o.cases[i], `cases[${i}]`);
    expectKeys(c, ["caseId", "suite"], `cases[${i}]`);
    const caseId = str(c.caseId, `cases[${i}].caseId`);
    const suite = str(c.suite, `cases[${i}].suite`);
    if (!isSafeSegment(caseId) || !isSafeSegment(suite)) {
      throw new CaseSelectionError("CASE_PATH_ESCAPE", `cases[${i}] is not a plain suite/caseId pair`);
    }
    if (suite === "holdout") throw new CaseSelectionError("HOLDOUT_CASE_REJECTED", `cases[${i}] is a holdout case`);
    if (seen.has(caseId)) throw new CaseSelectionError("SELECTION_INVALID", `duplicate case id ${caseId}`);
    seen.add(caseId);
    cases.push({ caseId, suite });
  }
  const f: FrozenCaseSelectionV1 = {
    schemaVersion,
    candidateId,
    suiteId: str(o.suiteId, "suiteId"),
    suiteVersion: str(o.suiteVersion, "suiteVersion"),
    ruleVersion: str(o.ruleVersion, "ruleVersion"),
    selectionRule: str(o.selectionRule, "selectionRule"),
    eligibilityRule: str(o.eligibilityRule, "eligibilityRule"),
    holdoutPolicy: str(o.holdoutPolicy, "holdoutPolicy"),
    evidenceKind: str(o.evidenceKind, "evidenceKind"),
    evidencePath: str(o.evidencePath, "evidencePath"),
    evidenceDigest: str(o.evidenceDigest, "evidenceDigest"),
    cases,
    selectionProvenanceDigest: str(o.selectionProvenanceDigest, "selectionProvenanceDigest"),
  };
  const recomputed = computeFrozenSelectionDigest(f);
  if (recomputed !== f.selectionProvenanceDigest) {
    throw new CaseSelectionError("SELECTION_DIGEST_MISMATCH", "selectionProvenanceDigest does not match the canonical selection body");
  }
  return f;
}

// ---------------------------------------------------------------------------
// Read-only re-derivation of the real catalog
// ---------------------------------------------------------------------------

interface TaxonomyRecord extends Record<string, unknown> {
  caseId: string;
  suite: string;
  termination?: string;
  toolFailures?: number;
}

interface Taxonomy {
  scope?: { attributedSuites?: string[] };
  cases?: TaxonomyRecord[];
}

/** The frozen eligibility rule (identical to the generator's). */
export function taxonomyRecordEligible(record: TaxonomyRecord, attributed: ReadonlySet<string>): boolean {
  if (!attributed.has(record.suite)) return false;
  if (record.suite === "holdout") return false;
  const terminationOk = record.termination === "agent_limit" || record.termination === "tool_limit";
  return terminationOk && typeof record.toolFailures === "number" && record.toolFailures > 0;
}

function readFixture(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const fixtureDir = join(dir, "fixture");
  let stat;
  try {
    stat = statSync(fixtureDir);
  } catch {
    return out;
  }
  if (!stat.isDirectory()) return out;
  const walk = (rel: string): void => {
    const abs = rel === "" ? fixtureDir : join(fixtureDir, rel);
    for (const name of readdirSync(abs).sort()) {
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const childAbs = join(fixtureDir, childRel);
      if (statSync(childAbs).isDirectory()) walk(childRel);
      else out[childRel] = readFileSync(childAbs, "utf8");
    }
  };
  walk("");
  return out;
}

export interface FrozenSelectionResolution {
  catalog: PreregCatalogEntryV2[];
  selection: {
    caseIds: string[];
    selectionRule: string;
    selectionProvenanceDigest: string;
    holdoutPolicy: string;
  };
  suiteId: string;
  suiteVersion: string;
  frozen: FrozenCaseSelectionV1;
}

export interface SelectionFromFrozenEvidenceOptions {
  /** Repository root the case files and evidence are read from. */
  root: string;
  /** Frozen selection artifact path (absolute or repo-relative). */
  selectionPath?: string;
  /** Committed taxonomy path (absolute or repo-relative). */
  taxonomyPath?: string;
}

function readTextOrThrow(abs: string, code: CaseSelectionErrorCode, what: string): string {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    throw new CaseSelectionError(code, `${what} could not be read`);
  }
}

/**
 * Read the frozen selection + the committed taxonomy, then re-derive every case
 * CONTENT digest from the real case files and every case ELIGIBILITY from the
 * taxonomy — read-only, fail closed. Returns the catalog (superset) and the
 * selection the v2 builder consumes.
 */
export function selectionFromFrozenEvidence(opts: SelectionFromFrozenEvidenceOptions): FrozenSelectionResolution {
  const root = resolve(opts.root);
  const selectionPath = opts.selectionPath ?? TOOL_CALL_EFFICIENCY_CASE_SELECTION_PATH;
  const taxonomyPath = opts.taxonomyPath ?? TOOL_CALL_EFFICIENCY_TAXONOMY_PATH;
  const selectionAbs = isAbsolute(selectionPath) ? selectionPath : join(root, selectionPath);
  const taxonomyAbs = isAbsolute(taxonomyPath) ? taxonomyPath : join(root, taxonomyPath);

  const frozen = parseFrozenCaseSelectionV1(readTextOrThrow(selectionAbs, "SELECTION_INVALID", "selection artifact"));

  // The frozen evidence is bound by the digest of its RAW bytes.
  const taxonomyRaw = readTextOrThrow(taxonomyAbs, "EVIDENCE_DIGEST_MISMATCH", "eligibility evidence");
  if (sha256Hex(taxonomyRaw) !== frozen.evidenceDigest) {
    throw new CaseSelectionError(
      "EVIDENCE_DIGEST_MISMATCH",
      "the committed eligibility evidence does not match the digest the selection was frozen against",
    );
  }
  let taxonomy: Taxonomy;
  try {
    taxonomy = JSON.parse(taxonomyRaw) as Taxonomy;
  } catch {
    throw new CaseSelectionError("EVIDENCE_DIGEST_MISMATCH", "eligibility evidence is not valid JSON");
  }
  const attributed = new Set(taxonomy.scope?.attributedSuites ?? []);
  const byKey = new Map<string, TaxonomyRecord>();
  for (const record of taxonomy.cases ?? []) byKey.set(`${record.suite}/${record.caseId}`, record);

  const catalog: PreregCatalogEntryV2[] = [];
  for (const ref of frozen.cases) {
    const dir = resolveBenchmarkCaseDir(root, ref.suite, ref.caseId);
    if (dir === null) {
      // Distinguish "there is no such case" from "the path was refused".
      throw new CaseSelectionError(
        ref.suite === "holdout" ? "HOLDOUT_CASE_REJECTED" : "CASE_PATH_ESCAPE",
        `selected case is not a readable benchmarks/<suite>/<caseId> directory inside the allowed root`,
      );
    }
    const record = byKey.get(`${ref.suite}/${ref.caseId}`);
    if (record === undefined) {
      throw new CaseSelectionError("ELIGIBILITY_UNPROVEN", "selected case is absent from the frozen eligibility evidence");
    }
    if (!taxonomyRecordEligible(record, attributed)) {
      throw new CaseSelectionError("ELIGIBILITY_UNPROVEN", "selected case does not satisfy the frozen eligibility rule");
    }
    catalog.push(
      catalogEntryFromCase(
        {
          id: ref.caseId,
          suite: ref.suite,
          requestMd: readFileSync(join(dir, "request.md"), "utf8"),
          expectedMd: readFileSync(join(dir, "expected.md"), "utf8"),
          fixture: readFixture(dir),
        },
        { eligible: true, holdout: false, evidence: record },
      ),
    );
  }

  if (catalog.length < frozen.cases.length) {
    throw new CaseSelectionError("INSUFFICIENT_ELIGIBLE_CASES", "not every frozen case could be re-derived");
  }

  return {
    catalog,
    selection: {
      caseIds: catalog.map((c) => c.caseId),
      selectionRule: frozen.selectionRule,
      selectionProvenanceDigest: frozen.selectionProvenanceDigest,
      holdoutPolicy: frozen.holdoutPolicy,
    },
    suiteId: frozen.suiteId,
    suiteVersion: frozen.suiteVersion,
    frozen,
  };
}