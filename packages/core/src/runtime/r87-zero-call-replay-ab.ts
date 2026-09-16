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
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

export interface ReplayAbOptions {
  arms: ReplayArm[];
  now?: () => number;
  runStatePath?: string;
  secretCanary?: string;
}

export interface ReplayAbResult {
  records: ArmCaseRecord[];
  executed: string[];
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

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: "r87-replay-agent",
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

/** Run the A/B: strictly serial (concurrency 1), atomic persist after each
 *  (case, arm), resume skips already-completed arms (no double billing). */
export async function runReplayAb(selection: FrozenCaseSelection, opts: ReplayAbOptions): Promise<ReplayAbResult> {
  const now = opts.now ?? (() => 0);
  const statePath = opts.runStatePath;
  const lines: string[] = [];
  const done = new Set<string>();
  if (statePath !== undefined && existsSync(statePath)) {
    for (const line of readFileSync(statePath, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      lines.push(line);
      const rec = JSON.parse(line) as { caseId: string; arm: ReplayArm };
      done.add(`${rec.caseId}/${rec.arm}`);
    }
  }
  const records: ArmCaseRecord[] = [];
  const executed: string[] = [];
  for (const c of selection.cases) {
    for (const arm of opts.arms) {
      const key = `${c.id}/${arm}`;
      if (done.has(key)) continue;
      const rec = await runCaseArm(c, arm, now, opts.secretCanary ?? "");
      records.push(rec);
      executed.push(key);
      if (statePath !== undefined) {
        // Atomic persist per (case, arm): write tmp + rename (same volume).
        lines.push(JSON.stringify({ ...rec, caseId: c.id, arm }));
        const tmp = `${statePath}.tmp`;
        writeFileSync(tmp, lines.join("\n") + "\n");
        renameSync(tmp, statePath);
      }
    }
  }
  // Re-load completed arms from the state file so records include resumed work.
  if (statePath !== undefined && existsSync(statePath)) {
    const loaded: ArmCaseRecord[] = [];
    for (const line of readFileSync(statePath, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const { caseId, arm, ...rest } = JSON.parse(line) as ArmCaseRecord & { caseId: string; arm: ReplayArm };
      loaded.push({ caseId, arm, ...rest });
    }
    for (const rec of loaded) {
      if (!records.some((r) => r.caseId === rec.caseId && r.arm === rec.arm)) {
        records.push(rec);
      }
    }
  }
  records.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.arm.localeCompare(b.arm));
  return { records, executed };
}

/** Sanitized per-arm sha256 over the arm's records (validator-recomputable). */
export function armHash(records: ArmCaseRecord[]): string {
  const sanitized = records.map(sanitizeRecord);
  return createHash("sha256").update(JSON.stringify(sanitized)).digest("hex");
}

function sanitizeRecord(r: ArmCaseRecord): Record<string, unknown> {
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

export interface Summary {
  mechanismMetric: { baselineTargetFires: number; candidateTargetFires: number; improvement: number };
  counterexampleOutcomeDiffs: string[];
  securityViolations: number;
  verifiedCompletion: boolean;
  verdict: "MECHANISM_VALIDATED" | "REJECTED" | "INCONCLUSIVE";
}

/** Primary metric = R85 mechanism metric: the H2 progress-blind gate firing on
 *  TARGET cases. Counterexample outcome diffs / security violations / verified
 *  completion are guards. */
export function computeSummary(records: ArmCaseRecord[]): Summary {
  const baseline = records.filter((r) => r.arm === "baseline");
  const candidate = records.filter((r) => r.arm === "candidate");
  const baselineTargetFires = baseline.filter((r) => r.role === "TARGET" && r.h2SignatureFires).length;
  const candidateTargetFires = candidate.filter((r) => r.role === "TARGET" && r.h2SignatureFires).length;

  const counterexampleOutcomeDiffs: string[] = [];
  for (const b of baseline.filter((r) => r.role === "COUNTEREXAMPLE")) {
    const c = candidate.find((r) => r.caseId === b.caseId);
    if (c === undefined) continue;
    if (c.status !== b.status || c.terminationReason !== b.terminationReason) {
      counterexampleOutcomeDiffs.push(b.caseId);
    }
  }

  const securityViolations = records.reduce((n, r) => n + r.securityViolations, 0);
  // verified_complete counterexamples must still complete in the candidate arm.
  const verifiedCompletion =
    baseline
      .filter((r) => r.role === "COUNTEREXAMPLE" && r.status === "completed")
      .every((b) => candidate.find((r) => r.caseId === b.caseId)?.status === "completed");

  const improvement = baselineTargetFires - candidateTargetFires;
  let verdict: Summary["verdict"];
  if (improvement > 0 && counterexampleOutcomeDiffs.length === 0 && securityViolations === 0 && verifiedCompletion) {
    verdict = "MECHANISM_VALIDATED";
  } else if (improvement <= 0 || securityViolations > 0 || counterexampleOutcomeDiffs.length > 0) {
    verdict = "REJECTED";
  } else {
    verdict = "INCONCLUSIVE";
  }
  return {
    mechanismMetric: { baselineTargetFires, candidateTargetFires, improvement },
    counterexampleOutcomeDiffs,
    securityViolations,
    verifiedCompletion,
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

export interface Manifest {
  schemaVersion: string;
  selectionDigest: string;
  baselineSha: string;
  candidateSha: string;
  arms: {
    baseline: { sourceSha: string; limits: ReplayLimits; records: Array<Record<string, unknown>>; hash: string };
    candidate: { sourceSha: string; limits: ReplayLimits; records: Array<Record<string, unknown>>; hash: string };
  };
  summary: Summary;
  providerCalls: 0;
  gate: PaidGateStatus;
  limits: ReplayLimits;
  caseOrder: string[];
}

export function buildManifest(opts: {
  selection: FrozenCaseSelection;
  records: ArmCaseRecord[];
  baselineSha: string;
  candidateSha: string;
  gate: PaidGateStatus;
}): Manifest {
  const baseline = opts.records.filter((r) => r.arm === "baseline");
  const candidate = opts.records.filter((r) => r.arm === "candidate");
  return {
    schemaVersion: "e4-r87-phase-a-manifest-v1",
    selectionDigest: opts.selection.digest,
    baselineSha: opts.baselineSha,
    candidateSha: opts.candidateSha,
    arms: {
      baseline: {
        sourceSha: opts.baselineSha,
        limits: REPLAY_LIMITS,
        records: baseline.map(sanitizeRecord),
        hash: armHash(baseline),
      },
      candidate: {
        sourceSha: opts.candidateSha,
        limits: REPLAY_LIMITS,
        records: candidate.map(sanitizeRecord),
        hash: armHash(candidate),
      },
    },
    summary: computeSummary(opts.records),
    providerCalls: 0,
    gate: opts.gate,
    limits: REPLAY_LIMITS,
    caseOrder: opts.selection.cases.map((c) => c.id),
  };
}
