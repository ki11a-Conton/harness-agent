import { z } from "zod";
import type {
  AgentEvent,
  EventStore,
  Message,
  Session,
  SessionId,
  SessionStore,
  Turn,
  TurnId,
} from "@ar/contracts";

/** In-memory stores for core tests (Fake infrastructure per plan §97). */

export class MemorySessionStore implements SessionStore {
  sessions = new Map<string, Session>();
  turns = new Map<string, Turn>();
  messages: Message[] = [];
  snapshots = new Map<string, Record<string, unknown>>();

  async createSession(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async getSession(id: SessionId): Promise<Session | undefined> {
    return this.sessions.get(id);
  }

  async updateSession(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async listSessions(): Promise<Session[]> {
    return [...this.sessions.values()];
  }

  async createTurn(turn: Turn): Promise<void> {
    this.turns.set(turn.id, turn);
  }

  async getTurn(id: TurnId): Promise<Turn | undefined> {
    return this.turns.get(id);
  }

  async updateTurn(turn: Turn): Promise<void> {
    this.turns.set(turn.id, turn);
  }

  async listTurns(sessionId: SessionId): Promise<Turn[]> {
    return [...this.turns.values()].filter((t) => t.sessionId === sessionId);
  }

  async appendMessage(message: Message): Promise<void> {
    this.messages.push(message);
  }

  async listMessages(sessionId: SessionId): Promise<Message[]> {
    return this.messages.filter((m) => m.sessionId === sessionId);
  }

  async listMessagesByTurn(sessionId: SessionId, turnId: TurnId): Promise<Message[]> {
    return this.messages.filter((m) => m.sessionId === sessionId && m.turnId === turnId);
  }

  async saveStateSnapshot(sessionId: SessionId, snapshot: Record<string, unknown>): Promise<void> {
    this.snapshots.set(sessionId, snapshot);
  }

  async loadStateSnapshot(sessionId: SessionId): Promise<Record<string, unknown> | undefined> {
    return this.snapshots.get(sessionId);
  }
}

export class MemoryEventStore implements EventStore {
  events: AgentEvent[] = [];
  private seq = 0;

  async nextSequence(_sessionId: SessionId): Promise<number> {
    return this.seq + 1;
  }

  async append(event: AgentEvent): Promise<AgentEvent> {
    const seq = ++this.seq;
    const stored = { ...event, sequence: seq };
    this.events.push(stored);
    return stored;
  }

  async appendNew(event: Omit<AgentEvent, "sequence">): Promise<AgentEvent> {
    return this.append({ ...event, sequence: -1 });
  }

  get durabilityLevel(): "memory" {
    return "memory";
  }

  async flushThrough(_sessionId: SessionId, _sequence: number): Promise<void> {}

  async list(sessionId: SessionId, opts?: { afterSequence?: number; limit?: number }): Promise<AgentEvent[]> {
    let list = this.events.filter((e) => e.sessionId === sessionId);
    if (opts?.afterSequence !== undefined) {
      list = list.filter((e) => e.sequence > opts.afterSequence!);
    }
    if (opts?.limit !== undefined) {
      list = list.slice(0, opts.limit);
    }
    return list;
  }

  async *stream(sessionId: SessionId, opts?: { afterSequence?: number }): AsyncIterable<AgentEvent> {
    for (const e of this.events) {
      if (e.sessionId !== sessionId) continue;
      if (opts?.afterSequence !== undefined && e.sequence <= opts.afterSequence) continue;
      yield e;
    }
  }
}
// ---------------------------------------------------------------------------
// P23-4 — default test tool catalog. Tests that exercise control flow with a
// FakeOrchestrator need the model's advertised tools to be RESOLVABLE in the
// frozen step router (P23-4 TOOL_NOT_IN_STEP otherwise fires). This catalog
// covers the conventional tool names; the definitions are inert stubs because
// a FakeOrchestrator never executes them.
// ---------------------------------------------------------------------------

const DEFAULT_TEST_TOOL_NAMES = [
  "read_file",
  "write_file",
  "edit_file",
  "exec",
  "search_files",
  "grep_search",
  "repo_tree",
  "repo_map",
  "update_plan",
  "ask_user",
  "env_snapshot",
  "discover_commands",
  "tool_lookup",
] as const;

/** Build an inert tool definition for a test tool name. */
export function inertTestToolDefinition(name: string): import("@ar/contracts").ToolDefinition {
  return {
    name,
    description: `test stub for ${name}`,
    inputSchema: z.object({}),
    risk: "readonly",
    metadata: { name, version: "1.0.0", sideEffect: false, network: false, filesystem: false, process: false, interactive: false },
    async execute() {
      return { status: "success", output: "" };
    },
  };
}

/** A StepToolCatalog covering the conventional tool names (inert definitions).
 *  Pass it as AgentRuntime toolRegistry in tests that drive tools through a
 *  FakeOrchestrator, so the frozen step router can resolve those calls. */
export function defaultTestToolCatalog(): import("../runtime/tool-catalog.js").StepToolCatalog {
  const defs = [...DEFAULT_TEST_TOOL_NAMES].map((name: string) => inertTestToolDefinition(name));
  return {
    get: (name) => defs.find((d) => d.name === name),
    list: () => defs,
    specs: () => defs.map((d) => ({ name: d.name, description: d.description, inputSchema: {} as never })),
  };
}
