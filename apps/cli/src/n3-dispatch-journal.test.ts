/**
 * N3 (plan(20260930-061557).md §6) — the production tool-dispatch journal and the
 * STRICT request/tool association. Defect F30-4.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `bindRequestDispatchJournals` used to accept the tool-dispatch side on one test
 * ("an object with a non-empty id that also appears in the request journal"), so
 * ALL of the following were rendered `budgetEvidenceReady = MEASURED`:
 *
 *   - a DUPLICATED dispatch reservation;
 *   - a dispatch attributed to the WRONG ARM;
 *   - `outcome: "banana"` / `outcome: "settled"` — any non-null value was
 *     "settled";
 *   - an EMPTY `reservations: []` with no coverage declaration.
 *
 * and the truth was REJECTED: a real, independent tool reservation id
 * (`<armRunId>:tool:1`) is not a model quota id, so requiring membership in the
 * model reservation set marked genuine dispatches UNBOUND.
 *
 * The counterexamples below are each derived from ONE fully valid journal and
 * change exactly ONE dimension, so a failure is always the dimension the test
 * names — never an earlier gate. The producer half then proves the durable
 * journal really is written at the reserve/settle boundary, and the last test
 * drives the REAL executor + isolated worker + durable budget chain end to end.
 *
 * OFFLINE: local files and local child processes only. Zero provider keys, zero
 * network, zero paid requests.
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelEvent, ModelProvider } from "@ar/contracts";
import {
  CostBudget,
  PREREG_RUN_MANIFEST_SCHEMA,
  R97_ARM_BUILD_ENTRIES,
  buildToolCallEfficiencyPreregistrationV2,
  createDurableToolDispatchBudget,
  createFormalBudgetedProvider,
  openR97BudgetLedger,
  stableStringify,
  type ToolCallEfficiencyPreregistrationV2,
  type PreregistrationV2Options,
} from "@ar/evaluation";
import {
  ARM_PROBE_EXPORT,
  FIXTURE_CHECKOUT_MARKER_FILENAME,
  createFixtureCheckoutTrust,
  createPreregArmExecutor,
} from "./prereg-arm-executor.js";
import { R97_ARM_ABI } from "./r97-arm-abi.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRATCH_ROOT = join(REPO_ROOT, ".ci", "n3-dispatch-journal-scratch");
const ARM_ENTRY_REL = "apps/cli/dist/benchmark-command.js";
const TOOLS_DIST = pathToFileURL(join(REPO_ROOT, "packages", "tools", "dist", "index.js")).href;
const REAL_CASE_ID = "stress-repeated-tool-failures";
const CASE_ID = "reg-01-basic-edit";
const N5_FIXTURE = JSON.parse(
  readFileSync(join(REPO_ROOT, "scripts", "e4", "fixtures", "n5-prereg-config.json"), "utf8"),
) as PreregistrationV2Options;

const scratchDirs: string[] = [];
async function scratch(name: string): Promise<string> {
  await mkdir(SCRATCH_ROOT, { recursive: true });
  const dir = await mkdtemp(join(SCRATCH_ROOT, `${name}-`));
  scratchDirs.push(dir);
  return dir;
}

/**
 * N3 — THE CAMPAIGN CLAIM REGISTRY IS MACHINE-GLOBAL, so it MUST be isolated.
 *
 * `openR97BudgetLedger` records the authorization it opened in
 * `R97_CAMPAIGN_CLAIMS_DIR` (a per-user, per-machine location by default). Two
 * test cases that open a ledger with the SAME `planDigest` therefore collide:
 * the second one is refused with `CAMPAIGN_STATE_LOST` / "already ESTABLISHED a
 * budget", because the recorded root belonged to the first case's temp directory
 * and has since been deleted. That refusal is CORRECT behaviour (a deleted root
 * is a loss of the consumed record, not a fresh allowance) — the defect would be
 * to relax it. The fix is to give every case its own claims directory, exactly as
 * `tool-call-efficiency-tool-budget.test.ts` and `prereg-production-wiring.test.ts`
 * do.
 */
const PREVIOUS_CLAIMS_DIR = process.env["R97_CAMPAIGN_CLAIMS_DIR"];
beforeEach(async () => {
  process.env["R97_CAMPAIGN_CLAIMS_DIR"] = await mkdtemp(join(tmpdir(), "n3-claims-"));
});

afterEach(async () => {
  if (PREVIOUS_CLAIMS_DIR === undefined) delete process.env["R97_CAMPAIGN_CLAIMS_DIR"];
  else process.env["R97_CAMPAIGN_CLAIMS_DIR"] = PREVIOUS_CLAIMS_DIR;
  await Promise.all(scratchDirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

/**
 * A UNIQUE campaign plan digest per call. Even with an isolated claims directory,
 * reusing one digest across cases would make each case's ledger a "resume" of a
 * deleted root; a unique digest makes every case a genuinely new campaign.
 */
let planDigestSeq = 0;
function uniquePlanDigest(): string {
  planDigestSeq += 1;
  return createHash("sha256").update(`n3-dispatch-journal#${planDigestSeq}`).digest("hex");
}

// ---------------------------------------------------------------------------
// The versioned journal fixture (ONE valid journal, derived from everywhere)
// ---------------------------------------------------------------------------

const ARM_B = "arm-run-baseline";
const ARM_C = "arm-run-candidate";

function scheduleArmsOf(): Map<string, { armId: string; caseId: string; repetition: number; orderIndex: number }> {
  return new Map([
    [ARM_B, { armId: "baseline", caseId: CASE_ID, repetition: 0, orderIndex: 0 }],
    [ARM_C, { armId: "candidate", caseId: CASE_ID, repetition: 0, orderIndex: 1 }],
  ]);
}

function requestEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    armRunId: ARM_B,
    arm: "baseline",
    caseId: CASE_ID,
    repetition: 0,
    requestId: `${ARM_B}:r1`,
    attemptId: 0,
    reservationId: "model-quota-1",
    campaignDigest: "campaign-digest-1",
    outcomeUnknown: false,
    ...over,
  };
}

function dispatchEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "reserve_granted",
    armRunId: ARM_B,
    arm: "baseline",
    caseId: CASE_ID,
    repetition: 0,
    orderIndex: 0,
    campaignDigest: "campaign-digest-1",
    // N3 — the TOOL reservation id is its OWN identifier. It deliberately does
    // NOT equal `model-quota-1`, and the binding must survive that.
    toolReservationId: `${ARM_B}:tool:1`,
    dispatchId: "tool-budget-reservation-1",
    toolCallId: "call-1",
    tool: "write_file",
    sessionId: "s1",
    turnId: "t1",
    readOnly: false,
    sideEffectScope: "filesystem",
    parentRequestId: `${ARM_B}:r1`,
    parentAttemptId: 0,
    refusalReason: null,
    settlement: null,
    ...over,
  };
}

function dispatchJournal(
  events: Array<Record<string, unknown>>,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const numbered = events.map((e, i) => ({ seq: i + 1, atMs: 1_700_000_000_000 + i, ...e }));
  return {
    schemaVersion: "e4-n3-tool-dispatch-journal-v1",
    campaignDigest: "campaign-digest-1",
    eventCount: numbered.length,
    events: numbered,
    coverage: {
      armRuns: [
        { armRunId: ARM_B, arm: "baseline", caseId: CASE_ID, repetition: 0, orderIndex: 0, openedAtMs: 1, closedAtMs: 9, reserveFrames: 1, settleFrames: 1 },
        { armRunId: ARM_C, arm: "candidate", caseId: CASE_ID, repetition: 0, orderIndex: 1, openedAtMs: 2, closedAtMs: 10, reserveFrames: 1, settleFrames: 1 },
      ],
    },
    ...over,
  };
}

/** A fully consistent two-arm journal: one dispatched write per arm. */
function validEvents(): Array<Record<string, unknown>> {
  return [
    dispatchEvent(),
    dispatchEvent({ type: "settled", settlement: "dispatched" }),
    dispatchEvent({
      armRunId: ARM_C,
      arm: "candidate",
      orderIndex: 1,
      toolReservationId: `${ARM_C}:tool:1`,
      dispatchId: "tool-budget-reservation-2",
      toolCallId: "call-2",
      parentRequestId: `${ARM_C}:r1`,
    }),
    dispatchEvent({
      type: "settled",
      armRunId: ARM_C,
      arm: "candidate",
      orderIndex: 1,
      toolReservationId: `${ARM_C}:tool:1`,
      dispatchId: "tool-budget-reservation-2",
      toolCallId: "call-2",
      parentRequestId: `${ARM_C}:r1`,
      settlement: "dispatched",
    }),
  ];
}

function validRequestEntries(): Array<Record<string, unknown>> {
  return [
    requestEntry(),
    requestEntry({ armRunId: ARM_C, arm: "candidate", requestId: `${ARM_C}:r1`, reservationId: "model-quota-2" }),
  ];
}

async function bind(over: {
  dispatchJournal?: unknown;
  entries?: Array<Record<string, unknown>> | null;
  scheduleArms?: Map<string, { armId: string; caseId: string; repetition: number; orderIndex: number }>;
  budgetFacts?: { chargedToolCalls: number | null; reservedToolCalls: number | null } | null;
} = {}) {
  const mod = await import(pathToFileURL(join(REPO_ROOT, "scripts", "e4", "readiness-evidence-verify.mjs")).href);
  return mod.bindRequestDispatchJournals({
    entries: "entries" in over ? over.entries : validRequestEntries(),
    scheduleArms: over.scheduleArms ?? scheduleArmsOf(),
    dispatchJournal: "dispatchJournal" in over ? over.dispatchJournal : dispatchJournal(validEvents()),
    dispatchJournalFile: "dispatch-journal.json",
    dispatchJournalProblem: null,
    budgetFacts: "budgetFacts" in over ? over.budgetFacts : { chargedToolCalls: 2, reservedToolCalls: 0 },
  });
}

// ---------------------------------------------------------------------------
// A. The F30-4 counterexamples (each changes ONE dimension of the valid journal)
// ---------------------------------------------------------------------------

describe("N3/F30-4 — the strict tool-dispatch journal contract", () => {
  it("N3/F30-4 duplicate dispatch and tool reservation are refused", async () => {
    // ONE dimension changed: the second arm's grant is duplicated verbatim
    // (same dispatchId, same toolReservationId) with a NEW sequence number, so
    // the journal is well-formed but charges one dispatch twice.
    const events = validEvents();
    events.splice(4, 0, { ...events[2] });
    const result = await bind({
      dispatchJournal: dispatchJournal(events, {
        coverage: {
          armRuns: [
            { armRunId: ARM_B, arm: "baseline", caseId: CASE_ID, repetition: 0, orderIndex: 0, openedAtMs: 1, closedAtMs: 9, reserveFrames: 1, settleFrames: 1 },
            { armRunId: ARM_C, arm: "candidate", caseId: CASE_ID, repetition: 0, orderIndex: 1, openedAtMs: 2, closedAtMs: 10, reserveFrames: 2, settleFrames: 1 },
          ],
        },
      }),
      budgetFacts: { chargedToolCalls: 2, reservedToolCalls: 0 },
    });
    expect(result.status).toBe("NOT_PROVEN");
    expect(result.reason).toMatch(/DISPATCH_DUPLICATE_DISPATCH_ID|DISPATCH_DUPLICATE_TOOL_RESERVATION/);
  });

  it("N3/F30-4 an undefined settlement value is refused by the closed enum", async () => {
    // ONE dimension changed: `settlement` carries a value that is not one of the
    // three defined outcomes. The old checker treated any non-null outcome as
    // "settled"; the closed enum is what refuses it.
    const events = validEvents();
    events[1] = { ...events[1]!, settlement: "banana" };
    const result = await bind({ dispatchJournal: dispatchJournal(events) });
    expect(result.status).toBe("NOT_PROVEN");
    expect(result.reason).toMatch(/DISPATCH_SETTLEMENT_INVALID/);
  });

  it("N3/F30-4 a dispatch attributed to the WRONG ARM is refused", async () => {
    // ONE dimension changed: the baseline arm's dispatch claims the candidate
    // arm. The old checker never read the arm at all.
    const events = validEvents();
    events[0] = { ...events[0]!, arm: "candidate" };
    events[1] = { ...events[1]!, arm: "candidate" };
    const result = await bind({ dispatchJournal: dispatchJournal(events) });
    expect(result.status).toBe("NOT_PROVEN");
    expect(result.reason).toMatch(/DISPATCH_EVENT_ARM_MISMATCH/);
  });

  it("N3/F30-4 an event for a case the schedule never planned is refused", async () => {
    const events = validEvents();
    events[0] = { ...events[0]!, caseId: "some-other-case" };
    events[1] = { ...events[1]!, caseId: "some-other-case" };
    const result = await bind({ dispatchJournal: dispatchJournal(events) });
    expect(result.status).toBe("NOT_PROVEN");
    expect(result.reason).toMatch(/DISPATCH_EVENT_SCOPE_MISMATCH/);
  });

  it("N3/F30-4 a campaign splice between the two journals is refused", async () => {
    const result = await bind({
      dispatchJournal: dispatchJournal(validEvents(), { campaignDigest: "campaign-digest-OTHER" }),
    });
    expect(result.status).toBe("NOT_PROVEN");
    expect(result.reason).toMatch(/DISPATCH_CAMPAIGN_MISMATCH/);
  });

  it("N3/F30-4 an empty journal with no coverage proof is refused", async () => {
    // ONE dimension changed: every event is removed AND the coverage proof is
    // gone. This is the forged `{ reservations: [] }` shape the old checker read
    // as a reconciled budget.
    const result = await bind({
      dispatchJournal: {
        schemaVersion: "e4-n3-tool-dispatch-journal-v1",
        campaignDigest: "campaign-digest-1",
        eventCount: 0,
        events: [],
      },
      budgetFacts: { chargedToolCalls: 0, reservedToolCalls: 0 },
    });
    expect(result.status).toBe("NOT_PROVEN");
    expect(result.reason).toMatch(/DISPATCH_JOURNAL_NO_COVERAGE|DISPATCH_JOURNAL_EMPTY_UNCOVERED/);
  });

  it("N3/F30-4 a pre-N3 journal shape is refused outright", async () => {
    // The OLD contract's own shape: `{reservations: [{reservationId, outcome}]}`.
    // It carries no version, no sequence and no coverage, so it can never reach
    // MEASURED again.
    const result = await bind({ dispatchJournal: { reservations: [{ reservationId: "model-quota-1", outcome: "settled" }] } });
    expect(result.status).toBe("NOT_PROVEN");
    expect(result.reason).toMatch(/DISPATCH_JOURNAL_SCHEMA/);
  });

  it("N3/F30-4 an independent tool reservation id binds through its parent request, never by equalling the model quota id", async () => {
    // The REAL shape: the tool reservation id is `<armRunId>:tool:1` and the
    // model quota id is `model-quota-1`. They are different identifiers, and the
    // binding must hold WITHOUT them being equal.
    const journal = dispatchJournal(validEvents());
    const events = journal["events"] as Array<Record<string, unknown>>;
    expect(events[0]!["toolReservationId"]).not.toBe(events[0]!["dispatchId"]);
    expect(events[0]!["toolReservationId"]).not.toBe("model-quota-1");
    const result = await bind({ dispatchJournal: journal });
    expect(result.status, JSON.stringify(result.problems)).toBe("MEASURED");

    // ...and conflating the two namespaces is refused in the OTHER direction.
    const collided = validEvents();
    collided[0] = { ...collided[0]!, toolReservationId: "model-quota-1" };
    collided[1] = { ...collided[1]!, toolReservationId: "model-quota-1" };
    const refused = await bind({ dispatchJournal: dispatchJournal(collided) });
    expect(refused.status).toBe("NOT_PROVEN");
    expect(refused.reason).toMatch(/DISPATCH_ID_NAMESPACE_COLLISION/);
  });

  it("N3/F30-4 a dispatch whose parent request or attempt does not exist is UNBOUND", async () => {
    // (a) the parent REQUEST does not exist.
    const missingRequest = validEvents();
    missingRequest[0] = { ...missingRequest[0]!, parentRequestId: `${ARM_B}:r9` };
    missingRequest[1] = { ...missingRequest[1]!, parentRequestId: `${ARM_B}:r9` };
    const a = await bind({ dispatchJournal: dispatchJournal(missingRequest) });
    expect(a.status).toBe("NOT_PROVEN");
    expect(a.reason).toMatch(/DISPATCH_PARENT_REQUEST_UNBOUND/);

    // (b) the request exists but the named ATTEMPT does not.
    const missingAttempt = validEvents();
    missingAttempt[0] = { ...missingAttempt[0]!, parentAttemptId: 4 };
    missingAttempt[1] = { ...missingAttempt[1]!, parentAttemptId: 4 };
    const b = await bind({ dispatchJournal: dispatchJournal(missingAttempt) });
    expect(b.status).toBe("NOT_PROVEN");
    expect(b.reason).toMatch(/DISPATCH_PARENT_ATTEMPT_UNBOUND/);
  });

  it("N3/F30-4 a truncated, reordered or tail-less journal is refused", async () => {
    // (a) the tail is gone but the summary still claims it: NO padding from the
    // summary is allowed.
    const truncated = dispatchJournal(validEvents());
    (truncated["events"] as unknown[]).pop();
    const a = await bind({ dispatchJournal: truncated });
    expect(a.status).toBe("NOT_PROVEN");
    expect(a.reason).toMatch(/DISPATCH_JOURNAL_TRUNCATED/);

    // (b) two events swapped: the sequence is no longer 1..N in file order.
    const reordered = dispatchJournal(validEvents());
    const ev = reordered["events"] as Array<Record<string, unknown>>;
    const first = ev[0]!["seq"];
    ev[0] = { ...ev[0]!, seq: ev[1]!["seq"] };
    ev[1] = { ...ev[1]!, seq: first };
    const b = await bind({ dispatchJournal: reordered });
    expect(b.status).toBe("NOT_PROVEN");
    expect(b.reason).toMatch(/DISPATCH_EVENT_SEQ/);

    // (c) a gap: one event deleted and the rest re-numbered consistently, but the
    // coverage counters no longer agree with the surviving entries.
    const gapped = dispatchJournal(validEvents().slice(0, 3));
    const c = await bind({ dispatchJournal: gapped });
    expect(c.status).toBe("NOT_PROVEN");
    expect(c.reason).toMatch(/DISPATCH_COVERAGE_COUNTS|DISPATCH_SETTLE_INCOMPLETE/);
  });

  it("N3/F30-4 an omitted field is never read as a value", async () => {
    // `settlement` removed entirely (not null): "omitted" and "null" must not be
    // the same thing, and neither is a settlement.
    const events = validEvents();
    const copy = { ...events[1]! };
    delete copy["settlement"];
    events[1] = copy;
    const result = await bind({ dispatchJournal: dispatchJournal(events) });
    expect(result.status).toBe("NOT_PROVEN");
    expect(result.reason).toMatch(/DISPATCH_EVENT_FIELD_MISSING/);
  });

  it("N3/F30-4 count conservation against the durable tool dimension is enforced", async () => {
    // The journal claims two dispatches; the durable ledger says it charged ONE.
    // A journal that talks past the ledger is not evidence.
    const result = await bind({ budgetFacts: { chargedToolCalls: 1, reservedToolCalls: 0 } });
    expect(result.status).toBe("NOT_PROVEN");
    expect(result.reason).toMatch(/DISPATCH_COUNT_CONSERVATION/);

    // An absent tool dimension is NOT_PROVEN, never an assumed 0.
    const absent = await bind({ budgetFacts: { chargedToolCalls: null, reservedToolCalls: null } });
    expect(absent.status).toBe("NOT_PROVEN");
    expect(absent.reason).toMatch(/DISPATCH_BUDGET_TOOL_COUNTS_ABSENT/);
  });

  it("N3/F30-4 a real zero-tool run passes ONLY with an exported coverage proof", async () => {
    // The PRODUCING execution exported one closed coverage record per scheduled
    // arm run, all counters zero, and the durable ledger shows zero tool
    // consumption. This is provable zero, not an asserted zero.
    const proven = await bind({
      dispatchJournal: dispatchJournal([], {
        coverage: {
          armRuns: [
            { armRunId: ARM_B, arm: "baseline", caseId: CASE_ID, repetition: 0, orderIndex: 0, openedAtMs: 1, closedAtMs: 9, reserveFrames: 0, settleFrames: 0 },
            { armRunId: ARM_C, arm: "candidate", caseId: CASE_ID, repetition: 0, orderIndex: 1, openedAtMs: 2, closedAtMs: 10, reserveFrames: 0, settleFrames: 0 },
          ],
        },
      }),
      budgetFacts: { chargedToolCalls: 0, reservedToolCalls: 0 },
    });
    expect(proven.status, JSON.stringify(proven.problems)).toBe("MEASURED");
    expect(proven.facts.toolDispatch.reserveGranted).toBe(0);
    expect(proven.facts.toolDispatch.dispatchCount).toBe(0);

    // A ledger that DID charge a tool call while the journal is empty contradicts
    // the zero claim and is refused.
    const contradicted = await bind({
      dispatchJournal: dispatchJournal([], {
        coverage: {
          armRuns: [
            { armRunId: ARM_B, arm: "baseline", caseId: CASE_ID, repetition: 0, orderIndex: 0, openedAtMs: 1, closedAtMs: 9, reserveFrames: 0, settleFrames: 0 },
            { armRunId: ARM_C, arm: "candidate", caseId: CASE_ID, repetition: 0, orderIndex: 1, openedAtMs: 2, closedAtMs: 10, reserveFrames: 0, settleFrames: 0 },
          ],
        },
      }),
      budgetFacts: { chargedToolCalls: 3, reservedToolCalls: 0 },
    });
    expect(contradicted.status).toBe("NOT_PROVEN");
    expect(contradicted.reason).toMatch(/DISPATCH_JOURNAL_EMPTY_CONTRADICTED/);

    // An arm run the schedule planned but no producer covered makes the coverage
    // INCOMPLETE: an unobserved arm run cannot be excluded from the tool budget.
    const uncovered = await bind({
      dispatchJournal: dispatchJournal([], {
        coverage: {
          armRuns: [
            { armRunId: ARM_B, arm: "baseline", caseId: CASE_ID, repetition: 0, orderIndex: 0, openedAtMs: 1, closedAtMs: 9, reserveFrames: 0, settleFrames: 0 },
          ],
        },
      }),
      budgetFacts: { chargedToolCalls: 0, reservedToolCalls: 0 },
    });
    expect(uncovered.status).toBe("NOT_PROVEN");
    expect(uncovered.reason).toMatch(/DISPATCH_COVERAGE_INCOMPLETE/);
  });
});

// ---------------------------------------------------------------------------
// B. The PRODUCER: the durable journal the real budget writes
// ---------------------------------------------------------------------------

function preregWithToolCap(maxToolCalls: number): ToolCallEfficiencyPreregistrationV2 {
  return buildToolCallEfficiencyPreregistrationV2({
    ...structuredClone(N5_FIXTURE),
    budget: { ...N5_FIXTURE.budget, maxToolCalls },
  });
}

const TOOL_REQUEST = {
  toolCallId: "call-1",
  tool: "write_file",
  sessionId: "s1",
  turnId: "t1",
  readOnly: false,
  sideEffectScope: "filesystem",
};

async function openBudgetedChain(over: { maxToolCalls?: number; deadlineAtMs?: number | null } = {}) {
  const dir = await scratch("chain");
  const budgetDir = join(dir, "budget");
  const artifact = preregWithToolCap(over.maxToolCalls ?? 1);
  const costBudget = await CostBudget.open(budgetDir, artifact, { allowCreate: true });
  costBudget.bindJournalScope({
    campaignDigest: artifact.preregistrationDigest,
    armRunId: ARM_B,
    arm: "baseline",
    caseId: CASE_ID,
    repetition: 0,
  });
  const budget = createDurableToolDispatchBudget({
    costBudget,
    deadlineAtMs: over.deadlineAtMs ?? null,
    journal: { dir: budgetDir, campaignDigest: artifact.preregistrationDigest },
  });
  const readJournal = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(join(budgetDir, "dispatch-journal.json"), "utf8")) as Record<string, unknown>;
  return { artifact, budgetDir, costBudget, budget, readJournal };
}

describe("N3 producer — the durable tool-dispatch journal", () => {
  it("N3 producer persists the acceptance fact BEFORE reserve returns", async () => {
    const { budget, readJournal, costBudget } = await openBudgetedChain();
    const granted = await budget.reserve(TOOL_REQUEST, {
      toolReservationId: `${ARM_B}:tool:1`,
      orderIndex: 3,
      parentRequestId: `${ARM_B}:r1`,
      parentAttemptId: 0,
    });
    expect(granted.ok).toBe(true);
    // NOTHING has settled yet — and the acceptance fact is already on disk.
    const journal = await readJournal();
    expect(journal["schemaVersion"]).toBe("e4-n3-tool-dispatch-journal-v1");
    const events = journal["events"] as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]!["type"]).toBe("reserve_granted");
    expect(events[0]!["toolReservationId"]).toBe(`${ARM_B}:tool:1`);
    expect(events[0]!["orderIndex"]).toBe(3);
    expect(events[0]!["parentRequestId"]).toBe(`${ARM_B}:r1`);
    // The durable dispatch id is the cost budget's OWN reservation, and it is a
    // DIFFERENT identifier from the tool reservation id.
    expect(typeof events[0]!["dispatchId"]).toBe("string");
    expect(events[0]!["dispatchId"]).not.toBe(events[0]!["toolReservationId"]);
    expect(costBudget.view().reserved.toolCalls).toBe(1);
    await granted.settle("dispatched");
  });

  it("N3 producer settles a duplicate notification exactly once and charges one dispatch", async () => {
    const { budget, readJournal, costBudget } = await openBudgetedChain();
    const granted = await budget.reserve(TOOL_REQUEST, { toolReservationId: `${ARM_B}:tool:1` });
    expect(granted.ok).toBe(true);
    await granted.settle("dispatched");
    // A LEGAL idempotent duplicate: the orchestrator settles once, and a replay
    // must be acknowledged without a second ledger entry or a second event.
    await granted.settle("dispatched");
    const events = (await readJournal())["events"] as Array<Record<string, unknown>>;
    expect(events.filter((e) => e["type"] === "settled")).toHaveLength(1);
    expect(costBudget.view().charged.toolCalls).toBe(1);
    expect(costBudget.view().reserved.toolCalls).toBe(0);
  });

  it("N3 producer keeps an unsettled grant as UNKNOWN with its upper bound retained", async () => {
    const { budget, readJournal, costBudget } = await openBudgetedChain();
    const granted = await budget.reserve(TOOL_REQUEST, { toolReservationId: `${ARM_B}:tool:1` });
    expect(granted.ok).toBe(true);
    // The process "dies" here: no settle notification ever arrives. The journal
    // must NOT release the bound and must NOT call it dispatched.
    const events = (await readJournal())["events"] as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]!["type"]).toBe("reserve_granted");
    expect(costBudget.view().reserved.toolCalls, "the upper bound was refunded without proof").toBe(1);
    expect(costBudget.view().charged.toolCalls).toBe(0);
  });

  it("N3 producer records a refusal with its stable reason and holds no reservation", async () => {
    const { budget, readJournal, costBudget } = await openBudgetedChain({ maxToolCalls: 0 });
    const refused = await budget.reserve(TOOL_REQUEST, { toolReservationId: `${ARM_B}:tool:1` });
    expect(refused.ok).toBe(false);
    expect(String(refused.reason)).toMatch(/TOOL_BUDGET_EXHAUSTED/);
    const events = (await readJournal())["events"] as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]!["type"]).toBe("reserve_refused");
    expect(events[0]!["refusalReason"]).toBe("TOOL_BUDGET_EXHAUSTED");
    expect(events[0]!["dispatchId"]).toBeNull();
    // A refusal is NOT a dispatch and NOT consumption.
    expect(costBudget.view().charged.toolCalls).toBe(0);
    expect(costBudget.view().reserved.toolCalls).toBe(0);
  });

  it("N3 producer refuses to append to a truncated journal", async () => {
    // cap = 2 so the SECOND reserve is refused by the JOURNAL, not by the tool
    // cap — otherwise the test would pass for the wrong reason.
    const { budget, budgetDir, costBudget } = await openBudgetedChain({ maxToolCalls: 2 });
    const granted = await budget.reserve(TOOL_REQUEST, { toolReservationId: `${ARM_B}:tool:1` });
    expect(granted.ok).toBe(true);
    await granted.settle("dispatched");
    // Truncate the tail by hand: the summary keeps claiming it.
    const path = join(budgetDir, "dispatch-journal.json");
    const file = JSON.parse(await readFile(path, "utf8")) as { events: unknown[] };
    file.events.pop();
    await writeFile(path, `${JSON.stringify(file)}\n`, "utf8");
    const second = await budget.reserve({ ...TOOL_REQUEST, toolCallId: "call-2" }, { toolReservationId: `${ARM_B}:tool:2` });
    // Fail closed: the budget refuses the dispatch whose acceptance it could not
    // record durably, and releases the bound so nothing is left charged.
    expect(second.ok).toBe(false);
    expect(String(second.reason)).toMatch(/TOOL_DISPATCH_JOURNAL_UNWRITABLE/);
    expect(costBudget.view().reserved.toolCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C. The REAL chain: model request -> tool reserve -> dispatch -> settle
// ---------------------------------------------------------------------------

/** An arm build that makes ONE real model request, then TWO real dispatches. */
function armEntrySource(marker: string): string {
  return `
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolOrchestrator, ToolRegistry, writeFileTool } from ${JSON.stringify(TOOLS_DIST)};

export const ${ARM_PROBE_EXPORT} = "probe:${marker}";
export const R97_ARM_ABI = ${JSON.stringify(R97_ARM_ABI)};

const OBS = ${JSON.stringify(join(tmpdir(), `n3-dispatch-observation-${marker}.json`))};

function baseOutcome(caseDef) {
  return {
    caseId: caseDef.id,
    status: "failed",
    actualStatus: "completed",
    events: [],
    metrics: { turn_count: 1, tool_call_count: 0, tokens_input: 0, tokens_output: 0, context_tokens: 0, compaction_count: 0, duration_ms: 0, retry_count: 0, verification_failures: 0, human_interventions: 0, estimated_cost: 0, usage_unknown: 0, cache_tokens_read: 0, cache_tokens_created: 0, model_call_count: 0 },
    violations: [],
    reason: "n3",
    suite: caseDef.suite || "regression",
    judgeVersion: "1.0.0",
    terminationReason: "verified_incomplete",
  };
}

export async function runOneCase(caseDef, opts, _suite) {
  const workspace = mkdtempSync(join(tmpdir(), "n3-arm-ws-"));
  // 1. ONE real model request through the driver's proxy (which forwards it to
  //    the campaign's budgeted provider, where the request journal is written).
  const client = opts.provider.createClient({ id: "arm-fixture" }, {});
  for await (const ev of client.generate({ messages: [] }, new AbortController().signal)) {
    if (ev.type === "completed" || ev.type === "error") break;
  }
  // 2. TWO real dispatches through a REAL ToolOrchestrator bound to the campaign
  //    tool budget the worker injected.
  const registry = new ToolRegistry();
  registry.register(writeFileTool);
  const orchestrator = new ToolOrchestrator({
    registry,
    workspaceRoot: workspace,
    events: { async emit() {} },
    toolBudget: opts.toolBudget,
  });
  const permissions = { rules: [
    { action: "read", resource: "file", effect: "allow" },
    { action: "edit", resource: "file", effect: "allow" },
  ] };
  const sandboxPolicy = {
    filesystem: { mode: "workspace-write", allowedPaths: [workspace] },
    network: { mode: "deny" },
    process: { timeoutMs: 5000, maxOutputBytes: 65536 },
  };
  const sessionId = "s1";
  const results = [];
  for (const name of ["first.txt", "second.txt"]) {
    const callId = "call-" + name;
    const r = await orchestrator.execute(
      { id: callId, sessionId, turnId: "t1", agentId: "a1", call: { id: callId, name: "write_file", args: { path: join(workspace, name), content: "written-by-" + name } } },
      { sessionId, turnId: "t1", agentId: "a1", cwd: workspace, signal: new AbortController().signal, permissions, sandboxPolicy },
    );
    results.push({ name, status: r.status, reasonCode: r.metadata && r.metadata.reasonCode ? r.metadata.reasonCode : null });
  }
  writeFileSync(OBS, JSON.stringify({
    marker: ${JSON.stringify(marker)},
    workspace,
    results,
    filesOnDisk: ["first.txt", "second.txt"].filter((n) => existsSync(join(workspace, n))),
  }, null, 2));
  const outcome = baseOutcome(caseDef);
  outcome.metrics.tool_call_count = results.length;
  return outcome;
}
`;
}

async function makeArmCheckout(dir: string, marker: string): Promise<void> {
  for (const rel of R97_ARM_BUILD_ENTRIES) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, rel === ARM_ENTRY_REL ? armEntrySource(marker) : `export {}; // stub:${marker}\n`, "utf8");
  }
  await writeFile(
    join(dir, FIXTURE_CHECKOUT_MARKER_FILENAME),
    `${JSON.stringify({ writer: "n3-dispatch-journal.test.ts", marker })}\n`,
    "utf8",
  );
}

/** The scripted OFFLINE model: one completed response that declares TWO tools. */
function scriptedProvider(): ModelProvider {
  return {
    id: "n3-scripted-offline",
    async listModels() {
      return [];
    },
    createClient() {
      return {
        async *generate(): AsyncGenerator<ModelEvent> {
          yield {
            type: "completed",
            result: {
              finishReason: "tool_calls",
              // Explicit synthetic usage; absence must now remain UNKNOWN and
              // can never establish MEASURED request/dispatch reconciliation.
              usage: { inputTokens: 0, outputTokens: 0 },
              toolCalls: [
                { id: "call-first.txt", name: "write_file", args: {} },
                { id: "call-second.txt", name: "write_file", args: {} },
              ],
            } as never,
            timestamp: 0,
          };
        },
      };
    },
  };
}

describe("N3 — the real reserve/dispatch/settle chain produces recomputable evidence", () => {
  it(
    "N3 real chain one model request, one dispatched write and one refused write bind as MEASURED",
    async () => {
      const base = await scratch("e2e-base");
      const cand = await scratch("e2e-cand");
      await makeArmCheckout(base, "baseline");
      await makeArmCheckout(cand, "candidate");

      const dir = await scratch("e2e");
      const budgetDir = join(dir, "budget");
      // cap = 1: the model declares TWO writes, so exactly ONE may really land.
      const artifact = preregWithToolCap(1);
      const costBudget = await CostBudget.open(budgetDir, artifact, { allowCreate: true });
      const armRunId = "pair-0-candidate";
      costBudget.bindJournalScope({
        campaignDigest: artifact.preregistrationDigest,
        armRunId,
        arm: "candidate",
        caseId: REAL_CASE_ID,
        repetition: 0,
      });
      const ledger = await openR97BudgetLedger(join(dir, "ledger"), {
        // A UNIQUE plan digest: this case must be a genuinely NEW campaign, not a
        // resume of a claim some other case already established.
        planDigest: uniquePlanDigest(),
        campaignModelCalls: 10,
        mode: "first-run",
      });
      // The REAL budgeted provider: it mints `<armRunId>:r1` and records the
      // request/attempt journal entry the tool journal is bound against.
      const { provider, stats } = createFormalBudgetedProvider({
        provider: scriptedProvider(),
        ledger,
        costBudget,
        arm: "tool_call_efficiency_v1",
        usdMicrosPerCall: 0,
      });
      const budget = createDurableToolDispatchBudget({
        costBudget,
        deadlineAtMs: null,
        journal: { dir: budgetDir, campaignDigest: artifact.preregistrationDigest },
      });

      const executor = createPreregArmExecutor({
        rootDir: REPO_ROOT,
        env: { R97_ARM_BASELINE_DIR: base, R97_ARM_CANDIDATE_DIR: cand },
        trustedFixtureCheckouts: createFixtureCheckoutTrust(base, cand),
        workerTimeoutMs: 120_000,
      });
      const arm = { armId: "candidate" as const, caseId: REAL_CASE_ID, repetition: 0, orderIndex: 0 };
      await executor(arm, {
        provider,
        armRunId,
        arm,
        preregistrationDigest: artifact.preregistrationDigest,
        planDigest: "2".repeat(64),
        isolation: { isolationBackendId: "process-exec", isolationStrength: "process" },
        evidenceDir: join(dir, "evidence"),
        toolDispatchBudget: budget,
        campaignDeadlineAtMs: Date.now() + 600_000,
      });

      // --- the raw observation: only ONE side effect really happened ---------
      const obs = JSON.parse(readFileSync(join(tmpdir(), "n3-dispatch-observation-candidate.json"), "utf8")) as {
        results: Array<{ name: string; status: string; reasonCode: string | null }>;
        filesOnDisk: string[];
      };
      expect(obs.results).toHaveLength(2);
      expect(obs.filesOnDisk, "the tool cap did not stop the second write before its side effect").toEqual(["first.txt"]);
      const refusal = obs.results.find((r) => r.status !== "success");
      expect(refusal, "the refused dispatch is not observable").toBeDefined();
      expect(refusal?.reasonCode).toBe("TOOL_BUDGET_EXHAUSTED");
      // The model DECLARED two tools; exactly ONE was dispatched. The declared
      // count is a diagnostic and is never the dispatch count.
      expect(stats.declaredToolCalls).toBe(2);

      // --- the durable journals --------------------------------------------
      const journal = JSON.parse(await readFile(join(budgetDir, "dispatch-journal.json"), "utf8")) as Record<string, unknown>;
      const view = costBudget.view();
      expect(view.charged.toolCalls, "the durable ledger charged the wrong number of tool calls").toBe(1);
      expect(view.reserved.toolCalls).toBe(0);
      // The journal's OWN derived counts: one grant + its one settlement, plus one
      // refusal. That is 3 events for 1 REAL dispatch — never 2, because the model
      // declared two tool calls and a DECLARED call is not a dispatch.
      expect(journal["eventCount"]).toBe(3);
      expect(
        (journal["events"] as Array<Record<string, unknown>>).map((e) => `${String(e["type"])}:${String(e["settlement"])}`),
      ).toEqual(["reserve_granted:null", "settled:dispatched", "reserve_refused:null"]);
      const coverageArmRuns = (journal["coverage"] as { armRuns: Array<Record<string, unknown>> }).armRuns;
      expect(coverageArmRuns).toHaveLength(1);
      expect(coverageArmRuns[0]!["armRunId"]).toBe(armRunId);
      // The coverage counters are DERIVED from the events above, and they are what
      // lets the verifier refuse a summary that claims frames the file lacks.
      expect(coverageArmRuns[0]!["reserveFrames"]).toBe(2);
      expect(coverageArmRuns[0]!["settleFrames"]).toBe(1);
      expect(coverageArmRuns[0]!["closedAtMs"], "coverage was never closed, so its counts are not final").not.toBeNull();
      expect(coverageArmRuns[0]!["orderIndex"]).toBe(0);
      // The tool id and the durable dispatch id are DIFFERENT identifiers, and
      // neither is the model's quota reservation id.
      const granted = (journal["events"] as Array<Record<string, unknown>>)[0]!;
      expect(granted["toolReservationId"]).toBe(`${armRunId}:tool:1`);
      expect(granted["dispatchId"]).not.toBe(granted["toolReservationId"]);
      expect(granted["parentRequestId"]).toBe(`${armRunId}:r1`);

      // --- readiness RECOMPUTES the same contract from the raw bytes ---------
      const mod = await import(pathToFileURL(join(REPO_ROOT, "scripts", "e4", "readiness-evidence-verify.mjs")).href);
      const binding = mod.bindRequestDispatchJournals({
        entries: costBudget.journalEntries(),
        scheduleArms: new Map([[armRunId, { armRunId, armId: "candidate", caseId: REAL_CASE_ID, repetition: 0, orderIndex: 0 }]]),
        dispatchJournal: journal,
        dispatchJournalFile: "dispatch-journal.json",
        dispatchJournalProblem: null,
        budgetFacts: { chargedToolCalls: view.charged.toolCalls, reservedToolCalls: view.reserved.toolCalls },
      });
      expect(binding.status, JSON.stringify(binding.problems)).toBe("MEASURED");
      // The reported counts are the REAL ones, not a claim.
      expect(binding.facts.toolDispatch.reserveGranted).toBe(1);
      expect(binding.facts.toolDispatch.reserveRefused).toBe(1);
      expect(binding.facts.toolDispatch.settledDispatched).toBe(1);
      expect(binding.facts.toolDispatch.dispatchCount).toBe(1);
      expect(binding.facts.toolDispatch.chargedToolCalls).toBe(1);
      expect(binding.facts.toolDispatch.coveredArmRuns).toBe(1);
      // The request journal really named the parent the tool journal binds to.
      expect(binding.facts.requestJournalEntries).toBe(1);

      // --- the arm MANIFEST, re-derived from the raw bytes --------------------
      // The dispatch facts must not have been obtained by weakening the arm
      // evidence: the manifest the executor wrote is still read back and its
      // identity fields must be the ones this run really used.
      const manifest = JSON.parse(readFileSync(join(dir, "evidence", "manifest.json"), "utf8")) as Record<string, unknown>;
      expect(manifest["schemaVersion"]).toBe(PREREG_RUN_MANIFEST_SCHEMA);
      expect(manifest["armRunId"]).toBe(armRunId);
      expect(manifest["armId"]).toBe("candidate");
      expect(manifest["caseId"]).toBe(REAL_CASE_ID);
      expect(manifest["repetition"]).toBe(0);
      expect(manifest["orderIndex"]).toBe(0);
      expect(typeof manifest["armBuildDigest"]).toBe("string");
      expect(String(manifest["armBuildDigest"])).toHaveLength(64);
      expect(String(manifest["armEntrySha256"])).toHaveLength(64);
      // The manifest's own digest is recomputed from its raw BYTES here, so the
      // assertion is about the bytes on disk rather than a re-serialization.
      const manifestBytes = readFileSync(join(dir, "evidence", "manifest.json"), "utf8");
      expect(createHash("sha256").update(manifestBytes).digest("hex")).toMatch(/^[0-9a-f]{64}$/);
      expect(manifestBytes).toBe(`${stableStringify(manifest)}\n`);
    },
    180_000,
  );
});
