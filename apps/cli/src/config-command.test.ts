import { describe, expect, it } from "vitest";
import { resolveConfig } from "@ar/harness";
import { defaultsLayer, profileLayer, runtimeLayer } from "@ar/harness";
import { configExplainCmd } from "./config-command.js";

function makeResolved(overrides: Record<string, unknown> = {}) {
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

describe("config explain CLI (P27-5)", () => {
  it("renders the whole config with origins and lifecycle", async () => {
    const resolved = makeResolved({ limits: { maxTurns: 4 } });
    const result = await configExplainCmd(undefined, { resolvedConfig: resolved });
    expect(result.exitCode).toBe(0);
    const text = result.lines.join("\n");
    expect(text).toContain(`config fingerprint: ${resolved.fingerprint}`);
    expect(text).toContain("limits.maxTurns = 4");
    expect(text).toContain("from runtime (runtime)");
    expect(text).toContain("[session_frozen]");
    expect(text).toContain("cwd = /workspace");
    expect(text).toContain("[process_static]");
  });

  it("renders a single key", async () => {
    const resolved = makeResolved({ limits: { maxTurns: 4 } });
    const result = await configExplainCmd("limits.maxTurns", { resolvedConfig: resolved });
    expect(result.exitCode).toBe(0);
    const text = result.lines.join("\n");
    expect(text).toContain("key: limits.maxTurns");
    expect(text).toContain("from runtime (runtime)");
    expect(text).toContain("[session_frozen]");
  });

  it("redacts secrets and never leaks them", async () => {
    const resolved = makeResolved({
      modelProvider: { id: "openai", apiKey: "sk-TOP-SECRET" } as never,
      mcp: [
        { serverId: "github", type: "stdio" as const, command: "x", args: [] },
      ],
    });
    const result = await configExplainCmd(undefined, { resolvedConfig: resolved });
    const text = result.lines.join("\n");
    expect(text).not.toContain("sk-TOP-SECRET");
    expect(text).toContain("***redacted***");
  });

  it("reports fingerprint for unknown keys as absent value", async () => {
    const resolved = makeResolved();
    const result = await configExplainCmd("does.not.exist", { resolvedConfig: resolved });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain("does.not.exist = undefined");
  });
});
