import { describe, expect, it } from "vitest";
import { decideSchemaAdvert, type ToolSpec } from "@ar/contracts";
import { schemaAdvertPolicyFor } from "./benchmark-command.js";

const coreSpec: ToolSpec = { name: "read_file", description: "read a file", inputSchema: { type: "object" } };
const peripheralSpec: ToolSpec = { name: "context_pipeline", description: "context pipeline tool with a long schema", inputSchema: { type: "object", properties: { a: { type: "string" } } } };

describe("schemaAdvertPolicyFor (E1-05)", () => {
  it("baseline returns undefined (default full advertisement)", () => {
    expect(schemaAdvertPolicyFor(undefined)).toBeUndefined();
    expect(schemaAdvertPolicyFor("adaptive_recovery")).toBeUndefined();
  });

  it("tool_selector_deferred_schema returns a real policy", () => {
    const policy = schemaAdvertPolicyFor("tool_selector_deferred_schema");
    expect(policy).toBeDefined();
    expect(policy!.maxInlineTokens).toBe(1);
    // Core tools are kept full.
    expect(policy!.keepFull("read_file")).toBe(true);
    expect(policy!.keepFull("write_file")).toBe(true);
    expect(policy!.keepFull("exec")).toBe(true);
    // Peripheral tools are NOT kept full.
    expect(policy!.keepFull("context_pipeline")).toBe(false);
  });

  it("applying the policy actually defers peripheral tools (deferred=[] on baseline)", () => {
    const specs = [coreSpec, peripheralSpec];
    // Without the policy the small set advertises full (baseline behavior).
    const baseline = decideSchemaAdvert(specs, undefined);
    expect(baseline.mode).toBe("full");
    expect(baseline.deferred).toEqual([]);
    // With the candidate policy the peripheral tool is deferred to a stub.
    const policy = schemaAdvertPolicyFor("tool_selector_deferred_schema")!;
    const deferred = decideSchemaAdvert(specs, policy);
    expect(deferred.mode).toBe("deferred");
    expect(deferred.deferred).toContain("context_pipeline");
    expect(deferred.advertised.find((s) => s.name === "context_pipeline")!.inputSchema).toEqual({ type: "object" });
    // Core tool still advertises its full schema.
    expect(deferred.advertised.find((s) => s.name === "read_file")).toBeDefined();
  });
});
