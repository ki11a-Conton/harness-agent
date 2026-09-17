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
export const LEGACY_MANIFEST_SCHEMA = "e4-r87-phase-a-manifest-v1";
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
  implementationSha: string;
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

/** E4-R88 reason codes — a CLOSED, stable set so callers can assert on them. */
export type EvidenceReasonCode =
  | "RECORDS_EMPTY"
  | "MATRIX_INCOMPLETE"
  | "ARM_MISSING"
  | "ARM_UNEXPECTED"
  | "DUPLICATE_RECORD"
  | "UNKNOWN_CASE"
  | "CASE_SUITE_MISMATCH"
  | "CASE_ROLE_MISMATCH"
  | "METRIC_NOT_FINITE"
  | "METRIC_NEGATIVE"
  | "EXPECT_NOT_MET"
  | "COUNTEREXAMPLE_REGRESSION"
  | "SECURITY_VIOLATION"
  | "VERIFIED_COMPLETION_REGRESSED"
  | "NO_MECHANISM_IMPROVEMENT"
  | "SELECTION_DIGEST_MISMATCH"
  | "EXPERIMENT_ID_MISMATCH"
  | "STATE_HEADER_MISSING"
  | "STATE_HEADER_INVALID"
  | "STATE_TRUNCATED"
  | "STATE_UNREADABLE"
  | "RECORD_HASH_MISMATCH"
  | "SCHEMA_UNSUPPORTED"
  | "ARM_HASH_MISMATCH"
  | "SUMMARY_MISMATCH"
  | "LEGACY_SCHEMA";

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

/** Build the experiment identity for a run. `experimentId` is the canonical
 *  digest of the whole identity payload (excluding the id itself). The arm
 *  semantics bound here always cover BOTH arms, so a single-arm intermediate
 *  state is not a different experiment from the later full A/B. */
export function experimentIdentity(opts: {
  selection: FrozenCaseSelection;
  arms: ReplayArm[];
  implementationSha: string;
}): ExperimentIdentity {
  void opts.arms; // declared-arm subset is NOT part of the experiment identity
  const payload = {
    schemaVersion: R88_RUN_STATE_SCHEMA,
    selectionSchema: opts.selection.schemaVersion,
    selectionDigest: opts.selection.digest,
    implementationSha: opts.implementationSha,
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
   *  arm semantics, limits, fixture digest) — not just the selection digest. */
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
}

/**
 * Build the sanitized A/B manifest.
 *
 * E4-R88: validates the frozen selection, refuses to build a manifest for an
 * arm that has no records at all (a "summary" over one arm is not evidence),
 * and binds the full experiment identity so the manifest cannot be replayed
 * against a different selection/config/implementation.
 */
export function buildManifest(opts: {
  selection: FrozenCaseSelection;
  records: ArmCaseRecord[];
  arms: ReplayArm[];
  implementationSha: string;
  baselineSha: string;
  candidateSha: string;
  gate: PaidGateStatus;
}): Manifest {
  verifySelectionDigest(opts.selection);
  const identity = experimentIdentity({
    selection: opts.selection,
    arms: opts.arms,
    implementationSha: opts.implementationSha,
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
    schemaVersion: R88_MANIFEST_SCHEMA,
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
  };
}

export type ValidationStatus = "VALID" | "INVALID" | "LEGACY_UNVERIFIED";
export interface ValidationResult {
  status: ValidationStatus;
  reasonCodes: EvidenceReasonCode[];
  detail: string;
}

/**
 * E4-R88 offline manifest validator (plan §R88 怎么做 #4).
 *
 * Recomputes the arm hashes and the verdict from the manifest's OWN records and
 * the frozen selection, and checks the declared identity. Constructs no
 * provider, performs no network access. A manifest whose declared hash, verdict
 * or completeness does not match its records is INVALID.
 */
export function validateManifest(
  manifest: unknown,
  selection: FrozenCaseSelection,
): ValidationResult {
  const m = manifest as Partial<Manifest> & { schemaVersion?: string };
  if (m.schemaVersion === LEGACY_MANIFEST_SCHEMA) {
    return {
      status: "LEGACY_UNVERIFIED",
      reasonCodes: ["LEGACY_SCHEMA"],
      detail:
        "legacy e4-r87-phase-a-manifest-v1: readable for history, but its verdict was " +
        "produced by the pre-R88 completeness-blind summary and is NOT verified evidence",
    };
  }
  if (m.schemaVersion !== R88_MANIFEST_SCHEMA) {
    return {
      status: "INVALID",
      reasonCodes: ["SCHEMA_UNSUPPORTED"],
      detail: `unsupported manifest schema ${String(m.schemaVersion)}`,
    };
  }

  const reasonCodes: EvidenceReasonCode[] = [];
  try {
    verifySelectionDigest(selection);
  } catch {
    reasonCodes.push("SELECTION_DIGEST_MISMATCH");
  }
  if (m.selectionDigest !== selection.digest) reasonCodes.push("SELECTION_DIGEST_MISMATCH");

  const declaredArms = (m.identity?.arms ?? []).map((a) => a.arm) as ReplayArm[];
  if (declaredArms.length === 0) reasonCodes.push("ARM_MISSING");

  // Recompute the identity independently and compare.
  if (m.identity === undefined) {
    reasonCodes.push("EXPERIMENT_ID_MISMATCH");
  } else {
    const recomputedIdentity = experimentIdentity({
      selection,
      arms: declaredArms,
      implementationSha: m.identity.implementationSha,
    });
    if (recomputedIdentity.experimentId !== m.identity.experimentId) {
      reasonCodes.push("EXPERIMENT_ID_MISMATCH");
    }
    if (canonicalDigest(m.identity.limits) !== canonicalDigest(REPLAY_LIMITS)) {
      reasonCodes.push("EXPERIMENT_ID_MISMATCH");
    }
    if (m.identity.fixtureDigest !== fixtureDigest()) reasonCodes.push("EXPERIMENT_ID_MISMATCH");
  }

  const armsObj = (m.arms ?? {}) as Partial<Record<ReplayArm, ManifestArm>>;
  const allRecords: ArmCaseRecord[] = [];
  for (const arm of declaredArms) {
    const entry = armsObj[arm];
    if (entry === undefined) {
      reasonCodes.push("ARM_MISSING");
      continue;
    }
    const armRecords = (entry.records ?? []) as unknown as ArmCaseRecord[];
    if (armRecords.length === 0) reasonCodes.push("ARM_MISSING");
    if (armHash(armRecords) !== entry.hash) reasonCodes.push("ARM_HASH_MISMATCH");
    for (const r of armRecords) allRecords.push(r);
  }

  // Recompute the summary from the records and compare with the declared one.
  const recomputedSummary = computeSummary(allRecords, selection, declaredArms);
  const declaredSummary = m.summary;
  if (declaredSummary === undefined) {
    reasonCodes.push("SUMMARY_MISMATCH");
  } else {
    if (declaredSummary.verdict !== recomputedSummary.verdict) reasonCodes.push("SUMMARY_MISMATCH");
    if (declaredSummary.completeness !== recomputedSummary.completeness) {
      reasonCodes.push("SUMMARY_MISMATCH");
    }
    if (declaredSummary.observedRecords !== recomputedSummary.observedRecords) {
      reasonCodes.push("SUMMARY_MISMATCH");
    }
    for (const issue of recomputedSummary.issues) reasonCodes.push(issue.code);
    if (recomputedSummary.verdict === "MECHANISM_VALIDATED" && recomputedSummary.completeness !== "COMPLETE") {
      reasonCodes.push("MATRIX_INCOMPLETE");
    }
  }

  const unique = [...new Set(reasonCodes)];
  return unique.length === 0
    ? { status: "VALID", reasonCodes: [], detail: `verified: verdict ${recomputedSummary.verdict}` }
    : {
        status: "INVALID",
        reasonCodes: unique,
        detail: `manifest does not match its own records (recomputed verdict ${recomputedSummary.verdict})`,
      };
}
