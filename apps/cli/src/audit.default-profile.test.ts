import { describe, expect, it } from "vitest";
import type { HarnessIntrospection } from "@ar/harness";
import {
  auditSummary,
  buildCapabilityMatrix,
  capabilityStatusOf,
  renderMatrixMarkdown,
  type AuditInput,
} from "./audit.js";

/**
 * P0-1 default (interactive, in-memory) profile: the harness composition root
 * wired the 11-tool production registry, ContextPipeline + budget, skills and
 * artifact stores, and memory-backed stores; checkpoint, memory, durable
 * approval and the usage accounting chain are NOT wired (no dataDir). The
 * audit must report exactly that, never what docs claim.
 */

const DEFAULT_INTROSPECTION: HarnessIntrospection = {
  profile: "interactive",
  registeredTools: [
    "read_file",
    "write_file",
    "edit_file",
    "search_files",
    "grep_search",
    "repo_tree",
    "symbol_search",
    "repo_map",
    "discover_commands",
    "env_snapshot",
    "exec",
    "update_plan",
  ],
  stores: {
    session: "MemSessionStore",
    events: "MemEventStore",
    approval: "InMemoryApprovalStore",
    artifacts: "InMemoryArtifactStore",
  },
  features: {
    context: true,
    verifier: false,
    checkpoint: false,
    artifacts: true,
    memory: false,
    learning: false,
    delegation: false,
    scheduler: false,
    mcp: false,
    plugins: false,
    skills: true,
    usageAccounting: false,
    runBudget: false,
    stepSnapshot: true,
  },
  persistence: {
    mode: "in-memory",
    degraded: false,
    reasons: [],
    stores: { approval: "InMemoryApprovalStore" },
  },
};

function defaultInput(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    generatedAt: 1_700_000_000_000,
    introspection: DEFAULT_INTROSPECTION,
    packages: {
      context: true,
      checkpoint: true,
      memory: true,
      learning: true,
      agents: true,
      mcp: true,
      plugins: true,
      tools: true,
      observability: true,
      security: true,
      contracts: true,
      core: true,
      session: true,
      evaluation: true,
    },
    integrationTests: {
      core_loop_integration: true,
      core_checkpoint: true,
      core_artifact: true,
      memory_store: true,
      memory_retrieval: true,
      learning_sandbox: true,
      agents_delegator: true,
      agents_scheduler: true,
      core_resume: true,
      security_approval: true,
      mcp_adapter: true,
      plugins_host: true,
      tools_navigation: true,
      observability_trace: true,
      core_runtime: true,
      suite_conformance: true,
      config_drift_matrix: true,
      security_regression_matrix: true,
    },
    // P36-7 + P37-8: fixtures declare tests present AND passing at the
    // fixture HEAD. Evidence keys are namespaced (capability:..., benchmark:...)
    // so test-run and benchmark-run claims for the same capability never
    // collide.
    executionEvidence: {
      "capability:context_pipeline": { kind: "test_run", headSha: "git-abc", command: "vitest", passed: true, generatedAt: "t" },
      "capability:advanced_tools": { kind: "test_run", headSha: "git-abc", command: "vitest", passed: true, generatedAt: "t" },
      "capability:artifact_store": { kind: "test_run", headSha: "git-abc", command: "vitest", passed: true, generatedAt: "t" },
      "benchmark:regression_suite": { kind: "benchmark_run", headSha: "git-abc", command: "bench", passed: true, generatedAt: "t" },
      "benchmark:holdout_suite": { kind: "benchmark_run", headSha: "git-abc", command: "bench", passed: true, generatedAt: "t" },
      "benchmark:adversarial_suite": { kind: "benchmark_run", headSha: "git-abc", command: "bench", passed: true, generatedAt: "t" },
      "benchmark:stress_suite": { kind: "benchmark_run", headSha: "git-abc", command: "bench", passed: true, generatedAt: "t" },
    },
    gitSha: "git-abc",
    benchmarkSuites: {
      regression: { exists: false, caseCount: 0 },
      holdout: { exists: false, caseCount: 0 },
      adversarial: { exists: true, caseCount: 13 },
      stress: { exists: true, caseCount: 11 },
    },
    ciWorkflow: { exists: true, ubuntu: true, windows: true },
    readmeClaims: [
      { suite: "regression", claimed: 30, planned: false },
      { suite: "holdout", claimed: 30, planned: true },
      { suite: "adversarial", claimed: 13, planned: false },
      { suite: "stress", claimed: 11, planned: false },
    ],
    ...overrides,
  };
}

describe("audit default (interactive) profile (P0-1)", () => {
  it("memory store: implemented but NOT production-wired (no host wiring)", () => {
    const matrix = buildCapabilityMatrix(defaultInput());
    const record = matrix.records.find((r) => r.id === "memory_store")!;
    expect(record.implemented).toBe(true);
    expect(record.productionWired).toBe(false);
    expect(capabilityStatusOf(record)).toBe("implemented");
    expect(record.evidence.some((e) => e.ref === "packages/memory")).toBe(true);
  });

  it("context pipeline: wired into the runtime (ContextPipeline + budget)", () => {
    const record = buildCapabilityMatrix(defaultInput()).records.find((r) => r.id === "context_pipeline")!;
    expect(record.implemented).toBe(true);
    expect(record.productionWired).toBe(true);
    expect(record.integrationTested).toBe(true);
    expect(capabilityStatusOf(record)).toBe("tested");
  });

  it("advanced tools: all six registered in the default profile", () => {
    const record = buildCapabilityMatrix(defaultInput()).records.find((r) => r.id === "advanced_tools")!;
    expect(record.implemented).toBe(true);
    expect(record.productionWired).toBe(true);
    expect(record.integrationTested).toBe(true);
    expect(capabilityStatusOf(record)).toBe("tested");
    expect(record.evidence.some((e) => e.kind === "registered_tool")).toBe(true);
  });

  it("approval durability: InMemoryApprovalStore is NOT durable", () => {
    const record = buildCapabilityMatrix(defaultInput()).records.find((r) => r.id === "approval_durable")!;
    expect(record.productionWired).toBe(false);
    expect(record.evidence.some((e) => e.kind === "store" && e.note === "not durable across restart")).toBe(true);
  });

  it("usage accounting: runtime drops the usage event, so NOT wired", () => {
    const record = buildCapabilityMatrix(defaultInput()).records.find((r) => r.id === "usage_accounting")!;
    expect(record.implemented).toBe(true);
    expect(record.productionWired).toBe(false);
    expect(capabilityStatusOf(record)).toBe("implemented");
    expect(record.evidence.some((e) => e.ref === "packages/core/src/runtime/model-call-controller.ts")).toBe(true);
  });

  it("regression suite: README claims 30 but no directory on disk → missing, audit FAILED", () => {
    const matrix = buildCapabilityMatrix(defaultInput());
    const record = matrix.records.find((r) => r.id === "regression_suite")!;
    expect(record.implemented).toBe(false);
    expect(capabilityStatusOf(record)).toBe("missing");
    const summary = auditSummary(matrix, defaultInput());
    expect(summary.ok).toBe(false);
    const regression = summary.docTruthfulness.find((row) => row.suite === "regression")!;
    expect(regression).toEqual({ suite: "regression", claimed: 30, actual: 0, planned: false, truthful: false });
  });

  it("holdout suite: README marks it planned, so the claim is truthful despite no directory", () => {
    const matrix = buildCapabilityMatrix(defaultInput());
    const summary = auditSummary(matrix, defaultInput());
    const holdout = summary.docTruthfulness.find((row) => row.suite === "holdout")!;
    expect(holdout.truthful).toBe(true);
    const record = matrix.records.find((r) => r.id === "holdout_suite")!;
    expect(capabilityStatusOf(record)).toBe("missing");
  });

  it("adversarial suite: 13 cases on disk match the documented 13 → benchmarked", () => {
    const record = buildCapabilityMatrix(defaultInput()).records.find((r) => r.id === "adversarial_suite")!;
    expect(record.implemented).toBe(true);
    expect(record.productionWired).toBe(true);
    // P37-8: the suite has benchmark_run evidence but not test_run, so
    // integrationTested is false — the conformance test needs its own
    // test_run evidence. benchmarkExercised remains true.
    expect(record.integrationTested).toBe(false);
    expect(record.benchmarkExercised).toBe(true);
    expect(record.benchmarkDeclared).toBe(true);
    expect(capabilityStatusOf(record)).toBe("wired");
  });

  it("CI: linux and windows jobs both wired (P10-6 promotion gate)", () => {
    const matrix = buildCapabilityMatrix(defaultInput());
    expect(capabilityStatusOf(matrix.records.find((r) => r.id === "ci_linux")!)).toBe("wired");
    expect(capabilityStatusOf(matrix.records.find((r) => r.id === "ci_windows")!)).toBe("wired");
  });

  it("summary counts the statuses across all records", () => {
    const matrix = buildCapabilityMatrix(defaultInput());
    const summary = auditSummary(matrix, defaultInput());
    expect(summary.total).toBe(21);
    expect(summary.benchmarked).toBe(0);
    expect(summary.wired).toBeGreaterThanOrEqual(4);
  });

  it("matrix round-trips through JSON with stable record count", () => {
    const matrix = buildCapabilityMatrix(defaultInput());
    const parsed = JSON.parse(JSON.stringify(matrix)) as typeof matrix;
    expect(parsed.records).toHaveLength(21);
    expect(parsed.generatedAt).toBe(1_700_000_000_000);
  });

  it("markdown rendering carries statuses, truthfulness and the FAILED verdict", () => {
    const input = defaultInput();
    const matrix = buildCapabilityMatrix(input);
    const md = renderMatrixMarkdown(matrix, auditSummary(matrix, input));
    expect(md).toContain("# CAPABILITY MATRIX");
    expect(md).toContain("| regression_suite | missing |");
    expect(md).toContain("| adversarial_suite | wired |");
    expect(md).toContain("| regression | 30 | 0 | false | false |");
    expect(md).toContain("audit verdict (P36-8): documentationClaims=FAIL");
  });

  it("P35-2: snapshot-bound capabilities are authoritative; plain ones are not", () => {
    const matrix = buildCapabilityMatrix(defaultInput());
    const byId = new Map(matrix.records.map((r) => [r.id, r]));
    // context + tool surface flow through the frozen StepToolRouter (P23)
    expect(byId.get("context_pipeline")!.snapshotAuthoritative).toBe(true);
    expect(byId.get("advanced_tools")!.snapshotAuthoritative).toBe(true);
    // not wired in this profile → not authoritative
    expect(byId.get("mcp_connected")!.snapshotAuthoritative).toBe(false);
    expect(byId.get("delegation")!.snapshotAuthoritative).toBe(false);
    expect(byId.get("plugin_host")!.snapshotAuthoritative).toBe(false);
    // durability/observability/lifecycle capabilities are not snapshot-bound
    expect(byId.get("checkpoint_store")!.snapshotAuthoritative).toBe(false);
    expect(byId.get("usage_accounting")!.snapshotAuthoritative).toBe(false);
    expect(byId.get("ci_linux")!.snapshotAuthoritative).toBe(false);
  });

  it("P35-2: never claims snapshot authority without the composed step pipeline", () => {
    const input = defaultInput();
    const noStep = {
      ...input,
      introspection: {
        ...DEFAULT_INTROSPECTION,
        features: { ...DEFAULT_INTROSPECTION.features, stepSnapshot: false },
      },
    };
    const matrix = buildCapabilityMatrix(noStep);
    const context = matrix.records.find((r) => r.id === "context_pipeline")!;
    expect(context.productionWired).toBe(true);
    expect(context.snapshotAuthoritative).toBe(false);
  });

  it("P35-2: markdown matrix renders the snapshotAuthoritative column", () => {
    const input = defaultInput();
    const matrix = buildCapabilityMatrix(input);
    const md = renderMatrixMarkdown(matrix, auditSummary(matrix, input));
    expect(md).toContain("| id | status | implemented | productionWired | snapshotAuthoritative |");
    expect(md).toContain("| context_pipeline | tested | true | true | true |");
  });

  // ---------------------------------------------------------------------------
  // P36-7 — execution-backed evidence (INV-P36-007)
  // ---------------------------------------------------------------------------

  it("P36-7: test file exists but no run evidence → NOT integrationTested", () => {
    const input = defaultInput({ executionEvidence: {} });
    const record = buildCapabilityMatrix(input).records.find((r) => r.id === "context_pipeline")!;
    expect(record.testDeclared).toBe(true);
    expect(record.integrationTested).toBe(false);
    expect(capabilityStatusOf(record)).toBe("wired");
  });

  it("P36-7: failed test run → NOT integrationTested", () => {
    const input = defaultInput({
      executionEvidence: {
        context_pipeline: { kind: "test_run", headSha: "git-abc", command: "vitest", passed: false, generatedAt: "t" },
      },
    });
    const record = buildCapabilityMatrix(input).records.find((r) => r.id === "context_pipeline")!;
    expect(record.testDeclared).toBe(true);
    expect(record.integrationTested).toBe(false);
  });

  it("P36-7: passing evidence at STALE SHA → NOT integrationTested", () => {
    const input = defaultInput({
      executionEvidence: {
        context_pipeline: { kind: "test_run", headSha: "old-sha", command: "vitest", passed: true, generatedAt: "t" },
      },
    });
    const record = buildCapabilityMatrix(input).records.find((r) => r.id === "context_pipeline")!;
    expect(record.integrationTested).toBe(false);
  });

  it("P36-7: passing evidence at current SHA → integrationTested", () => {
    const input = defaultInput();
    const record = buildCapabilityMatrix(input).records.find((r) => r.id === "context_pipeline")!;
    expect(record.integrationTested).toBe(true);
    expect(capabilityStatusOf(record)).toBe("tested");
  });

  it("P36-7: benchmark cases exist without run → NOT benchmarkExercised", () => {
    const input = defaultInput({ executionEvidence: {} });
    const record = buildCapabilityMatrix(input).records.find((r) => r.id === "adversarial_suite")!;
    expect(record.benchmarkDeclared).toBe(true);
    expect(record.benchmarkExercised).toBe(false);
  });

  it("P36-7: markdown matrix renders testDeclared vs integrationTested separately", () => {
    const input = defaultInput({ executionEvidence: {} });
    const matrix = buildCapabilityMatrix(input);
    const md = renderMatrixMarkdown(matrix, auditSummary(matrix, input));
    expect(md).toContain("| durability(actual/req/sat) |");
    expect(md).toContain("| context_pipeline | wired | true | true | true | none/none/true | sandboxed | true | false | false | false |");
  });
});