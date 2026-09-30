#!/usr/bin/env node
/**
 * N3 (plan(20260930-061557).md §6) — the STRICT tool-dispatch journal contract.
 *
 * WHY THIS FILE EXISTS (defect F30-4)
 * -----------------------------------
 * `readiness-evidence-verify.mjs::bindRequestDispatchJournals` used to accept the
 * tool-dispatch side on a single test: "a reservation object exists and its
 * `reservationId` appears in the request journal". That accepted, as
 * `budgetEvidenceReady = MEASURED`:
 *
 *   - a DUPLICATED dispatch reservation (`reservationId` appeared twice);
 *   - an entry attributed to the WRONG ARM (the arm was never read);
 *   - `outcome: "banana"` — any non-null value counted as "settled";
 *   - an EMPTY `reservations: []` with no coverage declaration at all.
 *
 * and it REJECTED the truth: a real, independent tool reservation id
 * (`<armRunId>:tool:1`) is not a model quota id, so requiring membership in the
 * model reservation set marked a genuine dispatch `DISPATCH_RESERVATION_UNBOUND`.
 *
 * The contract below is the fix, stated ONCE so the producer, the readiness
 * verifier and the R5 bundle verifier cannot drift:
 *
 *   - a VERSIONED schema, with per-field type checks and a CLOSED settlement enum
 *     (`dispatched` / `not_executed` / `unknown`) and a CLOSED refusal enum;
 *   - one CONTIGUOUS 1..N event sequence and an authoritative `eventCount`, so a
 *     deleted, truncated, reordered or tail-less journal is detected rather than
 *     silently completed from a summary;
 *   - UNIQUE tool reservation ids and UNIQUE durable dispatch ids;
 *   - arm / case / repetition / orderIndex / campaignDigest must agree with the
 *     SCHEDULE the bundle declares;
 *   - a tool dispatch is bound to its PARENT MODEL REQUEST by
 *     `(armRunId, parentRequestId, parentAttemptId)`, which must EXIST in the
 *     request/attempt journal — the tool id and the model quota id are never
 *     compared for equality;
 *   - settle IDEMPOTENCE and COUNT CONSERVATION against the durable cost ledger:
 *     `charged.toolCalls` must equal `dispatched + unknown`, and
 *     `reserved.toolCalls` must equal the number of granted-but-unsettled
 *     reservations. An unsettled grant keeps its UPPER BOUND and is reported as
 *     UNKNOWN — never as `not_executed`, never as 0.
 *   - an EMPTY journal is neither an error nor a pass: it is accepted only with a
 *     coverage proof EXPORTED BY THE PRODUCING EXECUTION (one closed coverage
 *     record per scheduled arm run, all counters zero) and zero tool consumption
 *     in the durable ledger. A hand-written empty array fails.
 *
 * PURE / OFFLINE: no I/O, no provider, no network, zero cost.
 */

/** The versioned schema tag this contract validates (mirrors the TS producer). */
export const N3_DISPATCH_JOURNAL_SCHEMA = "e4-n3-tool-dispatch-journal-v1";
/** The only legal settlement outcomes. */
export const DISPATCH_SETTLEMENTS = Object.freeze(["dispatched", "not_executed", "unknown"]);
/** The only legal reserve-refusal reasons. */
export const DISPATCH_REFUSAL_REASONS = Object.freeze(["TOOL_BUDGET_EXHAUSTED", "CAMPAIGN_DEADLINE_EXCEEDED"]);
/** The only legal event kinds. */
export const DISPATCH_EVENT_TYPES = Object.freeze(["reserve_granted", "reserve_refused", "settled"]);

const SETTLEMENTS = new Set(DISPATCH_SETTLEMENTS);
const REFUSALS = new Set(DISPATCH_REFUSAL_REASONS);
const EVENT_TYPES = new Set(DISPATCH_EVENT_TYPES);

const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";
const isInt = (v) => typeof v === "number" && Number.isInteger(v);
/** `null` is a MEANINGFUL value throughout this contract (NOT_PROVEN), never a
 *  placeholder for a number, and never interchangeable with `undefined`. */
const isNullableString = (v) => v === null || isNonEmptyString(v);
const isNullableInt = (v) => v === null || isInt(v);

/** The required field names, with the predicate each must satisfy. */
const EVENT_FIELDS = Object.freeze({
  seq: isInt,
  type: (v) => EVENT_TYPES.has(v),
  atMs: isInt,
  armRunId: isNonEmptyString,
  arm: (v) => v === "baseline" || v === "candidate",
  caseId: isNonEmptyString,
  repetition: isInt,
  orderIndex: isNullableInt,
  campaignDigest: isNullableString,
  toolReservationId: isNullableString,
  dispatchId: isNullableString,
  toolCallId: isNullableString,
  tool: isNullableString,
  sessionId: isNullableString,
  turnId: isNullableString,
  readOnly: (v) => v === null || typeof v === "boolean",
  sideEffectScope: isNullableString,
  parentRequestId: isNullableString,
  parentAttemptId: isNullableInt,
  refusalReason: (v) => v === null || REFUSALS.has(v),
  settlement: (v) => v === null || SETTLEMENTS.has(v),
});

/** A field that may legitimately stay `null` (unprovable) in this schema. */
const NULLABLE_EVENT_FIELDS = new Set([
  "orderIndex",
  "campaignDigest",
  "toolReservationId",
  "dispatchId",
  "toolCallId",
  "tool",
  "sessionId",
  "turnId",
  "readOnly",
  "sideEffectScope",
  "parentRequestId",
  "parentAttemptId",
  "refusalReason",
  "settlement",
]);

/**
 * Index the REQUEST/ATTEMPT journal (the cost ledger's own `entries`) by arm run
 * and request, so a tool dispatch can be resolved to the model request that
 * declared it.
 */
export function indexRequestJournal(entries) {
  const byArm = new Map();
  const allReservationIds = new Set();
  for (const e of entries ?? []) {
    if (e === null || typeof e !== "object") continue;
    if (!isNonEmptyString(e.armRunId)) continue;
    if (isNonEmptyString(e.reservationId)) allReservationIds.add(e.reservationId);
    if (!isNonEmptyString(e.requestId) || !isInt(e.attemptId)) continue;
    const arm = byArm.get(e.armRunId) ?? new Map();
    const req = arm.get(e.requestId) ?? {
      requestId: e.requestId,
      arm: e.arm,
      caseId: e.caseId,
      repetition: e.repetition,
      attempts: new Set(),
      digest: e.campaignDigest ?? null,
    };
    req.attempts.add(e.attemptId);
    arm.set(e.requestId, req);
    byArm.set(e.armRunId, arm);
  }
  return { byArm, allReservationIds };
}

/**
 * Validate the tool-dispatch journal against the schedule and the request journal.
 *
 * @param {object} input
 * @param {object|null} input.journal          the parsed `dispatch-journal.json`
 * @param {string|null} input.journalFile      its file name, for messages
 * @param {Map<string, object>} input.scheduleArms armRunId -> schedule record
 * @param {Array<object>|null} input.requestEntries the request/attempt journal
 * @param {{chargedToolCalls: number|null, reservedToolCalls: number|null}|null} input.budgetFacts
 * @returns {{problems: string[], facts: object}}
 */
export function verifyDispatchJournal({ journal, journalFile, scheduleArms, requestEntries, budgetFacts }) {
  const problems = [];
  const label = isNonEmptyString(journalFile) ? journalFile : "dispatch-journal.json";
  const facts = {
    dispatchJournalFile: label,
    schemaVersion: null,
    eventCount: null,
    declaredEventCount: null,
    reserveGranted: 0,
    reserveRefused: 0,
    settled: 0,
    dispatchCount: 0,
    settledDispatched: 0,
    settledNotExecuted: 0,
    settledUnknown: 0,
    unsettledGrants: 0,
    coveredArmRuns: 0,
    scheduledArmRuns: scheduleArms instanceof Map ? scheduleArms.size : null,
    chargedToolCalls: budgetFacts?.chargedToolCalls ?? null,
    reservedToolCalls: budgetFacts?.reservedToolCalls ?? null,
  };

  if (journal === null || journal === undefined || typeof journal !== "object" || Array.isArray(journal)) {
    problems.push(`DISPATCH_JOURNAL_MALFORMED: ${label} is not a JSON object`);
    return { problems, facts };
  }

  // --- 1. the versioned schema -------------------------------------------
  facts.schemaVersion = journal.schemaVersion ?? null;
  if (journal.schemaVersion !== N3_DISPATCH_JOURNAL_SCHEMA) {
    // This is also what refuses the PRE-N3 shapes (`{reservations: [...]}`,
    // `{entries: [...]}`): they carry no version, no sequence and no coverage, so
    // "a parsed JSON is evidence" can no longer be reached from them.
    problems.push(
      `DISPATCH_JOURNAL_SCHEMA: ${label}.schemaVersion is ${JSON.stringify(journal.schemaVersion)}, expected ${N3_DISPATCH_JOURNAL_SCHEMA}`,
    );
  }
  const events = Array.isArray(journal.events) ? journal.events : null;
  if (events === null) {
    problems.push(`DISPATCH_JOURNAL_EVENTS_MISSING: ${label} carries no events array`);
    return { problems, facts };
  }
  facts.eventCount = events.length;
  facts.declaredEventCount = isInt(journal.eventCount) ? journal.eventCount : null;

  // --- 2. completeness: the tail can never be lost silently --------------
  if (!isInt(journal.eventCount)) {
    problems.push(`DISPATCH_JOURNAL_EVENT_COUNT: ${label}.eventCount is ${JSON.stringify(journal.eventCount)}, expected an integer`);
  } else if (journal.eventCount !== events.length) {
    problems.push(
      `DISPATCH_JOURNAL_TRUNCATED: ${label} declares eventCount=${journal.eventCount} but carries ${events.length} event(s) — a summary may not be used to stand in for missing entries`,
    );
  }

  const coverage = journal.coverage !== undefined && journal.coverage !== null && typeof journal.coverage === "object" ? journal.coverage : null;
  const coverageArmRuns = coverage !== null && Array.isArray(coverage.armRuns) ? coverage.armRuns : null;
  if (coverage === null || coverageArmRuns === null) {
    problems.push(
      `DISPATCH_JOURNAL_NO_COVERAGE: ${label} carries no coverage.armRuns — the producing execution must export WHICH arm runs it observed, so an empty event list is proved rather than asserted`,
    );
  }

  const { byArm, allReservationIds } = indexRequestJournal(requestEntries);

  // --- 3. per-event schema, identity and uniqueness ----------------------
  const coverageByArm = new Map();
  for (const c of coverageArmRuns ?? []) {
    if (c === null || typeof c !== "object" || !isNonEmptyString(c.armRunId)) continue;
    coverageByArm.set(c.armRunId, c);
  }

  const seenGrantDispatchIds = new Map();
  const seenGrantToolReservations = new Map();
  const grantByDispatchId = new Map();
  const settledToolReservations = new Set();
  const settledDispatchIds = new Set();
  const digestSet = new Set();
  let dispatched = 0;
  let unknown = 0;
  let notExecuted = 0;
  let unsettled = 0;
  const problemSeen = new Set();
  const pushOnce = (code) => {
    if (problemSeen.has(code)) return;
    problemSeen.add(code);
    problems.push(code);
  };

  events.forEach((e, i) => {
    const where = `${label} event[${i}]`;
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      problems.push(`DISPATCH_JOURNAL_MALFORMED: ${where} is not an object`);
      return;
    }
    // 3a. sequence: contiguous 1..N, in file order. A reordered or spliced
    // journal fails here before any of its claims are believed.
    if (e.seq !== i + 1) {
      problems.push(`DISPATCH_EVENT_SEQ: ${where} has seq ${JSON.stringify(e.seq)}, expected ${i + 1} — the journal is reordered, spliced or has a gap`);
    }
    // 3b. required fields and their TYPES.
    for (const [field, ok] of Object.entries(EVENT_FIELDS)) {
      if (!(field in e)) {
        problems.push(`DISPATCH_EVENT_FIELD_MISSING: ${where} carries no ${field}`);
        continue;
      }
      if (e[field] === undefined) {
        problems.push(`DISPATCH_EVENT_FIELD_MISSING: ${where}.${field} is undefined (write null when the value is genuinely unknown)`);
        continue;
      }
      if (!ok(e[field])) {
        const code =
          field === "settlement"
            ? "DISPATCH_SETTLEMENT_INVALID"
            : field === "refusalReason"
              ? "DISPATCH_REFUSAL_REASON_INVALID"
              : field === "type"
                ? "DISPATCH_EVENT_TYPE_INVALID"
                : "DISPATCH_EVENT_FIELD_TYPE";
        problems.push(`${code}: ${where}.${field} is ${JSON.stringify(e[field])}`);
      }
    }
    if (problems.length > 0 && !EVENT_TYPES.has(e.type)) return;

    // 3c. the event's own identity must name a SCHEDULED arm.
    const scheduled = scheduleArms instanceof Map ? (scheduleArms.get(e.armRunId) ?? null) : null;
    if (scheduled === null) {
      pushOnce(`DISPATCH_UNKNOWN_ARM: ${label} carries an event for ${String(e.armRunId)}, which the schedule does not plan`);
    } else {
      if (e.arm !== scheduled.armId) {
        pushOnce(
          `DISPATCH_EVENT_ARM_MISMATCH: ${e.armRunId} is scheduled as ${String(scheduled.armId)} but the journal attributes an event to ${JSON.stringify(e.arm)}`,
        );
      }
      if (isNonEmptyString(scheduled.caseId) && e.caseId !== scheduled.caseId) {
        pushOnce(
          `DISPATCH_EVENT_SCOPE_MISMATCH: ${e.armRunId} is scheduled for case ${scheduled.caseId} but the journal says ${String(e.caseId)}`,
        );
      }
      if (isInt(scheduled.repetition) && e.repetition !== scheduled.repetition) {
        pushOnce(
          `DISPATCH_EVENT_SCOPE_MISMATCH: ${e.armRunId} is scheduled for repetition ${scheduled.repetition} but the journal says ${String(e.repetition)}`,
        );
      }
      if (isInt(scheduled.orderIndex) && isInt(e.orderIndex) && e.orderIndex !== scheduled.orderIndex) {
        pushOnce(
          `DISPATCH_EVENT_ORDER_MISMATCH: ${e.armRunId} is scheduled at orderIndex ${scheduled.orderIndex} but the journal says ${e.orderIndex}`,
        );
      }
    }
    if (isNonEmptyString(e.campaignDigest)) digestSet.add(e.campaignDigest);

    // 3d. uniqueness, in TWO stages. A reservation is GRANTED once and SETTLED at
    // most once — the pair legitimately repeats the same identifiers (that is how
    // a settle names the reservation it settles), so a bare "appears twice" test
    // would refuse every real journal. What must be unique is each LIFECYCLE STEP.
    if (isNonEmptyString(e.dispatchId)) {
      if (e.type === "reserve_granted") {
        const prior = seenGrantDispatchIds.get(e.dispatchId);
        if (prior === undefined) seenGrantDispatchIds.set(e.dispatchId, e.armRunId);
        else
          pushOnce(
            `DISPATCH_DUPLICATE_DISPATCH_ID: durable dispatch id ${e.dispatchId} is granted more than once (${prior} and ${e.armRunId}) — one reservation is taken exactly once`,
          );
      } else if (settledDispatchIds.has(e.dispatchId)) {
        pushOnce(`DISPATCH_SETTLE_DUPLICATE: durable dispatch id ${e.dispatchId} is settled more than once`);
      } else {
        settledDispatchIds.add(e.dispatchId);
      }
    }
    if (isNonEmptyString(e.toolReservationId)) {
      // The tool reservation id and a MODEL quota id are DIFFERENT identifiers.
      // Requiring them to be equal is the F30-4 defect; an actual COLLISION is
      // the opposite error — it means the two namespaces were conflated.
      if (allReservationIds.has(e.toolReservationId)) {
        pushOnce(
          `DISPATCH_ID_NAMESPACE_COLLISION: tool reservation ${e.toolReservationId} is also a MODEL quota reservation id — the two namespaces must stay distinct`,
        );
      }
      if (e.type === "reserve_granted" || e.type === "reserve_refused") {
        const prior = seenGrantToolReservations.get(e.toolReservationId);
        if (prior === undefined) seenGrantToolReservations.set(e.toolReservationId, e);
        else
          pushOnce(
            `DISPATCH_DUPLICATE_TOOL_RESERVATION: tool reservation ${e.toolReservationId} is reserved more than once (${prior.type}/${prior.armRunId} and ${e.type}/${e.armRunId})`,
          );
      }
    }

    // 3e. the lifecycle rules of each event kind.
    if (e.type === "reserve_granted") {
      facts.reserveGranted += 1;
      if (!isNonEmptyString(e.dispatchId)) {
        pushOnce(`DISPATCH_GRANT_WITHOUT_DISPATCH_ID: a reserve_granted event must name the durable dispatch id it holds`);
      }
      if (e.settlement !== null || e.refusalReason !== null) {
        pushOnce(`DISPATCH_GRANT_FIELDS: a reserve_granted event must not already carry a settlement or a refusal reason`);
      }
      if (isNonEmptyString(e.dispatchId)) grantByDispatchId.set(e.dispatchId, e);
    } else if (e.type === "reserve_refused") {
      facts.reserveRefused += 1;
      if (!REFUSALS.has(e.refusalReason)) {
        pushOnce(`DISPATCH_REFUSAL_REASON_INVALID: a reserve_refused event must name TOOL_BUDGET_EXHAUSTED or CAMPAIGN_DEADLINE_EXCEEDED, got ${JSON.stringify(e.refusalReason)}`);
      }
      if (e.dispatchId !== null) {
        pushOnce(`DISPATCH_REFUSAL_HAS_RESERVATION: a refused dispatch must not hold a reservation (dispatchId ${String(e.dispatchId)})`);
      }
      if (e.settlement !== null) {
        pushOnce(`DISPATCH_REFUSAL_SETTLED: a refused dispatch was never dispatched and must not carry a settlement`);
      }
    } else if (e.type === "settled") {
      facts.settled += 1;
      if (!SETTLEMENTS.has(e.settlement)) {
        pushOnce(`DISPATCH_SETTLEMENT_INVALID: a settled event must carry a defined outcome (${DISPATCH_SETTLEMENTS.join(" | ")}), got ${JSON.stringify(e.settlement)}`);
      }
      if (!isNonEmptyString(e.dispatchId)) {
        pushOnce(`DISPATCH_SETTLE_WITHOUT_RESERVATION: a settled event must name the reservation it settles`);
      } else if (!grantByDispatchId.has(e.dispatchId)) {
        pushOnce(`DISPATCH_SETTLE_WITHOUT_GRANT: ${e.dispatchId} is settled but never granted`);
      }
      if (!isNonEmptyString(e.toolReservationId)) {
        pushOnce(`DISPATCH_SETTLE_WITHOUT_TOOL_RESERVATION: a settled event must name the tool reservation it settles`);
      } else if (!seenGrantToolReservations.has(e.toolReservationId)) {
        pushOnce(
          `DISPATCH_SETTLE_WITHOUT_GRANT: tool reservation ${e.toolReservationId} is settled but never reserved — a settle may not create a dispatch fact`,
        );
      } else {
        settledToolReservations.add(e.toolReservationId);
      }
      // A LEGAL idempotent duplicate notification settles ONCE and appends no
      // second event; a second `settled` event for the same reservation is a
      // forged double entry and is refused (the duplicate-id check above is what
      // catches it, so nothing is charged twice here either way).
      if (e.settlement === "dispatched") dispatched += 1;
      else if (e.settlement === "unknown") unknown += 1;
      else if (e.settlement === "not_executed") notExecuted += 1;
    } else {
      pushOnce(`DISPATCH_EVENT_TYPE_INVALID: ${where}.type is ${JSON.stringify(e.type)}`);
      return;
    }

    // 3f. the PARENT MODEL REQUEST. This is the ONLY link between a tool dispatch
    // and the model quota id, and it is checked by EXISTENCE, never by equality.
    if (e.type === "reserve_granted" || e.type === "settled") {
      if (!isNonEmptyString(e.parentRequestId)) {
        pushOnce(`DISPATCH_PARENT_REQUEST_UNBOUND: a granted/settled dispatch must name the model request that declared it (${e.armRunId} carries ${JSON.stringify(e.parentRequestId)})`);
      } else if (requestEntries !== null && requestEntries !== undefined) {
        const requests = byArm.get(e.armRunId) ?? null;
        const req = requests === null ? null : (requests.get(e.parentRequestId) ?? null);
        if (req === null) {
          pushOnce(
            `DISPATCH_PARENT_REQUEST_UNBOUND: ${e.armRunId}/${e.parentRequestId} appears in no request/attempt journal entry — a tool dispatch cannot be bound by a same-named reservation`,
          );
        } else {
          if (isNonEmptyString(req.caseId) && req.caseId !== e.caseId) {
            pushOnce(`DISPATCH_PARENT_SCOPE_MISMATCH: ${e.armRunId}/${e.parentRequestId} is journaled for case ${req.caseId} but its tool dispatch says ${e.caseId}`);
          }
          if (isNonEmptyString(req.arm) && req.arm !== e.arm) {
            pushOnce(`DISPATCH_PARENT_ARM_MISMATCH: ${e.armRunId}/${e.parentRequestId} is journaled for arm ${req.arm} but its tool dispatch says ${e.arm}`);
          }
          if (isInt(e.parentAttemptId)) {
            if (!req.attempts.has(e.parentAttemptId)) {
              pushOnce(
                `DISPATCH_PARENT_ATTEMPT_UNBOUND: ${e.armRunId}/${e.parentRequestId} has no attempt ${e.parentAttemptId} in the request journal (recorded attempts: ${[...req.attempts].sort((a, b) => a - b).join(", ") || "none"})`,
              );
            }
          } else if (req.attempts.size !== 1) {
            // The response that declared the tool call could have come from ANY of
            // several physical attempts, so the binding is genuinely ambiguous —
            // UNKNOWN, not "probably attempt 0".
            pushOnce(
              `DISPATCH_PARENT_ATTEMPT_AMBIGUOUS: ${e.armRunId}/${e.parentRequestId} was sent ${req.attempts.size} times and the journal does not say which attempt declared the tool call`,
            );
          }
        }
      }
    }

    // 3g. coverage must speak for every arm run that appears in the events.
    if (isNonEmptyString(e.armRunId) && coverageByArm.size > 0 && !coverageByArm.has(e.armRunId)) {
      pushOnce(`DISPATCH_EVENT_UNCOVERED_ARM_RUN: ${label} carries events for ${e.armRunId} but its coverage never observed that arm run`);
    }
  });

  // --- 4. count conservation against the durable ledger -------------------
  const grantsWithoutSettle = [...grantByDispatchId.values()].filter(
    (g) => !isNonEmptyString(g.toolReservationId) || !settledToolReservations.has(g.toolReservationId),
  );
  unsettled = grantsWithoutSettle.length;
  // A grant whose settlement was never recorded is NOT a release: it stays
  // UNKNOWN with its upper bound retained.
  if (unsettled > 0) {
    problems.push(
      `DISPATCH_SETTLE_INCOMPLETE: ${unsettled} granted dispatch(es) carry no settlement event (${grantsWithoutSettle
        .map((g) => String(g.toolReservationId ?? g.dispatchId ?? "?"))
        .join(", ")}) — their consumption is UNKNOWN and their upper bound is retained, never zero and never not_executed`,
    );
  }
  facts.dispatchCount = dispatched + unknown + notExecuted;
  facts.settledDispatched = dispatched;
  facts.settledNotExecuted = notExecuted;
  facts.settledUnknown = unknown;
  facts.unsettledGrants = unsettled;

  const campaignDigests = new Set(digestSet);
  if (journal.campaignDigest !== undefined && journal.campaignDigest !== null) campaignDigests.add(journal.campaignDigest);
  if (campaignDigests.size > 1) {
    problems.push(
      `CROSS_RUN_SPLICE: the tool-dispatch journal carries ${campaignDigests.size} distinct campaignDigests (${[...campaignDigests].join(", ")})`,
    );
  }
  const requestDigests = new Set();
  for (const e of requestEntries ?? []) {
    if (e !== null && typeof e === "object" && isNonEmptyString(e.campaignDigest)) requestDigests.add(e.campaignDigest);
  }
  if (journal.campaignDigest !== undefined && journal.campaignDigest !== null && requestDigests.size === 1) {
    const only = [...requestDigests][0];
    if (journal.campaignDigest !== only) {
      problems.push(
        `DISPATCH_CAMPAIGN_MISMATCH: the tool-dispatch journal belongs to campaign ${String(journal.campaignDigest)} but the request journal belongs to ${String(only)}`,
      );
    }
  }

  // --- 5. the COVERAGE proof, and what an empty event list must show ------
  facts.coveredArmRuns = coverageByArm.size;
  if (coverageArmRuns !== null) {
    const observed = new Set([...coverageByArm.keys()]);
    if (scheduleArms instanceof Map) {
      for (const armRunId of scheduleArms.keys()) {
        if (!observed.has(armRunId)) {
          pushOnce(
            `DISPATCH_COVERAGE_INCOMPLETE: the schedule plans ${armRunId} but the tool-dispatch journal never observed it — an arm run no producer covered cannot be excluded from the tool dimension`,
          );
        }
      }
    }
    for (const [armRunId, c] of coverageByArm) {
      if (!isInt(c.openedAtMs)) {
        pushOnce(`DISPATCH_COVERAGE_MALFORMED: the coverage record for ${armRunId} carries no openedAtMs`);
      }
      if (c.closedAtMs === null || c.closedAtMs === undefined || !isInt(c.closedAtMs)) {
        // An arm run still "in flight" has no settled dispatch facts behind it.
        pushOnce(`DISPATCH_COVERAGE_UNCLOSED: the coverage record for ${armRunId} was never closed, so its dispatch count is not a final fact`);
      }
      if (!isInt(c.reserveFrames) || !isInt(c.settleFrames)) {
        pushOnce(`DISPATCH_COVERAGE_MALFORMED: the coverage record for ${armRunId} carries no integer reserveFrames/settleFrames`);
        continue;
      }
      // The counters must equal what the EVENTS say. A summary is not allowed to
      // stand in for entries that are missing from the file.
      const reserves = events.filter((e) => e?.armRunId === armRunId && (e.type === "reserve_granted" || e.type === "reserve_refused")).length;
      const settles = events.filter((e) => e?.armRunId === armRunId && e.type === "settled").length;
      if (c.reserveFrames !== reserves) {
        pushOnce(
          `DISPATCH_COVERAGE_COUNTS: coverage for ${armRunId} claims ${c.reserveFrames} reserve frame(s) but the journal carries ${reserves} — the summary may not fill in missing entries`,
        );
      }
      if (c.settleFrames !== settles) {
        pushOnce(
          `DISPATCH_COVERAGE_COUNTS: coverage for ${armRunId} claims ${c.settleFrames} settle frame(s) but the journal carries ${settles}`,
        );
      }
    }
  }

  const chargedKnown = budgetFacts !== null && budgetFacts !== undefined && isInt(budgetFacts.chargedToolCalls);
  const reservedKnown = budgetFacts !== null && budgetFacts !== undefined && isInt(budgetFacts.reservedToolCalls);
  if (!chargedKnown || !reservedKnown) {
    // "omit a field" is NOT_PROVEN, never a pass and never a 0.
    problems.push(
      `DISPATCH_BUDGET_TOOL_COUNTS_ABSENT: the bundle's cost journal carries no charged.toolCalls/reserved.toolCalls, so the dispatch journal cannot be reconciled against the durable tool dimension`,
    );
  } else {
    const charged = budgetFacts.chargedToolCalls;
    const reserved = budgetFacts.reservedToolCalls;
    if (charged !== dispatched + unknown) {
      problems.push(
        `DISPATCH_COUNT_CONSERVATION: the durable ledger charged ${charged} tool call(s) but the journal accounts for ${dispatched + unknown} (dispatched ${dispatched} + unknown ${unknown}); not_executed (${notExecuted}) is a release, not consumption`,
      );
    }
    if (reserved !== unsettled) {
      problems.push(
        `DISPATCH_RESERVATION_CONSERVATION: the durable ledger holds ${reserved} outstanding tool reservation(s) but the journal shows ${unsettled} granted-but-unsettled — an upper bound was refunded without proof it was never dispatched`,
      );
    }
  }

  // --- 6. the EMPTY journal: proved, or refused ---------------------------
  if (events.length === 0) {
    if (coverageArmRuns === null || coverageArmRuns.length === 0) {
      problems.push(
        `DISPATCH_JOURNAL_EMPTY_UNCOVERED: ${label} carries no event AND no coverage — an empty array is not a proof that the arm runs dispatched nothing`,
      );
    }
    const declaredReserve = (coverageArmRuns ?? []).reduce((n, c) => n + (isInt(c?.reserveFrames) ? c.reserveFrames : 0), 0);
    if (declaredReserve > 0) {
      problems.push(
        `DISPATCH_JOURNAL_EMPTY_CONTRADICTED: the coverage declares ${declaredReserve} reserve frame(s) but the journal carries no event for them`,
      );
    }
    if (isInt(budgetFacts?.chargedToolCalls) && budgetFacts.chargedToolCalls > 0) {
      problems.push(
        `DISPATCH_JOURNAL_EMPTY_CONTRADICTED: the durable ledger shows ${budgetFacts.chargedToolCalls} charged tool call(s) while the journal is empty`,
      );
    }
    if (isInt(budgetFacts?.reservedToolCalls) && budgetFacts.reservedToolCalls > 0) {
      problems.push(
        `DISPATCH_JOURNAL_EMPTY_CONTRADICTED: the durable ledger still holds ${budgetFacts.reservedToolCalls} tool reservation(s) while the journal is empty`,
      );
    }
  }

  return { problems, facts };
}
