import { describe, expect, it } from "vitest";
import type { ModelProvider } from "@ar/contracts";
import {
  collectChangedKeys,
  leafKeysOf,
  readPath,
  resolveConfig,
  resolveHarnessConfig,
} from "./config-resolver.js";
import { defaultsLayer, profileLayer, runtimeLayer } from "./config-layers.js";

const BASE_OVERRIDES = {
  cwd: "/workspace",
  profile: "champion" as const,
  modelProvider: { id: "stub" } as unknown as ModelProvider,
  model: { providerId: "stub", modelId: "stub-model" },
};

describe("config-resolver (P27-2)", () => {
  it("resolves a stack low → high with runtime winning", () => {
    const resolved = resolveConfig([
      defaultsLayer(),
      profileLayer("champion"),
      runtimeLayer({ ...BASE_OVERRIDES, featureFlags: { memory: true } }),
    ]);
    expect(resolved.value.cwd).toBe("/workspace");
    expect(resolved.value.profile).toBe("champion");
    // runtime override wins over defaults
    expect(resolved.value.featureFlags?.memory).toBe(true);
    // default left intact when runtime does not touch it
    expect(resolved.value.featureFlags?.context).toBe(true);
    // profile preset sandbox fills the gap
    expect(resolved.value.sandboxPolicy).toBeDefined();
    expect(resolved.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(resolved.layers.length).toBe(3);
  });

  it("tracks per-key origins (P27-2)", () => {
    const resolved = resolveConfig([
      defaultsLayer(),
      profileLayer("champion"),
      runtimeLayer({ ...BASE_OVERRIDES, contextBudget: { maxTokens: 64000 } }),
    ]);
    const originBudget = resolved.origins.get("contextBudget.maxTokens");
    expect(originBudget?.source).toBe("runtime");
    expect(originBudget?.layerId).toBe("runtime");
    // the profile preset supplies the full default feature flags, so a flag
    // untouched by runtime is recorded as profile-origin
    expect(resolved.origins.get("featureFlags.memory")?.source).toBe("profile");
    // sandbox leaves came from the profile preset
    expect(resolved.origins.get("sandboxPolicy.network.mode")?.source).toBe("profile");
    expect(resolved.origins.get("sandboxPolicy.network.mode")?.layerId).toBe("profile:champion");
  });

  it("undefined overrides never clobber lower layers", () => {
    const resolved = resolveConfig([
      profileLayer("champion"),
      runtimeLayer({ ...BASE_OVERRIDES, sandboxPolicy: undefined }),
    ]);
    // sandboxPolicy still present from the profile layer
    expect(resolved.value.sandboxPolicy).toBeDefined();
  });

  it("fingerprint is stable for identical inputs and changes on any value change", () => {
    const a = resolveConfig([defaultsLayer(), runtimeLayer({ ...BASE_OVERRIDES })]);
    const b = resolveConfig([defaultsLayer(), runtimeLayer({ ...BASE_OVERRIDES })]);
    expect(a.fingerprint).toBe(b.fingerprint);
    const c = resolveConfig([defaultsLayer(), runtimeLayer({ ...BASE_OVERRIDES, limits: { maxTurns: 3 } })]);
    expect(c.fingerprint).not.toBe(a.fingerprint);
  });

  it("leafKeysOf returns sorted dotted leaves", () => {
    const resolved = resolveConfig([runtimeLayer({ ...BASE_OVERRIDES, limits: { maxTurns: 1 } })]);
    const keys = leafKeysOf(resolved.value);
    expect(keys).toContain("cwd");
    expect(keys).toContain("limits.maxTurns");
    expect(keys).toEqual([...keys].sort());
  });

  it("readPath walks dotted paths", () => {
    const obj = { a: { b: { c: 42 } } };
    expect(readPath(obj, "a.b.c")).toBe(42);
    expect(readPath(obj, "a.b")).toEqual({ c: 42 });
    expect(readPath(obj, "a.x")).toBeUndefined();
  });
});

describe("collectChangedKeys", () => {
  it("detects nested leaf changes", () => {
    const prev = { a: { b: 1, c: 2 }, d: "x" };
    const next = { a: { b: 1, c: 3 }, d: "x" };
    expect(collectChangedKeys(prev, next)).toEqual(["a.c"]);
  });

  it("detects additions and removals", () => {
    expect(collectChangedKeys({ a: 1 }, { a: 1, b: 2 })).toEqual(["b"]);
    expect(collectChangedKeys({ a: 1, b: 2 }, { a: 1 })).toEqual(["b"]);
  });

  it("is stable for arrays (opaque leaves)", () => {
    expect(collectChangedKeys({ list: [1, 2] }, { list: [1, 3] })).toEqual(["list"]);
    expect(collectChangedKeys({ list: [1, 2] }, { list: [1, 2] })).toEqual([]);
  });
});

describe("resolveHarnessConfig", () => {
  it("builds the standard stack and resolves", () => {
    const resolved = resolveHarnessConfig({
      profile: "champion",
      overrides: { ...BASE_OVERRIDES },
    });
    expect(resolved.layers.map((l) => l.source)).toEqual(["defaults", "profile", "runtime"]);
    expect(resolved.value.profile).toBe("champion");
    expect(resolved.origins.get("sandboxPolicy.network.mode")?.source).toBe("profile");
  });

  it("applies session overrides between environment and runtime", () => {
    const resolved = resolveHarnessConfig({
      profile: "champion",
      overrides: { ...BASE_OVERRIDES },
      sessionOverrides: { limits: { maxTurns: 7 } },
    });
    expect(resolved.layers.map((l) => l.source)).toEqual([
      "defaults",
      "profile",
      "session",
      "runtime",
    ]);
    expect(resolved.value.limits?.maxTurns).toBe(7);
    expect(resolved.origins.get("limits.maxTurns")?.source).toBe("session");
  });

  it("environment layer applies below runtime", () => {
    const resolved = resolveHarnessConfig({
      profile: "champion",
      overrides: { ...BASE_OVERRIDES },
      env: { AGENT_CONTEXT_BUDGET__MAX_TOKENS: "48000" },
    });
    expect(resolved.value.contextBudget?.maxTokens).toBe(48000);
    expect(resolved.origins.get("contextBudget.maxTokens")?.source).toBe("environment");
  });
});
