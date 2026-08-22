import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@ar/contracts";
import { buildTraceTree, renderTraceTree, type TraceNode } from "./trace-tree.js";

function ev(
  type: AgentEvent["type"],
  payload: Record<string, unknown>,
  spans: { spanId?: string; parentSpanId?: string } = {},
  sequence = 1,
): AgentEvent {
  return {
    id: `e-${sequence}` as never,
    sessionId: "s" as never,
    sequence,
    timestamp: sequence * 1000,
    type,
    payload,
    ...spans,
  } as unknown as AgentEvent;
}

function find(root: TraceNode, type: string, label?: string): TraceNode | undefined {
  const queue = [...root.children];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node.type === type && (label === undefined || node.label === label)) return node;
    queue.push(...node.children);
  }
  return undefined;
}

const TURN_EVENTS: AgentEvent[] = [
  ev("turn.started", { goal: "fix the flaky test" }, {}, 1),
  // model call (span = call1) with usage on completion
  ev("model.started", { callId: "call1" }, { spanId: "call1" }, 2),
  ev("model.completed", { callId: "call1", finishReason: "tool_calls", toolCalls: 1, usage: { inputTokens: 10, outputTokens: 5, source: "measured" } }, { spanId: "call1" }, 3),
  // tool call under the model (parent = call1)
  ev("tool.started", { toolCallId: "tc-1", tool: "read_file" }, { spanId: "tc-1", parentSpanId: "call1" }, 4),
  ev("tool.completed", { toolCallId: "tc-1", tool: "read_file", status: "success", durationMs: 10 }, { spanId: "tc-1", parentSpanId: "call1" }, 5),
  // a second failing tool triggers recovery (parent = tc-2)
  ev("tool.started", { toolCallId: "tc-2", tool: "exec" }, { spanId: "tc-2", parentSpanId: "call1" }, 6),
  ev("tool.failed", { toolCallId: "tc-2", tool: "exec", error: { message: "boom" } }, { spanId: "tc-2", parentSpanId: "call1" }, 7),
  ev("recovery.decided", { action: "change_strategy", input: "tool_failure", tool: "exec", toolCallId: "tc-2" }, {}, 8),
  // compaction + verification (no span — must still attach to the turn)
  ev("context.compacted", { reason: "auto-compact", compressed: 1 }, {}, 9),
  ev("verification.completed", { passed: true, durationMs: 5 }, {}, 10),
  // subagent spawned by a delegate tool call
  ev("subagent.started", { subagentId: "sa-1", parentCallId: "tc-3", goal: "investigate" }, { spanId: "sa-1", parentSpanId: "tc-3" }, 11),
  ev("turn.completed", { status: "completed", terminationReason: "model_stopped", grade: "unverified_complete" }, {}, 12),
];

describe("P20-6 trace tree completeness", () => {
  it("rebuilds the turn → model → tool hierarchy from span identity", () => {
    const root = buildTraceTree(TURN_EVENTS);
    const model = find(root, "model");
    expect(model).toBeDefined();
    expect(model!.id).toBe("call1");
    // tool calls hang under the model (parent span = call1)
    const read = find(root, "tool", "tool done: read_file (success)");
    expect(read).toBeDefined();
    expect(read!.parentId).toBe("call1");
  });

  it("keeps the five documented branches present (recovery/compaction/verification/subagent)", () => {
    const root = buildTraceTree(TURN_EVENTS);
    expect(find(root, "recovery")).toBeDefined();
    expect(find(root, "compaction")).toBeDefined();
    expect(find(root, "verification")).toBeDefined();
    const subagent = find(root, "subagent");
    expect(subagent).toBeDefined();
    expect(subagent!.parentId).toBe("tc-3");
  });

  it("usage rides the model.completed leaf of the model node", () => {
    const root = buildTraceTree(TURN_EVENTS);
    const model = find(root, "model");
    const completed = model!.events.find((e) => e.type === "model.completed");
    const usage = completed!.payload.usage as { inputTokens: number; outputTokens: number };
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(5);
  });

  it("renders a stable tree with every node's label and event count", () => {
    const lines = renderTraceTree(buildTraceTree(TURN_EVENTS));
    const text = lines.join("\n");
    expect(text).toContain("turn");
    expect(text).toContain("model completed (tool_calls)");
    expect(text).toContain("tool done: read_file (success) (2 events)");
    expect(text).toContain("recovery: change_strategy (tool_failure)");
    expect(text).toContain("subagent: investigate");
    // deterministic: two renders are identical
    expect(renderTraceTree(buildTraceTree(TURN_EVENTS))).toEqual(lines);
  });
});
