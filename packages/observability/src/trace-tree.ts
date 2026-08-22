import type { AgentEvent } from "@ar/contracts";

/**
 * P20-6 — trace tree completeness.
 *
 * A turn must be reconstructible from the event stream as a tree:
 *
 *   turn
 *    ├─ model call
 *    │   ├─ tool calls            (usage rides the model.completed leaf)
 *    │   │   ├─ recovery actions  (recovery.decided under the failing tool)
 *    │   │   └─ subagent          (subagent.* under the delegating tool call)
 *    ├─ compaction
 *    └─ verification
 *
 * Every node carries a span identity (spanId / parentSpanId, P9-2). This
 * module rebuilds the tree purely from events — no hidden reasoning — so
 * `agent explain --tree` and episode analysis can answer "why was this tool
 * executed / why was it retried / why did the turn not complete".
 */

export type TraceNodeType =
  | "turn"
  | "model"
  | "tool"
  | "recovery"
  | "compaction"
  | "verification"
  | "subagent"
  | "other";

export interface TraceNode {
  /** span id when the events carry one, else a synthetic stable id. */
  id: string;
  type: TraceNodeType;
  label: string;
  detail?: string;
  /** The raw events attached to this node (chronological). */
  events: AgentEvent[];
  parentId?: string;
  children: TraceNode[];
}

function evType(event: AgentEvent): TraceNodeType {
  if (event.type === "turn.started" || event.type.startsWith("turn.")) return "turn";
  if (event.type.startsWith("model.")) return "model";
  if (event.type.startsWith("tool.") || event.type === "tools.selected") return "tool";
  if (event.type === "recovery.decided") return "recovery";
  if (event.type.startsWith("context.compacted") || event.type === "context.compacted") return "compaction";
  if (event.type.startsWith("verification.")) return "verification";
  if (event.type.startsWith("subagent.")) return "subagent";
  return "other";
}

function labelOf(event: AgentEvent): string {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case "model.started":
      return "model call";
    case "model.completed":
      return `model completed (${String(p.finishReason ?? "?")})`;
    case "tool.started":
      return String(p.tool ?? p.name ?? "tool");
    case "tool.completed":
      return `tool done: ${String(p.tool ?? p.name ?? "?")} (${String(p.status ?? "?")})`;
    case "tool.failed":
      return `tool failed: ${String(p.tool ?? p.name ?? "?")}`;
    case "recovery.decided":
      return `recovery: ${String(p.action ?? "?")} (${String(p.input ?? "?")})`;
    case "context.compacted":
      return "compaction";
    case "verification.completed":
      return `verification ${p.passed === true ? "passed" : "failed"}`;
    case "subagent.started":
      return `subagent: ${String(p.goal ?? p.subagentId ?? "?")}`;
    case "subagent.failed":
      return "subagent failed";
    default:
      return event.type;
  }
}

function spanIdOf(event: AgentEvent): string | undefined {
  return event.spanId;
}

function parentSpanOf(event: AgentEvent): string | undefined {
  if (event.parentSpanId !== undefined) return event.parentSpanId;
  // Fallbacks that still keep the tree parent/child complete.
  const p = event.payload as Record<string, unknown>;
  if (event.type.startsWith("tool.") && typeof p.toolCallId === "string") return p.toolCallId;
  if (event.type.startsWith("subagent.") && typeof p.parentCallId === "string") return p.parentCallId;
  return undefined;
}

/**
 * P20-6 — rebuild the turn's trace tree from events. Pure and deterministic:
 *   - every event with a span id attaches to (or creates) its span node;
 *   - events without spans attach to the current turn root by their type
 *     (recovery/compaction/verification/subagent), keeping the five
 *     documented branches present even for producers that emit no span.
 */
export function buildTraceTree(events: AgentEvent[]): TraceNode {
  const nodes = new Map<string, TraceNode>();
  const root: TraceNode = {
    id: "turn",
    type: "turn",
    label: "turn",
    events: [],
    children: [],
  };
  nodes.set(root.id, root);

  const attach = (node: TraceNode, parentId: string | undefined) => {
    node.parentId = parentId ?? root.id;
    const parent = nodes.get(node.parentId) ?? root;
    parent.children.push(node);
  };

  for (const event of events) {
    const type = evType(event);
    const span = spanIdOf(event);
    const parent = parentSpanOf(event);
    const nodeId = span ?? `${type}:${event.sequence}`;
    let node = nodes.get(nodeId);
    if (node === undefined) {
      node = {
        id: nodeId,
        type,
        label: labelOf(event),
        events: [],
        children: [],
        parentId: parent ?? root.id,
      };
      nodes.set(nodeId, node);
      attach(node, parent);
    }
    node.events.push(event);
    // Keep labels informative: the terminal model/tool event wins.
    if (
      (type === "model" && event.type === "model.completed") ||
      (type === "tool" && (event.type === "tool.completed" || event.type === "tool.failed")) ||
      (type === "verification" && (event.type === "verification.completed" || event.type === "verification.failed"))
    ) {
      node.label = labelOf(event);
    }
  }

  // Deterministic child order (by id) so rendering is stable.
  for (const node of nodes.values()) {
    node.children.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return root;
}

/** Render the tree as plain text (─ ├ └), for `agent explain --tree`. */
export function renderTraceTree(root: TraceNode, maxDepth = 12): string[] {
  const lines: string[] = [];
  const walk = (node: TraceNode, prefix: string, depth: number, isLast: boolean) => {
    if (depth > maxDepth) return;
    lines.push(`${prefix}${isLast ? "└─ " : "├─ "}${node.label}${node.events.length > 0 ? ` (${node.events.length} event${node.events.length > 1 ? "s" : ""})` : ""}`);
    const children = node.children;
    for (let i = 0; i < children.length; i += 1) {
      walk(children[i]!, `${prefix}${isLast ? "   " : "│  "}`, depth + 1, i === children.length - 1);
    }
  };
  lines.push(root.label);
  for (let i = 0; i < root.children.length; i += 1) {
    walk(root.children[i]!, "", 1, i === root.children.length - 1);
  }
  return lines;
}
