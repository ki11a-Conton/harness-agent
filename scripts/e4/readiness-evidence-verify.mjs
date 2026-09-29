#!/usr/bin/env node
/**
 * S6/F3 — READ-ONLY readiness evidence verifier (plan(20260929-015956).md §10).
 *
 * WHY THIS EXISTS
 * ---------------
 * `scripts/e4/ci-readiness.mjs` used to decide `realBuildOfflineReady` from the
 * `--e2e` artifact's OWN self-reported fields: `buildDigest` was checked for
 * non-emptiness, `verifier.casesVerified` was trusted, the artifact's `runId`
 * was optional, and no raw arm / verifier / journal file was ever opened. A
 * complete forged object with `buildDigest: "x"` and no files on disk rendered
 * `realBuildOfflineReady = PASS` with `failures: []` (S0b counter-example,
 * docs/evidence/s0b-f3-forged-readiness-counterexample.md).
 *
 * This module is the read-only core that replaces "a parsed JSON is evidence"
 * with "a parsed JSON is a CLAIM that must be corroborated by raw bytes":
 *
 *   1. Every path is confined to the evidence root (no absolute paths, no `..`,
 *      no symlink escape). Nothing inside the bundle is ever executed.
 *   2. The bundle must carry its OWN run identity (driver SHA, run id, attempt,
 *      platform). A caller-supplied `--run-id` is not a substitute.
 *   3. Both arms' build identity is derived from `identity.json`, and each
 *      `buildDigest` must be a legal 64-hex sha256 — never "non-empty".
 *   4. Every arm named by the schedule must have its per-arm manifest /
 *      verifier / security / activation bytes re-verified by the EXISTING A6
 *      verifier (`verifyArmEvidenceFromArtifacts`), injected by the caller so
 *      this module stays self-contained and offline.
 *   5. `budgetEvidenceReady` is recomputed from the raw cost-journal entries and
 *      compared with the aggregate. While S4's bundle contract for the
 *      request/dispatch journal does not exist, that binding is reported as an
 *      explicit NOT_PROVEN naming the missing inputs — never as a green PASS.
 *
 * HONESTY RULES:
 *   - A missing dimension is NOT_PROVEN with its reason; it is never a 0 and
 *     never a PASS.
 *   - `outcomeUnknown` / `RESERVED_UPPER_BOUND` journal entries stay VISIBLE and
 *     are never flattened into measured consumption.
 *   - This proves the integrity and internal consistency of a TRUSTED CI
 *     artifact. It does NOT claim an arbitrary bundle of JSON from anywhere is
 *     unforgeably authentic, and it never authorizes money or promotion.
 *
 * PURE / OFFLINE: reads local files only. Zero provider, zero tool, zero
 * network, zero cost.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export const READINESS_EVIDENCE_SCHEMA = "prereg-readiness-evidence-v1";

/** The bundle files this verifier understands, relative to the evidence root. */
export const EVIDENCE_BUNDLE_FILES = Object.freeze({
  identity: "identity.json",
  schedule: "schedule.json",
  aggregate: "aggregate.json",
  costJournal: "cost-journal.json",
  /** `<armEvidenceDir>/<armRunId>/{manifest,verifier,security,activation}.json` */
  armEvidenceDir: "evidence",
});

/** The per-arm raw artifact names, mirroring `PREREG_RUN_EVIDENCE_FILENAMES`. */
export const ARM_EVIDENCE_FILES = Object.freeze({
  manifest: "manifest.json",
  verifier: "verifier.json",
  security: "security.json",
  activation: "activation.json",
});

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const isSha40 = (v) => typeof v === "string" && SHA40.test(v);
export const isSha256Hex = (v) => typeof v === "string" && SHA256.test(v);
export const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";
export const asInt = (v) =>
  v === null || v === undefined || v === "" ? null : Number.isInteger(Number(v)) ? Number(v) : null;

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

/**
 * Resolve `rel` under `root` and REFUSE anything that leaves it.
 *
 * Rejected: an empty path, an absolute path, a `..` escape, and a path whose
 * REAL location (after symlink resolution) sits outside the root. A path that
 * does not exist yet is accepted lexically; the caller's read then reports the
 * missing file.
 */
export function resolveInsideRoot(root, rel) {
  if (!isNonEmptyString(rel)) return { ok: false, problem: "the relative path is empty" };
  if (isAbsolute(rel)) return { ok: false, problem: `an absolute path is not allowed: ${rel}` };
  const rootAbs = resolve(root);
  const target = resolve(rootAbs, rel);
  const lexical = relative(rootAbs, target);
  if (lexical.startsWith("..") || isAbsolute(lexical)) {
    return { ok: false, problem: `the path escapes the evidence root: ${rel}` };
  }
  if (existsSync(target)) {
    let realRoot;
    let realTarget;
    try {
      realRoot = realpathSync(rootAbs);
      realTarget = realpathSync(target);
    } catch {
      return { ok: false, problem: `the path could not be resolved: ${rel}` };
    }
    const realRel = relative(realRoot, realTarget);
    if (realRel.startsWith("..") || isAbsolute(realRel)) {
      return { ok: false, problem: `the path resolves outside the evidence root through a link: ${rel}` };
    }
  }
  return { ok: true, path: target };
}

/** Parse a bundle file as a STRICT JSON object; a non-object is a problem. */
function parseObject(text, artifact, problems) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    problems.push(`${artifact} is not valid JSON`);
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    problems.push(`${artifact} is not a JSON object`);
    return null;
  }
  return parsed;
}

/**
 * Recompute the token accounting from the RAW cost-journal entries.
 *
 * Mirrors the campaign's own rule: a MEASURED entry contributes its observed
 * tokens, a RESERVED_UPPER_BOUND entry contributes its conservative ceiling, and
 * an `outcomeUnknown` entry is COUNTED IN THE RESERVED BOUND and reported
 * separately. Nothing is dropped and nothing is silently zeroed.
 */
export function recomputeJournalTotals(entries) {
  const measured = { baseline: 0, candidate: 0 };
  const reserved = { baseline: 0, candidate: 0 };
  let unknownEntries = 0;
  let unsettled = 0;
  for (const e of entries) {
    const arm = e?.arm === "baseline" ? "baseline" : e?.arm === "candidate" ? "candidate" : null;
    if (arm === null) {
      unsettled += 1;
      continue;
    }
    if (e.basis === "MEASURED") measured[arm] += (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
    else if (e.basis === "RESERVED_UPPER_BOUND") reserved[arm] += (e.reservedInputTokens ?? 0) + (e.reservedOutputTokens ?? 0);
    else unsettled += 1;
    if (e.outcomeUnknown === true) unknownEntries += 1;
  }
  return {
    measuredBaseline: measured.baseline,
    measuredCandidate: measured.candidate,
    measuredTotal: measured.baseline + measured.candidate,
    measuredDelta: measured.candidate - measured.baseline,
    reservedBaseline: reserved.baseline,
    reservedCandidate: reserved.candidate,
    reservedUpperBound: reserved.baseline + reserved.candidate,
    unknownEntries,
    unsettledEntries: unsettled,
  };
}

/**
 * Verify one readiness evidence bundle.
 *
 * @param {object} input
 * @param {string} input.evidenceRoot  the raw evidence root directory
 * @param {string} input.expectSha     the 40-hex driver SHA this run certifies
 * @param {string} input.runId         the expected run id
 * @param {number} input.attempt       the expected attempt
 * @param {string} input.platform      `windows` | `ubuntu`
 * @param {(dir: string, identity: object, declared: object) => {verified: boolean, problems: string[]}} [input.armEvidenceVerifier]
 *        the EXISTING A6 verifier, injected so this module stays self-contained
 * @param {{baseline?: object, candidate?: object}} [input.declaredArms]
 *        the arm build identity the ARTIFACT declares (`e2e.dualBuild.*`), which
 *        must agree with the raw `identity.json` this bundle carries
 * @returns {{ok: boolean, problems: string[], facts: object, levels: object}}
 */
export function verifyEvidenceBundle(input) {
  const { evidenceRoot, expectSha, runId, attempt, platform, armEvidenceVerifier, declaredArms } = input ?? {};
  // TWO INDEPENDENT PROBLEM LISTS. The readiness levels are never collapsed
  // (plan §2/§10): a missing BUDGET file must not mark the REAL-BUILD level
  // unproven, and a broken arm artifact must not be reported as a budget issue.
  const problems = [];
  const budgetProblems = [];
  const facts = {
    evidenceRoot: isNonEmptyString(evidenceRoot) ? evidenceRoot : null,
    identity: null,
    perArmTotal: 0,
    perArmVerified: 0,
    derivedVerifierCoverage: null,
    budget: null,
    journalBinding: { status: "NOT_PROVEN", reason: null },
    // S6 — the request/attempt/dispatch-journal cross-binding (plan §10.2-10.4)
    // is S4's bundle contract and does not exist yet. It is declared here as an
    // UNBOUND dimension so `budgetEvidenceReady` can never PASS while a required
    // part of the budget proof is missing. It is never silently dropped.
    requestDispatchBinding: {
      status: "NOT_PROVEN",
      reason:
        "REQUEST_DISPATCH_JOURNAL_NOT_BOUND: the per-request/per-attempt request journal and the tool-dispatch reservation journal are not part of the bundle contract yet (S4/plan §10.2-10.4), so armRunId <-> requestId <-> attemptId <-> reservationId cannot be cross-bound and a dropped retry, a duplicate settlement or a tool unknown cannot be excluded",
    },
  };

  if (!isNonEmptyString(evidenceRoot)) {
    problems.push("NO_EVIDENCE_ROOT: no raw evidence root was supplied, so no raw arm/verifier/journal file can be read");
    return { ok: false, problems, budgetProblems, facts, levels: emptyLevels(problems, budgetProblems, facts) };
  }

  /** Read one bundle file, confined to the root. `sink` keeps the levels apart. */
  const readInside = (rel, sink = problems) => {
    const r = resolveInsideRoot(evidenceRoot, rel);
    if (!r.ok) {
      sink.push(`PATH_REJECTED: ${r.problem}`);
      return null;
    }
    try {
      return readFileSync(r.path, "utf8");
    } catch {
      sink.push(`MISSING_RAW_EVIDENCE: ${rel} is missing or unreadable under the evidence root`);
      return null;
    }
  };

  // --- 1. identity: the bundle's OWN run identity and build identity ---------
  const identityText = readInside(EVIDENCE_BUNDLE_FILES.identity);
  if (identityText !== null) {
    const identity = parseObject(identityText, EVIDENCE_BUNDLE_FILES.identity, problems);
    if (identity !== null) {
      if (identity.schemaVersion !== READINESS_EVIDENCE_SCHEMA) {
        problems.push(`EVIDENCE_SCHEMA: identity.schemaVersion is ${JSON.stringify(identity.schemaVersion)}, expected ${READINESS_EVIDENCE_SCHEMA}`);
      }
      if (!isSha40(identity.driverSha)) {
        problems.push(`IDENTITY_DRIVER_SHA_INVALID: identity.driverSha is not a 40-hex SHA (got ${JSON.stringify(identity.driverSha)})`);
      } else if (isSha40(expectSha) && identity.driverSha !== expectSha) {
        problems.push(`IDENTITY_SHA_MISMATCH: the evidence bundle is for driver ${identity.driverSha}, this run certifies ${expectSha}`);
      }
      if (!isNonEmptyString(identity.runId)) {
        problems.push("IDENTITY_RUN_ID_MISSING: the evidence bundle carries no run id");
      } else if (isNonEmptyString(runId) && identity.runId !== runId) {
        problems.push(`EVIDENCE_RUN_ID_MISMATCH: the evidence bundle is for run ${identity.runId}, this run certifies ${runId}`);
      }
      const idAttempt = asInt(identity.attempt);
      if (idAttempt === null) {
        problems.push("IDENTITY_ATTEMPT_MISSING: the evidence bundle carries no attempt number");
      } else if (attempt !== null && attempt !== undefined && idAttempt !== attempt) {
        problems.push(`EVIDENCE_ATTEMPT_MISMATCH: the evidence bundle is for attempt ${idAttempt}, this run certifies attempt ${String(attempt)}`);
      }
      if (!isNonEmptyString(identity.platform)) {
        problems.push("IDENTITY_PLATFORM_MISSING: the evidence bundle carries no platform");
      } else if (isNonEmptyString(platform) && identity.platform !== platform) {
        problems.push(`EVIDENCE_PLATFORM_MISMATCH: the evidence bundle is for platform ${identity.platform}, this run certifies ${platform}`);
      }

      const arms = identity.arms;
      if (typeof arms !== "object" || arms === null) {
        problems.push("IDENTITY_ARMS_MISSING: identity.arms does not carry the two arm build identities");
      } else {
        for (const armId of ["baseline", "candidate"]) {
          const a = arms[armId];
          const label = armId.toUpperCase();
          if (typeof a !== "object" || a === null) {
            problems.push(`BUILD_IDENTITY_MISSING: identity.arms.${armId} is absent`);
            continue;
          }
          if (!isSha40(a.sourceSha)) {
            problems.push(`${label}_SOURCE_SHA_INVALID: identity.arms.${armId}.sourceSha is not a 40-hex SHA (got ${JSON.stringify(a.sourceSha)})`);
          }
          if (!isSha256Hex(a.buildDigest)) {
            problems.push(`${label}_BUILD_DIGEST_MALFORMED: identity.arms.${armId}.buildDigest is not a 64-hex sha256 (got ${JSON.stringify(a.buildDigest)})`);
          }
          if (!isSha256Hex(a.entrySha256)) {
            problems.push(`${label}_ENTRY_SHA_INVALID: identity.arms.${armId}.entrySha256 is not a 64-hex sha256`);
          }
          if (a.clean !== true) {
            problems.push(`${label}_TREE_NOT_CLEAN: identity.arms.${armId}.clean is not true`);
          }
        }
        if (isSha40(arms.baseline?.sourceSha) && arms.baseline.sourceSha === arms.candidate?.sourceSha) {
          problems.push("ARMS_IDENTICAL: both arms name the same source SHA, so there is no comparable pair");
        }
        if (identity.closuresDistinguishable !== true) {
          problems.push("CLOSURES_NOT_DISTINGUISHABLE: identity.closuresDistinguishable is not true, so the two arm builds are not provably distinct");
        }
      }
      facts.identity = {
        driverSha: identity.driverSha ?? null,
        runId: identity.runId ?? null,
        attempt: asInt(identity.attempt),
        platform: identity.platform ?? null,
        baselineBuildDigest: arms?.baseline?.buildDigest ?? null,
        candidateBuildDigest: arms?.candidate?.buildDigest ?? null,
        arms: arms ?? null,
      };
    }
  }

  // --- 1b. the ARTIFACT's declared arm identity vs the raw identity file -----
  // S6/F3 — "64-hex" is necessary but not sufficient: the digest the artifact
  // declares must be the one the RAW identity file records. Otherwise a forger
  // only has to pick any well-formed sha256.
  if (declaredArms !== null && declaredArms !== undefined) {
    const rawArms = facts.identity?.arms ?? null;
    if (rawArms === null) {
      problems.push("BUILD_IDENTITY_UNVERIFIABLE: the artifact declares arm build identities but the bundle carries no readable identity.arms to compare them against");
    } else {
      for (const armId of ["baseline", "candidate"]) {
        const declared = declaredArms?.[armId];
        if (typeof declared !== "object" || declared === null) continue; // already reported above
        const raw = rawArms?.[armId];
        if (typeof raw !== "object" || raw === null) continue; // already reported above
        const label = armId.toUpperCase();
        if (isSha40(declared.sourceSha) && isSha40(raw.sourceSha) && declared.sourceSha !== raw.sourceSha) {
          problems.push(`${label}_SOURCE_SHA_MISMATCH: the artifact declares source ${declared.sourceSha}, the raw identity file records ${raw.sourceSha}`);
        }
        if (isSha256Hex(declared.buildDigest) && declared.buildDigest !== raw.buildDigest) {
          problems.push(`${label}_BUILD_DIGEST_MISMATCH: the artifact declares build digest ${declared.buildDigest}, the raw identity file records ${JSON.stringify(raw.buildDigest)}`);
        }
      }
    }
  }

  // --- 2. schedule + per-arm raw evidence -----------------------------------
  // `scheduleArmIds` is hoisted out of the block below because the budget step
  // needs it to detect a journal entry that belongs to no planned arm.
  const scheduleArmIds = new Set();
  const scheduleText = readInside(EVIDENCE_BUNDLE_FILES.schedule);
  if (scheduleText !== null) {
    const schedule = parseObject(scheduleText, EVIDENCE_BUNDLE_FILES.schedule, problems);
    if (schedule !== null) {
      if (schedule.schemaVersion !== READINESS_EVIDENCE_SCHEMA) {
        problems.push(`EVIDENCE_SCHEMA: schedule.schemaVersion is ${JSON.stringify(schedule.schemaVersion)}, expected ${READINESS_EVIDENCE_SCHEMA}`);
      }
      const list = Array.isArray(schedule.arms) ? schedule.arms : null;
      if (list === null || list.length === 0) {
        problems.push("SCHEDULE_EMPTY: schedule.arms is not a non-empty array, so no planned run can be reconciled");
      } else {
        facts.perArmTotal = list.length;
        const seen = new Set();
        for (const entry of list) {
          const armRunId = entry?.armRunId;
          if (!isNonEmptyString(armRunId)) {
            problems.push("SCHEDULE_ARM_RUN_ID_MISSING: a schedule entry carries no armRunId");
            continue;
          }
          if (seen.has(armRunId)) {
            problems.push(`DUPLICATE_ARM_RUN: ${armRunId} appears more than once in the schedule`);
            continue;
          }
          seen.add(armRunId);
          scheduleArmIds.add(armRunId);
          if (entry.armId !== "baseline" && entry.armId !== "candidate") {
            problems.push(`SCHEDULE_ARM_ID_INVALID: ${armRunId} names armId ${JSON.stringify(entry.armId)}`);
            continue;
          }
          if (!isNonEmptyString(entry.caseId) || asInt(entry.repetition) === null || asInt(entry.orderIndex) === null) {
            problems.push(`SCHEDULE_IDENTITY_INCOMPLETE: ${armRunId} is missing caseId/repetition/orderIndex`);
            continue;
          }
          const declared = entry.evidence;
          if (typeof declared !== "object" || declared === null) {
            problems.push(`ARM_EVIDENCE_NOT_DECLARED: ${armRunId} carries no declared evidence block`);
            continue;
          }
          if (typeof armEvidenceVerifier !== "function") {
            problems.push("EVIDENCE_VERIFIER_UNAVAILABLE: the A6 per-arm verifier could not be loaded, so no raw arm artifact was verified");
            continue;
          }
          const armDir = resolveInsideRoot(evidenceRoot, `${EVIDENCE_BUNDLE_FILES.armEvidenceDir}/${armRunId}`);
          if (!armDir.ok) {
            problems.push(`PATH_REJECTED: ${armDir.problem}`);
            continue;
          }
          let verdict;
          try {
            verdict = armEvidenceVerifier(armDir.path, {
              preregistrationDigest: entry.preregistrationDigest,
              planDigest: entry.planDigest,
              armRunId,
              armId: entry.armId,
              caseId: entry.caseId,
              repetition: asInt(entry.repetition),
              orderIndex: asInt(entry.orderIndex),
            }, declared);
          } catch (err) {
            problems.push(`ARM_EVIDENCE_UNVERIFIED: ${armRunId}: the verifier threw (${err instanceof Error ? err.message : String(err)})`);
            continue;
          }
          if (verdict?.verified === true) facts.perArmVerified += 1;
          else problems.push(`ARM_EVIDENCE_UNVERIFIED: ${armRunId}: ${(verdict?.problems ?? ["no verdict"]).join("; ")}`);
        }
        // Coverage is DERIVED from the per-arm records, never self-reported.
        facts.derivedVerifierCoverage = { verified: facts.perArmVerified, total: facts.perArmTotal };
        if (facts.perArmVerified !== facts.perArmTotal) {
          problems.push(`VERIFIER_COVERAGE_INCOMPLETE: ${facts.perArmVerified}/${facts.perArmTotal} scheduled arm runs were verified from raw artifacts`);
        }
      }
    }
  }

  // --- 3. budget: recomputed from raw journal entries vs the aggregate -------
  // Every problem here goes to `budgetProblems`, NEVER to `problems`: a missing
  // budget artifact is a BUDGET-level fact and must not make the REAL-BUILD
  // level unproven (the levels stay independent).
  const aggregateText = readInside(EVIDENCE_BUNDLE_FILES.aggregate, budgetProblems);
  const journalText = readInside(EVIDENCE_BUNDLE_FILES.costJournal, budgetProblems);
  if (aggregateText === null || journalText === null) {
    const missing = [
      aggregateText === null ? EVIDENCE_BUNDLE_FILES.aggregate : null,
      journalText === null ? EVIDENCE_BUNDLE_FILES.costJournal : null,
    ].filter((x) => x !== null);
    facts.journalBinding = {
      status: "NOT_PROVEN",
      reason: `JOURNAL_BINDING_NOT_PROVEN: the bundle carries no ${missing.join(" and ")}; the request/attempt/dispatch-journal cross-binding is S4's bundle contract and is not implemented yet`,
    };
  } else {
    const aggregate = parseObject(aggregateText, EVIDENCE_BUNDLE_FILES.aggregate, budgetProblems);
    const journal = parseObject(journalText, EVIDENCE_BUNDLE_FILES.costJournal, budgetProblems);
    if (aggregate !== null && journal !== null) {
      const entries = Array.isArray(journal.entries) ? journal.entries : null;
      if (entries === null) {
        budgetProblems.push("JOURNAL_ENTRIES_MISSING: cost-journal.json carries no entries array, so per-arm attribution cannot be reconciled");
        facts.journalBinding = { status: "NOT_PROVEN", reason: "JOURNAL_ENTRIES_MISSING: the raw per-request entries are absent" };
      } else {
        const seenAttempts = new Set();
        for (const e of entries) {
          if (!isNonEmptyString(e?.armRunId)) {
            budgetProblems.push("JOURNAL_ENTRY_UNATTRIBUTED: a journal entry carries no armRunId");
            continue;
          }
          if (scheduleArmIds.size > 0 && !scheduleArmIds.has(e.armRunId)) {
            budgetProblems.push(`JOURNAL_UNKNOWN_ARM: journal entry for ${e.armRunId} has no schedule entry`);
          }
          const key = `${e.armRunId}|${String(e.requestId)}|${String(e.attemptId)}`;
          if (seenAttempts.has(key)) budgetProblems.push(`JOURNAL_DUPLICATE_ATTEMPT: ${key} is settled more than once`);
          seenAttempts.add(key);
        }
        const totals = recomputeJournalTotals(entries);
        facts.budget = totals;
        const cost = aggregate.cost ?? null;
        const aggTotal = asInt(cost?.totalTokens);
        const aggDelta = asInt(cost?.deltaTokens);
        if (aggTotal === null || aggDelta === null) {
          budgetProblems.push("AGGREGATE_COST_MISSING: aggregate.cost.totalTokens/deltaTokens is absent, so the journal cannot be compared");
        } else {
          if (aggTotal !== totals.measuredTotal + totals.reservedUpperBound) {
            budgetProblems.push(`BUDGET_TOTAL_MISMATCH: aggregate total ${aggTotal} != journal recomputed ${totals.measuredTotal + totals.reservedUpperBound}`);
          }
          if (aggDelta !== totals.measuredDelta) {
            budgetProblems.push(`BUDGET_DELTA_MISMATCH: aggregate delta ${aggDelta} != journal recomputed candidate-baseline ${totals.measuredDelta}`);
          }
        }
        if (totals.unsettledEntries > 0) {
          budgetProblems.push(`JOURNAL_UNSETTLED_ENTRIES: ${totals.unsettledEntries} journal entries carry no usable arm/basis and are not flattened to zero`);
        }
        if (totals.unknownEntries > 0) {
          facts.journalBinding = {
            status: "NOT_PROVEN",
            reason: `JOURNAL_UNKNOWN_USAGE: ${totals.unknownEntries} entries were dispatched but never observed; their conservative upper bound ${totals.reservedUpperBound} stays visible and is not reported as measured consumption`,
          };
        } else if (budgetProblems.length === 0) {
          facts.journalBinding = { status: "MEASURED", reason: null };
        } else {
          facts.journalBinding = { status: "NOT_PROVEN", reason: budgetProblems.join("; ") };
        }
      }
    }
  }

  return { ok: problems.length === 0, problems, budgetProblems, facts, levels: emptyLevels(problems, budgetProblems, facts) };
}

/**
 * The machine-checkable decision conditions per level. `verifyEvidenceBundle`
 * fills the two levels it decides; `ci-readiness.mjs` owns the rest.
 *
 * `budgetEvidenceReady` requires BOTH the raw journal reconciliation AND the
 * request/dispatch cross-binding. While the latter is unbound, this level stays
 * NOT_PROVEN even when every other check passes — a partially proven budget is
 * not a proven budget.
 */
function emptyLevels(problems, budgetProblems, facts) {
  const realOk = problems.length === 0;
  const budgetOk =
    realOk &&
    budgetProblems.length === 0 &&
    facts.journalBinding?.status === "MEASURED" &&
    facts.requestDispatchBinding?.status === "MEASURED";
  const budgetReason = budgetOk
    ? null
    : facts.requestDispatchBinding?.status !== "MEASURED"
      ? facts.requestDispatchBinding?.reason
      : facts.journalBinding?.reason ??
        (budgetProblems.length > 0 ? budgetProblems.join("; ") : problems.length > 0 ? problems.join("; ") : "no budget evidence was verified");
  return {
    realBuildOfflineReady: {
      status: realOk ? "PASS" : "NOT_PROVEN",
      reason: realOk ? null : problems.join("; "),
    },
    budgetEvidenceReady: {
      status: budgetOk ? "PASS" : "NOT_PROVEN",
      reason: budgetReason,
    },
  };
}
