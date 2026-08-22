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
    },
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
    expect(record.integrationTested).toBe(true);
    expect(record.benchmarkExercised).toBe(true);
    expect(capabilityStatusOf(record)).toBe("benchmarked");
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
    expect(summary.benchmarked).toBeGreaterThanOrEqual(2);
    expect(summary.missing).toBeGreaterThanOrEqual(2);
    expect(summary.wired).toBeGreaterThanOrEqual(1);
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
    expect(md).toContain("| adversarial_suite | benchmarked |");
    expect(md).toContain("| regression | 30 | 0 | false | false |");
    expect(md).toContain("audit: FAILED");
  });
});