import { applyWorkingStateMutation, newWorkingState, toolNameOf, type AgentEvent, type Message, type Session, type WorkingStateMutation } from "@ar/contracts";
import { updatePlanTool } from "@ar/tools";

export interface ActivityWireEvent { type: string; data: Record<string, unknown> }
type TodoItem = { content: string; status: "pending" | "completed" };
type ChildRow = { id: string; createdAt: number; mode: "one-shot"; label?: string };

/** Pure UI projection of committed native working-state and child discovery facts.
 * It never renames native tools, invents submitted/approved plans, or runs a goal loop. */
export function createActivityProjection(session: Session, messages: readonly Message[], children: readonly Session[] = [], agentPreset = session.agentId as string) {
  let working = newWorkingState("");
  let todos: TodoItem[] | null = null;
  const emitted = new Set<string>();
  const childRows: ChildRow[] = [];
  const childIds = new Set<string>();
  return {
    consume(event: AgentEvent): ActivityWireEvent[] {
      if (event.type === "turn.started") { working = newWorkingState(""); return []; }
      if (event.type === "tool.completed" && toolNameOf(event.payload) === "update_plan" && event.payload.status === "success") {
        const id = event.payload.toolCallId;
        if (typeof id !== "string" || emitted.has(id)) return [];
        const owner = messages.find(message => message.role === "assistant" && message.turnId === event.turnId && message.toolCalls?.some(call => call.id === id));
        const call = owner?.toolCalls?.find(call => call.id === id);
        const settled = messages.find(message => message.role === "tool" && message.turnId === event.turnId && message.toolCallId === id);
        if (call === undefined || settled === undefined) return []; // The source event can precede Runtime's actual state/result commit.
        const parsed = updatePlanTool.inputSchema.safeParse(call.args);
        if (!parsed.success) return [];
        emitted.add(id);
        for (const mutation of (parsed.data as { mutations: WorkingStateMutation[] }).mutations) applyWorkingStateMutation(working, mutation);
        const steps = [...new Set([...working.plan, ...working.pending, ...working.completed])];
        todos = steps.map(content => ({ content, status: working.completed.includes(content) ? "completed" : "pending" }));
        return [{ type: "todo/write", data: { todos, source: { kind: "harness-working-state", eventId: event.id, toolCallId: id } } }];
      }
      if (event.type === "subagent.started" && typeof event.payload.childSessionId === "string") {
        const child = children.find(child => child.id === event.payload.childSessionId && child.parentId === session.id);
        if (child === undefined || childIds.has(child.id)) return [];
        childIds.add(child.id);
        const label = typeof event.payload.goal === "string" ? event.payload.goal : undefined;
        childRows.push({ id: child.id, createdAt: child.createdAt, mode: "one-shot", ...(label === undefined ? {} : { label }) });
        return [{ type: "subagent/catalog", data: { version: 0, childId: child.id, childCreatedAt: child.createdAt, mode: "one-shot", ...(label === undefined ? {} : { label }) } }];
      }
      if (event.type === "human.message" && event.payload.component === "web-command") {
        const value = event.payload.webCommand;
        if (record(value) && typeof value.commandId === "string") {
          if (value.phase === "run" && typeof value.name === "string" && typeof value.args === "string") return [{ type: "command/run", data: { commandId: value.commandId, name: value.name, args: value.args, source: { kind: "user" } } }];
          if (value.phase === "done" && (value.kind === "success" || value.kind === "error") && (value.text === undefined || typeof value.text === "string")) return [{ type: "command/done", data: { commandId: value.commandId, kind: value.kind, ...(value.text === undefined ? {} : { text: value.text }) } }];
        }
      }
      return [];
    },
    values(): { todos: readonly TodoItem[] | null; subagentCatalog: readonly ChildRow[]; agentPreset: string } {
      return { todos: todos === null ? null : structuredClone(todos), subagentCatalog: structuredClone(childRows), agentPreset };
    },
  };
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
