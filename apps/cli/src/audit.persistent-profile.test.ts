import { describe, expect, it } from "vitest";
import type { HarnessIntrospection } from "@ar/harness";
import {
  auditSummary,
  buildCapabilityMatrix,
  capabilityStatusOf,
  type AuditInput,
} from "./audit.js";

/**
 * P0-1 persistent-profile wiring: the harness composition root under a
 * dataDir wires JSONL session/event stores, a durable checkpoint store and a
 * durable approval store. The audit must distinguish the durable stores from
 * the still in-memory ones (artifacts) and keep honest about everything else
 * that remains unwired. The harness profile stays "interactive" regardless of
 * dataDir — only the stores change.
 */

const PERSISTENT_INTROSPECTION: HarnessIntrospection = {
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
    session: "JSONLSessionStore",
    events: "JSONLEventStore",
    checkpoint: "DurableCheckpointStore",
    approval: "DurableApprovalStore",
    artifacts: "InMemoryArtifactStore",
  },
  features: {
    context: true,
    verifier: false,
    checkpoint: true,
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
    mode: "durable",
    degraded: false,
    reasons: [],
    stores: {
      approval: "DurableApprovalStore",
      checkpoint: "DurableCheckpointStore",
    },
  },
};

function persistentInput(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    generatedAt: 1_700_000_000_000,
    introspection: PERSISTENT_INTROSPECTION,
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
    benchmarkSuites: {
      regression: { exists: false, caseCount: 0 },
      holdout: { exists: false, caseCount: 0 },
      adversarial: { exists: true, caseCount: 13 },
      stress: { exists: true, caseCount: 11 },
    },
    ciWorkflow: { exists: true, ubuntu: true, windows: true },
    readmeClaims: [
      { suite: "adversarial", claimed: 13, planned: false },
      { suite: "stress", claimed: 11, planned: false },
    ],
    ...overrides,
  };
}

describe("audit persistent profile (P0-1)", () => {
  it("reports the durable stores by their real implementation names (profile stays interactive)", () => {
    const introspection = persistentInput().introspection!;
    expect(introspection.profile).toBe("interactive");
    expect(introspection.stores.session).toBe("JSONLSessionStore");
    expect(introspection.stores.events).toBe("JSONLEventStore");
    expect(introspection.stores.checkpoint).toBe("DurableCheckpointStore");
    expect(introspection.features.checkpoint).toBe(true);
  });

  it("approval is durable with a dataDir (DurableApprovalStore)", () => {
    const record = buildCapabilityMatrix(persistentInput()).records.find((r) => r.id === "approval_durable")!;
    expect(record.productionWired).toBe(true);
    expect(record.integrationTested).toBe(true);
    expect(capabilityStatusOf(record)).toBe("tested");
  });

  it("memory stays unwired (package exists, host never passed a store)", () => {
    const record = buildCapabilityMatrix(persistentInput()).records.find((r) => r.id === "memory_store")!;
    expect(record.implemented).toBe(true);
    expect(record.productionWired).toBe(false);
  });

  it("usage accounting and run budget are not wired in either profile", () => {
    const matrix = buildCapabilityMatrix(persistentInput());
    expect(matrix.records.find((r) => r.id === "usage_accounting")!.productionWired).toBe(false);
    expect(matrix.records.find((r) => r.id === "run_budget")!.productionWired).toBe(false);
  });

  it("docs with only truthful claims → audit OK", () => {
    const input = persistentInput();
    const matrix = buildCapabilityMatrix(input);
    const summary = auditSummary(matrix, input);
    expect(summary.ok).toBe(true);
    expect(summary.docTruthfulness.every((row) => row.truthful)).toBe(true);
  });

  it("every record carries at least one evidence item with a ref", () => {
    const matrix = buildCapabilityMatrix(persistentInput());
    for (const record of matrix.records) {
      expect(record.evidence.length).toBeGreaterThanOrEqual(1);
      for (const item of record.evidence) {
        expect(item.ref.length).toBeGreaterThan(0);
      }
    }
  });
});