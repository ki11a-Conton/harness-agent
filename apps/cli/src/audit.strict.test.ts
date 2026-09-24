import { describe, expect, it } from "vitest";
import type { HarnessIntrospection } from "@ar/harness";
import {
  auditSummary,
  buildCapabilityMatrix,
  strictAuditExitCode,
  type AuditInput,
  type AuditVerdict,
} from "./audit.js";

/**
 * P38.1-8 (INV-P38.1-011) — `audit --strict` MUST fail (exit 1) when required
 * execution evidence is stale or missing, even if docs and profile requirements
 * are cleanly met. The old strict gate only checked `profileRequirementsOk`,
 * so stale/missing evidence could sail through a strict gate.
 */

const INTROSPECTION: HarnessIntrospection = {
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
    runBudget: true,
    stepSnapshot: true,
  },
  persistence: {
    mode: "in-memory",
    degraded: false,
    reasons: [],
    stores: { approval: "InMemoryApprovalStore" },
  },
};

function freshInput(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    generatedAt: 1_700_000_000_000,
    introspection: INTROSPECTION,
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
      // Only context_pipeline is test-declared — we back it with fresh evidence.
      core_loop_integration: true,
    },
    // context_pipeline is test-declared; regression_suite is benchmark-declared.
    // P38.2-6: required (mustBeWired) capabilities also need fresh test evidence.
    executionEvidence: {
      "capability:context_pipeline": { kind: "test_run", headSha: "git-abc", command: "vitest", passed: true, generatedAt: "t" },
      "capability:advanced_tools": { kind: "test_run", headSha: "git-abc", command: "vitest", passed: true, generatedAt: "t" },
      "benchmark:regression_suite": { kind: "benchmark_run", headSha: "git-abc", command: "bench", passed: true, generatedAt: "t" },
    },
    gitSha: "git-abc",
    benchmarkSuites: {
      regression: { exists: true, caseCount: 30 },
      holdout: { exists: false, caseCount: 0 },
      adversarial: { exists: false, caseCount: 0 },
      stress: { exists: false, caseCount: 0 },
    },
    ciWorkflow: { exists: true, ubuntu: true, windows: true },
    readmeClaims: [
      { suite: "regression", claimed: 30, planned: false },
      { suite: "holdout", claimed: 30, planned: true },
    ],
    ...overrides,
  };
}

function exitStrict(input: AuditInput): number {
  const matrix = buildCapabilityMatrix(input);
  const summary = auditSummary(matrix, input);
  return strictAuditExitCode({ strict: true, summaryOk: summary.ok, verdict: summary.verdict });
}

describe("P38.1-8 strict audit exit decision (INV-P38.1-011)", () => {
  it("all green (docs + profile + evidence fresh) → exit 0", () => {
    expect(exitStrict(freshInput())).toBe(0);
  });

  it("stale test evidence → exit 1 under strict", () => {
    // docs PASS + profile PASS, but test evidence is stale (old headSha).
    const input = freshInput({
      executionEvidence: {
        "capability:context_pipeline": { kind: "test_run", headSha: "git-OLD", command: "vitest", passed: true, generatedAt: "t" },
        "benchmark:regression_suite": { kind: "benchmark_run", headSha: "git-abc", command: "bench", passed: true, generatedAt: "t" },
      },
      gitSha: "git-abc",
    });
    const matrix = buildCapabilityMatrix(input);
    const summary = auditSummary(matrix, input);
    expect(summary.verdict.documentationClaimsOk).toBe(true);
    expect(summary.verdict.profileRequirementsOk).toBe(true);
    expect(summary.verdict.evidenceFresh).toBe(false);
    expect(strictAuditExitCode({ strict: true, summaryOk: summary.ok, verdict: summary.verdict })).toBe(1);
  });

  it("missing benchmark evidence → exit 0 under interactive strict (P38.2-6)", () => {
    // docs PASS + profile PASS + required test evidence fresh; benchmark
    // evidence is NOT required for the interactive runtime profile — strict
    // runtime release passes without paid benchmark evidence.
    const input = freshInput({
      executionEvidence: {
        "capability:context_pipeline": { kind: "test_run", headSha: "git-abc", command: "vitest", passed: true, generatedAt: "t" },
        "capability:advanced_tools": { kind: "test_run", headSha: "git-abc", command: "vitest", passed: true, generatedAt: "t" },
      },
      gitSha: "git-abc",
    });
    const matrix = buildCapabilityMatrix(input);
    const summary = auditSummary(matrix, input);
    expect(summary.verdict.documentationClaimsOk).toBe(true);
    expect(summary.verdict.profileRequirementsOk).toBe(true);
    expect(summary.verdict.requiredEvidenceFresh).toBe(true);
    expect(strictAuditExitCode({ strict: true, summaryOk: summary.ok, verdict: summary.verdict })).toBe(0);
  });

  it("pure decision is a strict conjunction over required axes (P38.2-6)", () => {
    const base: AuditVerdict = { documentationClaimsOk: true, profileRequirementsOk: true, evidenceFresh: true, requiredEvidenceFresh: true };
    expect(strictAuditExitCode({ strict: true, summaryOk: true, verdict: base })).toBe(0);
    expect(strictAuditExitCode({ strict: true, summaryOk: true, verdict: { ...base, documentationClaimsOk: false } })).toBe(1);
    expect(strictAuditExitCode({ strict: true, summaryOk: true, verdict: { ...base, profileRequirementsOk: false } })).toBe(1);
    // declared-only freshness drop does NOT block strict runtime release.
    expect(strictAuditExitCode({ strict: true, summaryOk: true, verdict: { ...base, evidenceFresh: false } })).toBe(0);
    // required freshness drop DOES block strict release.
    expect(strictAuditExitCode({ strict: true, summaryOk: true, verdict: { ...base, requiredEvidenceFresh: false } })).toBe(1);
  });
});