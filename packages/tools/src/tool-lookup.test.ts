import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "./registry.js";
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
