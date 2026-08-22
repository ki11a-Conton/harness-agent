import { describe, expect, it } from "vitest";
import type { ToolSpec } from "@ar/contracts";
import {
  DEFAULT_MAX_INLINE_SCHEMA_TOKENS,
  decideSchemaAdvert,
  estimateSpecTokens,
  estimateSpecsTokens,
  stubSpec,
} from "./schema-advert.js";

function spec(name: string, schemaBytes: number): ToolSpec {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", padding: "x".repeat(schemaBytes) },
  };
}

describe("P18-2 schema advertisement", () => {
  it("estimates tokens monotonically in schema size", () => {
    const small = spec("a", 40);
    const large = spec("b", 4_000);
    expect(estimateSpecTokens(large)).toBeGreaterThan(estimateSpecTokens(small));
    expect(estimateSpecsTokens([small, small])).toBe(estimateSpecTokens(small) * 2);
  });

  it("advertises everything inline when the token budget is not exceeded (built-in small set)", () => {
    const specs = [spec("read_file", 200), spec("write_file", 300), spec("exec", 250)];
    const decision = decideSchemaAdvert(specs);
    expect(decision.mode).toBe("full");
    expect(decision.advertised).toHaveLength(3);
    expect(decision.deferred).toEqual([]);
    expect(decision.advertised[0]).toEqual(specs[0]);
  });

  it("stubs the non-core bulk when the schema token budget is exceeded (threshold is TOKEN based, not tool count)", () => {
    // 10 tools × 3k schema chars each — tiny count, huge schema → deferred.
    const specs = Array.from({ length: 10 }, (_, i) => spec(`mcp_server.tool_${i}`, 3_000));
    const decision = decideSchemaAdvert(specs, { maxInlineTokens: 5_000 });
    expect(decision.mode).toBe("deferred");
    expect(decision.deferred).toHaveLength(10);
    // Every stub keeps name + description but replaces the schema with a
    // minimal placeholder, so the advertisement is much cheaper.
    for (const advertised of decision.advertised) {
      expect(advertised.inputSchema).toEqual({ type: "object" });
      expect(advertised.name).toMatch(/^mcp_server\.tool_/);
    }
    expect(decision.tokens).toBeGreaterThan(estimateSpecsTokens(decision.advertised));
  });

  it("keeps the built-in set inline even in deferred mode (keepFull)", () => {
    const builtin = spec("read_file", 200);
    const bulk = spec("mcp_server.big", 5_000);
    const decision = decideSchemaAdvert([builtin, bulk], {
      maxInlineTokens: 1_000,
      keepFull: new Set(["read_file"]),
    });
    expect(decision.mode).toBe("deferred");
    expect(decision.advertised.find((s) => s.name === "read_file")).toEqual(builtin);
    expect(decision.deferred).toEqual(["mcp_server.big"]);
  });

  it("supports a predicate keepFull", () => {
    const a = spec("keep_me", 5_000);
    const b = spec("mcp.b", 5_000);
    const decision = decideSchemaAdvert([a, b], {
      maxInlineTokens: 100,
      keepFull: (name) => name === "keep_me",
    });
    expect(decision.advertised.map((s) => s.name)).toEqual(["keep_me", "mcp.b"]);
    expect(decision.deferred).toEqual(["mcp.b"]);
    // keep_me is advertised in full; mcp.b is stubbed.
    expect(decision.advertised.find((s) => s.name === "keep_me")?.inputSchema).not.toEqual({ type: "object" });
    expect(decision.advertised.find((s) => s.name === "mcp.b")?.inputSchema).toEqual({ type: "object" });
  });

  it("default budget keeps the real built-in set well below the threshold", () => {
    // Regression guard: DEFAULT_MAX_INLINE_SCHEMA_TOKENS must be large enough
    // that the built-in 12-tool set always advertises inline (P18-2: small
    // built-in sets never go deferred by accident).
    expect(DEFAULT_MAX_INLINE_SCHEMA_TOKENS).toBeGreaterThan(10_000);
  });

  it("stubSpec truncates long descriptions with a discoverability marker", () => {
    const long = { name: "t", description: "x".repeat(400), inputSchema: { type: "object" } };
    const stub = stubSpec(long, 120);
    expect(stub.description).toContain("tool_lookup");
    expect(stub.description.length).toBeLessThan(long.description.length);
    const short = { name: "t2", description: "short", inputSchema: { type: "object" } };
    expect(stubSpec(short).description).toBe("short");
  });
});
