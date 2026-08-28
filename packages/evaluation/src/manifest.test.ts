import { describe, expect, it } from "vitest";
import {
  BENCHMARK_SUITE_VERSION,
  buildEffectiveConfig,
  buildRunManifest,
  computeCandidateConfigHash,
  computeEvaluationContextHash,
  computeRuntimeConfigHash,
  computeToolSetHash,
  normalizeToolSet,
  stableStringify,
} from "./manifest.js";
import { DEFAULT_JUDGE_VERSION } from "./baseline.js";

describe("buildRunManifest (P0-6)", () => {
  it("records every manifest field from the run identity", async () => {
    const manifest = await buildRunManifest({
      model: "gpt-4o-mini",
      provider: "openai",
      temperature: 0.3,
      suiteVersion: "2.1.0",
      judgeVersion: "1.2.0",
      runtimeConfigHash: "abc123",
      timestamp: "2026-01-01T00:00:00.000Z",
      gitInfo: { sha: "deadbeef", dirty: true },
    });

    expect(manifest).toEqual({
      gitSha: "deadbeef",
      dirty: true,
      model: "gpt-4o-mini",
      provider: "openai",
      temperature: 0.3,
      suiteVersion: "2.1.0",
      judgeVersion: "1.2.0",
      runtimeConfigHash: "abc123",
      timestamp: "2026-01-01T00:00:00.000Z",
      platform: process.platform,
      nodeVersion: process.version,
      // P21-1: reproducibility identity (defaults are honest).
      profile: "benchmark",
      features: {},
      contextBudgetTokens: null,
      taskSuites: [],
      randomSeed: null,
      // P38.3-10: absent candidate is an honest champion baseline.
      candidate: null,
    });
  });

  it("defaults suiteVersion to the suite definition version and judgeVersion to the harness default", async () => {
    const manifest = await buildRunManifest({
      model: "m",
      provider: "p",
      runtimeConfigHash: "h",
      timestamp: "2026-01-01T00:00:00.000Z",
      gitInfo: { sha: null, dirty: null },
    });

    expect(manifest.suiteVersion).toBe(BENCHMARK_SUITE_VERSION);
    expect(manifest.judgeVersion).toBe(DEFAULT_JUDGE_VERSION);
  });

  it("records temperature null when none was set explicitly", async () => {
    const manifest = await buildRunManifest({
      model: "m",
      provider: "p",
      runtimeConfigHash: "h",
      timestamp: "2026-01-01T00:00:00.000Z",
      gitInfo: { sha: null, dirty: null },
    });

    expect(manifest.temperature).toBeNull();
  });

  it("records a clean tree honestly: dirty false when there are no changes", async () => {
    const manifest = await buildRunManifest({
      model: "m",
      provider: "p",
      runtimeConfigHash: "h",
      timestamp: "2026-01-01T00:00:00.000Z",
      gitInfo: { sha: "beef", dirty: false },
    });

    expect(manifest.gitSha).toBe("beef");
    expect(manifest.dirty).toBe(false);
  });

  it("records null git info when the repository is not available", async () => {
    const manifest = await buildRunManifest({
      model: "m",
      provider: "p",
      runtimeConfigHash: "h",
      timestamp: "2026-01-01T00:00:00.000Z",
      gitInfo: { sha: null, dirty: null },
    });

    expect(manifest.gitSha).toBeNull();
    expect(manifest.dirty).toBeNull();
  });
});

describe("computeRuntimeConfigHash (P0-6)", () => {
  it("hashes identically for identical configs", () => {
    const config = {
      suite: "regression",
      budgetTokens: 32_000,
      permissions: { rules: [{ action: "read", resource: "file", effect: "allow" }] },
      sandbox: { network: { mode: "deny" } },
      tools: ["read_file", "write_file", "exec"],
    };
    expect(computeRuntimeConfigHash(config)).toBe(computeRuntimeConfigHash({ ...config }));
  });

  it("is independent of key insertion order (stable serialization)", () => {
    const a = { alpha: 1, beta: { gamma: [1, 2], delta: true } };
    const b = { beta: { delta: true, gamma: [1, 2] }, alpha: 1 };
    expect(computeRuntimeConfigHash(a)).toBe(computeRuntimeConfigHash(b));
  });

  it("changes when the runtime wiring changes", () => {
    const base = { permissions: "read-only" };
    const widened = { permissions: "read+write" };
    expect(computeRuntimeConfigHash(base)).not.toBe(computeRuntimeConfigHash(widened));
  });

  it("produces a 64-char hex digest", () => {
    expect(computeRuntimeConfigHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("stableStringify (Q-5)", () => {
  it("handles nested objects, arrays, and primitives deterministically", () => {
    const value = { b: [1, { c: true }], a: "x", n: null, u: undefined };
    expect(stableStringify(value)).toBe(
      '{"a":"x","b":[1,{"c":true}],"n":null,"u":undefined}',
    );
  });

  it("serializes arrays and nested structures recursively", () => {
    expect(stableStringify([[1, 2], { a: [3] }])).toBe('[[1,2],{"a":[3]}]');
  });

  it("P21-1: records profile / features / budget / suites / seed for reproducibility", async () => {
    const manifest = await buildRunManifest({
      model: "m",
      provider: "p",
      runtimeConfigHash: "hash",
      gitInfo: { sha: "abc", dirty: false },
      timestamp: "t",
      profile: "benchmark",
      features: { context: true, memory: false },
      contextBudgetTokens: 32000,
      taskSuites: ["regression", "holdout"],
      randomSeed: 42,
    });
    expect(manifest.profile).toBe("benchmark");
    expect(manifest.features).toEqual({ context: true, memory: false });
    expect(manifest.contextBudgetTokens).toBe(32000);
    expect(manifest.taskSuites).toEqual(["regression", "holdout"]);
    expect(manifest.randomSeed).toBe(42);
  });

  describe("P38.4-7 per-case provenance hashes", () => {
    const baseEval = {
      caseId: "reg-01",
      fixtureDigest: "abc123",
      judgeVersion: "1.0.0",
      toolSchemaDigest: "def456",
      suiteVersion: "2.1.0",
      securityPolicyVersion: "1.0.0",
      prerequisiteFeatures: ["memory"] as readonly string[],
      environmentContract: "linux-sandbox",
    };
    const baseCandidate = {
      candidate: "adaptive-recovery-5",
      maxSteps: 50,
      contextPipeline: "default",
      memoryStrategy: "semantic",
      specialistRouting: null,
      toolSelection: "default",
      recoveryStrategy: "adaptive",
      compactionStrategy: "aggressive",
      challengerFlags: { adaptiveRetry: true },
    };

    it("same effective context → same evaluationContextHash", () => {
      const h1 = computeEvaluationContextHash(baseEval);
      const h2 = computeEvaluationContextHash({ ...baseEval });
      expect(h1).toBe(h2);
    });

    it("changed case fixture → different evaluationContextHash", () => {
      const h1 = computeEvaluationContextHash(baseEval);
      const h2 = computeEvaluationContextHash({ ...baseEval, fixtureDigest: "xyz999" });
      expect(h1).not.toBe(h2);
    });

    it("changed judge version → different evaluationContextHash", () => {
      const h1 = computeEvaluationContextHash(baseEval);
      const h2 = computeEvaluationContextHash({ ...baseEval, judgeVersion: "2.0.0" });
      expect(h1).not.toBe(h2);
    });

    it("changed candidate-only knob → evaluationContextHash unchanged", () => {
      const h1 = computeEvaluationContextHash(baseEval);
      const h2 = computeEvaluationContextHash({ ...baseEval });
      // recovery strategy is NOT in evaluation context
      expect(h1).toBe(h2);
    });

    it("changed candidate-only knob → candidateConfigHash changed", () => {
      const h1 = computeCandidateConfigHash(baseCandidate);
      const h2 = computeCandidateConfigHash({ ...baseCandidate, recoveryStrategy: "fixed" });
      expect(h1).not.toBe(h2);
    });

    it("object key insertion order does not change hash", () => {
      const a = { z: 1, a: 2 };
      const b = { a: 2, z: 1 };
      const h1 = computeRuntimeConfigHash(a);
      const h2 = computeRuntimeConfigHash(b);
      expect(h1).toBe(h2);
    });

    it("candidateConfigHash is deterministic", () => {
      const h1 = computeCandidateConfigHash(baseCandidate);
      const h2 = computeCandidateConfigHash(baseCandidate);
      expect(h1).toBe(h2);
    });

    it("evaluationContextHash output is 64-char hex", () => {
      const h = computeEvaluationContextHash(baseEval);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it("P21-1: absent identity fields are honest nulls/[], never guessed", async () => {
    const manifest = await buildRunManifest({
      model: "m",
      provider: "p",
      runtimeConfigHash: "hash",
      gitInfo: { sha: "abc", dirty: false },
      timestamp: "t",
    });
    expect(manifest.contextBudgetTokens).toBeNull();
    expect(manifest.taskSuites).toEqual([]);
    expect(manifest.randomSeed).toBeNull();
    // two runs with different budgets can NEVER claim identical identity.
    const other = await buildRunManifest({
      model: "m",
      provider: "p",
      runtimeConfigHash: "hash",
      gitInfo: { sha: "abc", dirty: false },
      timestamp: "t",
      contextBudgetTokens: 64000,
    });
    expect(other.contextBudgetTokens).not.toBe(manifest.contextBudgetTokens);
  });
});

describe("buildEffectiveConfig (P38.3-10)", () => {
  const BASE = {
    candidate: null,
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0.3,
    context: { maxTokens: 32000, dynamic: 0 },
    recovery: { adaptive: false },
    mechanisms: {
      memory: false,
      subagent: false,
      scheduler: false,
      mcp: false,
      deferredSchema: false,
      stepBudgetCompletion: false,
    },
    tools: ["read_file", "write_file", "exec"],
  };

  it("baseline hash != adaptive_recovery hash", () => {
    const baseline = buildEffectiveConfig(BASE);
    const adaptive = buildEffectiveConfig({
      ...BASE,
      candidate: "adaptive_recovery",
      recovery: { adaptive: true },
    });
    expect(baseline.runtimeConfigHash).not.toBe(adaptive.runtimeConfigHash);
  });

  it("baseline hash != memory_retrieval hash", () => {
    const baseline = buildEffectiveConfig(BASE);
    const memory = buildEffectiveConfig({
      ...BASE,
      candidate: "memory_retrieval",
      mechanisms: { ...BASE.mechanisms, memory: true },
    });
    expect(baseline.runtimeConfigHash).not.toBe(memory.runtimeConfigHash);
  });

  it("baseline hash != deferred schema hash", () => {
    const baseline = buildEffectiveConfig(BASE);
    const deferred = buildEffectiveConfig({
      ...BASE,
      candidate: "tool_selector_deferred_schema",
      mechanisms: { ...BASE.mechanisms, deferredSchema: true },
    });
    expect(baseline.runtimeConfigHash).not.toBe(deferred.runtimeConfigHash);
  });

  it("baseline hash != adaptive context hash", () => {
    const baseline = buildEffectiveConfig(BASE);
    const context = buildEffectiveConfig({
      ...BASE,
      candidate: "adaptive_context_policy",
      context: { maxTokens: 32000, dynamic: 4096 },
    });
    expect(baseline.runtimeConfigHash).not.toBe(context.runtimeConfigHash);
  });

  it("deterministic repeat: same config → same hashes", () => {
    const a = buildEffectiveConfig(BASE);
    const b = buildEffectiveConfig({ ...BASE });
    expect(a.runtimeConfigHash).toBe(b.runtimeConfigHash);
    expect(a.toolSetHash).toBe(b.toolSetHash);
  });

  it("tool set hash is order-independent (normalized)", () => {
    const unordered = ["exec", "read_file", "write_file"];
    const normal = ["read_file", "write_file", "exec"];
    expect(computeToolSetHash(unordered)).toBe(computeToolSetHash(normal));
    expect(computeToolSetHash(unordered)).toBe(
      computeRuntimeConfigHash(["exec", "read_file", "write_file"]),
    );
  });

  it("model/provider change changes hash/provenance", () => {
    const base = buildEffectiveConfig(BASE);
    const diffModel = buildEffectiveConfig({ ...BASE, model: "gpt-4o" });
    const diffProvider = buildEffectiveConfig({ ...BASE, provider: "azure" });
    expect(base.runtimeConfigHash).not.toBe(diffModel.runtimeConfigHash);
    expect(base.runtimeConfigHash).not.toBe(diffProvider.runtimeConfigHash);
  });
});
