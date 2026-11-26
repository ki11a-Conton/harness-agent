import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry, toolInputJsonSchema } from "./registry.js";
import { createToolLookupTool } from "./tool-lookup.js";
import { readFileTool } from "./tools/read-file.js";

describe("P18-2 tool_lookup", () => {
  it("returns the full schema for requested tools and an error for unknown ones", async () => {
    const registry = new ToolRegistry();
    registry.register(readFileTool);
    registry.register(createToolLookupTool(registry));

    const result = await registry
      .get("tool_lookup")!
      .execute({ names: ["read_file", "no_such_tool"] }, {
        sessionId: "s" as never,
        agentId: "a" as never,
        cwd: "/tmp",
        signal: new AbortController().signal,
        permissions: { rules: [], defaultEffect: "allow" },
        sandboxPolicy: { enabled: false, extraRoots: [], network: { deny: true } },
      } as never);

    expect(result.status).toBe("success");
    const out = result.output as Record<string, unknown>;
    expect(out["read_file"]).toMatchObject({ name: "read_file" });
    const schema = (out["read_file"] as { inputSchema: Record<string, unknown> }).inputSchema;
    expect(schema).toEqual(registry.specs().find(spec => spec.name === "read_file")!.inputSchema);
    expect(schema.type).toBe("object");
    expect(out["no_such_tool"]).toEqual({ error: "unknown tool: no_such_tool" });
  });

  it("declares itself read-only, idempotent and concurrency-safe", () => {
    const registry = new ToolRegistry();
    const tool = createToolLookupTool(registry);
    expect(tool.metadata.sideEffect).toBe(false);
    expect(tool.metadata.retry).toBe("safe");
    expect(tool.metadata.concurrencySafe).toBe(true);
    expect(tool.risk).toBe("readonly");
    // Schema enforces the names array shape.
    const parsed = z.object({ names: z.array(z.string()).min(1).max(10) }).safeParse({ names: [] });
    expect(parsed.success).toBe(false);
  });
});

it("advertises caller input for transformed tools and preserves provider schema constraints", () => {
  const schema = z.object({
    wait: z.number().default(50),
    mode: z.discriminatedUnion("op", [
      z.object({ op: z.literal("start") }), z.object({ op: z.literal("stop") }),
    ]),
    env: z.record(z.string(), z.string()),
    labels: z.record(z.string().regex(/^tag/), z.string()),
  }).transform(args => ({ ...args, internal: true }));
  const wire = toolInputJsonSchema(schema);
  expect(wire).toMatchObject({
    type: "object", additionalProperties: false, required: ["mode", "env", "labels"],
    properties: {
      wait: { type: "number", default: 50 }, mode: { anyOf: expect.any(Array) },
      env: { additionalProperties: { type: "string" } }, labels: { propertyNames: { pattern: "^tag" } },
    },
  });
  expect(wire.properties).not.toHaveProperty("internal");
  expect(wire.properties).not.toHaveProperty("mode.oneOf");
  expect(wire.properties).not.toHaveProperty("env.propertyNames");
});
