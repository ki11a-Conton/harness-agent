/**
 * E4-R87 Phase A — zero-call replay A/B runner (plan §R87).
 *
 * Loads the frozen, digest-bound case selection
 * (`docs/evidence/e4-r87-case-selection.json`), runs BOTH arms over the SAME
 * cases in the SAME order with IDENTICAL limits using `ScriptedModelProvider`
 * (0 provider calls, 0 tokens, no key, no network), persists each completed
 * (case, arm) atomically, resumes by skipping already-completed arms, and
 * emits a sanitized manifest + per-arm sha256 + summary + honest verdict.
 *
 * Arms:
 *   - baseline  = pre-R86 streak semantics: `streakResultAware: false` so
 *     `AgentState.noteToolCall(name, args)` keeps the ORIGINAL pre-R86
 *     contract (name+args-only streak, byte-identical to source SHA e9776ba).
 *   - candidate = the R86 runtime (result fingerprint fed), SHA a203737.
 *
 * The only difference between the arms is the pre-declared fix (plan §R87:
 * "baseline 与 candidate 除 source SHA/预声明修复外的身份和 limits 完全相同").
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  AgentDefinition,
  ModelProvider,
  ToolCallRequest,
  ToolExecutionContext,
  ToolResult,
} from "@ar/contracts";
import { DEFAULT_TOOL_SEMANTICS, errorInfo, newAgentId } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";

export const R87_SELECTION_SCHEMA = "e4-r87-case-selection-v1";
export const R87_SELECTION_DIGEST =
  "0d8af323110301e0392c77d595c8c34f5f01851ffe6844f0ed7fab49703465ae";

/** E4-R88: versioned resume-state schema. The header binds the experiment
 *  identity (selection digest, implementation SHA, arm semantics, limits,
 *  fixture/tool contract digest) so stale or foreign records can never be
 *  mistaken for this experiment's results. */
export const R88_RUN_STATE_SCHEMA = "e4-r88-run-state-v1";
/** E4-R88 manifest schema. The legacy `e4-r87-phase-a-manifest-v1` file stays
 *  on disk untouched and is reported as LEGACY_UNVERIFIED, never blessed. */
export const R88_MANIFEST_SCHEMA = "e4-r88-phase-a-manifest-v2";
/**
 * E4-R90 manifest schema. The v2 artifact stays on disk untouched (a versioned
 * erratum, never a deletion) but is no longer blessed, because `sourceSha`
 * alone let a reader infer that the historical baseline build had been checked
 * out and executed. It never was: the baseline arm is the SAME runtime with
 * `streakResultAware: false`. v3 records that honestly via
 * `executedSourceSha` / `historicalReferenceSha` / `baselineMode`.
 */
export const R90_MANIFEST_SCHEMA = "e4-r90-phase-a-manifest-v3";
export const LEGACY_MANIFEST_SCHEMA = "e4-r87-phase-a-manifest-v1";

/**
 * R90 §2: how the baseline arm was realised.
 *   - `emulated_semantics` — the SAME built runtime driven with the pre-fix
 *     switch (`streakResultAware: false`). This is a legitimate MECHANISM
 *     experiment but it is NOT a real two-version A/B.
 *   - `isolated_build` — two real SHAs, each checked out and built separately.
 *     Only this mode may support a claim about real historical versions.
 */
export type BaselineMode = "emulated_semantics" | "isolated_build";

/**
 * R90 §2: what kind of experiment produced a result.
 *   - `synthetic_mechanism` — a scripted trace, not a recorded transcript.
 *   - `real_version_ab` — real provider traffic over two real builds.
 */
export type ExperimentKind = "synthetic_mechanism" | "real_version_ab";

/** Version of the scripted trace builder below — part of the fixture digest. */
export const TRACE_BUILDER_VERSION = "e4-r87-buildTrace-v1";

export type ReplayArm = "baseline" | "candidate";

export interface RecordedSignature {
  outcome: string;
  termination: string;
  modelCalls: number;
  toolCalls: number;
  toolFailures: number;
  stallRecovery: number;
  fingerprint: string;
}

export interface TraceSpec {
  kind: "identical-changing" | "identical-failing" | "different-args" | "iteration-tool-steps";
  tool?: string;
  args?: unknown;
  callCount: number;
  errorCode?: string;
  note?: string;
}

export interface ExpectSpec {
  baseline: { status: string; h2SignatureFires: boolean; note?: string; termination?: string };
  candidate: { status: string; h2SignatureFires: boolean; note?: string; termination?: string };
}

export interface FrozenCase {
  id: string;
  suite: string;
  role: "TARGET" | "COUNTEREXAMPLE";
  recorded: RecordedSignature;
  trace: TraceSpec;
  expect: ExpectSpec;
}

export interface FrozenCaseSelection {
  schemaVersion: string;
  title: string;
  boundBeforeExecution: boolean;
  selectionRule: Record<string, unknown>;
  cases: FrozenCase[];
  digest: string;
}

export interface ReplayLimits {
  maxRepeatedIdenticalToolCalls: number;
  maxStallRecoveries: number;
  maxPatternStallRecoveries: number;
  maxIterationsPerTurn: number;
  maxParallelToolCalls: number;
}

/** Identical limits for BOTH arms (plan §R87: identity/limits must match). */
export const REPLAY_LIMITS: ReplayLimits = {
  maxRepeatedIdenticalToolCalls: 3,
  maxStallRecoveries: 1,
  maxPatternStallRecoveries: 1,
  maxIterationsPerTurn: 20,
  maxParallelToolCalls: 1,
};

/**
 * R90 §7: the replay runs `maxIterationsPerTurn: 20` while the benchmark's
 * effective iteration cap is 30. That is a DECLARED experimental configuration
 * difference, not a retro-description of history: the historical R83 evidence
 * was produced under the benchmark's own limit and is never re-labelled as 20
 * or as 30 by this experiment.
 */
export const REPLAY_CONFIG_DIFFERENCES = {
  maxIterationsPerTurn: {
    replay: 20,
    benchmark: 30,
    /** R90: the historical evidence is NEVER retro-claimed as 20. */
    retroClaimed: false,
    note:
      "The replay bounds iterations at 20 to keep the scripted mechanism trace " +
      "short. The benchmark's effective cap is 30. The two numbers describe two " +
      "different configurations and neither rewrites the recorded history.",
  },
} as const;

/**
 * R90 §2: the honest description of what the synthetic case set represents.
 *
 * The three TARGET labels are three LABELS of ONE scripted mechanism trace
 * (`identical-changing`), not three independent historical transcripts replayed
 * exactly. Declaring the mapping prevents a reader from reading "3 targets" as
 * "3 independent confirmations".
 */
export const SYNTHETIC_SCENARIO_MAPPING = {
  independentScenarioCount: 1,
  targetLabels: 3,
  counterexampleLabels: 5,
  traceKind: "identical-changing",
  note:
    "One synthetic mechanism scenario (a repeated identical call whose result " +
    "CHANGES) is labelled against three frozen target cases. The labels reuse the " +
    "same scripted trace; they are not three independently recorded historical " +
    "traces. Counterexample labels exercise outcome-invariance, not the mechanism.",
} as const;


export interface ArmCaseRecord {
  caseId: string;
  suite: string;
  role: "TARGET" | "COUNTEREXAMPLE";
  arm: ReplayArm;
  status: string;
  terminationReason?: string;
  toolCalls: number;
  modelCalls: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  maxRepeatedToolCallsLimits: number;
  stallRecoveries: number;
  progressDetected: number;
  toolFailures: number;
  securityViolations: number;
  h2SignatureFires: boolean;
  expectedMet: boolean;
}

/** E4-R88: the declared semantics of one arm. Both the runner and the resume
 *  header bind these, so an arm whose meaning changed can never reuse state. */
export interface ArmSemantics {
  arm: ReplayArm;
  /** true = R86 result-aware streak (candidate); false = pre-R86 name+args. */
  streakResultAware: boolean;
}

/** E4-R88 experiment identity. `experimentId` is the canonical digest of this
 *  payload, so ANY change to selection, implementation, arm semantics, limits
 *  or fixtures yields a different id and invalidates prior state.
 *
 *  `arms` binds the semantics of BOTH arms (plan §R88: "resume header 绑定 …
 *  两臂语义配置") — not merely whichever subset a given invocation happened to
 *  declare. That is what makes a single-arm intermediate state safely
 *  extensible into a full A/B later. */
export interface ExperimentIdentity {
  schemaVersion: string;
  experimentId: string;
  selectionSchema: string;
  selectionDigest: string;
  /**
   * R90 §2: the source SHA of the code that ACTUALLY RAN. Kept under its
   * historical name for compatibility, but it is now explicitly the executed
   * identity — never a stand-in for "the historical build was checked out".
   */
  implementationSha: string;
  /** R90 §2: the source SHA that actually executed in this process. */
  executedSourceSha: string;
  /** R90 §2: a REFERENCE-ONLY historical SHA. Nothing was checked out from it. */
  historicalReferenceSha: string;
  /** R90 §2: how the baseline arm was realised (see `BaselineMode`). */
  baselineMode: BaselineMode;
  /** R90 §2: synthetic mechanism experiment vs. real version A/B. */
  experimentKind: ExperimentKind;
  /** R90 §2: how many INDEPENDENT mechanism scenarios the labels represent. */
  syntheticScenarios: {
    independentScenarioCount: number;
    targetLabels: number;
    counterexampleLabels: number;
    traceKind: string;
  };
  arms: ArmSemantics[];
  limits: ReplayLimits;
  fixtureDigest: string;
}

export interface RunStateHeader extends ExperimentIdentity {
  kind: "header";
  /** Which arms THIS state file has been declared for so far. A resume may add
   *  arms (extension) but never silently drop one. */
  declaredArms: ReplayArm[];
}

export interface RunStateRecordLine {
  kind: "record";
  experimentId: string;
  caseId: string;
  arm: ReplayArm;
  /** evidenceHash of this single record (v2, timing-independent). */
  hash: string;
  record: ArmCaseRecord;
}

export interface ReplayAbOptions {
  arms: ReplayArm[];
  now?: () => number;
  runStatePath?: string;
  secretCanary?: string;
  /** Identity binding (E4-R88). Defaults to a stable placeholder so tests that
   *  do not care about implementation identity still get a bound header. */
  implementationSha?: string;
}

export interface ReplayAbResult {
  records: ArmCaseRecord[];
  executed: string[];
  /** E4-R88: the bound experiment identity (also persisted in the header). */
  identity: ExperimentIdentity;
  experimentId: string;
  /** Tail lines dropped as unconfirmed mid-write fragments (they are re-run). */
  incompleteRecovered: string[];
}

/** Recursively sort object keys → compact JSON → sha256 hex (deterministic). */
export function canonicalDigest(value: unknown): string {
  const sorted = sortKeys(value);
  const canon = JSON.stringify(sorted);
  return createHash("sha256").update(canon).digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

const SELECTION_PATH = fileURLToPath(
  new URL("../../../../docs/evidence/e4-r87-case-selection.json", import.meta.url),
);

export function loadCaseSelection(path = SELECTION_PATH): FrozenCaseSelection {
  const doc = JSON.parse(readFileSync(path, "utf8")) as FrozenCaseSelection;
  verifySelectionDigest(doc);
  return doc;
}

/** Fail-closed: recompute the canonical digest over the payload (digest field
 *  excluded); throw on ANY mismatch (plan §R87 #2/#5: no post-execution case
 *  swapping, no drift). */
export function verifySelectionDigest(doc: FrozenCaseSelection): void {
  if (doc.schemaVersion !== R87_SELECTION_SCHEMA) {
    throw new Error(`E4-R87 digest mismatch: schema ${doc.schemaVersion} != ${R87_SELECTION_SCHEMA}`);
  }
  const { digest, ...payload } = doc;
  const recomputed = canonicalDigest(payload);
  if (recomputed !== doc.digest) {
    throw new Error(`E4-R87 digest mismatch: recomputed ${recomputed} != frozen ${doc.digest}`);
  }
  if (doc.digest !== R87_SELECTION_DIGEST) {
    throw new Error(
      `E4-R87 digest mismatch: frozen ${doc.digest} != committed ${R87_SELECTION_DIGEST} (frozen list was swapped after binding)`,
    );
  }
}

/** E4-R88 reason codes — a CLOSED, stable set so callers can assert on them.
 *
 *  R93: kept as a runtime ARRAY (not only a type) so the validator can also
 *  reject an UNKNOWN code found inside a manifest's own `issues` array. The
 *  codes added by R93 are exactly the ones a three-field comparison could never
 *  produce: `LIMITS_MISMATCH`, `CASE_ORDER_MISMATCH`, `SCOPE_MISMATCH`,
 *  `ARM_IDENTITY_MISMATCH`, `ARM_RECORD_MISPLACED`, `ARM_DUPLICATE`,
 *  `ARM_UNKNOWN`, `RECORD_INVALID`, `MANIFEST_STRUCTURE_INVALID`,
 *  `IDENTITY_UNTRUSTED`, `EXPERIMENT_KIND_UNSUPPORTED`. */
export const EVIDENCE_REASON_CODES = [
  "RECORDS_EMPTY",
  "MATRIX_INCOMPLETE",
  "ARM_MISSING",
  "ARM_UNEXPECTED",
  "DUPLICATE_RECORD",
  "UNKNOWN_CASE",
  "CASE_SUITE_MISMATCH",
  "CASE_ROLE_MISMATCH",
  "METRIC_NOT_FINITE",
  "METRIC_NEGATIVE",
  "EXPECT_NOT_MET",
  "COUNTEREXAMPLE_REGRESSION",
  "SECURITY_VIOLATION",
  "VERIFIED_COMPLETION_REGRESSED",
  "NO_MECHANISM_IMPROVEMENT",
  "SELECTION_DIGEST_MISMATCH",
  "EXPERIMENT_ID_MISMATCH",
  "STATE_HEADER_MISSING",
  "STATE_HEADER_INVALID",
  "STATE_TRUNCATED",
  "STATE_UNREADABLE",
  "RECORD_HASH_MISMATCH",
  "SCHEMA_UNSUPPORTED",
  "ARM_HASH_MISMATCH",
  "SUMMARY_MISMATCH",
  "LEGACY_SCHEMA",
  // ------------------------------- E4-R93 -------------------------------
  "MANIFEST_STRUCTURE_INVALID",
  "RECORD_INVALID",
  "LIMITS_MISMATCH",
  "CASE_ORDER_MISMATCH",
  "SCOPE_MISMATCH",
  "ARM_IDENTITY_MISMATCH",
  "ARM_RECORD_MISPLACED",
  "ARM_DUPLICATE",
  "ARM_UNKNOWN",
  "IDENTITY_UNTRUSTED",
  "EXPERIMENT_KIND_UNSUPPORTED",
] as const;

export type EvidenceReasonCode = (typeof EVIDENCE_REASON_CODES)[number];

const EVIDENCE_REASON_CODE_SET: ReadonlySet<string> = new Set<string>(EVIDENCE_REASON_CODES);

export class ReplayEvidenceError extends Error {
  constructor(
    readonly code: EvidenceReasonCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ReplayEvidenceError";
  }
}

/** The arm semantics actually executed. Bound into the experiment identity so a
 *  changed meaning can never silently reuse another experiment's state. */
export function armSemantics(arms: ReplayArm[]): ArmSemantics[] {
  return [...arms]
    .sort()
    .map((arm) => ({ arm, streakResultAware: arm === "candidate" }));
}

/** Digest of the scripted fixture/tool contract. A change to the trace builder,
 *  the limits or the tool catalogue changes this digest. */
export function fixtureDigest(): string {
  return canonicalDigest({
    traceBuilder: TRACE_BUILDER_VERSION,
    limits: REPLAY_LIMITS,
    tools: ["echo"],
    agent: { name: AGENT_NAME, mode: "primary" },
  });
}

/**
 * R90 §2: the historical pre-R86 source SHA the baseline arm's SEMANTICS were
 * derived from. It is a REFERENCE ONLY: this experiment never checks out or
 * builds that revision, so it must never be presented as the executed code.
 */
export const R87_BASELINE_REFERENCE_SHA = "e9776ba66190ea63b1bacb685c91aa900b6935e7";

/** Build the experiment identity for a run. `experimentId` is the canonical
 *  digest of the whole identity payload (excluding the id itself). The arm
 *  semantics bound here always cover BOTH arms, so a single-arm intermediate
 *  state is not a different experiment from the later full A/B.
 *
 *  R90 §2: `implementationSha` is the code that ACTUALLY RAN. The historical
 *  baseline is recorded separately as a reference, and the baseline MODE is
 *  declared explicitly so `sourceSha` can never imply a real two-version A/B. */
export function experimentIdentity(opts: {
  selection: FrozenCaseSelection;
  arms: ReplayArm[];
  implementationSha: string;
  /** R90: defaults to the pre-R86 reference SHA. Reference-only, never executed. */
  historicalReferenceSha?: string;
  /** R90: defaults to `emulated_semantics` — the honest description of R87. */
  baselineMode?: BaselineMode;
  /** R90: defaults to `synthetic_mechanism` — a scripted trace, not a transcript. */
  experimentKind?: ExperimentKind;
}): ExperimentIdentity {
  void opts.arms; // declared-arm subset is NOT part of the experiment identity
  const payload = {
    schemaVersion: R88_RUN_STATE_SCHEMA,
    selectionSchema: opts.selection.schemaVersion,
    selectionDigest: opts.selection.digest,
    implementationSha: opts.implementationSha,
    // R90: bound into the digest too, so a manifest that silently re-labels the
    // executed identity or the baseline mode is a DIFFERENT experiment.
    executedSourceSha: opts.implementationSha,
    historicalReferenceSha: opts.historicalReferenceSha ?? R87_BASELINE_REFERENCE_SHA,
    baselineMode: opts.baselineMode ?? "emulated_semantics",
    experimentKind: opts.experimentKind ?? "synthetic_mechanism",
    syntheticScenarios: {
      independentScenarioCount: SYNTHETIC_SCENARIO_MAPPING.independentScenarioCount,
      targetLabels: SYNTHETIC_SCENARIO_MAPPING.targetLabels,
      counterexampleLabels: SYNTHETIC_SCENARIO_MAPPING.counterexampleLabels,
      traceKind: SYNTHETIC_SCENARIO_MAPPING.traceKind,
    },
    arms: armSemantics(["baseline", "candidate"]),
    limits: REPLAY_LIMITS,
    fixtureDigest: fixtureDigest(),
  };
  return { ...payload, experimentId: canonicalDigest(payload) };
}

export const AGENT_NAME = "r87-replay-agent";

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: AGENT_NAME,
  description: "zero-call replay A/B (E4-R87 Phase A)",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "replay A/B",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

/** Build the scripted provider + orchestrator for one frozen trace. */
function buildTrace(c: FrozenCase, secretCanary: string): {
  provider: ModelProvider;
  orchestrator: { execute(req: ToolCallRequest, ctx: ToolExecutionContext): Promise<ToolResult>; executeBound(...args: unknown[]): Promise<ToolResult> };
} {
  const tool = c.trace.tool ?? "echo";
  const callCount = c.trace.callCount;
  const canary = secretCanary;

  let calls: Array<{ name: string; args: Record<string, unknown> }>;
  if (c.trace.kind === "different-args") {
    const argList = (c.trace.args as string[]) ?? ["a", "b", "c", "d", "e"];
    calls = Array.from({ length: callCount }, (_, i) => ({
      name: tool,
      args: { text: argList[i % argList.length] },
    }));
  } else if (c.trace.kind === "iteration-tool-steps") {
    // Distinct args per call: the loop must exhaust maxIterationsPerTurn and
    // terminate agent_limit — never a stall signal, never a repeat.
    calls = Array.from({ length: callCount }, (_, i) => ({
      name: tool,
      args: { text: `step-${i}` },
    }));
  } else {
    calls = Array.from({ length: callCount }, () => ({
      name: tool,
      args: (c.trace.args as Record<string, unknown>) ?? { text: "same" },
    }));
  }

  const provider = new ScriptedModelProvider([
    ...calls.map((call) => ScriptedModelProvider.toolCall(call.name, call.args)),
    ScriptedModelProvider.text("done"),
  ]);

  const orchestrator =
    c.trace.kind === "identical-failing"
      ? new (class {
          async execute(): Promise<ToolResult> {
            return { status: "failed", error: errorInfo("PROCESS_ERROR", "constant failure") };
          }
          async executeBound(): Promise<ToolResult> {
            return { status: "failed", error: errorInfo("PROCESS_ERROR", "constant failure") };
          }
        })()
      : new (class {
          private n = 0;
          async execute(): Promise<ToolResult> {
            this.n += 1;
            return { status: "success", output: { progress: `${c.trace.kind}-step-${this.n}${canary ? `-${canary}` : ""}` } };
          }
          async executeBound(): Promise<ToolResult> {
            return await this.execute();
          }
        })();

  return { provider: provider as unknown as ModelProvider, orchestrator: orchestrator as never };
}

/** Run ONE (case, arm) through the real runtime, zero provider calls. */
async function runCaseArm(c: FrozenCase, arm: ReplayArm, now: () => number, secretCanary: string): Promise<ArmCaseRecord> {
  const { provider, orchestrator } = buildTrace(c, secretCanary);
  const events = new MemoryEventStore();
  const startedAt = now();
  const runtime = new AgentRuntime({
    store: new MemorySessionStore(),
    events,
    modelProvider: provider,
    orchestrator,
    agents: [AGENT],
    maxRepeatedIdenticalToolCalls: REPLAY_LIMITS.maxRepeatedIdenticalToolCalls,
    maxStallRecoveries: REPLAY_LIMITS.maxStallRecoveries,
    maxPatternStallRecoveries: REPLAY_LIMITS.maxPatternStallRecoveries,
    maxIterationsPerTurn: REPLAY_LIMITS.maxIterationsPerTurn,
    maxParallelToolCalls: REPLAY_LIMITS.maxParallelToolCalls,
    streakResultAware: arm === "candidate",
    toolRegistry: defaultTestToolCatalog(),
    permissiveToolResolution: true,
    toolSemanticsOf: () => ({ ...DEFAULT_TOOL_SEMANTICS, sideEffectScope: "none" as const, readOnly: true }),
    now,
  });
  const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\work" });
  const turn = await runtime.startTurn(session.id, "r87 replay");
  const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);
  const stored = await events.list(session.id);

  const maxRepeatedToolCallsLimits = stored.filter(
    (e) => e.type === "run.limit_reached" && (e.payload as { limit?: unknown }).limit === "maxRepeatedToolCalls",
  ).length;
  const stallRecoveries = stored.filter((e) => e.type === "retry.stallRecovery").length;
  const progressDetected = stored.filter((e) => e.type === "stall.progress_detected").length;
  const toolFailures = stored.filter((e) => e.type === "tool.failed").length;
  const securityViolations = stored.filter((e) => e.type.startsWith("security.")).length;
  const modelCalls = stored.filter((e) => e.type === "model.started").length;

  const h2SignatureFires =
    outcome.status === "failed" &&
    outcome.terminationReason === "tool_limit" &&
    maxRepeatedToolCallsLimits > 0 &&
    toolFailures === 0 &&
    stallRecoveries > 0;

  const expectFor = c.expect[arm];
  const expectedMet =
    outcome.status === expectFor.status && h2SignatureFires === expectFor.h2SignatureFires;

  return {
    caseId: c.id,
    suite: c.suite,
    role: c.role,
    arm,
    status: outcome.status,
    terminationReason: outcome.terminationReason,
    toolCalls: c.trace.callCount,
    modelCalls,
    tokensIn: 0,
    tokensOut: 0,
    durationMs: now() - startedAt,
    maxRepeatedToolCallsLimits,
    stallRecoveries,
    progressDetected,
    toolFailures,
    securityViolations,
    h2SignatureFires,
    expectedMet,
  };
}

/**
 * Run the A/B: strictly serial (concurrency 1), atomic persist after each
 * (case, arm), resume skips already-completed arms (no double billing).
 *
 * E4-R88 (F2): the runner verifies the frozen selection digest ITSELF and binds
 * every run to a versioned experiment identity. Resume only reuses records that
 * (a) carry this experiment's id, (b) name a frozen case with the declared arm,
 * (c) match their own recomputed record hash, and (d) are not duplicates.
 * Foreign, stale, unknown, duplicated or corrupt state is REJECTED loudly —
 * never silently absorbed as this experiment's results.
 *
 * Crash semantics (plan §R88 怎么做): a truncated TAIL line is an unconfirmed
 * mid-write fragment — it is dropped and its arm re-runs (`incompleteRecovered`).
 * A malformed NON-tail line is corruption and fails closed (`STATE_TRUNCATED`).
 * A stale `.tmp` from a crash between write and rename is discarded; the main
 * file stays authoritative, so a record is only ever "done" once it is IN it.
 *
 * NOTE: this is an offline replay — "no double billing" is a local-file
 * guarantee only. It does NOT prove paid exactly-once semantics across a
 * network boundary, and this module makes no such claim.
 */
export async function runReplayAb(
  selection: FrozenCaseSelection,
  opts: ReplayAbOptions,
): Promise<ReplayAbResult> {
  // (F2a) Fail closed on a swapped/tampered selection, regardless of whether the
  // caller remembered to call loadCaseSelection()/verifySelectionDigest().
  verifySelectionDigest(selection);

  const now = opts.now ?? (() => 0);
  const statePath = opts.runStatePath;
  const identity = experimentIdentity({
    selection,
    arms: opts.arms,
    implementationSha: opts.implementationSha ?? "unbound-local",
  });
  const declaredArms = new Set<string>(opts.arms);
  const caseById = new Map(selection.cases.map((c) => [c.id, c]));

  const lines: string[] = [];
  const done = new Set<string>();
  const incompleteRecovered: string[] = [];

  if (statePath !== undefined) {
    // A stale tmp means a crash between write and rename: the main file is
    // authoritative and simply lacks that record, so the arm re-runs.
    if (existsSync(`${statePath}.tmp`)) rmSync(`${statePath}.tmp`, { force: true });
    if (existsSync(statePath)) {
      const raw = readFileSync(statePath, "utf8");
      const all = raw.split("\n").filter((l) => l.trim() !== "");
      if (all.length === 0) {
        throw new ReplayEvidenceError("STATE_HEADER_MISSING", `state file ${statePath} is empty`);
      }
      let header: RunStateHeader;
      try {
        header = JSON.parse(all[0]!) as RunStateHeader;
      } catch {
        throw new ReplayEvidenceError("STATE_HEADER_INVALID", "the state header is not valid JSON");
      }
      if (header.kind !== "header") {
        throw new ReplayEvidenceError("STATE_HEADER_MISSING", "the first state line is not a header");
      }
      if (header.schemaVersion !== R88_RUN_STATE_SCHEMA) {
        throw new ReplayEvidenceError(
          "SCHEMA_UNSUPPORTED",
          `state schema ${header.schemaVersion} != ${R88_RUN_STATE_SCHEMA}`,
        );
      }
      if (header.experimentId !== identity.experimentId) {
        throw new ReplayEvidenceError(
          "EXPERIMENT_ID_MISMATCH",
          `state belongs to experiment ${header.experimentId ?? "(none)"}, not ${identity.experimentId} ` +
            `(selection/config/implementation/limits/fixture identity changed)`,
        );
      }
      // Arms may be ADDED by a later invocation (single-arm state extended into
      // a full A/B) but never silently DROPPED.
      const previouslyDeclared = header.declaredArms ?? [];
      for (const arm of previouslyDeclared) {
        if (!declaredArms.has(arm)) {
          throw new ReplayEvidenceError(
            "ARM_UNEXPECTED",
            `state already holds ${arm} results, but this run declares only [${[...declaredArms].join(", ")}]`,
          );
        }
      }
      lines.push(all[0]!);
      const body = all.slice(1);
      body.forEach((line, index) => {
        const isTail = index === body.length - 1;
        let parsed: RunStateRecordLine;
        try {
          parsed = JSON.parse(line) as RunStateRecordLine;
        } catch {
          if (isTail) {
            // Unconfirmed mid-write fragment: drop it, re-run that arm.
            const partial = /"caseId":"([^"]+)"/.exec(line);
            const partialArm = /"arm":"([^"]+)"/.exec(line);
            incompleteRecovered.push(
              partial !== null && partialArm !== null ? `${partial[1]}/${partialArm[1]}` : "(unknown tail)",
            );
            return;
          }
          throw new ReplayEvidenceError("STATE_TRUNCATED", `malformed state record at line ${index + 2}`);
        }
        if (parsed.kind !== "record") {
          throw new ReplayEvidenceError("STATE_TRUNCATED", `line ${index + 2} is not a record`);
        }
        if (parsed.experimentId !== identity.experimentId) {
          throw new ReplayEvidenceError(
            "EXPERIMENT_ID_MISMATCH",
            `record ${parsed.caseId}/${parsed.arm} belongs to another experiment`,
          );
        }
        if (!caseById.has(parsed.caseId)) {
          throw new ReplayEvidenceError("UNKNOWN_CASE", `state names unknown case ${parsed.caseId}`);
        }
        if (!declaredArms.has(parsed.arm)) {
          throw new ReplayEvidenceError(
            "ARM_UNEXPECTED",
            `state names undeclared arm ${parsed.arm} for ${parsed.caseId}`,
          );
        }
        const key = `${parsed.caseId}/${parsed.arm}`;
        if (done.has(key)) {
          throw new ReplayEvidenceError("DUPLICATE_RECORD", `state repeats ${key}`);
        }
        const recomputed = recordHash(parsed.record);
        if (recomputed !== parsed.hash) {
          throw new ReplayEvidenceError(
            "RECORD_HASH_MISMATCH",
            `${key} hash ${parsed.hash} != recomputed ${recomputed}`,
          );
        }
        done.add(key);
        lines.push(line);
      });
    }
    if (lines.length === 0) {
      // Fresh run: bind the identity header before any result is persisted.
      const header: RunStateHeader = { kind: "header", ...identity, declaredArms: [...declaredArms] as ReplayArm[] };
      lines.push(JSON.stringify(header));
      writeFileSync(statePath, lines.join("\n") + "\n");
    } else {
      // Existing state: record any newly declared arms in the header so a later
      // resume knows which arms this file legitimately covers.
      const header = JSON.parse(lines[0]!) as RunStateHeader;
      const union = [...new Set([...(header.declaredArms ?? []), ...declaredArms])] as ReplayArm[];
      if (union.length !== (header.declaredArms ?? []).length) {
        lines[0] = JSON.stringify({ ...header, declaredArms: union });
        const tmp = `${statePath}.tmp`;
        writeFileSync(tmp, lines.join("\n") + "\n");
        renameSync(tmp, statePath);
      }
    }
  }

  const records: ArmCaseRecord[] = [];
  const executed: string[] = [];
  // Records already confirmed by the (validated) state file, so a resume returns
  // the FULL matrix rather than only the newly executed arms.
  for (const line of lines.slice(1)) {
    const parsed = JSON.parse(line) as RunStateRecordLine;
    records.push(parsed.record);
  }

  for (const c of selection.cases) {
    for (const arm of opts.arms) {
      const key = `${c.id}/${arm}`;
      if (done.has(key)) continue;
      const rec = await runCaseArm(c, arm, now, opts.secretCanary ?? "");
      records.push(rec);
      executed.push(key);
      done.add(key);
      if (statePath !== undefined) {
        // Atomic persist per (case, arm): write tmp + rename (same volume).
        const line = JSON.stringify({
          kind: "record",
          experimentId: identity.experimentId,
          caseId: rec.caseId,
          arm: rec.arm,
          hash: recordHash(rec),
          record: rec,
        } satisfies RunStateRecordLine);
        lines.push(line);
        const tmp = `${statePath}.tmp`;
        writeFileSync(tmp, lines.join("\n") + "\n");
        renameSync(tmp, statePath);
      }
    }
  }

  if (statePath !== undefined && !existsSync(statePath)) {
    // No state file and nothing ran: still bind the identity on disk.
    const header: RunStateHeader = { kind: "header", ...identity, declaredArms: [...declaredArms] as ReplayArm[] };
    writeFileSync(statePath, JSON.stringify(header) + "\n");
  } else if (statePath !== undefined && lines[0] === undefined) {
    throw new ReplayEvidenceError("STATE_HEADER_MISSING", "internal: state lost its header");
  }

  records.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.arm.localeCompare(b.arm));
  return { records, executed, identity, experimentId: identity.experimentId, incompleteRecovered };
}

/** E4-R88: the committed/hashed evidence projection of one record.
 *  `durationMs` is EXCLUDED on purpose: it is timing noise, not evidence, and a
 *  resume must reproduce exactly the fresh run's hashes (plan §R88 验收:
 *  "完整 resume 与新跑结果 hash 一致"). */
function evidenceRecord(r: ArmCaseRecord): Record<string, unknown> {
  return {
    caseId: r.caseId,
    suite: r.suite,
    role: r.role,
    arm: r.arm,
    status: r.status,
    terminationReason: r.terminationReason,
    toolCalls: r.toolCalls,
    modelCalls: r.modelCalls,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    maxRepeatedToolCallsLimits: r.maxRepeatedToolCallsLimits,
    stallRecoveries: r.stallRecoveries,
    progressDetected: r.progressDetected,
    toolFailures: r.toolFailures,
    securityViolations: r.securityViolations,
    h2SignatureFires: r.h2SignatureFires,
  };
}

/** The v1 (legacy) record projection, kept ONLY so the historical R87 manifest
 *  stays verifiable. It reproduces the ORIGINAL key order and `JSON.stringify`
 *  (not the sorted canonical form) byte-for-byte, because that is what the
 *  committed `e4-r87-phase-a-manifest-v1` hashes were computed over. */
function legacyRecord(r: ArmCaseRecord): Record<string, unknown> {
  return {
    caseId: r.caseId,
    suite: r.suite,
    role: r.role,
    arm: r.arm,
    status: r.status,
    terminationReason: r.terminationReason,
    toolCalls: r.toolCalls,
    modelCalls: r.modelCalls,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    durationMs: r.durationMs,
    maxRepeatedToolCallsLimits: r.maxRepeatedToolCallsLimits,
    stallRecoveries: r.stallRecoveries,
    progressDetected: r.progressDetected,
    toolFailures: r.toolFailures,
    securityViolations: r.securityViolations,
    h2SignatureFires: r.h2SignatureFires,
  };
}

/** E4-R88 v2 arm hash: deterministic and timing-independent. */
export function armHash(records: ArmCaseRecord[]): string {
  return canonicalDigest(records.map(evidenceRecord));
}

/** Reproduces the E4-R87 v1 arm hash so the historical manifest remains
 *  checkable. Never used for new evidence. */
export function legacyArmHash(records: ArmCaseRecord[]): string {
  return createHash("sha256").update(JSON.stringify(records.map(legacyRecord))).digest("hex");
}

/** Stable per-record hash binding a result line to its experiment identity. */
export function recordHash(r: ArmCaseRecord): string {
  return canonicalDigest(evidenceRecord(r));
}

export interface EvidenceIssue {
  code: EvidenceReasonCode;
  detail: string;
  caseId?: string;
  arm?: ReplayArm;
}

export type Completeness = "COMPLETE" | "PARTIAL";

export interface Summary {
  mechanismMetric: { baselineTargetFires: number; candidateTargetFires: number; improvement: number };
  counterexampleOutcomeDiffs: string[];
  securityViolations: number;
  verifiedCompletion: boolean;
  /** E4-R88: the expected matrix is derived from the FROZEN SELECTION, never
   *  from the observed results (that was F1). */
  expectedRecords: number;
  observedRecords: number;
  completeness: Completeness;
  issues: EvidenceIssue[];
  verdict: "MECHANISM_VALIDATED" | "REJECTED" | "INCONCLUSIVE";
}

/**
 * E4-R88 primary evidence gate.
 *
 * The expected matrix is `selection.cases × declared arms`. A verdict of
 * MECHANISM_VALIDATED requires a COMPLETE, identity-consistent matrix in which
 * every declared expectation is met, no counterexample regressed, no security
 * violation occurred, verified completion did not worsen AND the mechanism
 * metric actually improved.
 *
 * Any structural defect (missing/duplicate/unknown record, wrong suite or role,
 * non-finite or negative metric) is REJECTED — never silently averaged away.
 * Incomplete evidence can only be PARTIAL and is at most INCONCLUSIVE.
 */
export function computeSummary(
  records: ArmCaseRecord[],
  selection: FrozenCaseSelection,
  arms: ReplayArm[] = ["baseline", "candidate"],
): Summary {
  const issues: EvidenceIssue[] = [];
  const declaredArms = [...arms].sort();
  const caseById = new Map(selection.cases.map((c) => [c.id, c]));

  // --- structural validation ------------------------------------------------
  if (records.length === 0) {
    issues.push({ code: "RECORDS_EMPTY", detail: "no records at all were supplied" });
  }

  const seen = new Set<string>();
  for (const r of records) {
    const frozen = caseById.get(r.caseId);
    if (frozen === undefined) {
      issues.push({ code: "UNKNOWN_CASE", detail: `case is not in the frozen selection`, caseId: r.caseId, arm: r.arm });
      continue;
    }
    if (!declaredArms.includes(r.arm)) {
      issues.push({ code: "ARM_UNEXPECTED", detail: `arm is not declared for this run`, caseId: r.caseId, arm: r.arm });
      continue;
    }
    if (frozen.suite !== r.suite) {
      issues.push({
        code: "CASE_SUITE_MISMATCH",
        detail: `suite ${r.suite} != frozen ${frozen.suite}`,
        caseId: r.caseId,
        arm: r.arm,
      });
    }
    if (frozen.role !== r.role) {
      issues.push({
        code: "CASE_ROLE_MISMATCH",
        detail: `role ${r.role} != frozen ${frozen.role}`,
        caseId: r.caseId,
        arm: r.arm,
      });
    }
    const key = `${r.caseId}/${r.arm}`;
    if (seen.has(key)) {
      issues.push({ code: "DUPLICATE_RECORD", detail: `duplicate ${key}`, caseId: r.caseId, arm: r.arm });
    }
    seen.add(key);

    for (const [name, value] of Object.entries({
      toolCalls: r.toolCalls,
      modelCalls: r.modelCalls,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      maxRepeatedToolCallsLimits: r.maxRepeatedToolCallsLimits,
      stallRecoveries: r.stallRecoveries,
      progressDetected: r.progressDetected,
      toolFailures: r.toolFailures,
      securityViolations: r.securityViolations,
    })) {
      if (!Number.isFinite(value)) {
        issues.push({ code: "METRIC_NOT_FINITE", detail: `${name} is not finite`, caseId: r.caseId, arm: r.arm });
      } else if (value < 0) {
        issues.push({ code: "METRIC_NEGATIVE", detail: `${name} is negative`, caseId: r.caseId, arm: r.arm });
      }
    }
  }

  // Missing (case, arm) pairs vs the FROZEN expectation.
  const missing: string[] = [];
  for (const c of selection.cases) {
    for (const arm of declaredArms) {
      if (!seen.has(`${c.id}/${arm}`)) missing.push(`${c.id}/${arm}`);
    }
  }
  if (missing.length > 0) {
    const perArm = new Map<ReplayArm, number>();
    for (const key of missing) {
      const arm = key.slice(key.lastIndexOf("/") + 1) as ReplayArm;
      perArm.set(arm, (perArm.get(arm) ?? 0) + 1);
    }
    for (const [arm, count] of perArm) {
      const total = selection.cases.length;
      issues.push({
        code: count === total ? "ARM_MISSING" : "MATRIX_INCOMPLETE",
        detail: `${count}/${total} frozen cases have no ${arm} record`,
        arm,
      });
    }
  }

  const expectedRecords = selection.cases.length * declaredArms.length;
  const matrixComplete = missing.length === 0 && records.length === expectedRecords;
  // A FORMAL A/B requires BOTH arms (plan §R88 怎么做: "正式 A/B 必須两臂齐全。
  // 单臂执行可以保存中间状态，但状态只能 PARTIAL/INCONCLUSIVE"). A single-arm run
  // may persist intermediate state but can never be COMPLETE or validated.
  const formalAb = declaredArms.includes("baseline") && declaredArms.includes("candidate");
  if (!formalAb) {
    issues.push({
      code: "ARM_MISSING",
      detail: `a formal A/B requires both arms; declared: [${declaredArms.join(", ")}]`,
    });
  }
  const complete = matrixComplete && formalAb;

  // --- metric + guards ------------------------------------------------------
  const baseline = records.filter((r) => r.arm === "baseline");
  const candidate = records.filter((r) => r.arm === "candidate");
  const baselineTargetFires = baseline.filter((r) => r.role === "TARGET" && r.h2SignatureFires).length;
  const candidateTargetFires = candidate.filter((r) => r.role === "TARGET" && r.h2SignatureFires).length;

  const counterexampleOutcomeDiffs: string[] = [];
  for (const ce of selection.cases.filter((c) => c.role === "COUNTEREXAMPLE")) {
    const b = baseline.find((r) => r.caseId === ce.id);
    const c = candidate.find((r) => r.caseId === ce.id);
    if (b === undefined || c === undefined) continue; // already reported as incomplete
    if (c.status !== b.status || c.terminationReason !== b.terminationReason) {
      counterexampleOutcomeDiffs.push(ce.id);
    }
  }
  for (const id of counterexampleOutcomeDiffs) {
    issues.push({ code: "COUNTEREXAMPLE_REGRESSION", detail: `counterexample outcome changed`, caseId: id });
  }

  const securityViolations = records.reduce((n, r) => n + r.securityViolations, 0);
  if (securityViolations > 0) {
    issues.push({ code: "SECURITY_VIOLATION", detail: `${securityViolations} security event(s) observed` });
  }

  // verified_complete counterexamples must still complete in the candidate arm.
  const verifiedBaseline = baseline.filter((r) => r.status === "completed");
  const verifiedCompletion = verifiedBaseline.every(
    (b) => candidate.find((r) => r.caseId === b.caseId)?.status === "completed",
  );
  if (!verifiedCompletion) {
    issues.push({ code: "VERIFIED_COMPLETION_REGRESSED", detail: "a completing case no longer completes" });
  }

  // Expectations are FROZEN: a candidate that fails for a non-target reason, or
  // whose declared expectation is unmet, is not an improvement (plan §R88 验收).
  const unmet = records.filter((r) => {
    const frozen = caseById.get(r.caseId);
    if (frozen === undefined) return false;
    const exp = frozen.expect[r.arm];
    if (exp === undefined) return false;
    const statusOk = r.status === exp.status && r.h2SignatureFires === exp.h2SignatureFires;
    const termOk = exp.termination === undefined || r.terminationReason === exp.termination;
    return !(statusOk && termOk) || r.expectedMet === false;
  });
  for (const r of unmet) {
    issues.push({
      code: "EXPECT_NOT_MET",
      detail: `expected ${JSON.stringify(caseById.get(r.caseId)!.expect[r.arm])}, observed ${r.status}/${r.terminationReason ?? "-"}`,
      caseId: r.caseId,
      arm: r.arm,
    });
  }

  const improvement = baselineTargetFires - candidateTargetFires;
  const rejected =
    issues.some((i) =>
      (
        [
          "DUPLICATE_RECORD",
          "UNKNOWN_CASE",
          "CASE_SUITE_MISMATCH",
          "CASE_ROLE_MISMATCH",
          "METRIC_NOT_FINITE",
          "METRIC_NEGATIVE",
          "EXPECT_NOT_MET",
          "COUNTEREXAMPLE_REGRESSION",
          "SECURITY_VIOLATION",
          "VERIFIED_COMPLETION_REGRESSED",
          "ARM_UNEXPECTED",
        ] as EvidenceReasonCode[]
      ).includes(i.code),
    ) || improvement < 0;

  let verdict: Summary["verdict"];
  if (rejected) {
    verdict = "REJECTED";
  } else if (complete && improvement > 0 && issues.length === 0) {
    verdict = "MECHANISM_VALIDATED";
  } else if (improvement <= 0) {
    // No improvement on a complete matrix is a rejection of the candidate, not
    // merely inconclusive evidence.
    verdict = complete ? "REJECTED" : "INCONCLUSIVE";
    if (complete && improvement === 0) {
      issues.push({ code: "NO_MECHANISM_IMPROVEMENT", detail: "the mechanism metric did not improve" });
    }
  } else {
    verdict = "INCONCLUSIVE";
  }

  return {
    mechanismMetric: { baselineTargetFires, candidateTargetFires, improvement },
    counterexampleOutcomeDiffs,
    securityViolations,
    verifiedCompletion,
    expectedRecords,
    observedRecords: records.length,
    completeness: complete ? "COMPLETE" : "PARTIAL",
    issues,
    verdict,
  };
}

export interface PaidGateStatus {
  status: "NOT_RUN" | "AUTHORIZED";
  code?: "PAID_AUTHORIZATION_REQUIRED";
  reason: string;
}

/** R87 paid gate (plan §R87 强制授权门). Phase A NEVER authorizes: without a
 *  NEW explicit authorization (distinct from R83), the paid path is
 *  NOT_RUN: PAID_AUTHORIZATION_REQUIRED and makes 0 provider calls. */
export function paidAuthorizationStatus(env: Record<string, string | undefined>): PaidGateStatus {
  const hasNewAuth = env.E4_R87_PAID_AUTH === "1" && env.RUN_PAID_BENCHMARKS === "1";
  const digestMatches = env.E4_R87_PAID_AUTH_DIGEST === R87_SELECTION_DIGEST;
  if (!hasNewAuth || !digestMatches) {
    return {
      status: "NOT_RUN",
      code: "PAID_AUTHORIZATION_REQUIRED",
      reason:
        "no NEW explicit R87 paid authorization present (E4_R87_PAID_AUTH=1 + RUN_PAID_BENCHMARKS=1 + matching E4_R87_PAID_AUTH_DIGEST). R83 key/digest/oral authorization does NOT carry over.",
    };
  }
  return { status: "AUTHORIZED", reason: "new explicit R87 authorization present" };
}

export interface ManifestArm {
  arm: ReplayArm;
  sourceSha: string;
  streakResultAware: boolean;
  limits: ReplayLimits;
  records: Array<Record<string, unknown>>;
  hash: string;
}

export interface Manifest {
  schemaVersion: string;
  /** E4-R88: the full experiment identity (selection digest, implementation SHA,
   *  arm semantics, limits, fixture digest) — not just the selection digest.
   *  R90 §2: it now also carries `executedSourceSha`, `historicalReferenceSha`,
   *  `baselineMode` and the synthetic-scenario mapping. */
  identity: ExperimentIdentity;
  selectionDigest: string;
  baselineSha: string;
  candidateSha: string;
  /** Both arm keys are always present; an arm NOT declared for the run carries
   *  no records and the validator reports ARM_MISSING for it. Which arms were
   *  declared lives in `identity.arms`. */
  arms: Record<ReplayArm, ManifestArm>;
  summary: Summary;
  providerCalls: 0;
  gate: PaidGateStatus;
  limits: ReplayLimits;
  caseOrder: string[];
  /**
   * R93: the per-arm BUILD digests that substantiate a `real_version_ab` claim.
   *
   * R90 already refused to let the emulated switch masquerade as a real
   * two-version A/B, but it did so by comparing the `experimentKind` and
   * `baselineMode` ENUMS. Flipping two enum strings to
   * `real_version_ab` / `isolated_build` was therefore enough to look
   * legitimate. R93 requires actual two-arm build evidence: without two distinct
   * non-empty digests, such a claim is `UNSUPPORTED` — never `VALID`.
   *
   * NOTE: this field is deliberately NOT part of `experimentIdentity`'s digest
   * payload (it is build output, not experimental configuration). It is checked
   * separately, and a `real_version_ab` claim that lacks it is refused.
   */
  armBuildDigests?: { baseline: string; candidate: string };
  /**
   * R90 §2: a reviewer-facing statement of what this manifest does and does not
   * prove, so no reader has to infer it from `sourceSha`.
   */
  scope: {
    experimentKind: ExperimentKind;
    baselineMode: BaselineMode;
    executedSourceSha: string;
    historicalReferenceSha: string;
    historicalReferenceCheckedOut: false;
    independentMechanismScenarios: number;
    targetLabels: number;
    statement: string;
  };
}

/**
 * Build the sanitized A/B manifest.
 *
 * E4-R88: validates the frozen selection, refuses to build a manifest for an
 * arm that has no records at all (a "summary" over one arm is not evidence),
 * and binds the full experiment identity so the manifest cannot be replayed
 * against a different selection/config/implementation.
 *
 * R90 §2: emits schema v3, which records the EXECUTED source SHA, labels the
 * baseline as emulated semantics (the same runtime behind a switch, NOT a
 * checked-out historical build) and declares how many independent mechanism
 * scenarios the synthetic target labels actually represent.
 */
export function buildManifest(opts: {
  selection: FrozenCaseSelection;
  records: ArmCaseRecord[];
  arms: ReplayArm[];
  implementationSha: string;
  baselineSha: string;
  candidateSha: string;
  gate: PaidGateStatus;
  /** R90: defaults to `emulated_semantics` — the honest R87 description. */
  baselineMode?: BaselineMode;
  /** R90: defaults to `synthetic_mechanism`. */
  experimentKind?: ExperimentKind;
  /**
   * R93: the two arm BUILD digests. REQUIRED to substantiate a
   * `real_version_ab` claim; ignored (and not emitted) otherwise.
   */
  armBuildDigests?: { baseline: string; candidate: string };
}): Manifest {
  verifySelectionDigest(opts.selection);
  const baselineMode = opts.baselineMode ?? "emulated_semantics";
  const experimentKind = opts.experimentKind ?? "synthetic_mechanism";
  const identity = experimentIdentity({
    selection: opts.selection,
    arms: opts.arms,
    implementationSha: opts.implementationSha,
    historicalReferenceSha: opts.baselineSha,
    baselineMode,
    experimentKind,
  });
  const semantics = armSemantics(opts.arms);
  const arms = {} as Record<ReplayArm, ManifestArm>;
  for (const arm of ["baseline", "candidate"] as ReplayArm[]) {
    const declared = semantics.some((s) => s.arm === arm);
    const armRecords = declared ? opts.records.filter((r) => r.arm === arm) : [];
    arms[arm] = {
      arm,
      sourceSha: arm === "baseline" ? opts.baselineSha : opts.candidateSha,
      streakResultAware: arm === "candidate",
      limits: REPLAY_LIMITS,
      records: armRecords.map(evidenceRecord),
      hash: armHash(armRecords),
    };
  }
  return {
    schemaVersion: R90_MANIFEST_SCHEMA,
    identity,
    selectionDigest: opts.selection.digest,
    baselineSha: opts.baselineSha,
    candidateSha: opts.candidateSha,
    arms,
    summary: computeSummary(opts.records, opts.selection, opts.arms),
    providerCalls: 0,
    gate: opts.gate,
    limits: REPLAY_LIMITS,
    caseOrder: opts.selection.cases.map((c) => c.id),
    // R93: only a real_version_ab claim carries build digests; a synthetic
    // mechanism experiment has no two builds to substantiate.
    ...(opts.armBuildDigests !== undefined && experimentKind === "real_version_ab"
      ? { armBuildDigests: opts.armBuildDigests }
      : {}),
    scope: {
      experimentKind,
      baselineMode,
      executedSourceSha: opts.implementationSha,
      historicalReferenceSha: opts.baselineSha,
      historicalReferenceCheckedOut: false,
      independentMechanismScenarios: SYNTHETIC_SCENARIO_MAPPING.independentScenarioCount,
      targetLabels: SYNTHETIC_SCENARIO_MAPPING.targetLabels,
      statement:
        `synthetic mechanism experiment: the code that executed is ${opts.implementationSha}. ` +
        `The baseline arm is the SAME runtime with streakResultAware=false ` +
        `(baselineMode=${baselineMode}); the historical revision ${opts.baselineSha} was NOT ` +
        `checked out or built and is a reference only. The ${SYNTHETIC_SCENARIO_MAPPING.targetLabels} ` +
        `target labels are labels of ${SYNTHETIC_SCENARIO_MAPPING.independentScenarioCount} ` +
        `independent scripted scenario (${SYNTHETIC_SCENARIO_MAPPING.traceKind}), not independent ` +
        `historical transcripts. This manifest therefore proves the MECHANISM and does not by ` +
        `itself prove that any historical case was affected.`,
    },
  };
}

/**
 * R93: `UNSUPPORTED` is deliberately distinct from `INVALID`.
 *   - `INVALID`     — the manifest contradicts itself or its own records.
 *   - `UNSUPPORTED` — the manifest is internally consistent, but the CLAIM it
 *     makes is not substantiated by the evidence it carries (e.g. a
 *     `real_version_ab` claim with no two-arm build digests). Editing an enum is
 *     never enough to substantiate a real two-version A/B.
 */
export type ValidationStatus = "VALID" | "INVALID" | "LEGACY_UNVERIFIED" | "UNSUPPORTED";
export interface ValidationResult {
  status: ValidationStatus;
  reasonCodes: EvidenceReasonCode[];
  detail: string;
}

/** R93: the limits fields, as a closed set. */
const REPLAY_LIMIT_FIELDS = [
  "maxRepeatedIdenticalToolCalls",
  "maxStallRecoveries",
  "maxPatternStallRecoveries",
  "maxIterationsPerTurn",
  "maxParallelToolCalls",
] as const;

/** R93: the canonical evidence-record projection (`evidenceRecord`), as a closed
 *  field set. A record carrying anything else is not the hashed projection. */
const RECORD_STRING_FIELDS = ["caseId", "suite", "status"] as const;
const RECORD_OPTIONAL_STRING_FIELDS = ["terminationReason"] as const;
const RECORD_NUMBER_FIELDS = [
  "toolCalls",
  "modelCalls",
  "tokensIn",
  "tokensOut",
  "maxRepeatedToolCallsLimits",
  "stallRecoveries",
  "progressDetected",
  "toolFailures",
  "securityViolations",
] as const;
const RECORD_BOOLEAN_FIELDS = ["h2SignatureFires"] as const;
const RECORD_ROLE_VALUES = ["TARGET", "COUNTEREXAMPLE"] as const;
const ARM_VALUES = ["baseline", "candidate"] as const;
const BASELINE_MODE_VALUES = ["emulated_semantics", "isolated_build"] as const;
const EXPERIMENT_KIND_VALUES = ["synthetic_mechanism", "real_version_ab"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isPositiveSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

function isNonNegativeSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** Digest that tolerates a MISSING field (JSON has no `undefined`). */
function safeCanonical(value: unknown): string {
  if (value === undefined) return "\u0000absent";
  try {
    return canonicalDigest(value);
  } catch {
    return "\u0000unencodable";
  }
}

/** Strict limits validation. Returns offending FIELD PATHS only — never the
 *  values, so a secret can never be echoed back through the validator. */
function replayLimitProblems(value: unknown, path: string): string[] {
  if (!isPlainObject(value)) return [`${path} is not an object`];
  const out: string[] = [];
  for (const key of REPLAY_LIMIT_FIELDS) {
    if (!(key in value)) out.push(`${path}.${key} is missing`);
    else if (!isPositiveSafeInt(value[key])) out.push(`${path}.${key} is not a positive safe integer`);
  }
  for (const key of Object.keys(value)) {
    if (!(REPLAY_LIMIT_FIELDS as readonly string[]).includes(key)) {
      out.push(`${path}.${key} is an unknown limits field`);
    }
  }
  return out;
}

/** Strict evidence-record validation against the canonical projection. */
function recordProblems(value: unknown, path: string): string[] {
  if (!isPlainObject(value)) return [`${path} is not an object`];
  const out: string[] = [];
  for (const key of RECORD_STRING_FIELDS) {
    if (!isNonEmptyString(value[key])) out.push(`${path}.${key} is not a non-empty string`);
  }
  for (const key of RECORD_OPTIONAL_STRING_FIELDS) {
    const v = value[key];
    if (v !== undefined && typeof v !== "string") out.push(`${path}.${key} is not a string`);
  }
  if (!(RECORD_ROLE_VALUES as readonly unknown[]).includes(value["role"])) {
    out.push(`${path}.role is not a known role`);
  }
  if (!(ARM_VALUES as readonly unknown[]).includes(value["arm"])) {
    out.push(`${path}.arm is not a known arm`);
  }
  for (const key of RECORD_NUMBER_FIELDS) {
    if (!isNonNegativeSafeInt(value[key])) {
      out.push(`${path}.${key} is not a non-negative safe integer`);
    }
  }
  for (const key of RECORD_BOOLEAN_FIELDS) {
    if (typeof value[key] !== "boolean") out.push(`${path}.${key} is not a boolean`);
  }
  const known = new Set<string>([
    ...RECORD_STRING_FIELDS,
    ...RECORD_OPTIONAL_STRING_FIELDS,
    "role",
    "arm",
    ...RECORD_NUMBER_FIELDS,
    ...RECORD_BOOLEAN_FIELDS,
  ]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) out.push(`${path}.${key} is an unknown record field`);
  }
  return out;
}

/**
 * R93: an OPTIONAL, independently trusted expectation supplied by the caller.
 *
 * Without it the validator can only prove INTERNAL CONSISTENCY — that a
 * manifest agrees with its own records and the frozen selection. It cannot prove
 * that the code named in `executedSourceSha` ever ran, because the manifest is
 * the only witness. Supplying this upgrades the claim to "matches an identity
 * obtained out of band".
 */
export interface TrustedExpectation {
  experimentId?: string;
  selectionDigest?: string;
  executedSourceSha?: string;
  fixtureDigest?: string;
}

export interface ValidateManifestOptions {
  expected?: TrustedExpectation;
}

/**
 * E4-R88 offline manifest validator (plan §R88 怎么做 #4); R93 full-schema and
 * full-semantics rewrite (plan 20260917-083737 §R93, finding A).
 *
 * Constructs no provider, performs no network access.
 *
 * WHAT IT PROVES: that a manifest is INTERNALLY CONSISTENT — every
 * conclusion-bearing field matches a value recomputed from the manifest's own
 * records and the frozen selection, and the identity/limits/order/scope fields
 * agree with each other.
 *
 * WHAT IT DOES NOT PROVE: that any code actually ran. The manifest is the only
 * witness to its own execution. A caller that wants the stronger claim must
 * supply `opts.expected`, an identity obtained OUT OF BAND. Even then this
 * proves the manifest matches that identity — not that the run happened.
 *
 * R93 correctness notes:
 *   - Every failure is reported as a FIELD PATH plus a reason. Values are never
 *     echoed, so a secret cannot leak through a validation result.
 *   - Malformed input returns a structured INVALID; it never throws.
 *   - Records are validated against the canonical `evidenceRecord` projection,
 *     and each record must sit in the arm its own `arm` field names. Comparing
 *     the two arms' aggregate hashes alone would MISS a swap of two records
 *     between arms when the pair is outcome-identical.
 */
export function validateManifest(
  manifest: unknown,
  selection: FrozenCaseSelection,
  opts: ValidateManifestOptions = {},
): ValidationResult {
  const invalid = (reasonCodes: EvidenceReasonCode[], detail: string): ValidationResult => {
    const unique = [...new Set(reasonCodes)];
    return { status: "INVALID", reasonCodes: unique, detail };
  };

  // --- 1. top-level structure ------------------------------------------------
  if (!isPlainObject(manifest)) {
    return invalid(
      ["MANIFEST_STRUCTURE_INVALID"],
      `manifest is not an object (received ${manifest === null ? "null" : typeof manifest})`,
    );
  }
  const m = manifest;

  const schemaVersion = m["schemaVersion"];
  if (schemaVersion === LEGACY_MANIFEST_SCHEMA) {
    return {
      status: "LEGACY_UNVERIFIED",
      reasonCodes: ["LEGACY_SCHEMA"],
      detail:
        "legacy e4-r87-phase-a-manifest-v1: readable for history, but its verdict was " +
        "produced by the pre-R88 completeness-blind summary and is NOT verified evidence",
    };
  }
  if (schemaVersion === R88_MANIFEST_SCHEMA) {
    // R90 §2: v2 is a versioned ERRATUM, never a deletion. It stays readable for
    // history, but it is no longer blessed: its `sourceSha` field let a reader
    // infer that the historical baseline build had been checked out and
    // executed, which never happened.
    return {
      status: "LEGACY_UNVERIFIED",
      reasonCodes: ["LEGACY_SCHEMA"],
      detail:
        "superseded e4-r88-phase-a-manifest-v2: readable for history, but it recorded the " +
        "historical baseline SHA without declaring that the baseline arm is an EMULATED " +
        "semantic switch rather than a checked-out build. Superseded by " +
        `${R90_MANIFEST_SCHEMA}, which separates executedSourceSha from ` +
        "historicalReferenceSha and declares baselineMode. NOT verified evidence",
    };
  }
  if (schemaVersion !== R90_MANIFEST_SCHEMA) {
    return invalid(
      ["SCHEMA_UNSUPPORTED"],
      `unsupported manifest schema ${typeof schemaVersion === "string" ? schemaVersion : typeof schemaVersion}`,
    );
  }

  const reasonCodes: EvidenceReasonCode[] = [];
  const details: string[] = [];

  // --- 2. identity ----------------------------------------------------------
  const identity = m["identity"];
  let declaredArms: ReplayArm[] = [];
  let identityIsValid = false;
  if (!isPlainObject(identity)) {
    reasonCodes.push("MANIFEST_STRUCTURE_INVALID");
    details.push("identity is not an object");
  } else {
    const id = identity;
    const rawArms = id["arms"];
    if (!Array.isArray(rawArms)) {
      reasonCodes.push("MANIFEST_STRUCTURE_INVALID");
      details.push("identity.arms is not an array");
    } else {
      const seenArms = new Set<string>();
      let armsValid = true;
      rawArms.forEach((entry, i) => {
        if (!isPlainObject(entry)) {
          reasonCodes.push("MANIFEST_STRUCTURE_INVALID");
          details.push(`identity.arms[${i}] is not an object`);
          armsValid = false;
          return;
        }
        const arm = entry["arm"];
        if (!(ARM_VALUES as readonly unknown[]).includes(arm)) {
          reasonCodes.push("ARM_UNKNOWN");
          details.push(`identity.arms[${i}].arm is not a known arm`);
          armsValid = false;
          return;
        }
        const name = arm as ReplayArm;
        if (seenArms.has(name)) {
          reasonCodes.push("ARM_DUPLICATE");
          details.push(`identity.arms repeats ${name}`);
          armsValid = false;
          return;
        }
        seenArms.add(name);
        declaredArms.push(name);
        // R93: the declared semantics must match the frozen meaning, not merely
        // be a boolean. `armSemantics` is the single source of truth.
        const expected = name === "candidate";
        if (entry["streakResultAware"] !== expected) {
          reasonCodes.push("ARM_IDENTITY_MISMATCH");
          details.push(`identity.arms[${i}].streakResultAware does not match the frozen semantics of ${name}`);
          armsValid = false;
        }
      });
      if (declaredArms.length === 0) {
        reasonCodes.push("ARM_MISSING");
        details.push("identity.arms declares no arm");
      }
      if (armsValid && declaredArms.length > 0) identityIsValid = true;
    }

    for (const key of ["implementationSha", "executedSourceSha", "historicalReferenceSha", "fixtureDigest"] as const) {
      if (!isNonEmptyString(id[key])) {
        reasonCodes.push("MANIFEST_STRUCTURE_INVALID");
        details.push(`identity.${key} is not a non-empty string`);
      }
    }
    if (!(BASELINE_MODE_VALUES as readonly unknown[]).includes(id["baselineMode"])) {
      reasonCodes.push("MANIFEST_STRUCTURE_INVALID");
      details.push("identity.baselineMode is not a known enum value");
    }
    if (!(EXPERIMENT_KIND_VALUES as readonly unknown[]).includes(id["experimentKind"])) {
      reasonCodes.push("MANIFEST_STRUCTURE_INVALID");
      details.push("identity.experimentKind is not a known enum value");
    }
    // R93: the identity's OWN view of the selection must agree with the frozen
    // one. Without this the recomputation below would silently substitute the
    // caller's selection for a tampered `identity.selectionDigest`.
    if (id["selectionDigest"] !== selection.digest) {
      reasonCodes.push("EXPERIMENT_ID_MISMATCH");
      details.push("identity.selectionDigest does not match the frozen selection");
    }
    if (id["selectionSchema"] !== selection.schemaVersion) {
      reasonCodes.push("EXPERIMENT_ID_MISMATCH");
      details.push("identity.selectionSchema does not match the frozen selection schema");
    }
    for (const problem of replayLimitProblems(id["limits"], "identity.limits")) {
      reasonCodes.push("MANIFEST_STRUCTURE_INVALID");
      details.push(problem);
    }

    // Recompute the identity independently and compare.
    const recomputedIdentity = experimentIdentity({
      selection,
      arms: declaredArms,
      implementationSha: typeof id["implementationSha"] === "string" ? id["implementationSha"] : "",
      // R90: recompute with the manifest's OWN declared framing, so the digest
      // covers (and therefore validates) the executed/reference split.
      historicalReferenceSha:
        typeof id["historicalReferenceSha"] === "string" ? id["historicalReferenceSha"] : undefined,
      baselineMode: id["baselineMode"] as BaselineMode,
      experimentKind: id["experimentKind"] as ExperimentKind,
    });
    if (recomputedIdentity.experimentId !== id["experimentId"]) {
      reasonCodes.push("EXPERIMENT_ID_MISMATCH");
      details.push("identity.experimentId does not match the recomputed experiment identity");
    }
    if (canonicalDigest(id["limits"]) !== canonicalDigest(REPLAY_LIMITS)) {
      reasonCodes.push("EXPERIMENT_ID_MISMATCH");
      details.push("identity.limits does not match the frozen replay limits");
    }
    if (id["fixtureDigest"] !== fixtureDigest()) {
      reasonCodes.push("EXPERIMENT_ID_MISMATCH");
      details.push("identity.fixtureDigest does not match the current fixture digest");
    }
    // R90 §2: an experiment must not claim to have executed code it did not.
    if (id["executedSourceSha"] !== id["implementationSha"]) {
      reasonCodes.push("EXPERIMENT_ID_MISMATCH");
      details.push("identity.executedSourceSha != identity.implementationSha");
    }
  }

  // --- 3. selection digest --------------------------------------------------
  try {
    verifySelectionDigest(selection);
  } catch {
    reasonCodes.push("SELECTION_DIGEST_MISMATCH");
    details.push("the supplied frozen selection does not verify");
  }
  if (m["selectionDigest"] !== selection.digest) {
    reasonCodes.push("SELECTION_DIGEST_MISMATCH");
    details.push("selectionDigest does not match the frozen selection");
  }

  // --- 4. top-level identity/limits/order/scope -----------------------------
  const baselineSha = m["baselineSha"];
  const candidateSha = m["candidateSha"];
  if (m["limits"] === undefined) {
    reasonCodes.push("MANIFEST_STRUCTURE_INVALID");
    details.push("limits is missing");
  } else {
    for (const problem of replayLimitProblems(m["limits"], "limits")) {
      reasonCodes.push("LIMITS_MISMATCH");
      details.push(problem);
    }
    if (canonicalDigest(m["limits"]) !== canonicalDigest(REPLAY_LIMITS)) {
      reasonCodes.push("LIMITS_MISMATCH");
      details.push("limits does not equal the frozen replay limits");
    }
  }

  if (m["providerCalls"] !== 0) {
    reasonCodes.push("MANIFEST_STRUCTURE_INVALID");
    details.push("providerCalls is not 0 (a zero-call replay must record zero calls)");
  }

  const gate = m["gate"];
  if (!isPlainObject(gate)) {
    reasonCodes.push("MANIFEST_STRUCTURE_INVALID");
    details.push("gate is not an object");
  } else {
    const status = gate["status"];
    if (status !== "NOT_RUN" && status !== "AUTHORIZED") {
      reasonCodes.push("MANIFEST_STRUCTURE_INVALID");
      details.push("gate.status is not a known value");
    }
    if (typeof gate["reason"] !== "string") {
      reasonCodes.push("MANIFEST_STRUCTURE_INVALID");
      details.push("gate.reason is not a string");
    }
    if (status === "NOT_RUN" && gate["code"] !== "PAID_AUTHORIZATION_REQUIRED") {
      reasonCodes.push("MANIFEST_STRUCTURE_INVALID");
      details.push("gate.code is not PAID_AUTHORIZATION_REQUIRED for a NOT_RUN gate");
    }
  }

  // The frozen case order is part of the contract: the same cases in the same
  // order. A reordered manifest is a different experiment.
  const frozenOrder = selection.cases.map((c) => c.id);
  const declaredOrder = m["caseOrder"];
  if (!Array.isArray(declaredOrder) || declaredOrder.some((v) => typeof v !== "string")) {
    reasonCodes.push("MANIFEST_STRUCTURE_INVALID");
    details.push("caseOrder is not an array of strings");
  } else if (canonicalDigest(declaredOrder) !== canonicalDigest(frozenOrder)) {
    reasonCodes.push("CASE_ORDER_MISMATCH");
    details.push("caseOrder does not match the frozen case order");
  }

  const scope = m["scope"];
  if (!isPlainObject(scope)) {
    reasonCodes.push("MANIFEST_STRUCTURE_INVALID");
    details.push("scope is not an object");
  } else {
    const sc = scope;
    if (!(EXPERIMENT_KIND_VALUES as readonly unknown[]).includes(sc["experimentKind"])) {
      reasonCodes.push("SCOPE_MISMATCH");
      details.push("scope.experimentKind is not a known enum value");
    } else if (sc["experimentKind"] !== (identity as Record<string, unknown> | undefined)?.["experimentKind"]) {
      reasonCodes.push("SCOPE_MISMATCH");
      details.push("scope.experimentKind disagrees with identity.experimentKind");
    }
    if (!(BASELINE_MODE_VALUES as readonly unknown[]).includes(sc["baselineMode"])) {
      reasonCodes.push("SCOPE_MISMATCH");
      details.push("scope.baselineMode is not a known enum value");
    } else if (sc["baselineMode"] !== (identity as Record<string, unknown> | undefined)?.["baselineMode"]) {
      reasonCodes.push("SCOPE_MISMATCH");
      details.push("scope.baselineMode disagrees with identity.baselineMode");
    }
    // The scope's executed sha must be the EXECUTED one, and the reference sha
    // must be the historical one. R90's whole point was that these differ.
    if (sc["executedSourceSha"] !== (identity as Record<string, unknown> | undefined)?.["executedSourceSha"]) {
      reasonCodes.push("SCOPE_MISMATCH");
      details.push("scope.executedSourceSha disagrees with identity.executedSourceSha");
    }
    if (sc["historicalReferenceSha"] !== (identity as Record<string, unknown> | undefined)?.["historicalReferenceSha"]) {
      reasonCodes.push("SCOPE_MISMATCH");
      details.push("scope.historicalReferenceSha disagrees with identity.historicalReferenceSha");
    }
    if (sc["historicalReferenceSha"] !== baselineSha) {
      reasonCodes.push("SCOPE_MISMATCH");
      details.push("scope.historicalReferenceSha disagrees with baselineSha");
    }
    // This experiment NEVER checks out the historical revision. A manifest that
    // claims otherwise is claiming evidence it cannot have.
    if (sc["historicalReferenceCheckedOut"] !== false) {
      reasonCodes.push("SCOPE_MISMATCH");
      details.push("scope.historicalReferenceCheckedOut must be false");
    }
    if (sc["independentMechanismScenarios"] !== SYNTHETIC_SCENARIO_MAPPING.independentScenarioCount) {
      reasonCodes.push("SCOPE_MISMATCH");
      details.push("scope.independentMechanismScenarios does not match the declared synthetic mapping");
    }
    if (sc["targetLabels"] !== SYNTHETIC_SCENARIO_MAPPING.targetLabels) {
      reasonCodes.push("SCOPE_MISMATCH");
      details.push("scope.targetLabels does not match the declared synthetic mapping");
    }
    if (!isNonEmptyString(sc["statement"])) {
      reasonCodes.push("SCOPE_MISMATCH");
      details.push("scope.statement is not a non-empty string");
    }
  }

  // --- 5. arms and records --------------------------------------------------
  const armsValue = m["arms"];
  const allRecords: ArmCaseRecord[] = [];
  if (!isPlainObject(armsValue)) {
    reasonCodes.push("MANIFEST_STRUCTURE_INVALID");
    details.push("arms is not an object");
  } else {
    const armsObj = armsValue;
    // An arm key that is not a known arm is a structural defect: it would carry
    // records that no identity covers.
    for (const key of Object.keys(armsObj)) {
      if (!(ARM_VALUES as readonly string[]).includes(key)) {
        reasonCodes.push("ARM_UNKNOWN");
        details.push(`arms.${key} is an unknown arm container`);
      }
    }
    for (const arm of ARM_VALUES) {
      const entry = armsObj[arm];
      const declared = declaredArms.includes(arm);
      if (!isPlainObject(entry)) {
        if (declared) {
          reasonCodes.push("ARM_MISSING");
          details.push(`arms.${arm} is missing for a declared arm`);
        }
        continue;
      }
      const e = entry;
      const rawRecords = e["records"];
      if (!Array.isArray(rawRecords)) {
        reasonCodes.push("MANIFEST_STRUCTURE_INVALID");
        details.push(`arms.${arm}.records is not an array`);
        continue;
      }
      if (typeof e["hash"] !== "string") {
        reasonCodes.push("MANIFEST_STRUCTURE_INVALID");
        details.push(`arms.${arm}.hash is not a string`);
      }
      if (e["arm"] !== arm) {
        reasonCodes.push("ARM_IDENTITY_MISMATCH");
        details.push(`arms.${arm}.arm is not ${arm}`);
      }
      // The frozen per-arm semantics and limits.
      const expectedAware = arm === "candidate";
      if (e["streakResultAware"] !== expectedAware) {
        reasonCodes.push("ARM_IDENTITY_MISMATCH");
        details.push(`arms.${arm}.streakResultAware does not match the frozen semantics`);
      }
      const expectedSource = arm === "baseline" ? baselineSha : candidateSha;
      if (e["sourceSha"] !== expectedSource) {
        reasonCodes.push("ARM_IDENTITY_MISMATCH");
        details.push(`arms.${arm}.sourceSha disagrees with the top-level ${arm}Sha`);
      }
      if (e["limits"] === undefined) {
        reasonCodes.push("MANIFEST_STRUCTURE_INVALID");
        details.push(`arms.${arm}.limits is missing`);
      } else if (canonicalDigest(e["limits"]) !== canonicalDigest(REPLAY_LIMITS)) {
        reasonCodes.push("LIMITS_MISMATCH");
        details.push(`arms.${arm}.limits does not equal the frozen replay limits`);
      }
      if (!declared && rawRecords.length > 0) {
        // Records for an arm the identity never declared.
        reasonCodes.push("ARM_UNEXPECTED");
        details.push(`arms.${arm} holds records but ${arm} is not a declared arm`);
      }
      if (declared && rawRecords.length === 0) {
        reasonCodes.push("ARM_MISSING");
        details.push(`arms.${arm} has no records for a declared arm`);
      }

      const armRecords: ArmCaseRecord[] = [];
      rawRecords.forEach((raw, i) => {
        const path = `arms.${arm}.records[${i}]`;
        const problems = recordProblems(raw, path);
        if (problems.length > 0) {
          reasonCodes.push("RECORD_INVALID");
          for (const p of problems) details.push(p);
          return;
        }
        const rec = raw as unknown as ArmCaseRecord;
        // R93: a record MUST belong to the arm whose container holds it. The
        // aggregate arm hash cannot catch a swap of two outcome-identical
        // records between arms, so this is checked per record.
        if (rec.arm !== arm) {
          reasonCodes.push("ARM_RECORD_MISPLACED");
          details.push(`${path}.arm is ${rec.arm} but the record is stored under ${arm}`);
        }
        armRecords.push(rec);
      });

      if (typeof e["hash"] === "string" && armRecords.length === rawRecords.length) {
        if (armHash(armRecords) !== e["hash"]) {
          reasonCodes.push("ARM_HASH_MISMATCH");
          details.push(`arms.${arm}.hash does not match its records`);
        }
      }
      allRecords.push(...armRecords);
    }
  }

  // --- 6. the claim must be substantiated ----------------------------------
  const kind = (identity as Record<string, unknown> | undefined)?.["experimentKind"];
  const mode = (identity as Record<string, unknown> | undefined)?.["baselineMode"];
  let unsupported: string | undefined;
  if (kind === "real_version_ab") {
    // R90's hard contradiction: a real two-version A/B is asserted while the
    // manifest simultaneously declares that the baseline was the SAME build
    // behind a switch. That is self-contradictory — INVALID, as R88 required.
    if (mode === "emulated_semantics") {
      reasonCodes.push("EXPERIMENT_ID_MISMATCH");
      details.push(
        "identity.experimentKind=real_version_ab contradicts identity.baselineMode=emulated_semantics",
      );
    } else if (mode !== "isolated_build") {
      reasonCodes.push("EXPERIMENT_ID_MISMATCH");
      details.push("identity.baselineMode is not a known enum value for a real_version_ab claim");
    } else {
      // Self-consistent framing, but a real two-version A/B requires two real
      // builds. Editing the enums is not evidence: without two DISTINCT build
      // digests the claim is UNSUPPORTED — never VALID.
      const digests = m["armBuildDigests"];
      const digestsOk =
        isPlainObject(digests) &&
        isNonEmptyString(digests["baseline"]) &&
        isNonEmptyString(digests["candidate"]) &&
        digests["baseline"] !== digests["candidate"];
      if (!digestsOk) {
        reasonCodes.push("EXPERIMENT_KIND_UNSUPPORTED");
        unsupported =
          "a real_version_ab claim requires two DISTINCT non-empty armBuildDigests " +
          "(armBuildDigests.baseline / armBuildDigests.candidate)";
      }
    }
  }

  // --- 7. recompute the whole summary and compare EVERY field --------------
  const recomputedSummary = computeSummary(allRecords, selection, declaredArms);
  const declaredSummary = m["summary"];
  if (!isPlainObject(declaredSummary)) {
    reasonCodes.push("SUMMARY_MISMATCH");
    details.push("summary is not an object");
  } else {
    const ds = declaredSummary;

    // Every conclusion-bearing field, compared by canonical form so key order
    // and equivalent shapes cannot hide a difference. The mechanism metric is
    // decomposed so the report names the OFFENDING SUB-FIELD, not just its parent.
    const declaredMetric = isPlainObject(ds["mechanismMetric"]) ? ds["mechanismMetric"] : {};
    const summaryFields: Array<[string, unknown, unknown]> = [
      ["mechanismMetric.baselineTargetFires", declaredMetric["baselineTargetFires"], recomputedSummary.mechanismMetric.baselineTargetFires],
      ["mechanismMetric.candidateTargetFires", declaredMetric["candidateTargetFires"], recomputedSummary.mechanismMetric.candidateTargetFires],
      ["mechanismMetric.improvement", declaredMetric["improvement"], recomputedSummary.mechanismMetric.improvement],
      ["counterexampleOutcomeDiffs", ds["counterexampleOutcomeDiffs"], recomputedSummary.counterexampleOutcomeDiffs],
      ["securityViolations", ds["securityViolations"], recomputedSummary.securityViolations],
      ["verifiedCompletion", ds["verifiedCompletion"], recomputedSummary.verifiedCompletion],
      ["expectedRecords", ds["expectedRecords"], recomputedSummary.expectedRecords],
      ["observedRecords", ds["observedRecords"], recomputedSummary.observedRecords],
      ["completeness", ds["completeness"], recomputedSummary.completeness],
      ["issues", ds["issues"], recomputedSummary.issues],
      ["verdict", ds["verdict"], recomputedSummary.verdict],
    ];
    for (const [field, declared, recomputed] of summaryFields) {
      if (safeCanonical(declared) !== safeCanonical(recomputed)) {
        reasonCodes.push("SUMMARY_MISMATCH");
        details.push(`summary.${field} does not match the value recomputed from the records`);
      }
    }
    // A `mechanismMetric` that is missing or not an object is a structural defect
    // even when every sub-field comparison above happens to be undefined.
    if (!isPlainObject(ds["mechanismMetric"])) {
      reasonCodes.push("SUMMARY_MISMATCH");
      details.push("summary.mechanismMetric is not an object");
    }

    // An issue code that is not in the CLOSED set is not a real finding.
    if (Array.isArray(ds["issues"])) {
      ds["issues"].forEach((issue, i) => {
        if (!isPlainObject(issue) || typeof issue["code"] !== "string") {
          reasonCodes.push("RECORD_INVALID");
          details.push(`summary.issues[${i}] is not a structured issue`);
          return;
        }
        if (!EVIDENCE_REASON_CODE_SET.has(issue["code"])) {
          reasonCodes.push("RECORD_INVALID");
          details.push(`summary.issues[${i}].code is not a known reason code`);
        }
      });
    }

    // The recomputed issues must also be reported, so a caller cannot miss a
    // defect by reading only the declared list.
    for (const issue of recomputedSummary.issues) reasonCodes.push(issue.code);
    if (recomputedSummary.verdict === "MECHANISM_VALIDATED" && recomputedSummary.completeness !== "COMPLETE") {
      reasonCodes.push("MATRIX_INCOMPLETE");
      details.push("a MECHANISM_VALIDATED verdict requires a COMPLETE matrix");
    }
  }

  // --- 8. optional independently trusted expectation ------------------------
  const expected = opts.expected;
  if (expected !== undefined) {
    const id = isPlainObject(identity) ? identity : {};
    const checks: Array<[keyof TrustedExpectation, unknown]> = [
      ["experimentId", id["experimentId"]],
      ["selectionDigest", m["selectionDigest"]],
      ["executedSourceSha", id["executedSourceSha"]],
      ["fixtureDigest", id["fixtureDigest"]],
    ];
    for (const [field, actual] of checks) {
      const want = expected[field];
      if (want !== undefined && want !== actual) {
        reasonCodes.push("IDENTITY_UNTRUSTED");
        details.push(`${String(field)} does not match the independently supplied expectation`);
      }
    }
  }

  const unique = [...new Set(reasonCodes)];
  if (unique.length > 0) {
    // `UNSUPPORTED` describes a self-consistent manifest whose CLAIM outruns its
    // evidence; anything else is a self-contradiction.
    const onlyUnsupported = unique.every(
      (c) => c === "EXPERIMENT_KIND_UNSUPPORTED" || c === "MATRIX_INCOMPLETE" || c === "NO_MECHANISM_IMPROVEMENT",
    );
    if (onlyUnsupported && unsupported !== undefined) {
      return { status: "UNSUPPORTED", reasonCodes: unique, detail: unsupported };
    }
    return invalid(unique, `manifest does not match its own records: ${details.join("; ")}`);
  }
  return {
    status: "VALID",
    reasonCodes: [],
    detail: `internally consistent: verdict ${recomputedSummary.verdict}; identity ${
      identityIsValid ? "well-formed" : "not verified"
    }. Internal consistency does NOT prove that the named code executed.`,
  };
}
