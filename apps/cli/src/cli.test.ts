import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentDefinition,
  AgentEvent,
  ApprovalRequest,
  EventStore,
  Message,
  ModelEvent,
  ModelProvider,
  Session,
  SessionId,
  SessionStore,
  Skill,
  ToolCallRequest,
  ToolExecutionContext,
  ToolOrchestrator,
  ToolResult,
  ToolSpec,
  Turn,
  TurnId,
} from "@ar/contracts";
import { errorInfo, newAgentId, newApprovalId, newSkillId } from "@ar/contracts";
import { AgentRuntime, DefaultLoadedSessionManager, defaultSandboxPolicy } from "@ar/core";
import { ScriptedModelProvider } from "@ar/model";
import { createRuntimeRpc, InMemoryTransport } from "@ar/gateway";
import { JSONLEventStore } from "@ar/events";
import { JSONLSessionStore, SessionService } from "@ar/session";
import { InMemoryApprovalStore } from "@ar/security";
import { readFileTool, ToolRegistry } from "@ar/tools";
import { runChecks } from "./doctor.js";
import type { CommandDeps } from "./commands.js";
import { runCommand } from "./commands.js";
import { createDefaultDeps, registerBuiltinTools } from "./main.js";

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: "cli-agent",
  description: "cli test agent",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "you are a cli test agent",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

const TOOL_SPEC: ToolSpec = {
  name: "read_file",
  description: "reads a file",
  inputSchema: {},
};

const SKILL_SPEC: Skill = {
  id: newSkillId(),
  path: "skills/echo",
  manifest: { name: "echo", description: "echo skill", version: "1.0.0" },
  status: "discovered",
  discoveredAt: 0,
};

/** In-memory SessionStore (repo convention: fakes are per-file). */
class MemSessionStore implements SessionStore {
  sessions = new Map<string, Session>();
  turns = new Map<string, Turn>();
  messages: Message[] = [];
  failList = false;

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
    if (this.failList) throw new Error("disk on fire");
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
  async saveStateSnapshot(_sessionId: SessionId, _snapshot: Record<string, unknown>): Promise<void> {}
  async loadStateSnapshot(): Promise<Record<string, unknown> | undefined> {
    return undefined;
  }
}

/** In-memory EventStore (mirrors the core test fake; not exported). */
class MemEventStore implements EventStore {
  events: AgentEvent[] = [];
  private seq = 0;
  failList = false;

  async nextSequence(_sessionId: SessionId): Promise<number> {
    return this.seq + 1;
  }
  async appendNew(event: Omit<AgentEvent, "sequence">): Promise<AgentEvent> {
    return this.append({ ...event, sequence: -1 });
  }

  async append(event: AgentEvent): Promise<AgentEvent> {
    const seq = ++this.seq;
    const stored = { ...event, sequence: seq };
    this.events.push(stored);
    return stored;
  }
  async list(sessionId: SessionId, opts?: { afterSequence?: number; limit?: number }): Promise<AgentEvent[]> {
    if (this.failList) throw new Error("journal corrupted");
    let list = this.events.filter((e) => e.sessionId === sessionId);
    if (opts?.afterSequence !== undefined) list = list.filter((e) => e.sequence > opts.afterSequence!);
    if (opts?.limit !== undefined) list = list.slice(0, opts.limit);
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

class FakeOrchestrator implements ToolOrchestrator {
  calls: ToolCallRequest[] = [];
    async executeBound(request: import("@ar/contracts").BoundToolCallRequest, ctx: import("@ar/contracts").ToolExecutionContext): Promise<import("@ar/contracts").ToolResult> {
    return this.execute(request, ctx);
  }

async execute(request: ToolCallRequest, _context: ToolExecutionContext): Promise<ToolResult> {
    this.calls.push(request);
    return { status: "success", output: "ok" };
  }
}

/** Model that blocks mid-turn until its AbortSignal fires, then finishes. */
class BlockingProvider implements ModelProvider {
  readonly id = "blocking";
  private releaseBlocked?: () => void;
  readonly blocked: Promise<void> = new Promise((resolve) => {
    this.releaseBlocked = resolve;
  });
  listModels() {
    return Promise.resolve([]);
  }
  createClient() {
    const self = this;
    return {
      async *generate(
        _request: unknown,
        signal: AbortSignal,
      ): AsyncGenerator<ModelEvent, void, void> {
        yield { type: "started", timestamp: 0 };
        yield { type: "text_delta", text: "thinking", timestamp: 0 };
        self.releaseBlocked?.();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield {
          type: "completed",
          result: { finishReason: "stop", text: "done" },
          timestamp: 0,
        };
      },
    };
  }
}

function makeDeps(opts: { provider?: ModelProvider } = {}) {
  const store = new MemSessionStore();
  const events = new MemEventStore();
  const approvalStore = new InMemoryApprovalStore();
  const provider = opts.provider ?? new ScriptedModelProvider([ScriptedModelProvider.text("hello world")]);
  const runtime = new AgentRuntime({
      toolRegistry: defaultTestToolCatalog(),
      permissiveToolResolution: true,
    store,
    events,
    modelProvider: provider,
    orchestrator: new FakeOrchestrator(),
    agents: [AGENT],
  });
  const sessionService = new SessionService({ store });
  const toolRegistry = new ToolRegistry();
  registerBuiltinTools(toolRegistry);
  const sessions = new DefaultLoadedSessionManager({ runtime, store });
  const registry = createRuntimeRpc(runtime, {
    sessionService,
    sessions,
    approvalStore,
    events,
    listAgents: () => [AGENT],
    listTools: () => [TOOL_SPEC],
    listSkills: () => [SKILL_SPEC],
  });
  const { client, server } = InMemoryTransport.pair();
  server.connect(registry);
  const deps: CommandDeps = {
    rpc: client,
    store,
    events,
    sessionService,
    approvalStore,
    introspection: {
      profile: "test",
      registeredTools: ["read_file", "write_file", "edit_file", "search_files", "exec"],
      stores: {
        session: store.constructor.name,
        events: events.constructor.name,
        approval: approvalStore.constructor.name,
      },
      features: {
        context: false,
        verifier: false,
        checkpoint: false,
        artifacts: false,
        memory: false,
        learning: false,
        delegation: false,
        scheduler: false,
        mcp: false,
        plugins: false,
        skills: false,
        usageAccounting: false,
        runBudget: false,
      },
      persistence: {
        mode: "in-memory",
        degraded: false,
        reasons: [],
        stores: { approval: approvalStore.constructor.name },
      },
    },
    doctor: {
      modelProvider: provider,
      sandboxPolicy: defaultSandboxPolicy(),
      permissions: AGENT.permissions,
      workspaceRoot: process.cwd(),
      toolRegistry,
      skills: undefined,
      plugins: undefined,
      sessionStore: store,
      eventStore: events,
    },
  };
  return { deps, store, events, provider, approvalStore };
}

describe("agent run (plan §173 structured outcome)", () => {
  it("completes a turn and prints the structured outcome", async () => {
    const { deps, store } = makeDeps();
    const result = await runCommand(["run", "C:\\work", "do it"], deps);
    expect(result.exitCode).toBe(0);
    const out = result.lines.join("\n");
    expect(out).toContain("run: session ");
    expect(out).toContain("status: completed");
    expect(out).toContain("summary: hello world");
    expect(out).toContain("files changed: (none)");
    expect(out).toContain("tests: no verification gate configured");
    expect(out).toContain("verification: no verification gate configured");
    expect(out).toContain("remaining issues: (none)");
    expect(out).toContain("tool calls: 0");
    expect(out).toContain("iterations: 0");
    expect((await store.listSessions()).length).toBe(1);
  });

  it("reports files changed from tool calls with a path", async () => {
    const { deps } = makeDeps({
      provider: new ScriptedModelProvider([
        ScriptedModelProvider.toolCall("write_file", { path: "a.txt" }),
        ScriptedModelProvider.text("done"),
      ]),
    });
    const result = await runCommand(["run", "C:\\work", "write it"], deps);
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain("files changed: a.txt");
  });

  it("fails with exit code 1 when the model errors", async () => {
    const { deps } = makeDeps({
      provider: new ScriptedModelProvider([
        [{ type: "error", error: errorInfo("MODEL_ERROR", "boom"), timestamp: 0 }],
      ]),
    });
    const result = await runCommand(["run", "C:\\work", "explode"], deps);
    expect(result.exitCode).toBe(1);
    const out = result.lines.join("\n");
    expect(out).toContain("status: failed");
    expect(out).toContain("remaining issues: failed: MODEL_ERROR — boom");
  });

  it("rejects missing arguments with usage", async () => {
    const { deps } = makeDeps();
    const result = await runCommand(["run"], deps);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("agent run: expected <cwd> <text>");
    expect(result.lines.join("\n")).toContain("usage: agent <command> [args]");
  });
});

describe("agent resume", () => {
  it("prints the session state", async () => {
    const { deps } = makeDeps();
    const session = (await deps.rpc.request("session.create", {
      agentId: AGENT.id,
      cwd: "C:\\work",
    })) as Session;
    const result = await runCommand(["resume", session.id], deps);
    expect(result.exitCode).toBe(0);
    const out = result.lines.join("\n");
    expect(out).toContain(`session: ${session.id}`);
    expect(out).toContain(`agent: ${AGENT.id}`);
    expect(out).toContain("model: scripted/scripted-model");
    expect(out).toContain("status: active");
    expect(out).toContain("cwd: C:\\work");
  });

  it("fails with exit code 1 for an unknown session", async () => {
    const { deps } = makeDeps();
    const result = await runCommand(["resume", "session_nope"], deps);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("cannot resume unknown session session_nope");
  });
});

describe("agent cancel", () => {
  it("cancels a running turn", async () => {
    const provider = new BlockingProvider();
    const { deps, store } = makeDeps({ provider });
    const runPromise = runCommand(["run", "C:\\work", "block me"], deps);
    await provider.blocked;
    const session = (await store.listSessions())[0]!;
    const turn = (await store.listTurns(session.id))[0]!;
    const cancel = await runCommand(["cancel", session.id, turn.id], deps);
    expect(cancel.exitCode).toBe(0);
    expect(cancel.lines.join(" ")).toContain("cancel: cancel_requested");
    const outcome = await runPromise;
    expect(outcome.exitCode).toBe(1);
    expect(outcome.lines.join("\n")).toContain("status: cancelled");
  });

  it("reports not_running for an idle turn", async () => {
    const { deps } = makeDeps();
    const session = (await deps.rpc.request("session.create", {
      agentId: AGENT.id,
      cwd: "C:\\work",
    })) as Session;
    const { turnId } = (await deps.rpc.request("session.send", {
      sessionId: session.id,
      text: "hi",
    })) as { turnId: string };
    const result = await runCommand(["cancel", session.id, turnId], deps);
    expect(result.exitCode).toBe(0);
    expect(result.lines.join(" ")).toContain("cancel: not_running");
  });
});

describe("agent approve", () => {
  function pendingApproval(store: InMemoryApprovalStore): ApprovalRequest {
    const request: ApprovalRequest = {
      id: newApprovalId(),
      sessionId: "session_approve_cli" as SessionId,
      agentId: AGENT.id,
      action: "tool.execute",
      target: "rm -rf /tmp/x",
      reason: "cli approval test",
      createdAt: 1_000,
      expiresAt: Date.now() + 60_000,
    };
    store.create(request);
    return request;
  }

  it("resolves allow and prints the request + decision", async () => {
    const { deps, approvalStore } = makeDeps();
    const request = pendingApproval(approvalStore);
    const result = await runCommand(["approve", request.id, "allow"], deps);
    expect(result.exitCode).toBe(0);
    const out = result.lines.join("\n");
    expect(out).toContain(`approval: ${request.id}`);
    expect(out).toContain("action: tool.execute");
    expect(out).toContain("target: rm -rf /tmp/x");
    expect(out).toContain("decision: allow (decided by cli)");
  });

  it("resolves deny", async () => {
    const { deps, approvalStore } = makeDeps();
    const request = pendingApproval(approvalStore);
    const result = await runCommand(["approve", request.id, "deny"], deps);
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain("decision: deny (decided by cli)");
  });

  it("fails with exit code 1 for an unknown approval", async () => {
    const { deps } = makeDeps();
    const result = await runCommand(["approve", newApprovalId(), "allow"], deps);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("unknown or already-resolved approval");
  });

  it("rejects a value that is not allow or deny", async () => {
    const { deps, approvalStore } = makeDeps();
    const request = pendingApproval(approvalStore);
    const result = await runCommand(["approve", request.id, "maybe"], deps);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("value must be allow or deny");
  });
});

describe("agent listings", () => {
  it("lists agents, tools and skills over the RPC surface", async () => {
    const { deps } = makeDeps();
    const agents = await runCommand(["agents"], deps);
    expect(agents.exitCode).toBe(0);
    expect(agents.lines.join("\n")).toContain(`agent ${AGENT.id}: cli-agent — cli test agent [primary]`);

    const tools = await runCommand(["tools"], deps);
    expect(tools.exitCode).toBe(0);
    expect(tools.lines.join("\n")).toContain("tool read_file: reads a file");

    const skills = await runCommand(["skills"], deps);
    expect(skills.exitCode).toBe(0);
    expect(skills.lines.join("\n")).toContain(`skill ${SKILL_SPEC.id}: echo v1.0.0 [discovered]`);
  });

  it("lists sessions from the store; empty store prints (none)", async () => {
    const { deps } = makeDeps();
    const empty = await runCommand(["sessions"], deps);
    expect(empty.exitCode).toBe(0);
    expect(empty.lines).toEqual(["(none)"]);

    const session = (await deps.rpc.request("session.create", {
      agentId: AGENT.id,
      cwd: "C:\\work",
    })) as Session;
    const listed = await runCommand(["sessions"], deps);
    expect(listed.exitCode).toBe(0);
    expect(listed.lines.join("\n")).toContain(`session ${session.id}: agent=${AGENT.id} status=active cwd=C:\\work`);
  });
});

describe("agent trace", () => {
  it("exports an episode package to the output directory", async () => {
    const { deps, store } = makeDeps();
    const outDir = await mkdtemp(join(tmpdir(), "cli-trace-"));
    const cwd = await mkdtemp(join(tmpdir(), "cli-cwd-"));
    try {
      const run = await runCommand(["run", cwd, "hello"], deps);
      expect(run.exitCode).toBe(0);
      const sessionId = (await store.listSessions())[0]!.id;
      const trace = await runCommand(["trace", sessionId, outDir], deps);
      expect(trace.exitCode).toBe(0);
      const out = trace.lines.join("\n");
      expect(out).toContain("trace: exported episode to");
      expect(out).toContain(`trace: session ${sessionId}`);
      const files = await readdir(outDir);
      expect(files).toEqual(
        expect.arrayContaining(["events.jsonl", "summary.json", "session.json", "metrics.json"]),
      );
      expect(files).toHaveLength(10);
    } finally {
      await rm(outDir, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("agent doctor (plan §87)", () => {
  it("reports every check area and exits 0 when nothing is broken", async () => {
    const { deps } = makeDeps();
    const result = await runCommand(["doctor"], deps);
    expect(result.exitCode).toBe(0);
    const out = result.lines.join("\n");
    expect(out).toContain("[OK] model provider");
    expect(out).toContain("[OK] sandbox");
    expect(out).toContain("[OK] workspace");
    expect(out).toContain("[OK] session store");
    expect(out).toContain("[OK] event store");
    expect(out).toContain("doctor: 8 ok, 4 warning(s), 0 error(s)");
  });

  it("exits 1 with [ERROR] when a store is broken", async () => {
    const { deps, store } = makeDeps();
    store.failList = true;
    const result = await runCommand(["doctor"], deps);
    expect(result.exitCode).toBe(1);
    const out = result.lines.join("\n");
    expect(out).toContain("[ERROR] session store — disk on fire");
    expect(out).toContain("doctor: 7 ok, 4 warning(s), 1 error(s)");
  });

  it("runChecks reports ERROR for a throwing event store", async () => {
    const { deps, events } = makeDeps();
    events.failList = true;
    const checks = await runChecks({ ...deps.doctor, eventStore: events });
    const eventCheck = checks.find((c) => c.name === "event store");
    expect(eventCheck?.status).toBe("ERROR");
    expect(eventCheck?.detail).toContain("journal corrupted");
  });
});

describe("agent command dispatch", () => {
  it("unknown commands exit 1 with usage", async () => {
    const { deps } = makeDeps();
    const result = await runCommand(["frobnicate"], deps);
    expect(result.exitCode).toBe(1);
    const out = result.lines.join("\n");
    expect(out).toContain("unknown command: frobnicate");
    expect(out).toContain("usage: agent <command> [args]");
  });

  it("cancel with missing arguments exits 1 with usage", async () => {
    const { deps } = makeDeps();
    const result = await runCommand(["cancel", "session_1"], deps);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("agent cancel: expected <sessionId> <turnId>");
  });
});

describe("default host wiring (createDefaultDeps)", () => {
  it("registers the five builtin tools on the RPC surface", async () => {
    const deps = await createDefaultDeps({
      provider: new ScriptedModelProvider([ScriptedModelProvider.text("hi")]),
    });
    const result = await runCommand(["tools"], deps);
    expect(result.exitCode).toBe(0);
    const out = result.lines.join("\n");
    for (const name of ["read_file", "write_file", "edit_file", "search_files", "exec"]) {
      expect(out).toContain(`tool ${name}:`);
    }
  });

  it("runs an end-to-end read through the real orchestrator and tools", async () => {
    const deps = await createDefaultDeps({
      provider: new ScriptedModelProvider([
        ScriptedModelProvider.toolCall("read_file", { path: "package.json" }),
        ScriptedModelProvider.text("done reading"),
      ]),
    });
    const result = await runCommand(["run", process.cwd(), "read package.json"], deps);
    expect(result.exitCode).toBe(0);
    const out = result.lines.join("\n");
    expect(out).toContain("status: completed");
    expect(out).toContain("files changed: (none)");
    const sessionId = (await deps.store.listSessions())[0]!.id;
    const events = await deps.events.list(sessionId);
    const completed = events.find((e) => e.type === "tool.completed" && e.payload.tool === "read_file");
    expect(completed?.payload.status).toBe("success");
  });

  it("asks for approval on write_file (edit:ask) and applies the denial", async () => {
    const deps = await createDefaultDeps({
      provider: new ScriptedModelProvider([
        ScriptedModelProvider.toolCall("write_file", { path: "out.txt", content: "hi" }),
        ScriptedModelProvider.text("done"),
      ]),
    });
    const run = runCommand(["run", process.cwd(), "write it"], deps);
    let approval: ApprovalRequest | undefined;
    for (let i = 0; i < 200 && approval === undefined; i += 1) {
      approval = deps.approvalStore.listPending().find((a) => a.target === "out.txt");
      if (approval === undefined) await new Promise((r) => setTimeout(r, 10));
    }
    expect(approval).toBeDefined();
    deps.approvalStore.resolve(approval!.id, "deny", "test");
    const result = await run;
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain("status: completed");
    const sessionId = (await deps.store.listSessions())[0]!.id;
    const events = await deps.events.list(sessionId);
    const created = events.find(
      (e) => e.type === "approval.created" && e.payload.target === "out.txt",
    );
    expect(created).toBeDefined();
    const denied = events.find(
      (e) =>
        e.type === "tool.failed" &&
        e.payload.tool === "write_file" &&
        (e.payload.error as { code?: string } | undefined)?.code === "APPROVAL_DENIED",
    );
    expect(denied).toBeDefined();
  });

  it("doctor warns (not errors) when the stub provider is active", async () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const deps = await createDefaultDeps();
      const result = await runCommand(["doctor"], deps);
      expect(result.exitCode).toBe(0);
      const out = result.lines.join("\n");
      expect(out).toContain("[WARNING] model provider — stub provider");
      expect(out).toContain("doctor: 7 ok, 5 warning(s), 0 error(s)");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("doctor flags an under-registered tool registry as ERROR", async () => {
    const registry = new ToolRegistry();
    registry.register(readFileTool);
    const checks = await runChecks({ toolRegistry: registry });
    const toolCheck = checks.find((c) => c.name === "tool registry");
    expect(toolCheck?.status).toBe("ERROR");
    expect(toolCheck?.detail).toContain("1 of 11");
  });

  it("persists sessions across deps rebuilds via dataDir", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cli-data-"));
    try {
      const deps1 = await createDefaultDeps({
        dataDir,
        provider: new ScriptedModelProvider([ScriptedModelProvider.text("first")]),
      });
      expect(deps1.doctor.sessionStore).toBeInstanceOf(JSONLSessionStore);
      expect(deps1.doctor.eventStore).toBeInstanceOf(JSONLEventStore);
      const agents = (await deps1.rpc.request("agent.list")) as { id: string }[];
      const session = (await deps1.rpc.request("session.create", {
        agentId: agents[0]!.id,
        cwd: "C:\\work",
      })) as Session;
      const deps2 = await createDefaultDeps({
        dataDir,
        provider: new ScriptedModelProvider([ScriptedModelProvider.text("second")]),
      });
      const resume = await runCommand(["resume", session.id], deps2);
      expect(resume.exitCode).toBe(0);
      expect(resume.lines.join("\n")).toContain(`session: ${session.id}`);
      const sessions = await runCommand(["sessions"], deps2);
      expect(sessions.lines.join("\n")).toContain(session.id);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("doctor reports persistent stores with a dataDir", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cli-data-"));
    try {
      const deps = await createDefaultDeps({
        dataDir,
        provider: new ScriptedModelProvider([ScriptedModelProvider.text("hi")]),
      });
      const result = await runCommand(["doctor"], deps);
      expect(result.exitCode).toBe(0);
      const out = result.lines.join("\n");
      expect(out).toContain(`[OK] persistence — dataDir=${dataDir}`);
      expect(out).toContain("[OK] session store — reachable (JSONLSessionStore)");
      expect(out).toContain("[OK] event store — reachable (JSONLEventStore)");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("uses the configured model ref", async () => {
    const deps = await createDefaultDeps({
      provider: new ScriptedModelProvider([ScriptedModelProvider.text("hi")]),
      model: { providerId: "scripted", modelId: "custom-model" },
    });
    const agents = (await deps.rpc.request("agent.list")) as { id: string }[];
    const session = (await deps.rpc.request("session.create", {
      agentId: agents[0]!.id,
      cwd: "C:\\work",
    })) as Session;
    const resume = await runCommand(["resume", session.id], deps);
    expect(resume.exitCode).toBe(0);
    expect(resume.lines.join("\n")).toContain("model: scripted/custom-model");
  });

  it("champion state reports the active champion level (E1-14)", async () => {
    const deps = await createDefaultDeps();
    const result = await runCommand(["champion", "state", "--json"], deps);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.lines.join("\n")) as { level: string; applied: boolean; candidateId: string | null };
    // The repository's champion-state.json is the source of truth; this asserts
    // the CLI reports whatever the active level is (C0 frozen baseline, or a
    // promoted C1/C2 with its candidate id).
    expect(["C0", "C1", "C2"]).toContain(parsed.level);
    expect(parsed.applied).toBe(true);
    if (parsed.level !== "C0") {
      expect(parsed.candidateId).toBeTruthy();
    }
  });

  it("champion promote fails closed without an explicit ACCEPT decision (E1-14)", async () => {
    const deps = await createDefaultDeps();
    // Missing --decision ACCEPT is fail-closed (usage error, never promotes).
    const result = await runCommand(["champion", "promote", "memory_retrieval", "--evidence", "some-file.json"], deps);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("usage: agent champion promote");
  });

  it("champion promote fails closed when the evidence file does not exist (E1-14)", async () => {
    const deps = await createDefaultDeps();
    const result = await runCommand(
      ["champion", "promote", "memory_retrieval", "--evidence", "nope.json", "--decision", "ACCEPT"],
      deps,
    );
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("does not exist");
  });
});

/** Local copy of the core test catalog (tests must not reach into @ar/core's
 *  test internals): inert definitions so the frozen step router can resolve
 *  the conventional tool names under a FakeOrchestrator. */
function defaultTestToolCatalog() {
  const names = ["read_file", "write_file", "edit_file", "exec", "search_files", "grep_search", "repo_tree", "repo_map", "update_plan", "ask_user", "env_snapshot", "discover_commands", "tool_lookup"];
  const mk = (name: string) => ({
    name,
    description: `stub ${name}`,
    inputSchema: z.object({}),
    risk: "readonly" as const,
    metadata: { name, version: "1.0.0", sideEffect: false, network: false, filesystem: false, process: false, interactive: false },
    execute: async () => ({ status: "success" as const, output: "" }),
  });
  return {
    get: (name: string) => (names.includes(name) ? mk(name) : undefined),
    list: () => names.map(mk),
    specs: () => names.map((name) => ({ name, description: `stub ${name}`, inputSchema: {} as never })),
  };
}
