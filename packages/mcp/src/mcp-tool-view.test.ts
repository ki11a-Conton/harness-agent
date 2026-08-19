import { describe, expect, it } from "vitest";
import { AgentError } from "@ar/contracts";
import type { McpToolInfoLike } from "./mcp-tool-view.js";
import { McpToolView, schemaHash } from "./mcp-tool-view.js";

function source(tools: McpToolInfoLike[]) {
  let current = tools;
  return {
    listTools: () => Promise.resolve(current),
    set(v: McpToolInfoLike[]) {
      current = v;
    },
  };
}

const TOOL_A = { name: "a", description: "do a", inputSchema: { type: "object", properties: { x: { type: "string" } } } };
const TOOL_B = { name: "b", inputSchema: { type: "object" } };

describe("P2-20 McpToolView — static & diff", () => {
  it("refresh without a pinned turn applies immediately and reports additions", async () => {
    const src = source([TOOL_A, TOOL_B]);
    const view = new McpToolView(src);
    const diff = await view.refresh();
    expect(diff.added).toEqual(["a", "b"]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(view.size()).toBe(2);
    expect(view.has("a")).toBe(true);
  });

  it("reports removed and changed tools on the next refresh", async () => {
    const src = source([TOOL_A, TOOL_B]);
    const view = new McpToolView(src);
    await view.refresh();
    const moved = src as unknown as { set(v: McpToolInfoLike[]): void };
    moved.set([TOOL_B, { ...TOOL_A, inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "string" } } } }]);
    const diff = await view.refresh();
    expect(diff.removed).toEqual([]); // 'b' still present; 'a' changed schema only
    expect(diff.changed.map((c) => c.name)).toEqual(["a"]);
    expect(diff.changed[0]?.oldHash).toBe(schemaHash(TOOL_A.inputSchema));
    moved.set([TOOL_B]);
    const diff2 = await view.refresh();
    expect(diff2.removed).toEqual(["a"]);
    expect(diff2.added).toEqual([]);
  });

  it("duplicate tool names throw TOOL_SCHEMA_ERROR without mutating the view", async () => {
    const src = source([TOOL_A]);
    const view = new McpToolView(src);
    await view.refresh();
    const moved = src as unknown as { set(v: McpToolInfoLike[]): void };
    moved.set([TOOL_A, { name: "a" }]); // duplicate "a"
    let error: AgentError | undefined;
    try {
      await view.refresh();
    } catch (e) {
      error = e as AgentError;
    }
    expect(error).toBeInstanceOf(AgentError);
    expect(error?.info.code).toBe("TOOL_SCHEMA_ERROR");
    // view unchanged; still exactly the single committed tool, schema of original.
    expect(view.size()).toBe(1);
    expect(view.snapshot()[0]!.schemaHash).toBe(schemaHash(TOOL_A.inputSchema));
  });

  it("a malformed (nameless) tool fails structurally and is not applied", async () => {
    const src = source([TOOL_A]);
    const view = new McpToolView(src);
    await view.refresh();
    const moved = src as unknown as { set(v: McpToolInfoLike[]): void };
    moved.set([{ name: "" }]);
    await expect(view.refresh()).rejects.toThrow(AgentError);
    expect(view.size()).toBe(1);
  });

  it("schema hash is stable regardless of object key order", () => {
    expect(schemaHash({ type: "object", a: 1, b: 2 })).toBe(schemaHash({ b: 2, a: 1, type: "object" }));
  });
});

describe("P2-20 McpToolView — turn snapshot isolation", () => {
  it("a refresh mid-turn is staged, NOT applied; the turn's view is frozen", async () => {
    const src = source([TOOL_A]);
    const view = new McpToolView(src);
    await view.refresh();
    view.beginTurn("turn-1");
    // Mid-turn the server adds "b".
    const moved = src as unknown as { set(v: McpToolInfoLike[]): void };
    moved.set([TOOL_A, TOOL_B]);
    const diff = await view.refresh();
    expect(diff.added).toEqual(["b"]);
    // The active turn must NOT see the new tool (no mid-turn bypass).
    expect(view.has("b")).toBe(false);
    expect(view.size()).toBe(1);
    // resolveTool for the not-yet-visible tool fails structurally.
    expect(() => view.resolveTool("b")).toThrow(AgentError);
  });

  it("new tools become visible only at the next safe boundary (beginTurn commit)", async () => {
    const src = source([TOOL_A]);
    const view = new McpToolView(src);
    await view.refresh();
    view.beginTurn("turn-1");
    const moved = src as unknown as { set(v: McpToolInfoLike[]): void };
    moved.set([TOOL_A, TOOL_B]);
    await view.refresh(); // staged only
    expect(view.has("b")).toBe(false);
    view.endTurn("turn-1");
    const boundaryDiff = view.beginTurn("turn-2"); // safe boundary applies staged
    expect(boundaryDiff.added).toEqual(["b"]);
    expect(view.has("b")).toBe(true);
    // The registered tool then flows through the normal pipeline (registered
    // as an ordinary tool at the boundary, subject to permission/sandbox).
    expect(view.resolveTool("b").name).toBe("b");
  });

  it("schema mismatch between provided schema and snapshot fails structurally", async () => {
    const src = source([TOOL_A]);
    const view = new McpToolView(src);
    await view.refresh();
    // Someone invokes with a schema that drifted from the snapshot.
    let error: AgentError | undefined;
    try {
      view.resolveTool("a", { type: "object", properties: { x: { type: "number" } } });
    } catch (e) {
      error = e as AgentError;
    }
    expect(error?.info.code).toBe("TOOL_SCHEMA_ERROR");
    // Matching schema resolves fine.
    expect(view.resolveTool("a", TOOL_A.inputSchema).name).toBe("a");
  });

  it("resolveTool rejects tools removed from the snapshot", async () => {
    const src = source([TOOL_A]);
    const view = new McpToolView(src);
    await view.refresh();
    const moved = src as unknown as { set(v: McpToolInfoLike[]): void };
    moved.set([TOOL_B]);
    await view.refresh(); // stage the removal
    view.beginTurn("t1");
    view.endTurn("t1");
    view.beginTurn("t2"); // safe boundary commits the removal
    expect(view.has("a")).toBe(false);
    expect(() => view.resolveTool("a")).toThrow(AgentError);
  });
});