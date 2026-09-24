import { describe, expect, it } from "vitest";
import {
  buildConfigLayers,
  configLayerFingerprint,
  defaultsLayer,
  environmentLayer,
  fieldDocOf,
  hashOf,
  lifecycleOf,
  profileLayer,
  runtimeLayer,
  sessionOverridesLayer,
  stableSerialize,
} from "./config-layers.js";

describe("config-layers (P27-1)", () => {
  it("defaultsLayer carries DEFAULT_FEATURE_FLAGS + DEFAULT_CONTEXT_BUDGET", () => {
    const layer = defaultsLayer();
    expect(layer.source).toBe("defaults");
    expect(layer.id).toBe("defaults");
    expect(layer.values.featureFlags?.context).toBe(true);
    expect(layer.values.featureFlags?.memory).toBe(false);
    expect(layer.values.contextBudget?.maxTokens).toBe(32_000);
    expect(layer.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it("profileLayer carries the preset sandbox + feature flags for the profile", () => {
    const layer = profileLayer("champion");
    expect(layer.source).toBe("profile");
    expect(layer.id).toBe("profile:champion");
    expect(layer.values.sandboxPolicy).toBeDefined();
    expect(layer.values.featureFlags?.mcp).toBe(false);
    expect(layer.values.featureFlags?.context).toBe(true);
  });

  it("environmentLayer maps flat AGENT_ vars onto dotted keys", () => {
    const layer = environmentLayer({
      AGENT_SANDBOX_POLICY__NETWORK: "deny",
      AGENT_CONTEXT_BUDGET__MAX_TOKENS: "64000",
      AGENT_FEATURE_FLAGS__MEMORY: "true",
      IRRELEVANT: "x",
    });
    expect(layer).toBeDefined();
    const values = layer!.values as Record<string, Record<string, unknown>>;
    expect(values.sandboxPolicy?.network).toBe("deny");
    expect(values.contextBudget?.maxTokens).toBe(64000);
    expect(values.featureFlags?.memory).toBe(true);
    expect(layer!.source).toBe("environment");
  });

  it("environmentLayer is undefined when no AGENT_ vars are present", () => {
    expect(environmentLayer({ IRRELEVANT: "x", HOME: "/home" })).toBeUndefined();
    expect(environmentLayer({})).toBeUndefined();
    // empty-string values are skipped too
    expect(environmentLayer({ AGENT_PROFILE: "" })).toBeUndefined();
  });

  it("session + runtime layers carry their overrides", () => {
    const session = sessionOverridesLayer({ profile: "batch" });
    expect(session.source).toBe("session");
    expect(session.values.profile).toBe("batch");
    const runtime = runtimeLayer({ profile: "interactive" });
    expect(runtime.source).toBe("runtime");
    expect(runtime.values.profile).toBe("interactive");
  });

  it("buildConfigLayers orders low → high: defaults, profile, environment, session, runtime", () => {
    const layers = buildConfigLayers({
      profile: "champion",
      overrides: { cwd: "/tmp" },
      env: { AGENT_FEATURE_FLAGS__LEARNING: "true" },
      sessionOverrides: { limits: { maxTurns: 5 } },
    });
    expect(layers.map((l) => l.source)).toEqual([
      "defaults",
      "profile",
      "environment",
      "session",
      "runtime",
    ]);
    expect(layers[0]!.id).toBe("defaults");
    expect(layers[1]!.id).toBe("profile:champion");
    expect(layers[4]!.id).toBe("runtime");
  });

  it("stableSerialize is deterministic and key-sorted", () => {
    const a = { b: 1, a: [2, { c: 3 }] };
    const b = { a: [2, { c: 3 }], b: 1 };
    expect(stableSerialize(a)).toBe(stableSerialize(b));
    expect(stableSerialize({ x: 1 })).toBe('{"x":1}');
  });

  it("configLayerFingerprint changes when values change and hashOf is stable", () => {
    const f1 = configLayerFingerprint({ featureFlags: { memory: false } });
    const f2 = configLayerFingerprint({ featureFlags: { memory: true } });
    expect(f1).not.toBe(f2);
    expect(hashOf("abc")).toBe(hashOf("abc"));
  });
});

describe("config lifecycle (P27-3)", () => {
  it("classifies every documented key by lifecycle", () => {
    expect(lifecycleOf("cwd")).toBe("process_static");
    expect(lifecycleOf("dataDir")).toBe("process_static");
    expect(lifecycleOf("dataStore")).toBe("process_static");
    expect(lifecycleOf("profile")).toBe("session_frozen");
    expect(lifecycleOf("modelProvider")).toBe("session_frozen");
    expect(lifecycleOf("featureFlags")).toBe("session_frozen");
    expect(lifecycleOf("featureFlags.memory")).toBe("session_frozen");
    expect(lifecycleOf("sandboxPolicy")).toBe("session_frozen");
    expect(lifecycleOf("limits.maxTurns")).toBe("session_frozen");
    expect(lifecycleOf("contextBudget.maxTokens")).toBe("session_frozen");
    expect(lifecycleOf("task")).toBe("turn_dynamic");
    expect(lifecycleOf("verification.planner")).toBe("turn_dynamic");
    expect(lifecycleOf("mcp")).toBe("step_dynamic");
    expect(lifecycleOf("mcp.github.enabled")).toBe("step_dynamic");
    // unknown keys fail closed to session_frozen
    expect(lifecycleOf("unknownField")).toBe("session_frozen");
  });

  it("fieldDocOf documents known patterns and resolves wildcards", () => {
    expect(fieldDocOf("cwd")).toBeDefined();
    expect(fieldDocOf("featureFlags.memory")?.doc).toContain("mechanism toggles");
    expect(fieldDocOf("mcp.servers[0]")).toBeDefined();
    expect(fieldDocOf("totallyUnknown")).toBeUndefined();
  });
});
