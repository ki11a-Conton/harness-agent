import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config-resolver.js";
import { defaultsLayer, profileLayer, runtimeLayer } from "./config-layers.js";
import {
  evaluateConfigDrift,
  isSensitiveKey,
  normalizeForComparison,
  redactConfigValue,
  REDACTED,
  renderConfigValue,
} from "./config-drift.js";

function makeResolved(overrides: Record<string, unknown>) {
  return resolveConfig([
    defaultsLayer(),
    profileLayer("champion"),
    runtimeLayer({
      cwd: "/workspace",
      profile: "champion",
      modelProvider: { id: "stub" } as never,
      model: { providerId: "stub", modelId: "stub-model" },
      ...overrides,
    }),
  ]);
}

describe("config-drift (P27-4)", () => {
  it("no drift when fingerprints match", () => {
    const a = makeResolved({});
    const b = makeResolved({});
    const decision = evaluateConfigDrift(a, b);
    expect(decision.severity).toBe("none");
    expect(decision.changed).toEqual([]);
  });

  it("process_static change → restart_required", () => {
    const decision = evaluateConfigDrift(
      makeResolved({ dataDir: "/data/a" }),
      makeResolved({ dataDir: "/data/b" }),
    );
    expect(decision.severity).toBe("restart_required");
    expect(decision.changed[0]?.key).toBe("dataDir");
    expect(decision.changed[0]?.lifecycle).toBe("process_static");
  });

  it("session_frozen widening → reject (require a new session)", () => {
    const decision = evaluateConfigDrift(
      makeResolved({ featureFlags: { memory: false } }),
      makeResolved({ featureFlags: { memory: true } }),
    );
    expect(decision.severity).toBe("reject");
    const item = decision.changed.find((c) => c.key === "featureFlags.memory")!;
    expect(item.direction).toBe("widen");
    expect(decision.frozenChanged).toBe(true);
  });

  it("session_frozen narrowing → emergency revocation policy", () => {
    const decision = evaluateConfigDrift(
      makeResolved({ limits: { maxTurns: 10 } }),
      makeResolved({ limits: { maxTurns: 5 } }),
    );
    expect(decision.severity).toBe("emergency_revocation");
    const item = decision.changed.find((c) => c.key === "limits.maxTurns")!;
    expect(item.direction).toBe("narrow");
  });

  it("session_frozen with unknown direction fails closed → reject", () => {
    const decision = evaluateConfigDrift(
      makeResolved({ model: { providerId: "a", modelId: "m" } }),
      makeResolved({ model: { providerId: "b", modelId: "m" } }),
    );
    expect(decision.severity).toBe("reject");
  });

  it("step_dynamic change → next_step only", () => {
    const decision = evaluateConfigDrift(
      makeResolved({ mcp: [{ serverId: "a" }] } as never),
      makeResolved({ mcp: [{ serverId: "b" }] } as never),
    );
    expect(decision.severity).toBe("next_step");
    expect(decision.changed[0]?.lifecycle).toBe("step_dynamic");
  });

  it("turn_dynamic change → next_step only", () => {
    const decision = evaluateConfigDrift(
      makeResolved({ task: { id: "t1" } as never }),
      makeResolved({ task: { id: "t2" } as never }),
    );
    expect(decision.severity).toBe("next_step");
  });

  it("severity escalates to the highest across changed keys", () => {
    const decision = evaluateConfigDrift(
      makeResolved({ dataDir: "/a", featureFlags: { memory: false } }),
      makeResolved({ dataDir: "/b", featureFlags: { memory: true } }),
    );
    expect(decision.severity).toBe("restart_required");
  });
});

describe("normalizeForComparison", () => {
  it("replaces functions with a constant placeholder", () => {
    const fn = () => 1;
    const out = normalizeForComparison({ a: fn, b: [fn, { c: fn }] }) as {
      a: unknown;
      b: unknown[];
    };
    expect(out.a).toBe("[[function]]");
    expect((out.b[1] as { c: unknown }).c).toBe("[[function]]");
  });

  it("leaves plain data untouched", () => {
    expect(normalizeForComparison({ a: 1, b: "x", c: [true] })).toEqual({ a: 1, b: "x", c: [true] });
  });
});

describe("config redaction (P27-5)", () => {
  it("flags sensitive keys", () => {
    expect(isSensitiveKey("modelProvider.apiKey")).toBe(true);
    expect(isSensitiveKey("mcp.servers[0].headers.Authorization")).toBe(true);
    expect(isSensitiveKey("authToken")).toBe(true);
    expect(isSensitiveKey("sandboxPolicy.network")).toBe(false);
    expect(isSensitiveKey("limits.maxTurns")).toBe(false);
  });

  it("redacts secrets recursively but keeps the shape", () => {
    const value = {
      apiKey: "sk-12345",
      headers: { Authorization: "Bearer abc" },
      limits: { maxTurns: 3 },
    };
    const redacted = redactConfigValue("modelProvider", value) as typeof value;
    expect(redacted.apiKey).toBe(REDACTED);
    expect(redacted.headers.Authorization).toBe(REDACTED);
    expect(redacted.limits.maxTurns).toBe(3);
  });

  it("renderConfigValue never leaks secrets", () => {
    const out = renderConfigValue("modelProvider.apiKey", "sk-super-secret-value");
    expect(out).toContain(REDACTED);
    expect(out).not.toContain("sk-super-secret-value");
  });

  it("renderConfigValue caps long output", () => {
    const out = renderConfigValue("limits", { maxTurns: "x".repeat(1000) });
    expect(out.length).toBeLessThanOrEqual(210);
  });
});
