import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import type { Dirent } from "node:fs";
import type { HarnessIntrospection } from "@ar/harness";
import type { CommandDeps, CommandResult } from "./commands.js";

/**
 * P0-1 automatic capability matrix.
 *
 * `agent audit` judges feature maturity from REAL wiring evidence — the
 * composition root's runtime introspection (HarnessIntrospection), the
 * on-disk repository layout, benchmark suites and CI workflow — never from
 * "docs say DONE" (plan.md §2.2).
 *
 * The matrix records are derived by pure functions (buildCapabilityMatrix)
 * so tests can feed any wiring state; the CLI (`auditCmd`) probes the
 * workspace, writes CAPABILITY_MATRIX.json + CAPABILITY_MATRIX.md, and exits
 * non-zero when the docs (benchmarks/README.md) claim a suite that does not
 * exist on disk.
 */

// ---------------------------------------------------------------------------
// Contracts (plan.md P0-1)
// ---------------------------------------------------------------------------

export type CapabilityStatus =
  | "implemented"
  | "wired"
  | "tested"
  | "benchmarked"
  | "missing"
  | "unknown";

/**
 * P20-2 — capability composition profiles. The matrix reports per profile,
 * NOT "source exists => production". A memory capability is genuinely
 * production in the interactive-persistent profile only when the store is
 * durable; the benchmark profile demands benchmark harness wiring; the
 * champion profile demands the strongest posture (durable + isolated).
 */
export type CapabilityProfile =
  | "interactive-ephemeral"
  | "interactive-persistent"
  | "benchmark"
  | "champion";

export const CAPABILITY_PROFILES = [
  "interactive-ephemeral",
  "interactive-persistent",
  "benchmark",
  "champion",
] as const satisfies readonly CapabilityProfile[];

export type SecurityMode = "sandboxed" | "isolated" | "approved" | "unrestricted";

/** P36-8: actual/required durability levels (INV-P36-008). */
export type DurabilityLevel = "none" | "memory" | "process" | "flush" | "durable";

/** Map a store implementation name to its actual durability level. */
export function storeDurabilityLevel(name: string | undefined): DurabilityLevel {
  if (name === undefined) return "none";
  const lower = name.toLowerCase();
  if (/^(jsonl|durable|file|sqlite)/.test(lower) && !lower.includes("memory")) {
    if (lower.startsWith("sqlite")) return "process";
    return "durable";
  }
  return "memory";
}

/** P37-9: the backing store for a durability-required capability. Bug A fix —
 *  each capability reads its OWN store, never the approval store for all. */
export function backingStoreName(
  id: string,
  introspection: HarnessIntrospection | undefined,
): string | undefined {
  switch (id) {
    case "checkpoint_store":
      return introspection?.stores.checkpoint ?? introspection?.persistence?.stores.checkpoint;
    case "memory_store":
      return introspection?.stores.memory;
    case "ask_user_durable":
      return introspection?.stores.askUser ?? introspection?.persistence?.stores.askUser;
    case "approval_durable":
      return introspection?.stores.approval ?? introspection?.persistence?.stores.approval;
    default:
      return undefined;
  }
}

export interface ProfileExpectations {
  /** Capability ids that MUST be durable in this profile. */
  mustBeDurable: readonly string[];
  /** Capability ids that MUST be wired (productionWired) in this profile. */
  mustBeWired: readonly string[];
  /** Security posture this profile promises. */
  securityMode: SecurityMode;
  /** When the profile demands durability, an in-memory harness is degraded. */
  requiresDurableHarness: boolean;
}

/** P20-2 — per-profile expectations. Values are a reviewed configuration,
 *  not a comment: changing a profile's posture is a behavior change. */
export const PROFILE_EXPECTATIONS: Readonly<Record<CapabilityProfile, ProfileExpectations>> = {
  "interactive-ephemeral": {
    mustBeDurable: [],
    mustBeWired: ["context_pipeline", "advanced_tools", "run_budget"],
    securityMode: "sandboxed",
    requiresDurableHarness: false,
  },
  "interactive-persistent": {
    mustBeDurable: ["checkpoint_store", "memory_store", "ask_user_durable", "approval_durable"],
    mustBeWired: ["context_pipeline", "advanced_tools", "usage_accounting", "run_budget"],
    securityMode: "sandboxed",
    requiresDurableHarness: true,
  },
  benchmark: {
    mustBeDurable: [],
    mustBeWired: [
      "context_pipeline",
      "advanced_tools",
      "usage_accounting",
      "run_budget",
      "regression_suite",
      "holdout_suite",
    ],
    securityMode: "sandboxed",
    requiresDurableHarness: false,
  },
  champion: {
    mustBeDurable: ["checkpoint_store", "memory_store", "ask_user_durable", "approval_durable"],
    mustBeWired: [
      "context_pipeline",
      "advanced_tools",
      "usage_accounting",
      "run_budget",
      "regression_suite",
      "holdout_suite",
      "adversarial_suite",
      "stress_suite",
    ],
    securityMode: "isolated",
    requiresDurableHarness: true,
  },
};

export function isCapabilityProfile(value: unknown): value is CapabilityProfile {
  return typeof value === "string" && (CAPABILITY_PROFILES as readonly string[]).includes(value);
}

/** P20-2 — map the harness's own introspection.profile label to a capability
 *  profile. "interactive" + in-memory => ephemeral; "interactive" + durable
 *  harness => persistent; anything else maps to benchmark (the default audit
 *  posture). */
export function profileOf(input: AuditInput): CapabilityProfile {
  const label = input.introspection?.profile ?? "";
  const durable = input.introspection?.persistence?.mode === "durable";
  if (label.startsWith("interactive")) return durable ? "interactive-persistent" : "interactive-ephemeral";
  return "benchmark";
}

export interface CapabilityEvidence {
  kind:
    | "runtime_dependency"
    | "registered_tool"
    | "integration_test"
    | "benchmark_case"
    | "store"
    | "ci_job"
    | "config";
  ref: string;
  note?: string;
}

export interface CapabilityRecord {
  id: string;
  description: string;
  implemented: boolean;
  productionWired: boolean;
  /** P35-2: the capability's model-visible execution path is bound to the
   *  frozen StepExecutionSnapshot (P23) — model-advertised tool world ==
   *  executed tool world (INV-V5-001/002/003). True only when the step
   *  snapshot pipeline is composed (introspection.features.stepSnapshot)
   *  AND this capability's surface actually flows through the frozen
   *  router/policy/context. Separates "implemented/wired" from
   *  "authoritative under the world-snapshot invariant". */
  snapshotAuthoritative: boolean;
  /** P37-9: the actual durability level of the backing store. */
  durabilityActual: DurabilityLevel;
  /** P37-9: the durability level this profile requires. */
  durabilityRequired: DurabilityLevel;
  /** P37-9: whether the actual durability satisfies the profile requirement. */
  durabilitySatisfied: boolean;
  /** P36-7: a test FILE exists for this capability (static evidence only —
   *  says nothing about whether it ran or passed). */
  testDeclared: boolean;
  /** P36-7: a current-HEAD PASSING test-run evidence exists (execution
   *  evidence). Without it, integrationTested is false even when a test
   *  file exists (INV-P36-007). */
  integrationTested: boolean;
  /** P36-7: benchmark CASES exist for this capability (static evidence). */
  benchmarkDeclared: boolean;
  /** P36-7: current-HEAD successful benchmark execution evidence exists. */
  benchmarkExercised: boolean;
  /** P20-2: the security posture the current profile promises (sandboxed /
   *  isolated / approved / unrestricted). */
  securityMode: SecurityMode;
  /** P20-2: why this record is degraded for the current profile — present
   *  exactly when a profile expectation (durable harness / wired / isolated)
   *  is NOT met. Absent = no degradation. */
  degradedReason?: string;
  evidence: CapabilityEvidence[];
}

export interface CapabilityMatrix {
  generatedAt: number;
  gitSha?: string;
  /** P20-2: the capability profile this matrix was built for (see
   *  CAPABILITY_PROFILES). The SAME wiring yields different production
   *  claims per profile — never read a bare matrix as profile-less. */
  profile?: CapabilityProfile;
  records: CapabilityRecord[];
}

/**
 * Runtime introspection supplied by the composition root (plan.md P0-1) —
 * the @ar/harness HarnessIntrospection contract. It reflects what the host
 * ACTUALLY wired — stores by implementation name, registered tool names, and
 * feature flags — so the audit never guesses.
 */

// ---------------------------------------------------------------------------
// Audit input (what the pure builder sees)
// ---------------------------------------------------------------------------

export interface BenchmarkSuiteProbe {
  exists: boolean;
  caseCount: number;
}

/** A suite count claim found in benchmarks/README.md. */
export interface DocClaim {
  suite: string;
  claimed: number;
  /** README marks the suite as planned (honest docs admit it is not built). */
  planned: boolean;
}

export interface CiWorkflowProbe {
  exists: boolean;
  ubuntu: boolean;
  windows: boolean;
}

export interface AuditInput {
  generatedAt: number;
  gitSha?: string;
  introspection?: HarnessIntrospection;
  /** Probe id → source dir present under packages/. */
  packages: Record<string, boolean>;
  /** Probe id → test file present in the repo. */
  integrationTests: Record<string, boolean>;
  benchmarkSuites: Record<string, BenchmarkSuiteProbe>;
  ciWorkflow: CiWorkflowProbe;
  readmeClaims: DocClaim[];
  /** P36-7 (INV-P36-007): execution evidence bound to a HEAD. Keyed by
   *  capability id (or suite name). A capability is integrationTested /
   *  benchmarkExercised ONLY when it has a passing, current-HEAD run
   *  recorded here — a test file on disk is not enough. */
  executionEvidence?: Record<string, ExecutionEvidence>;
}

/** P36-7 — execution-backed evidence. Static declaration ≠ execution. */
export interface ExecutionEvidence {
  kind: "test_run" | "benchmark_run" | "coverage_run" | "ci_run" | "release_gate";
  headSha: string;
  command: string;
  passed: boolean;
  generatedAt: string;
  artifactRef?: string;
}

// ---------------------------------------------------------------------------
// Pure matrix builder
// ---------------------------------------------------------------------------

export const ADVANCED_TOOL_NAMES = [
  "grep_search",
  "repo_tree",
  "symbol_search",
  "repo_map",
  "discover_commands",
  "env_snapshot",
] as const;

export const SUITE_NAMES = ["regression", "holdout", "adversarial", "stress"] as const;

interface CapabilitySpec {
  id: string;
  description: string;
  usesIntrospection: boolean;
  implemented(input: AuditInput): boolean;
  wired(input: AuditInput): boolean;
  /** P35-2: declares this capability's surface as snapshot-bound (P23) —
   *  tools/MCP bindings frozen into StepToolRouter, context frozen per step.
   *  The record reports true only when the step-snapshot pipeline is also
   *  actually composed (introspection.features.stepSnapshot). */
  snapshotAuthoritative?(input: AuditInput): boolean;
  /** P36-7: "declared" predicate — a test file / benchmark case exists.
   *  Whether it RAN and PASSED at HEAD is decided by execution evidence in
   *  toRecord (INV-P36-007). */
  integrationTested(input: AuditInput): boolean;
  benchmarkExercised(input: AuditInput): boolean;
  evidence(input: AuditInput): CapabilityEvidence[];
}

function intro(input: AuditInput): HarnessIntrospection | undefined {
  return input.introspection;
}

function regs(input: AuditInput): readonly string[] {
  return intro(input)?.registeredTools ?? [];
}

function hasTool(input: AuditInput, name: string): boolean {
  return regs(input).includes(name);
}

function allTools(input: AuditInput, names: readonly string[]): boolean {
  return names.every((name) => hasTool(input, name));
}

/** P35-2 — cross-verification of the world-snapshot invariant (plan.md
 *  P35-2): a capability may claim `snapshotAuthoritative` only when the step
 *  snapshot pipeline is composed (introspection fact) AND the invariant is
 *  actually tested by the P34-7 config-drift matrix and the P34-8 security
 *  regression matrix. No claim without both wiring AND coverage. */
function snapshotAuthorityProven(input: AuditInput): boolean {
  return (
    intro(input)?.features.stepSnapshot === true &&
    input.integrationTests["config_drift_matrix"] === true &&
    input.integrationTests["security_regression_matrix"] === true
  );
}

function suiteProbe(input: AuditInput, suite: string): BenchmarkSuiteProbe {
  return input.benchmarkSuites[suite] ?? { exists: false, caseCount: 0 };
}

function claimedOf(input: AuditInput, suite: string): number | undefined {
  return input.readmeClaims.find((c) => c.suite === suite)?.claimed;
}

/** A complete suite on disk (matches its documented count) is "benchmarked". */
function suiteBenchmarked(input: AuditInput, suite: string): boolean {
  const probe = suiteProbe(input, suite);
  const claimed = claimedOf(input, suite);
  if (!probe.exists) return false;
  return claimed === undefined ? probe.caseCount > 0 : probe.caseCount >= claimed;
}

function suiteTested(input: AuditInput): boolean {
  return input.integrationTests["suite_conformance"] === true;
}

const CAPABILITY_SPECS: CapabilitySpec[] = [
  {
    id: "context_pipeline",
    description: "ContextPipeline wired into the runtime (AGENTS.md discovery, budget, compaction)",
    usesIntrospection: true,
    implemented: (i) => i.packages["context"] === true,
    wired: (i) => intro(i)?.features.context === true,
    snapshotAuthoritative: (i) => intro(i)?.features.context === true,
    integrationTested: (i) => i.integrationTests["core_loop_integration"] === true,
    benchmarkExercised: () => false,
    evidence: (i) => [
      dep("context_pipeline"),
      ...(intro(i)?.features.context === true
        ? [ev("runtime_dependency", "AgentRuntimeDeps.context", "context pipeline + budget + instruction discovery passed")]
        : []),
    ],
  },
  {
    id: "checkpoint_store",
    description: "Durable checkpoint store wired (crash resume)",
    usesIntrospection: true,
    implemented: (i) => i.packages["checkpoint"] === true,
    wired: (i) => intro(i)?.stores.checkpoint !== undefined,
    integrationTested: (i) => i.integrationTests["core_checkpoint"] === true,
    benchmarkExercised: () => false,
    evidence: (i) => [
      dep("checkpoint_store"),
      ...(intro(i)?.stores.checkpoint !== undefined
        ? [ev("store", `stores.checkpoint=${intro(i)?.stores.checkpoint}`)]
        : []),
    ],
  },
  {
    id: "artifact_store",
    description: "Artifact registry wired (tool output offload, provenance)",
    usesIntrospection: true,
    implemented: (i) => i.packages["core"] === true,
    wired: (i) => intro(i)?.stores.artifacts !== undefined,
    integrationTested: (i) => i.integrationTests["core_artifact"] === true,
    benchmarkExercised: () => false,
    evidence: (i) => [
      dep("artifact_store"),
      ...(intro(i)?.stores.artifacts !== undefined
        ? [ev("store", `stores.artifacts=${intro(i)?.stores.artifacts}`)]
        : []),
    ],
  },
  {
    id: "memory_store",
    description: "Memory store wired (SQLite/durable memory)",
    usesIntrospection: true,
    implemented: (i) => i.packages["memory"] === true,
    wired: (i) => intro(i)?.stores.memory !== undefined,
    integrationTested: (i) => i.integrationTests["memory_store"] === true,
    benchmarkExercised: () => false,
    evidence: (i) => [
      dep("memory_store"),
      ...(intro(i)?.stores.memory !== undefined
        ? [ev("store", `stores.memory=${intro(i)?.stores.memory}`)]
        : []),
    ],
  },
  {
    id: "memory_retrieval",
    description: "Pre-turn memory retrieval injects context blocks",
    usesIntrospection: true,
    implemented: (i) => i.packages["memory"] === true,
    wired: (i) => intro(i)?.features.memory === true,
    integrationTested: (i) => i.integrationTests["memory_retrieval"] === true,
    benchmarkExercised: () => false,
    evidence: (i) => [dep("memory_retrieval")],
  },
  {
    id: "learning",
    description: "Learning pipeline wired (reflection → candidate, no inline promotion)",
    usesIntrospection: true,
    implemented: (i) => i.packages["learning"] === true,
    wired: (i) => intro(i)?.features.learning === true,
    integrationTested: (i) => i.integrationTests["learning_sandbox"] === true,
    benchmarkExercised: () => false,
    evidence: (i) => [dep("learning")],
  },
  {
    id: "delegation",
    description: "Subagent delegation exposed to the model as a tool",
    usesIntrospection: true,
    implemented: (i) => i.packages["agents"] === true,
    wired: (i) =>
      intro(i)?.features.delegation === true &&
      (hasTool(i, "delegate") || hasTool(i, "delegate_explore") || hasTool(i, "delegate_worker")),
    snapshotAuthoritative: (i) =>
      intro(i)?.features.delegation === true &&
      (hasTool(i, "delegate") || hasTool(i, "delegate_explore") || hasTool(i, "delegate_worker")),
    integrationTested: (i) => i.integrationTests["agents_delegator"] === true,
    benchmarkExercised: () => false,
    evidence: (i) => [
      dep("delegation"),
      ...regs(i).filter((n) => n.startsWith("delegate")).map((n) => ev("registered_tool", n)),
    ],
  },
  {
    id: "scheduler",
    description: "Agent execution scheduler wired (queue, budgets)",
    usesIntrospection: true,
    implemented: (i) => i.packages["agents"] === true,
    wired: (i) => intro(i)?.features.scheduler === true,
    integrationTested: (i) => i.integrationTests["agents_scheduler"] === true,
    benchmarkExercised: () => false,
    evidence: (i) => [dep("scheduler")],
  },
  {
    id: "ask_user_durable",
    description: "AskUser store durable across restart (waiting_for_user suspend/resume)",
    usesIntrospection: true,
    implemented: (i) => i.packages["core"] === true,
    wired: (i) => intro(i)?.stores.askUser !== undefined,
    integrationTested: (i) => i.integrationTests["core_resume"] === true,
    benchmarkExercised: () => false,
    evidence: (i) => [
      dep("ask_user_durable"),
      ...(intro(i)?.stores.askUser !== undefined
        ? [ev("store", `stores.askUser=${intro(i)?.stores.askUser}`)]
        : []),
    ],
  },
  {
    id: "approval_durable",
    description: "Approval store durable across restart (not InMemory)",
    usesIntrospection: true,
    implemented: (i) => i.packages["security"] === true,
    wired: (i) => {
      const name = intro(i)?.stores.approval;
      return name !== undefined && name !== "InMemoryApprovalStore";
    },
    integrationTested: (i) => i.integrationTests["security_approval"] === true,
    benchmarkExercised: () => false,
    evidence: (i) => {
      const name = intro(i)?.stores.approval;
      return [
        dep("approval_durable"),
        ...(name !== undefined
          ? [ev("store", `stores.approval=${name}`, name === "InMemoryApprovalStore" ? "not durable across restart" : undefined)]
          : []),
      ];
    },
  },
  {
    id: "mcp_connected",
    description: "MCP servers connected and tools registered",
    usesIntrospection: true,
    implemented: (i) => i.packages["mcp"] === true,
    wired: (i) => intro(i)?.features.mcp === true,
    snapshotAuthoritative: (i) => intro(i)?.features.mcp === true,
    integrationTested: (i) => i.integrationTests["mcp_adapter"] === true,
    benchmarkExercised: () => false,
    evidence: (i) => [dep("mcp_connected")],
  },
  {
    id: "plugin_host",
    description: "Plugin host implemented (in-process, no process isolation); P18-3 default Champion OFF — same-process plugins load only under explicit trusted-local config (defaultChampion + allowedSources) and project-local plugins need workspace approval; isolated/production-wired stages not built yet",
    usesIntrospection: true,
    implemented: (i) => i.packages["plugins"] === true,
    wired: (i) => intro(i)?.features.plugins === true,
    snapshotAuthoritative: (i) => intro(i)?.features.plugins === true,
    integrationTested: (i) => i.integrationTests["plugins_host"] === true,
    benchmarkExercised: () => false,
    evidence: (i) => [dep("plugin_host")],
  },
  {
    id: "advanced_tools",
    description: "Advanced navigation tools registered (grep_search, repo_tree, symbol_search, repo_map, discover_commands, env_snapshot)",
    usesIntrospection: true,
    implemented: (i) => i.packages["tools"] === true,
    wired: (i) => allTools(i, ADVANCED_TOOL_NAMES),
    snapshotAuthoritative: (i) => allTools(i, ADVANCED_TOOL_NAMES),
    integrationTested: (i) => i.integrationTests["tools_navigation"] === true,
    benchmarkExercised: () => false,
    evidence: (i) => [
      dep("advanced_tools"),
      ...ADVANCED_TOOL_NAMES.map((name) =>
        ev("registered_tool", name, hasTool(i, name) ? undefined : "not registered in the default profile"),
      ),
    ],
  },
  {
    id: "usage_accounting",
    description: "Model usage reaches events/metrics (usage event → model.completed → metrics)",
    usesIntrospection: true,
    implemented: (i) => i.packages["observability"] === true,
    wired: (i) => intro(i)?.features.usageAccounting === true,
    integrationTested: (i) => i.integrationTests["observability_trace"] === true,
    benchmarkExercised: () => false,
    evidence: (i) => [
      dep("usage_accounting"),
      ...(intro(i)?.features.usageAccounting !== true
        ? // P38.2-11: the diagnostic must reflect CURRENT production wiring. The
          // runtime folds `usage` events into `model.completed.usage` (P0-9,
          // runtime.test.ts) and metrics read that snapshot — it no longer
          // drops the event or strips usage from model.completed.
          [ev("runtime_dependency", "packages/core/src/runtime/model-call-controller.ts", "usageAccounting not reported wired by this composition; note: the runtime folds usage events into model.completed (P0-9) so tokens/cost ARE observable from the event stream")]
        : []),
    ],
  },
  {
    id: "run_budget",
    description: "RunLimits enforced end-to-end (turns/tool calls/duration/retries/subagents/cost)",
    usesIntrospection: true,
    implemented: (i) => i.packages["contracts"] === true,
    wired: (i) => intro(i)?.features.runBudget === true,
    integrationTested: (i) => i.integrationTests["core_runtime"] === true,
    benchmarkExercised: () => false,
    evidence: (i) => [
      dep("run_budget"),
      ...(intro(i)?.features.runBudget !== true
        ? [ev("runtime_dependency", "agent.limits", "maxToolCalls/maxDurationMs enforced by the runtime; RunBudgetTracker (P0-10) tracks all limits, controls are wired for maxToolCalls/maxDurationMs")]
        : []),
    ],
  },
  {
    id: "regression_suite",
    description: "Regression benchmark suite present at the documented count (benchmarks/regression, README claims 30)",
    usesIntrospection: false,
    implemented: (i) => suiteProbe(i, "regression").exists,
    wired: (i) => suiteProbe(i, "regression").exists,
    integrationTested: (i) => suiteTested(i),
    benchmarkExercised: (i) => suiteBenchmarked(i, "regression"),
    evidence: (i) => [suiteEvidence(i, "regression")],
  },
  {
    id: "holdout_suite",
    description: "Holdout benchmark suite present at the documented count (benchmarks/holdout, README claims 30)",
    usesIntrospection: false,
    implemented: (i) => suiteProbe(i, "holdout").exists,
    wired: (i) => suiteProbe(i, "holdout").exists,
    integrationTested: (i) => suiteTested(i),
    benchmarkExercised: (i) => suiteBenchmarked(i, "holdout"),
    evidence: (i) => [suiteEvidence(i, "holdout")],
  },
  {
    id: "adversarial_suite",
    description: "Adversarial benchmark suite present at the documented count (benchmarks/adversarial, README claims 13)",
    usesIntrospection: false,
    implemented: (i) => suiteProbe(i, "adversarial").exists,
    wired: (i) => suiteProbe(i, "adversarial").exists,
    integrationTested: (i) => suiteTested(i),
    benchmarkExercised: (i) => suiteBenchmarked(i, "adversarial"),
    evidence: (i) => [suiteEvidence(i, "adversarial")],
  },
  {
    id: "stress_suite",
    description: "Stress benchmark suite present at the documented count (benchmarks/stress, README claims 11)",
    usesIntrospection: false,
    implemented: (i) => suiteProbe(i, "stress").exists,
    wired: (i) => suiteProbe(i, "stress").exists,
    integrationTested: (i) => suiteTested(i),
    benchmarkExercised: (i) => suiteBenchmarked(i, "stress"),
    evidence: (i) => [suiteEvidence(i, "stress")],
  },
  {
    id: "ci_linux",
    description: "Linux CI job exists (ubuntu-latest)",
    usesIntrospection: false,
    implemented: (i) => i.ciWorkflow.exists,
    wired: (i) => i.ciWorkflow.ubuntu,
    integrationTested: () => false,
    benchmarkExercised: () => false,
    evidence: (i) => [
      i.ciWorkflow.exists
        ? ev("ci_job", ".github/workflows/ci.yml", i.ciWorkflow.ubuntu ? "ubuntu-latest job" : "no ubuntu-latest job")
        : ev("ci_job", ".github/workflows/ci.yml", "workflow file missing"),
    ],
  },
  {
    id: "ci_windows",
    description: "Windows CI job exists (windows-latest)",
    usesIntrospection: false,
    implemented: (i) => i.ciWorkflow.exists,
    wired: (i) => i.ciWorkflow.windows,
    integrationTested: () => false,
    benchmarkExercised: () => false,
    evidence: (i) => [
      i.ciWorkflow.exists
        ? ev("ci_job", ".github/workflows/ci.yml", i.ciWorkflow.windows ? "windows-latest job" : "no windows-latest job")
        : ev("ci_job", ".github/workflows/ci.yml", "workflow file missing"),
    ],
  },
];

/** Record id → the package that implements the capability (evidence ref). */
const IMPLEMENTING_PACKAGE: Record<string, string> = {
  context_pipeline: "packages/context",
  checkpoint_store: "packages/checkpoint",
  artifact_store: "packages/core",
  memory_store: "packages/memory",
  memory_retrieval: "packages/memory",
  learning: "packages/learning",
  delegation: "packages/agents",
  scheduler: "packages/agents",
  ask_user_durable: "packages/core",
  approval_durable: "packages/security",
  mcp_connected: "packages/mcp",
  plugin_host: "packages/plugins",
  advanced_tools: "packages/tools",
  usage_accounting: "packages/observability",
  run_budget: "packages/contracts",
};

function dep(id: string): CapabilityEvidence {
  return ev("runtime_dependency", IMPLEMENTING_PACKAGE[id] ?? "packages", undefined);
}

function suiteEvidence(input: AuditInput, suite: string): CapabilityEvidence {
  const probe = suiteProbe(input, suite);
  const claimed = claimedOf(input, suite);
  return ev(
    "benchmark_case",
    `benchmarks/${suite}`,
    probe.exists
      ? `${probe.caseCount} case(s) on disk${claimed !== undefined ? ` (README claims ${claimed})` : ""}`
      : `directory missing${claimed !== undefined ? ` (README claims ${claimed})` : ""}`,
  );
}

function ev(kind: CapabilityEvidence["kind"], ref: string, note?: string): CapabilityEvidence {
  return note === undefined ? { kind, ref } : { kind, ref, note };
}

function toRecord(spec: CapabilitySpec, input: AuditInput, profile: CapabilityProfile): CapabilityRecord {
  const expectations = PROFILE_EXPECTATIONS[profile];
  const implemented = spec.implemented(input);
  const wired = spec.wired(input);
  // P20-2 + P36-8 + P37-9 + P38-11 (INV-P38-013): durabilityActual describes
  // the ACTUAL backing store regardless of profile requirements. Changing the
  // profile never rewrites actual store durability.
  const storeName = backingStoreName(spec.id, input.introspection);
  const durabilityActual: DurabilityLevel = storeDurabilityLevel(storeName);
  const requiresDurability = expectations.mustBeDurable.includes(spec.id);
  const durabilityRequired: DurabilityLevel = requiresDurability ? "durable" : "none";
  const DURABILITY_RANK: Record<DurabilityLevel, number> = { none: 0, memory: 1, process: 2, flush: 3, durable: 4 };
  const durabilitySatisfied =
    !requiresDurability ||
    (DURABILITY_RANK[durabilityActual] >= DURABILITY_RANK[durabilityRequired] &&
      input.introspection?.persistence?.degraded !== true);
  // P35-2: snapshot authority is a claim only when the step-snapshot
  // pipeline is actually composed (introspection.features.stepSnapshot) AND
  // the spec declares its surface as snapshot-bound (P23) AND the invariant
  // is cross-verified by the P34-7/P34-8 matrix coverage.
  const snapshotAuthoritative =
    spec.snapshotAuthoritative?.(input) === true && snapshotAuthorityProven(input);
  // P20-2: degradation — a profile expectation that the wiring does not meet.
  const reasons: string[] = [];
  if (expectations.requiresDurableHarness && input.introspection?.persistence?.mode !== "durable") {
    reasons.push("profile requires a durable harness but persistence is in-memory");
  } else if (
    expectations.requiresDurableHarness &&
    input.introspection?.persistence?.degraded === true &&
    (input.introspection?.persistence?.reasons ?? []).length > 0
  ) {
    reasons.push(`harness degraded: ${input.introspection!.persistence!.reasons.join("; ")}`);
  }
  if (expectations.mustBeWired.includes(spec.id) && !wired) {
    reasons.push(`profile ${profile} requires ${spec.id} wired but it is not`);
  }
  const record: CapabilityRecord = {
    id: spec.id,
    description: spec.description,
    implemented,
    productionWired: wired,
    snapshotAuthoritative,
    durabilityActual,
    durabilityRequired,
    durabilitySatisfied,
    // P36-7: declared = file/cases exist; executed = declared AND passing,
    // current-HEAD run evidence (INV-P36-007).
    testDeclared: spec.integrationTested(input),
    integrationTested: spec.integrationTested(input) && executionProven(input, "test_run", spec.id),
    benchmarkDeclared: spec.benchmarkExercised(input),
    benchmarkExercised: spec.benchmarkExercised(input) && executionProven(input, "benchmark_run", spec.id),
    securityMode: expectations.securityMode,
    evidence: spec.evidence(input),
  };
  if (reasons.length > 0) record.degradedReason = reasons.join("; ");
  return record;
}

/** P36-7/P37-7/P37-8: is there passing, correct-kind execution evidence for
 *  `key` at the audited HEAD? No evidence, failed evidence, stale-SHA
 *  evidence, or wrong-kind evidence all fail closed. Evidence keys are
 *  namespaced (capability:..., benchmark:..., gate:...) to avoid collisions
 *  between test-run and benchmark-run claims for the same capability. */
function executionProven(input: AuditInput, kind: ExecutionEvidence["kind"], key: string): boolean {
  const evidenceKey = kind === "benchmark_run" ? `benchmark:${key}` : `capability:${key}`;
  const evidence = input.executionEvidence?.[evidenceKey];
  return evidenceIsFresh(evidence, kind, input.gitSha);
}

/** P37-7 (INV-P37-008): strict freshness helper. A single shared condition
 *  means stale/missing/failed/malformed/wrong-kind evidence can never produce
 *  `evidenceFresh=PASS` via a `false === false` comparison. */
function evidenceIsFresh(
  evidence: ExecutionEvidence | undefined,
  expectedKind: ExecutionEvidence["kind"],
  headSha: string | undefined,
): boolean {
  return (
    evidence !== undefined &&
    evidence.passed === true &&
    // P37-8 (INV-P37-009): a benchmark run cannot satisfy a test-run claim
    // and vice versa.
    evidence.kind === expectedKind &&
    headSha !== undefined &&
    evidence.headSha === headSha
  );
}

/** P0-1 + P36-7: a capability is as mature as its weakest PROVEN link.
 *  "tested" requires both a declared test file AND passing current-HEAD run
 *  evidence; "benchmarked" requires both declared cases AND successful
 *  current-HEAD benchmark evidence. File existence alone is not tested. */
export function capabilityStatusOf(record: CapabilityRecord): CapabilityStatus {
  if (!record.implemented) return "missing";
  if (!record.productionWired) return "implemented";
  if (!record.testDeclared || !record.integrationTested) return "wired";
  if (!record.benchmarkDeclared || !record.benchmarkExercised) return "tested";
  return "benchmarked";
}

export function buildCapabilityMatrix(
  input: AuditInput,
  profile: CapabilityProfile = profileOf(input),
): CapabilityMatrix {
  return {
    generatedAt: input.generatedAt,
    ...(input.gitSha !== undefined ? { gitSha: input.gitSha } : {}),
    ...(profile !== undefined ? { profile } : {}),
    records: CAPABILITY_SPECS.map((spec) => toRecord(spec, input, profile)),
  };
}

/** P20-2 — the composition-aware view: one matrix PER profile, so a reader
 *  never mistakes "source exists" for "production in my configuration". */
export function buildCapabilityMatrixForProfiles(
  input: AuditInput,
): Record<CapabilityProfile, CapabilityMatrix> {
  const out = {} as Record<CapabilityProfile, CapabilityMatrix>;
  for (const profile of CAPABILITY_PROFILES) {
    out[profile] = buildCapabilityMatrix(input, profile);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Documentation truthfulness (plan.md P0-1: README claims vs on-disk reality)
// ---------------------------------------------------------------------------

export interface DocTruthfulnessRow {
  suite: string;
  claimed: number;
  actual: number;
  planned: boolean;
  truthful: boolean;
}

export interface AuditSummary {
  total: number;
  implemented: number;
  wired: number;
  tested: number;
  benchmarked: number;
  missing: number;
  docTruthfulness: DocTruthfulnessRow[];
  /** P36-8: split verdict — `audit: OK` is no longer a single label.
   *  Each axis is independently true/false so "docs truthful" can never be
   *  misread as "release ready". */
  verdict: AuditVerdict;
  /** Back-compat: docs claims truthful only (legacy single-label). */
  ok: boolean;
}

/** P36-8 — explicit audit verdict axes. */
export interface AuditVerdict {
  documentationClaimsOk: boolean;
  profileRequirementsOk: boolean;
  /** P38.2-6: evidence for ALL declared capabilities (test + benchmark). */
  evidenceFresh: boolean;
  /** P38.2-6 (INV-P38.2-006): evidence for the profile's REQUIRED
   *  capabilities only. Runtime release does not require paid benchmark
   *  evidence. */
  requiredEvidenceFresh: boolean;
  releaseReady?: boolean;
}

/**
 * P38.1-8 (INV-P38.1-011) — the strict audit exit decision.
 *
 * Under `--strict` the audit exits non-zero unless EVERY axis is green:
 * documentation claims, profile requirements, AND required-execution-evidence
 * freshness. The old code only looked at `profileRequirementsOk`, so stale /
 * missing evidence could slip through a strict gate. `summaryOk` is the
 * docs-only shorthand (documentationClaimsOk) used by the non-strict path.
 */
export function strictAuditExitCode(input: {
  strict: boolean;
  summaryOk: boolean;
  verdict: AuditVerdict;
}): number {
  const strictOk = input.strict
    ? input.verdict.documentationClaimsOk &&
      input.verdict.profileRequirementsOk &&
      // P38.2-6 (INV-P38.2-006): strict mode gates on REQUIRED evidence
      // freshness, not declared. Benchmark evidence is NOT required for
      // interactive/champion profiles that don't demand it.
      input.verdict.requiredEvidenceFresh
    : true;
  return input.summaryOk && strictOk ? 0 : 1;
}

export function auditSummary(matrix: CapabilityMatrix, input: AuditInput): AuditSummary {
  let implemented = 0;
  let wired = 0;
  let tested = 0;
  let benchmarked = 0;
  let missing = 0;
  for (const record of matrix.records) {
    switch (capabilityStatusOf(record)) {
      case "missing": missing += 1; break;
      case "implemented": implemented += 1; break;
      case "wired": wired += 1; break;
      case "tested": tested += 1; break;
      case "benchmarked": benchmarked += 1; break;
      default: break;
    }
  }
  const rows: DocTruthfulnessRow[] = input.readmeClaims.map((claim) => ({
    suite: claim.suite,
    claimed: claim.claimed,
    actual: suiteProbe(input, claim.suite).caseCount,
    planned: claim.planned,
    truthful: claim.planned || suiteProbe(input, claim.suite).caseCount >= claim.claimed,
  }));
  const documentationClaimsOk = rows.every((row) => row.truthful);
  // P36-8: profile requirements — every capability the profile says MUST be
  // durable is actually satisfied; every must-be-wired capability is wired.
  const profileRequirementsOk = matrix.records.every((record) => {
    const expectations = PROFILE_EXPECTATIONS[matrix.profile ?? "interactive-ephemeral"];
    if (expectations.mustBeWired.includes(record.id) && !record.productionWired) return false;
    if (expectations.mustBeDurable.includes(record.id) && !record.durabilitySatisfied) return false;
    return true;
  });
  // P36-8 + P37-7 + P38-10 (INV-P38-012): evidence freshness — every declared
  // test AND benchmark has current-HEAD passing evidence of the correct kind.
  // The old code compared `false === false` which made stale/missing evidence
  // look fresh; it also ignored benchmark evidence entirely.
  const testFresh = matrix.records.every(
    (record) =>
      !record.testDeclared ||
      evidenceIsFresh(input.executionEvidence?.[`capability:${record.id}`], "test_run", input.gitSha),
  );
  const benchmarkFresh = matrix.records.every(
    (record) =>
      !record.benchmarkDeclared ||
      evidenceIsFresh(input.executionEvidence?.[`benchmark:${record.id}`], "benchmark_run", input.gitSha),
  );
  const evidenceFresh = testFresh && benchmarkFresh;
  // P38.2-6 (INV-P38.2-006): required evidence freshness checks only the
  // profile's REQUIRED (mustBeWired) capabilities. Runtime release does not
  // require paid benchmark evidence — interactive profiles skip benchmark
  // freshness here.
  const profile = matrix.profile ?? "interactive-ephemeral";
  const expectations = PROFILE_EXPECTATIONS[profile];
  const requiredTestFresh = matrix.records.every(
    (record) =>
      !expectations.mustBeWired.includes(record.id) ||
      !record.testDeclared ||
      evidenceIsFresh(input.executionEvidence?.[`capability:${record.id}`], "test_run", input.gitSha),
  );
  const requiredBenchmarkFresh = matrix.records.every(
    (record) =>
      !expectations.mustBeWired.includes(record.id) ||
      !record.benchmarkDeclared ||
      evidenceIsFresh(input.executionEvidence?.[`benchmark:${record.id}`], "benchmark_run", input.gitSha),
  );
  const requiredEvidenceFresh = requiredTestFresh && requiredBenchmarkFresh;
  const verdict: AuditVerdict = {
    documentationClaimsOk,
    profileRequirementsOk,
    evidenceFresh,
    requiredEvidenceFresh,
  };
  return {
    total: matrix.records.length,
    implemented,
    wired,
    tested,
    benchmarked,
    missing,
    docTruthfulness: rows,
    verdict,
    ok: documentationClaimsOk,
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering (generated from the matrix — never hand-maintained)
// ---------------------------------------------------------------------------

export function renderMatrixMarkdown(matrix: CapabilityMatrix, summary: AuditSummary): string {
  const lines: string[] = [
    "# CAPABILITY MATRIX",
    "",
    // P38.2-11 (INV-P38.2-011): a repository snapshot is INFORMATIONAL, never
    // release evidence. Official release verification must use freshly
    // generated CI artifacts at the immutable github.sha.
    "> NOT RELEASE EVIDENCE — informational repository snapshot. Official release verification uses CI-generated artifacts at immutable `github.sha`.",
    "",
    `- generatedAt: ${new Date(matrix.generatedAt).toISOString()}`,
    ...(matrix.gitSha !== undefined ? [`- gitSha: ${matrix.gitSha}`] : []),
    "",
    "## Summary",
    "",
    `| status | count |`,
    `| --- | --- |`,
    `| total | ${summary.total} |`,
    `| implemented | ${summary.implemented} |`,
    `| wired | ${summary.wired} |`,
    `| tested | ${summary.tested} |`,
    `| benchmarked | ${summary.benchmarked} |`,
    `| missing | ${summary.missing} |`,
    "",
    "## Records",
    "",
    ...(matrix.profile !== undefined ? [`- profile: ${matrix.profile}`] : []),
    "",
    "## Records",
    "",
    "| id | status | implemented | productionWired | snapshotAuthoritative | durability(actual/req/sat) | securityMode | testDeclared | integrationTested | benchmarkDeclared | benchmarkExercised | degraded | evidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...matrix.records.map((record) => {
      const status = capabilityStatusOf(record);
      const evidence = record.evidence.map((e) => (e.note === undefined ? `${e.kind}:${e.ref}` : `${e.kind}:${e.ref} (${e.note})`)).join("; ");
      const dur = `${record.durabilityActual}/${record.durabilityRequired}/${record.durabilitySatisfied}`;
      return [
        `| ${record.id} | ${status} | ${record.implemented} | ${record.productionWired} | ${record.snapshotAuthoritative} | ${dur} | ${record.securityMode} | ${record.testDeclared} | ${record.integrationTested} | ${record.benchmarkDeclared} | ${record.benchmarkExercised} | ${record.degradedReason ?? "-"} | ${evidence} |`,
      ].join("");
    }),
    "",
    "## Documentation truthfulness (benchmarks/README.md claims vs on-disk suites)",
    "",
    "| suite | claimed | actual | planned | truthful |",
    "| --- | --- | --- | --- | --- |",
    ...summary.docTruthfulness.map(
      (row) => `| ${row.suite} | ${row.claimed} | ${row.actual} | ${row.planned} | ${row.truthful} |`,
    ),
    "",
    `audit verdict (P36-8): documentationClaims=${summary.verdict.documentationClaimsOk ? "PASS" : "FAIL"}; profileRequirements=${summary.verdict.profileRequirementsOk ? "PASS" : "FAIL"}; evidenceFresh=${summary.verdict.evidenceFresh ? "PASS" : "FAIL"}; requiredEvidenceFresh=${summary.verdict.requiredEvidenceFresh ? "PASS" : "FAIL"}`,
    "",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Filesystem probes (real evidence, injected root for tests)
// ---------------------------------------------------------------------------

export interface AuditProbeOptions {
  root?: string;
  now?: () => number;
  gitSha?: () => Promise<string | undefined>;
}

export async function probeWorkspace(opts: AuditProbeOptions = {}): Promise<AuditInput> {
  const root = resolve(opts.root ?? process.cwd());
  const now = opts.now ?? Date.now;
  const gitSha = opts.gitSha ?? detectGitSha;
  const sha = await gitSha();
  const integrationTests = await probeIntegrationTests(root);
  return {
    generatedAt: now(),
    ...(sha === undefined ? {} : { gitSha: sha }),
    packages: await probePackages(root),
    integrationTests,
    benchmarkSuites: await probeBenchmarkSuites(root),
    ciWorkflow: await probeCiWorkflow(root),
    readmeClaims: await probeReadmeClaims(root),
    // P36-7: ingest `.ci/evidence/**` produced by gates/CI. Without them
    // every capability's integrationTested/benchmarkExercised stays false —
    // file existence alone is never execution proof. P38.2-5/11: the probe
    // walks namespaced subdirectories and synthesizes capability test_run
    // evidence from a passing `test` gate + the reviewed manifest.
    executionEvidence: await probeExecutionEvidence(root, sha, integrationTests),
  };
}

/** P36-7 — read every `.ci/evidence` JSON file (recursively) into an
 *  execution-evidence map keyed by namespaced id (`gate:...`, `capability:...`,
 *  `benchmark:...`). Walks subdirectories (P38.2-5/10: evidence lives under
 *  gates/<os>/, capabilities/, benchmarks/). Malformed/missing files are
 *  skipped (fail closed to false).
 *
 *  P38.2-5/11 (INV-P38.2-005): capability evidence is NEVER inferred from a
 *  test filename. After reading all files, if a `test` GATE passed at the exact
 *  audited HEAD, the reviewed CAPABILITY_TEST_MANIFEST maps capabilities to
 *  probe files that were part of that lane — each mapped capability whose probe
 *  files exist on disk gets synthesized `capability:<id>` test_run evidence.
 *  A failed/missing test gate synthesizes nothing (fail closed). */
async function probeExecutionEvidence(
  root: string,
  headSha: string | undefined,
  integrationTests: Record<string, boolean>,
): Promise<Record<string, ExecutionEvidence>> {
  const dir = join(root, ".ci", "evidence");
  const out: Record<string, ExecutionEvidence> = {};

  const collect = async (d: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return; // missing dir — every capability stays fail-closed false
    }
    for (const entry of entries) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) {
        await collect(path);
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(await readFile(path, "utf8")) as ExecutionEvidence & {
          capability?: string;
          id?: string;
          gate?: string;
          suite?: string;
          kind?: string;
        };
        // P38.2-5: key by the EXPLICIT field, never the file name — a gate file
        // can never collide with a capability key and vice versa.
        const key =
          raw.capability !== undefined
            ? `capability:${raw.capability}`
            : raw.suite !== undefined
              ? `benchmark:${raw.suite}`
              : raw.id !== undefined
                ? raw.id
                : raw.gate !== undefined
                  ? `gate:${raw.gate}`
                  : undefined;
        if (key === undefined) continue;
        if (raw.capability !== undefined && raw.kind === "benchmark_run") {
          // benchmark evidence carried under a capability field — namespace by
          // benchmark to keep test/benchmark claims disjoint (INV-P38.2-005).
          out[`benchmark:${raw.capability}`] = {
            kind: "benchmark_run",
            headSha: raw.headSha,
            command: raw.command,
            passed: raw.passed === true,
            generatedAt: raw.generatedAt,
            ...(raw.artifactRef !== undefined ? { artifactRef: raw.artifactRef } : {}),
          };
          continue;
        }
        out[key] = {
          kind: raw.kind,
          headSha: raw.headSha,
          command: raw.command,
          passed: raw.passed === true,
          generatedAt: raw.generatedAt,
          ...(raw.artifactRef !== undefined ? { artifactRef: raw.artifactRef } : {}),
        };
      } catch {
        // P36-7: malformed evidence file — skip silently; executionProven
        // fails closed (returns false) for this capability.
        void 0; // P14-6: observable statement — comments alone are not observability
      }
    }
  };
  await collect(dir);

  // P38.2-5/11: synthesize capability test_run evidence from a PASSING test
  // gate at the exact audited HEAD + the reviewed manifest. A general `pnpm
  // test` result may prove many capability test files ran, but the mapping is
  // the reviewed CAPABILITY_TEST_MANIFEST — never a filename guess.
  const testGate = out["gate:test"];
  const testLanePassed =
    testGate !== undefined &&
    testGate.passed === true &&
    headSha !== undefined &&
    testGate.headSha === headSha;
  if (testLanePassed) {
    for (const [capabilityId, probeIds] of Object.entries(CAPABILITY_TEST_MANIFEST)) {
      const key = `capability:${capabilityId}`;
      if (out[key] !== undefined) continue; // explicit evidence wins
      const probesPresent = probeIds.every((probeId) => integrationTests[probeId] === true);
      if (!probesPresent) continue; // file missing → not part of the lane
      out[key] = {
        kind: "test_run",
        headSha,
        command: "pnpm test",
        passed: true,
        generatedAt: testGate.generatedAt,
        artifactRef: "gate:test",
      };
    }
  }

  return out;
}

const PACKAGE_PROBES = [
  "context",
  "checkpoint",
  "memory",
  "learning",
  "agents",
  "mcp",
  "plugins",
  "tools",
  "observability",
  "security",
  "contracts",
  "core",
  "session",
  "evaluation",
] as const;

/**
 * P38.2-5/11: reviewed manifest mapping capability → integration-test
 * probe id(s). Evidence generation uses this to derive test_run evidence
 * from a successful `pnpm test` gate (INV-P38.2-005/013). Each capability
 * listed here whose probe files exist on disk AND whose `test` gate passed
 * at the exact HEAD SHA receives synthesized `capability:<id>` test_run
 * evidence. This is the ONLY path that may turn a passed test lane into
 * capability evidence — never guessed by filename.
 */
const CAPABILITY_TEST_MANIFEST: Record<string, readonly string[]> = {
  context_pipeline: ["core_loop_integration"],
  checkpoint_store: ["core_checkpoint"],
  artifact_store: ["core_artifact"],
  memory_store: ["memory_store"],
  memory_retrieval: ["memory_retrieval"],
  learning: ["learning_sandbox"],
  delegation: ["agents_delegator"],
  scheduler: ["agents_scheduler"],
  ask_user_durable: ["core_resume"],
  approval_durable: ["security_approval"],
  mcp_connected: ["mcp_adapter"],
  plugin_host: ["plugins_host"],
  advanced_tools: ["tools_navigation"],
  usage_accounting: ["observability_trace"],
  run_budget: ["core_runtime"],
  regression_suite: ["suite_conformance"],
  holdout_suite: ["suite_conformance"],
  adversarial_suite: ["suite_conformance"],
  stress_suite: ["suite_conformance"],
};

const INTEGRATION_TEST_PROBES: Record<string, string[]> = {
  core_loop_integration: ["packages/core/src/runtime/loop-integration.test.ts", "packages/context/src/pipeline.test.ts"],
  core_checkpoint: ["packages/core/src/runtime/checkpoint.test.ts"],
  core_artifact: ["packages/core/src/runtime/artifact-store.test.ts"],
  memory_store: ["packages/memory/src/sqlite-memory-store.test.ts", "packages/memory/src/memory-store.test.ts"],
  memory_retrieval: ["packages/memory/src/retrieval.test.ts"],
  learning_sandbox: ["packages/learning/src/sandbox.test.ts", "packages/learning/src/promoter-v2.test.ts"],
  agents_delegator: ["packages/agents/src/delegator.test.ts", "packages/agents/src/parallel-delegator.test.ts"],
  agents_scheduler: ["packages/agents/src/scheduler.test.ts"],
  core_resume: ["packages/core/src/runtime/resume.test.ts"],
  security_approval: ["packages/security/src/approval.test.ts"],
  mcp_adapter: ["packages/mcp/src/mcp-tool-adapter.test.ts"],
  plugins_host: ["packages/plugins/src/plugin-host.test.ts"],
  tools_navigation: ["packages/tools/src/navigate.test.ts", "packages/tools/src/repo-map.test.ts", "packages/tools/src/env-snapshot.test.ts", "packages/tools/src/command-discovery.test.ts"],
  observability_trace: ["packages/observability/src/trace-exporter.test.ts"],
  core_runtime: ["packages/core/src/runtime/runtime.test.ts"],
  suite_conformance: ["packages/evaluation/src/benchmark-suite.test.ts"],
  // P35-2: invariant coverage required to claim snapshotAuthoritative —
  // P34-7 config-drift matrix (step immutability across config lifecycle)
  // and P34-8 security regression matrix (security invariants stay green).
  config_drift_matrix: ["packages/harness/src/config-drift-matrix.test.ts"],
  security_regression_matrix: ["packages/harness/src/security-regression-matrix.test.ts"],
};

async function probePackages(root: string): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  for (const name of PACKAGE_PROBES) {
    result[name] = await isDirectory(join(root, "packages", name));
  }
  return result;
}

async function probeIntegrationTests(root: string): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  for (const [id, relPaths] of Object.entries(INTEGRATION_TEST_PROBES)) {
    let found = false;
    for (const rel of relPaths) {
      if (await fileExists(join(root, rel))) {
        found = true;
        break;
      }
    }
    result[id] = found;
  }
  return result;
}

async function probeBenchmarkSuites(root: string): Promise<Record<string, BenchmarkSuiteProbe>> {
  const result: Record<string, BenchmarkSuiteProbe> = {};
  for (const suite of SUITE_NAMES) {
    const dir = join(root, "benchmarks", suite);
    if (!(await isDirectory(dir))) {
      result[suite] = { exists: false, caseCount: 0 };
      continue;
    }
    let caseCount = 0;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (await fileExists(join(dir, entry.name, "case.json")))) {
        caseCount += 1;
      }
    }
    result[suite] = { exists: true, caseCount };
  }
  return result;
}

async function probeCiWorkflow(root: string): Promise<CiWorkflowProbe> {
  const file = join(root, ".github", "workflows", "ci.yml");
  if (!(await fileExists(file))) return { exists: false, ubuntu: false, windows: false };
  const content = await readFile(file, "utf8");
  return {
    exists: true,
    ubuntu: content.includes("ubuntu-latest"),
    windows: content.includes("windows-latest"),
  };
}

const SUITE_CLAIM_RE = /###\s+(regression|holdout|adversarial|stress)\s*（\s*(\d+)\s*个\s*）([^\n]*)/g;

async function probeReadmeClaims(root: string): Promise<DocClaim[]> {
  const file = join(root, "benchmarks", "README.md");
  if (!(await fileExists(file))) return [];
  const content = await readFile(file, "utf8");
  const claims: DocClaim[] = [];
  for (const match of content.matchAll(SUITE_CLAIM_RE)) {
    const suite = match[1]!;
    const claimed = Number(match[2]);
    const tail = match[3] ?? "";
    claims.push({ suite, claimed, planned: tail.includes("规划") });
  }
  return claims;
}

async function detectGitSha(): Promise<string | undefined> {
  return new Promise((resolveSha) => {
    execFile("git", ["rev-parse", "HEAD"], { timeout: 5_000, windowsHide: true }, (err, stdout) => {
      resolveSha(err !== null ? undefined : String(stdout).trim() || undefined);
    });
  });
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// CLI command (`agent audit` / `agent audit --json`)
// ---------------------------------------------------------------------------

export async function auditCmd(rest: string[], deps: CommandDeps, options: { root?: string } = {}): Promise<CommandResult> {
  let json = false;
  let strict = false;
  let outDir: string | undefined = undefined;
  const root = options.root ?? process.cwd();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--out") {
      outDir = rest[i + 1] ?? process.cwd();
      i += 1;
    } else if (arg !== undefined && arg.startsWith("--out=")) {
      outDir = arg.slice("--out=".length);
    } else {
      return { exitCode: 1, lines: [`agent audit: unknown flag: ${arg ?? "(none)"}`, "", "usage: agent audit [--json] [--strict] [--out <dir>]"] };
    }
  }

  // P20-2: the audit reports per PROFILE — the JSON carries the full
  // composition-aware view plus the profile the host actually runs.
  const probe = await probeWorkspace({ root });
  const matrix = buildCapabilityMatrix({ ...probe, introspection: deps.introspection });
  const byProfile = buildCapabilityMatrixForProfiles({ ...probe, introspection: deps.introspection });
  const summary = auditSummary(matrix, probe);

  const jsonOut = {
    ...matrix,
    byProfile,
    verdict: summary.verdict,
    // P38.2-11 (INV-P38.2-011): the generated snapshot is informational only —
    // never release evidence. The CI artifact generated at the immutable
    // github.sha is the authoritative capability record.
    releaseEvidence: false,
    notice: "NOT RELEASE EVIDENCE — informational repository snapshot. Official release verification uses CI-generated artifacts at immutable github.sha.",
  };

  // E1-01: stdout-only contract. `--json` writes NO files unless an explicit
  // `--out <dir>` is given; this keeps `agent audit --json` side-effect free
  // so full test runs / CI never modify tracked CAPABILITY_MATRIX.* files.
  // The non-JSON default (no `--json`, no `--out`) keeps its legacy behavior:
  // it writes CAPABILITY_MATRIX.json + .md into the workspace root, which is
  // what `pnpm capability:audit` (`audit --strict`) and docs:verify rely on.
  let wroteArtifacts = false;
  if (outDir !== undefined || !json) {
    const targetDir = outDir ?? root;
    await mkdir(targetDir, { recursive: true });
    const jsonPath = join(targetDir, "CAPABILITY_MATRIX.json");
    const mdPath = join(targetDir, "CAPABILITY_MATRIX.md");
    await writeFile(jsonPath, `${JSON.stringify(jsonOut, null, 2)}\n`, "utf8");
    await writeFile(mdPath, renderMatrixMarkdown(matrix, summary), "utf8");
    wroteArtifacts = true;
  }

  // P36-8 + P38.1-8 (INV-P38.1-011): exit semantics —
  //   agent audit         → exit 0 on truthful docs (malformed evidence still 0
  //                         but evidenceFresh=false is reported; malformed
  //                         JSON is skipped silently — not fatal);
  //   agent audit --strict → exit non-zero when documentation claims, PROFILE
  //                          requirements, OR evidence freshness is unmet.
  const exitCode = strictAuditExitCode({ strict, summaryOk: summary.ok, verdict: summary.verdict });

  if (json) {
    return { exitCode, lines: [JSON.stringify(jsonOut, null, 2)] };
  }
  const lines: string[] = [
    `audit: ${summary.ok ? "OK" : "FAILED"} — ${summary.total} capabilities, ${summary.wired} wired, ${summary.implemented} implemented-only, ${summary.missing} missing`,
    `audit verdict: documentationClaims=${summary.verdict.documentationClaimsOk ? "PASS" : "FAIL"}; profileRequirements=${summary.verdict.profileRequirementsOk ? "PASS" : "FAIL"}; evidenceFresh=${summary.verdict.evidenceFresh ? "PASS" : "FAIL"}; requiredEvidenceFresh=${summary.verdict.requiredEvidenceFresh ? "PASS" : "FAIL"}`,
    ...summary.docTruthfulness.map(
      (row) => `docs ${row.suite}: claimed ${row.claimed}, on disk ${row.actual}${row.planned ? " (marked planned)" : ""} → ${row.truthful ? "truthful" : "UNTRUTHFUL"}`,
    ),
    ...(wroteArtifacts
      ? [`audit: wrote ${join(outDir ?? root, "CAPABILITY_MATRIX.json")}`, `audit: wrote ${join(outDir ?? root, "CAPABILITY_MATRIX.md")}`]
      : []),
  ];
  return { exitCode, lines };
}