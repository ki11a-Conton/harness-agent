import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
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
  integrationTested: boolean;
  benchmarkExercised: boolean;
  evidence: CapabilityEvidence[];
}

export interface CapabilityMatrix {
  generatedAt: number;
  gitSha?: string;
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
    integrationTested: (i) => i.integrationTests["mcp_adapter"] === true,
    benchmarkExercised: () => false,
    evidence: (i) => [dep("mcp_connected")],
  },
  {
    id: "plugin_host",
    description: "Plugin host wired (registry, isolation, tool contributions)",
    usesIntrospection: true,
    implemented: (i) => i.packages["plugins"] === true,
    wired: (i) => intro(i)?.features.plugins === true,
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
        ? [ev("runtime_dependency", "packages/core/src/runtime/model-call-controller.ts", "usage event dropped (case \"usage\": break); model.completed carries no usage — metrics cannot see tokens/cost")]
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

function toRecord(spec: CapabilitySpec, input: AuditInput): CapabilityRecord {
  return {
    id: spec.id,
    description: spec.description,
    implemented: spec.implemented(input),
    productionWired: spec.wired(input),
    integrationTested: spec.integrationTested(input),
    benchmarkExercised: spec.benchmarkExercised(input),
    evidence: spec.evidence(input),
  };
}

/** P0-1: a capability is as mature as its weakest proven link. */
export function capabilityStatusOf(record: CapabilityRecord): CapabilityStatus {
  if (!record.implemented) return "missing";
  if (!record.productionWired) return "implemented";
  if (!record.integrationTested) return "wired";
  if (!record.benchmarkExercised) return "tested";
  return "benchmarked";
}

export function buildCapabilityMatrix(input: AuditInput): CapabilityMatrix {
  return {
    generatedAt: input.generatedAt,
    ...(input.gitSha !== undefined ? { gitSha: input.gitSha } : {}),
    records: CAPABILITY_SPECS.map((spec) => toRecord(spec, input)),
  };
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
  /** False when a README claim contradicts the on-disk benchmark suites. */
  ok: boolean;
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
  return {
    total: matrix.records.length,
    implemented,
    wired,
    tested,
    benchmarked,
    missing,
    docTruthfulness: rows,
    ok: rows.every((row) => row.truthful),
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering (generated from the matrix — never hand-maintained)
// ---------------------------------------------------------------------------

export function renderMatrixMarkdown(matrix: CapabilityMatrix, summary: AuditSummary): string {
  const lines: string[] = [
    "# CAPABILITY MATRIX",
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
    "| id | status | implemented | productionWired | integrationTested | benchmarkExercised | evidence |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...matrix.records.map((record) => {
      const status = capabilityStatusOf(record);
      const evidence = record.evidence.map((e) => (e.note === undefined ? `${e.kind}:${e.ref}` : `${e.kind}:${e.ref} (${e.note})`)).join("; ");
      return [
        `| ${record.id} | ${status} | ${record.implemented} | ${record.productionWired} | ${record.integrationTested} | ${record.benchmarkExercised} | ${evidence} |`,
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
    `audit: ${summary.ok ? "OK" : "FAILED (a README claim contradicts the on-disk benchmark suites)"}`,
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
  return {
    generatedAt: now(),
    ...(await gitSha().then((sha) => (sha === undefined ? {} : { gitSha: sha }))),
    packages: await probePackages(root),
    integrationTests: await probeIntegrationTests(root),
    benchmarkSuites: await probeBenchmarkSuites(root),
    ciWorkflow: await probeCiWorkflow(root),
    readmeClaims: await probeReadmeClaims(root),
  };
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

export async function auditCmd(rest: string[], deps: CommandDeps): Promise<CommandResult> {
  let json = false;
  let outDir = process.cwd();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--out") {
      outDir = rest[i + 1] ?? process.cwd();
      i += 1;
    } else if (arg !== undefined && arg.startsWith("--out=")) {
      outDir = arg.slice("--out=".length);
    } else {
      return { exitCode: 1, lines: [`agent audit: unknown flag: ${arg ?? "(none)"}`, "", "usage: agent audit [--json] [--out <dir>]"] };
    }
  }

  const probe = await probeWorkspace({ root: process.cwd() });
  const matrix = buildCapabilityMatrix({ ...probe, introspection: deps.introspection });
  const summary = auditSummary(matrix, probe);

  await mkdir(outDir, { recursive: true });
  const jsonPath = join(outDir, "CAPABILITY_MATRIX.json");
  const mdPath = join(outDir, "CAPABILITY_MATRIX.md");
  await writeFile(jsonPath, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
  await writeFile(mdPath, renderMatrixMarkdown(matrix, summary), "utf8");

  if (json) {
    return { exitCode: summary.ok ? 0 : 1, lines: [JSON.stringify(matrix, null, 2)] };
  }
  const lines: string[] = [
    `audit: ${summary.ok ? "OK" : "FAILED"} — ${summary.total} capabilities, ${summary.wired} wired, ${summary.implemented} implemented-only, ${summary.missing} missing`,
    ...summary.docTruthfulness.map(
      (row) => `docs ${row.suite}: claimed ${row.claimed}, on disk ${row.actual}${row.planned ? " (marked planned)" : ""} → ${row.truthful ? "truthful" : "UNTRUTHFUL"}`,
    ),
    `audit: wrote ${jsonPath}`,
    `audit: wrote ${mdPath}`,
  ];
  return { exitCode: summary.ok ? 0 : 1, lines };
}