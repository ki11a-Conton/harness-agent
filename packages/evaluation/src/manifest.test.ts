import { describe, expect, it } from "vitest";
import {
  BENCHMARK_SUITE_VERSION,
  buildRunManifest,
  computeRuntimeConfigHash,
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
});
