// P3-1/P3-7/P3-8: delegation tools — read-only child delegation with a forced
// tool policy, bounded parallel batches, and structured semi-trusted synthesis.

import { describe, expect, it } from "vitest";
import type { DelegationResult, Delegator, ParallelDelegator } from "@ar/agents";
import { newSessionId } from "@ar/contracts";
import { createDelegationTools, renderDelegationResult } from "./delegation-tools.js";

const READONLY = ["read_file", "search_files", "grep_search", "repo_tree"] as const;

function resultOf(overrides: Partial<DelegationResult> = {}): DelegationResult {
  return {
    status: "success",
    summary: "the API is stable",
    childSessionId: newSessionId(),
    toolCalls: 1,
    durationMs: 5,
    evidence: [],
    artifacts: [],
    answer: "stable",
    findings: [{ claim: "the API is stable", evidenceRefs: ["ev-1"], confidence: "high" }],
    changedArtifacts: [],
    testsRun: [{ description: "pnpm typecheck", passed: true }],
    openQuestions: [],
    blockers: [],
    suggestedNextActions: [],
    budgetUsed: { toolCalls: 1, durationMs: 5 },
    verified: true,
    ...overrides,
  };
}

function execContext(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: newSessionId(),
    turnId: "turn-1",
    agentId: "agent-main",
    cwd: "/workspace",
    signal: new AbortController().signal,
    permissions: { rules: [] },
    sandboxPolicy: {},
    ...overrides,
  } as never;
}

describe("P3-8: renderDelegationResult (semi-trusted synthesis)", () => {
  it("renders a structured, verifiable completion block", () => {
    const out = renderDelegationResult(resultOf());
    expect(out).toContain("[Subagent completion]");
    expect(out).toContain("status: success");
    expect(out).toContain("verified: true");
    expect(out).toContain("- the API is stable (confidence high)");
    expect(out).toContain("evidence: ev-1");
    expect(out).toContain("- pnpm typecheck: passed");
  });

  it("never fabricates verification for unverified children", () => {
    const out = renderDelegationResult(resultOf({ verified: false }));
    expect(out).not.toContain("verified: true");
  });
});

describe("P3-1: delegate_explore", () => {
  it("delegates with a forced read-only tool policy and no write access", async () => {
    let delegated: unknown;
    const delegator = {
      delegate: async (req: unknown) => {
        delegated = req;
        return resultOf();
      },
    } as unknown as Delegator;
    const tools = createDelegationTools({
      delegator: () => delegator,
      parallelDelegator: () => ({} as ParallelDelegator),
      readonlyToolNames: READONLY,
    });
    const explore = tools.find((t) => t.name === "delegate_explore")!;

    const out = await explore.execute({ goal: "map the auth flow" }, execContext());
    expect(out.status).toBe("success");
    expect(delegated).toMatchObject({
      writable: false,
      toolPolicy: { allow: [...READONLY] },
    });
    expect(out.output).toContain("[Subagent completion]");
  });
});

describe("P3-7: delegate_batch", () => {
  it("runs a bounded batch through the parallel delegator", async () => {
    const calls: unknown[] = [];
    const parallel = {
      delegateAll: async (reqs: unknown[]) => {
        calls.push(...(reqs as unknown[]));
        return reqs.map(() => resultOf({ summary: "found" }));
      },
    } as unknown as ParallelDelegator;
    const tools = createDelegationTools({
      delegator: () => ({} as Delegator),
      parallelDelegator: () => parallel,
      readonlyToolNames: READONLY,
      maxBatchSize: 2,
    });
    const batch = tools.find((t) => t.name === "delegate_batch")!;

    const out = await batch.execute(
      {
        tasks: [
          { id: "a", goal: "find tests" },
          { id: "b", goal: "map modules" },
        ],
      },
      execContext(),
    );
    expect(out.status).toBe("success");
    expect(calls).toHaveLength(2);
    expect(out.output).toContain("--- task a ---");
    expect(out.output).toContain("--- task b ---");
  });

  it("rejects batches over the cap", async () => {
    const tools = createDelegationTools({
      delegator: () => ({} as Delegator),
      parallelDelegator: () => ({} as ParallelDelegator),
      readonlyToolNames: READONLY,
      maxBatchSize: 1,
    });
    const batch = tools.find((t) => t.name === "delegate_batch")!;
    const out = await batch.execute(
      { tasks: [{ id: "a", goal: "x" }, { id: "b", goal: "y" }] },
      execContext(),
    );
    expect(out.status).toBe("failed");
  });
});

describe("P3-6: delegate_worker", () => {
  it("is exposed only when a worker agent + workspace manager are wired", () => {
    const tools = createDelegationTools({
      delegator: () => ({} as Delegator),
      parallelDelegator: () => ({} as ParallelDelegator),
      readonlyToolNames: READONLY,
    });
    expect(tools.find((t) => t.name === "delegate_worker")).toBeUndefined();
  });

  it("delegates writable, applies the patch, and reports the merge", async () => {
    let delegated: unknown;
    const appliedCalls: unknown[] = [];
    const delegator = {
      delegate: async (req: unknown) => {
        delegated = req;
        return resultOf({
          workspacePatch: {
            childSessionId: newSessionId(),
            entries: [{ path: "out/impl.ts", kind: "added" as const, content: "export const impl = 1;\n" }],
          },
        });
      },
    } as unknown as Delegator;
    const manager = {
      apply: async (root: string, patch: unknown) => {
        appliedCalls.push({ root, patch });
        return { applied: ["out/impl.ts"], conflicts: [], skipped: [] };
      },
    };
    const tools = createDelegationTools({
      delegator: () => delegator,
      parallelDelegator: () => ({} as ParallelDelegator),
      readonlyToolNames: READONLY,
      workerAgentId: () => "agent-worker-w",
      workspaceManager: () => manager as never,
    });
    const worker = tools.find((t) => t.name === "delegate_worker")!;
    expect(worker).toBeDefined();

    const out = await worker.execute({ goal: "implement the parser" }, execContext());
    expect(out.status).toBe("success");
    expect(delegated).toMatchObject({ writable: true, agentId: "agent-worker-w" });
    expect(appliedCalls).toHaveLength(1);
    expect(out.output).toContain("[workspace merge]");
    expect(out.output).toContain("applied: out/impl.ts");
  });
});
