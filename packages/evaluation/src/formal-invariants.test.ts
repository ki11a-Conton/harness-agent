import { describe, expect, it } from "vitest";
import {
  allPass,
  checkInvariants,
  invChildCapabilityIsConferredBound,
  invChildContextIsolation,
  invDelegationBounded,
  invHoldoutJudgeSecrecy,
  invMemoryUnsafeContentCannotPersist,
  invNetworkDeniedCannotExecute,
  invReplayNoDuplicateUnsafeSideEffect,
  invTerminalStateCannotTransition,
  invUntrustedContextIsDataOnly,
  invUnsafeToolNeverAutoRetried,
  invVerificationCannotBeFabricated,
  violated,
} from "./formal-invariants.js";

describe("P3-17 INV-001 terminal state cannot transition", () => {
  it("holds while a run is still progressing (no terminal state yet)", () => {
    const r = invTerminalStateCannotTransition([
      { at: "t0", state: "running" },
      { at: "t1", state: "planning" },
      { at: "t2", state: "running" },
    ]);
    expect(r.ok).toBe(true);
  });

  it("holds when a terminal state is reached and then stays unchanged", () => {
    const r = invTerminalStateCannotTransition([
      { at: "t0", state: "running" },
      { at: "t1", state: "verified_complete" },
      { at: "t2", state: "verified_complete" },
    ]);
    expect(r.ok).toBe(true);
  });

  it("fails when a terminal state transitions to another state", () => {
    const r = invTerminalStateCannotTransition([
      { at: "t0", state: "running" },
      { at: "t1", state: "verified_complete" },
      { at: "t2", state: "running" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.at).toBe("t2");
    expect(r.violations[0]!.detail).toContain("verified_complete");
  });

  it("fails when one terminal state changes to a different terminal state", () => {
    const r = invTerminalStateCannotTransition([
      { at: "t0", state: "failed" },
      { at: "t1", state: "cancelled" },
    ]);
    expect(r.ok).toBe(false);
  });
});

describe("P3-17 INV-002 child cannot gain parent-unavailable capability", () => {
  it("holds when the child only relies on conferred tools and paths", () => {
    const r = invChildCapabilityIsConferredBound({
      conferred: { tool: ["read", "write", "run"], filesystem: ["/workspace/proj"] },
      declared: { tool: ["read", "write"], filesystem: ["/workspace/proj/src"] },
    });
    expect(r.ok).toBe(true);
  });

  it("holds under a wildcard (full) upper bound", () => {
    const r = invChildCapabilityIsConferredBound({
      conferred: { tool: ["*"] },
      declared: { tool: ["anything"] },
    });
    expect(r.ok).toBe(true);
  });

  it("fails when the child requires a tool the parent does not confer", () => {
    const r = invChildCapabilityIsConferredBound({
      conferred: { tool: ["read"] },
      declared: { tool: ["read", "delete"] },
    });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.at === "tool:delete")).toBe(true);
  });

  it("fails when a declared path escapes the conferred filesystem root", () => {
    const r = invChildCapabilityIsConferredBound({
      conferred: { filesystem: ["/workspace/proj"] },
      declared: { filesystem: ["/workspace/project-secrets"] },
    });
    expect(r.ok).toBe(false);
    // A sibling with a shared prefix must NOT be treated as inside the root.
    expect(r.violations.some((v) => v.at === "filesystem:/workspace/project-secrets")).toBe(true);
  });
});

describe("P3-17 INV-003 unsafe tool is never auto retried", () => {
  it("holds when no unsafe tool is auto-retried", () => {
    const r = invUnsafeToolNeverAutoRetried([
      { toolId: "write_file", unsafe: true, autoRetry: false, retryAttempt: 1 }, // manual re-run is OK
      { toolId: "read_file", unsafe: false, autoRetry: true, retryAttempt: 2 },  // safe tool auto-retry OK
    ]);
    expect(r.ok).toBe(true);
  });

  it("fails when an unsafe tool is auto-retried", () => {
    const r = invUnsafeToolNeverAutoRetried([
      { toolId: "exec_delete", unsafe: true, autoRetry: true, retryAttempt: 1 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.at).toBe("exec_delete");
  });
});

describe("P3-17 INV-004 completed verification cannot be fabricated", () => {
  it("holds when a pass is backed by a passed check and evidence", () => {
    const r = invVerificationCannotBeFabricated([
      {
        caseId: "c1",
        passed: true,
        checks: [{ id: "check-a", passed: true }],
        evidence: [{ id: "ev-1" }],
      },
    ]);
    expect(r.ok).toBe(true);
  });

  it("fails when a pass has no checks at all", () => {
    const r = invVerificationCannotBeFabricated([
      { caseId: "c1", passed: true, checks: [], evidence: [] },
    ]);
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.detail).toContain("fabricated");
  });

  it("fails when a pass is reported while every check failed", () => {
    const r = invVerificationCannotBeFabricated([
      {
        caseId: "c2",
        passed: true,
        checks: [{ id: "a", passed: false }, { id: "b", passed: false }],
        evidence: [{ id: "ev" }],
      },
    ]);
    expect(r.ok).toBe(false);
  });

  it("fails when a pass has checks but no evidence artifact", () => {
    const r = invVerificationCannotBeFabricated([
      { caseId: "c3", passed: true, checks: [{ id: "a", passed: true }], evidence: [] },
    ]);
    expect(r.ok).toBe(false);
  });

  it("holds for a genuinely failed gate", () => {
    const r = invVerificationCannotBeFabricated([
      { caseId: "c4", passed: false, checks: [{ id: "a", passed: false }], evidence: [] },
    ]);
    expect(r.ok).toBe(true);
  });
});

describe("P3-17 INV-005 child context isolation", () => {
  it("holds when the child only reads granted keys", () => {
    const r = invChildContextIsolation({
      granted: ["cwd", "env.PATH", "file:notes.md"],
      observed: [
        { key: "cwd", at: "t0" },
        { key: "env.PATH", at: "t0" },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it("fails when the child observes an un-granted key", () => {
    const r = invChildContextIsolation({
      granted: ["cwd"],
      observed: [{ key: "env.AUTH_TOKEN", at: "t1" }],
    });
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.detail).toContain("env.AUTH_TOKEN");
  });

  it("fails when the child observes a parent-internal key even if granted", () => {
    const r = invChildContextIsolation({
      granted: ["cwd", "parent.secret"],
      observed: [{ key: "parent.secret", at: "t1" }],
    });
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.detail).toContain("isolation breach");
  });
});

describe("P3-17 INV-006 benchmark holdout judge secrecy", () => {
  it("holds when holdout cases are not scored before activation", () => {
    const r = invHoldoutJudgeSecrecy([
      { caseId: "h1", holdout: true, activated: false, scored: false },
      { caseId: "normal", holdout: false, activated: true, scored: true },
      { caseId: "h2", holdout: true, activated: true, scored: true }, // activated, scoring allowed
    ]);
    expect(r.ok).toBe(true);
  });

  it("fails when a holdout case is scored before activation", () => {
    const r = invHoldoutJudgeSecrecy([
      { caseId: "h1", holdout: true, activated: false, scored: true },
    ]);
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.at).toBe("h1");
  });
});

describe("P3-17 INV-007 memory unsafe content cannot persist", () => {
  it("holds when unsafe writes are rejected (never persisted)", () => {
    const r = invMemoryUnsafeContentCannotPersist([
      { contentId: "m1", unsafe: true, persisted: false, rejected: true },
      { contentId: "m2", unsafe: false, persisted: true, rejected: false },
    ]);
    expect(r.ok).toBe(true);
  });

  it("fails when unsafe content is persisted", () => {
    const r = invMemoryUnsafeContentCannotPersist([
      { contentId: "m1", unsafe: true, persisted: true, rejected: false },
    ]);
    expect(r.ok).toBe(false);
  });

  it("fails when unsafe content is simultaneously rejected and persisted (gate bypass)", () => {
    const r = invMemoryUnsafeContentCannotPersist([
      { contentId: "m1", unsafe: true, persisted: true, rejected: true },
    ]);
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.detail).toContain("gate bypass");
  });
});

describe("P3-17 INV-008 network denied cannot execute", () => {
  it("holds when denied actions never execute", () => {
    const r = invNetworkDeniedCannotExecute([
      { actionId: "a1", allowed: false, executed: false },
      { actionId: "a2", allowed: true, executed: true },
    ]);
    expect(r.ok).toBe(true);
  });

  it("fails when a denied network action executes", () => {
    const r = invNetworkDeniedCannotExecute([
      { actionId: "a1", allowed: false, executed: true },
    ]);
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.at).toBe("a1");
  });
});

describe("P3-17 INV-009 delegation bounded", () => {
  it("holds when delegations respect depth and fan-out bounds and narrow capability", () => {
    const r = invDelegationBounded([
      { delegateId: "d1", depth: 1, maxDepth: 2, count: 2, maxCount: 5, capabilityNarrowed: true },
      { delegateId: "d2", depth: 2, maxDepth: 2, count: 1, maxCount: 5, capabilityNarrowed: true },
    ]);
    expect(r.ok).toBe(true);
  });

  it("fails when delegation depth exceeds the bound", () => {
    const r = invDelegationBounded([
      { delegateId: "d1", depth: 3, maxDepth: 2, count: 1, maxCount: 5, capabilityNarrowed: true },
    ]);
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.detail).toContain("depth 3 exceeds bound 2");
  });

  it("fails when fan-out exceeds the bound", () => {
    const r = invDelegationBounded([
      { delegateId: "d1", depth: 1, maxDepth: 2, count: 6, maxCount: 5, capabilityNarrowed: true },
    ]);
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.detail).toContain("fan-out 6 exceeds bound 5");
  });

  it("fails when delegation widens capability", () => {
    const r = invDelegationBounded([
      { delegateId: "d1", depth: 1, maxDepth: 2, count: 1, maxCount: 5, capabilityNarrowed: false },
    ]);
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.detail).toContain("not a subset");
  });
});

describe("P3-17 INV-010 replay cannot duplicate known completed unsafe side effect", () => {
  it("holds when replay executes only fresh or safe effects", () => {
    const r = invReplayNoDuplicateUnsafeSideEffect(
      [
        { effectId: "e1", unsafe: true, completed: true }, // known completed unsafe
        { effectId: "e2", unsafe: false, completed: true },
      ],
      [
        { effectId: "e1", executed: false }, // correctly replayed as no-op
        { effectId: "e2", executed: true },  // safe effect may re-execute
        { effectId: "e3", executed: true },  // fresh effect
      ],
    );
    expect(r.ok).toBe(true);
  });

  it("fails when replay re-executes a known completed unsafe side effect", () => {
    const r = invReplayNoDuplicateUnsafeSideEffect(
      [{ effectId: "e1", unsafe: true, completed: true }],
      [{ effectId: "e1", executed: true }],
    );
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.at).toBe("e1");
  });
});

describe("P3-17 checkInvariants aggregator", () => {
  it("runs all eleven invariants", () => {
    const results = checkInvariants({});
    expect(results).toHaveLength(11);
    expect(allPass(results)).toBe(true);
  });

  it("surfaces exactly the violated invariants from a mixed snapshot", () => {
    const results = checkInvariants({
      stateTimeline: [
        { at: "t0", state: "running" },
        { at: "t1", state: "failed" },
        { at: "t2", state: "running" },
      ],
      networkDecisions: [{ actionId: "a1", allowed: false, executed: true }],
      memoryWrites: [],
    });
    const failures = violated(results);
    expect(failures.map((f) => f.invariant).sort()).toEqual(["INV-001", "INV-008"]);
  });

  it("aggregator reuses the same checks as the standalone predicates", () => {
    const results = checkInvariants({
      verificationClaims: [{ caseId: "c1", passed: true, checks: [], evidence: [] }],
    });
    const fabricated = results.find((r) => r.invariant === "INV-004")!;
    const standalone = invVerificationCannotBeFabricated([
      { caseId: "c1", passed: true, checks: [], evidence: [] },
    ]);
    expect(fabricated.ok).toBe(false);
    expect(standalone.ok).toBe(false);
  });
});
describe("P14-5 INV-011 untrusted context is data only", () => {
  it("holds when trusted blocks are instructional and untrusted blocks are data", () => {
    const result = invUntrustedContextIsDataOnly([
      { id: "system", trust: "trusted", instructional: true },
      { id: "user", trust: "trusted", instructional: true, persistable: true },
      { id: "tool:1", trust: "semi-trusted", instructional: false, persistable: false },
      { id: "mcp:1", trust: "untrusted", instructional: false, persistable: false },
    ]);
    expect(result.ok).toBe(true);
  });

  it("fails when untrusted data is marked instructional (data upgrading into instruction)", () => {
    const result = invUntrustedContextIsDataOnly([
      { id: "evil-repo", trust: "untrusted", instructional: true },
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.at).toBe("evil-repo");
    expect(result.violations[0]!.detail).toContain("instruction");
  });

  it("fails when semi-trusted data is marked instructional too", () => {
    const result = invUntrustedContextIsDataOnly([
      { id: "skill-body", trust: "semi-trusted", instructional: true },
    ]);
    expect(result.ok).toBe(false);
  });

  it("fails when untrusted content is marked persistable (memory-pollution gate)", () => {
    const result = invUntrustedContextIsDataOnly([
      { id: "mcp-result", trust: "untrusted", persistable: true },
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.detail).toContain("persistable");
  });

  it("a missing flag is data by default (absent = false)", () => {
    const result = invUntrustedContextIsDataOnly([
      { id: "plain", trust: "untrusted" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("is part of the aggregated gate", () => {
    const results = checkInvariants({
      contextBlocks: [{ id: "x", trust: "untrusted", instructional: true }],
    });
    expect(violated(results).some((r) => r.invariant === "INV-011")).toBe(true);
    expect(allPass(results)).toBe(false);
  });
});
