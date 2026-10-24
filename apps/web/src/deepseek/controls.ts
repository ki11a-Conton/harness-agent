import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { newEventId, type AgentEvent, type ModelRequest, type SessionId, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "@ar/contracts";
import type { Harness } from "@ar/harness";
import { fail, keys, object, string } from "./events.js";
import { createSessionMetadataStore } from "./metadata.js";
import { sessionMetadataTool, type SessionHost } from "./session.js";
import { controlsSchema, defaultControls, permissionPresets, type Goal, type SessionControls } from "./controls-state.js";

interface ControlsHost extends SessionHost {
  externalSessionId(nativeId: string): string;
  submitPrompt(request: { sessionId: string; requestId: string; mode: "queue"; content: Array<{ type: "text"; text: string }> }, signal: AbortSignal): Promise<unknown>;
  resolveHarness(sessionId: string): Promise<Harness>;
  nativeSessionId(sessionId: string): SessionId;
}
const commands = ["permission", "plan", "goal", "compact"];
const signal = () => new AbortController().signal;
// Retain legacy revision-number claims on restart. New round claims use a
// separate namespace so they cannot collide with a legacy numeric receipt.
const isGoalRequestId = (id: string) => /^goal-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-(?:round-)?[1-9]\d*$/u.test(id);

/** Human controls live in the Web owner. Every mutation uses its private
 * Orchestrator; project effects still traverse the original frozen tool binding,
 * permission engine, sandbox and verification. No mutable agent snapshot. */
export function createControlsService(host: ControlsHost) {
  const store = createSessionMetadataStore(host.dataDir);
  const attached = new WeakSet<Harness>();
  const inflight = new Map<string, Set<AbortController>>();
  const pending = new Set<Promise<unknown>>();
  const activeGoals = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined, driving: Promise<void> | undefined, closed = false;
  const serial = <T>(id: string, action: () => Promise<T>) => host.withSessionLock?.(id, action) ?? action();
  const read = async (id: string) => structuredClone((await store.read(id)).controls ?? defaultControls());
  const session = async (id: string) => {
    const row = await host.harness.store.getSession(id as SessionId);
    if (row === undefined || row.status === "failed") fail("session/not-found", "Session is unavailable");
    return row!;
  };
  async function write(id: string, change: (controls: SessionControls) => void, abort?: AbortSignal): Promise<SessionControls> {
    const before = await read(id); change(before); const next = controlsSchema.parse(before);
    const tool = sessionMetadataTool(store, row => { row.controls = next; });
    const execute = tool.execute;
    tool.execute = async (input, context) => {
      const result = await execute(input, context);
      if (next.goal?.phase === "active") activeGoals.add(id); else activeGoals.delete(id);
      // A durable after-write fence invalidates control projections even when
      // their poll observed the earlier intent before the file committed.
      await host.harness.events.appendNew({ id: newEventId(), sessionId: id as SessionId, timestamp: Date.now(), type: "tool.completed",
        payload: { tool: tool.name, hostOnly: true, kind: "web_controls_committed", outputPreview: JSON.stringify({ permission: next.permission,
          plan: { status: next.plan.status, revision: next.plan.revision }, goal: next.goal === undefined ? null : { id: next.goal.id, revision: next.goal.revision, phase: next.goal.phase },
          compactionPending: next.compaction?.pending ?? false }) } });
      return result;
    };
    const result = await host.executeHostTool!(id, tool, { path: store.path ?? resolve(host.cwd, ".deepseek-memory-metadata"), sessionId: id }, abort ?? signal());
    if (result.status !== "success") fail(result.error?.code ?? "controls/write-failed", result.error?.message ?? "Controls could not be saved");
    return next;
  }
  function revoke(id: string) { for (const controller of inflight.get(id) ?? []) controller.abort(); }
  function reportBackgroundFailure(context: string, error: unknown) {
    console.error(`[degraded] web-controls.${context}`, error instanceof Error ? error.message : String(error));
  }
  function modeGuidance(state: SessionControls): string {
    // Only fixed host policy belongs in this channel. The goal itself is user
    // data, already carried by the durable inbox; never promote it to system.
    return [
      state.permission === "read-only" ? "The human selected read-only. Inspect code and explain; do not modify files or run commands." : "",
      ["draft", "review"].includes(state.plan.status) ? "The human selected PLAN MODE. Inspect using read-only tools, then present a concrete implementation plan with validation steps. Do not write files, execute commands, delegate side effects or implement until the human approves the plan." : "",
      state.goal?.phase === "active" ? "Continue the user goal from the conversation with concrete verified progress. Respect its round budget and report blockers; do not claim completion without evidence." : "",
    ].filter(Boolean).join("\n");
  }
  async function controlled<T extends ToolResult>(id: string, definition: ToolDefinition, context: ToolExecutionContext,
    execute: (context: ToolExecutionContext) => Promise<T>): Promise<T> {
    const controller = new AbortController(), registered = new Set<string>();
    if (closed) controller.abort();
    const register = (ownerId: string) => {
      let calls = inflight.get(ownerId);
      if (calls === undefined) { calls = new Set(); inflight.set(ownerId, calls); }
      calls.add(controller); registered.add(ownerId);
    };
    register(id);
    try {
      const details = await store.read(id), state = details.controls ?? defaultControls(), receipts = details.requests;
      let parent = (await host.harness.store.getSession(id as SessionId))?.parentId, ancestorRestricted = false;
      while (parent !== undefined) {
        if (registered.has(parent) || registered.size >= 32) { ancestorRestricted = true; break; }
        register(parent); // Register before reading: a concurrent downgrade revokes this call too.
        const control = await read(parent);
        if (control.permission === "read-only" || ["draft", "review"].includes(control.plan.status)) ancestorRestricted = true;
        const ancestor = await host.harness.store.getSession(parent);
        if (ancestor === undefined) { ancestorRestricted = true; break; }
        parent = ancestor.parentId;
      }
      const goalPromptIds = new Set(Object.entries(receipts).filter(([requestId]) => isGoalRequestId(requestId)).map(([, receipt]) => receipt.promptId));
      const goalPrompt = context.turnId === undefined ? undefined : (await host.harness.inbox.listAll(id as SessionId)).find(prompt => prompt.promotedTurnId === context.turnId && goalPromptIds.has(prompt.id));
      const staleGoal = goalPrompt !== undefined && (state.goal?.phase !== "active" || receipts[state.goal.pending?.requestId ?? ""]?.promptId !== goalPrompt.id);
      const restricted = ancestorRestricted || staleGoal || state.permission === "read-only" || ["draft", "review"].includes(state.plan.status);
      let next = { ...context, signal: AbortSignal.any([context.signal, controller.signal]) };
      if (restricted) next = { ...next,
        permissions: { defaultEffect: "deny", rules: definition.metadata.sideEffect ? [] : [{ action: "read", resource: "*", effect: "allow" }] },
        sandboxPolicy: { ...context.sandboxPolicy, filesystem: { ...context.sandboxPolicy.filesystem, mode: "read-only" },
          network: { mode: "deny" }, process: { ...context.sandboxPolicy.process, allowedCommands: [] } } };
      else if (state.permission === "danger-full-access") {
        const { allowedCommands: _commands, deniedSurfaces: _surfaces, ...limits } = context.sandboxPolicy.process;
        next = { ...next, permissions: { defaultEffect: "allow", rules: [{ action: "*", resource: "*", effect: "allow", scope: "call" }] },
          sandboxPolicy: { filesystem: { mode: "full" }, network: { mode: "full" }, process: limits } };
      } else if (context.sandboxPolicy.filesystem.mode === "full") next = { ...next, sandboxPolicy: { ...context.sandboxPolicy,
        filesystem: { ...context.sandboxPolicy.filesystem, mode: "workspace-write", allowedPaths: [context.cwd] } } };
      return await execute(next);
    } finally { for (const ownerId of registered) { const calls = inflight.get(ownerId); calls?.delete(controller); if (calls?.size === 0) inflight.delete(ownerId); } }
  }
  function attach(owner: Harness) {
    if (attached.has(owner)) return; attached.add(owner);
    const build = owner.context.pipeline.build.bind(owner.context.pipeline);
    owner.context.pipeline.build = async options => {
      if (options.telemetrySessionId === undefined) return build(options);
      const guidance = modeGuidance(await read(host.externalSessionId(options.telemetrySessionId)));
      // Enter the existing authoritative block BEFORE admission/compaction so
      // the same production budget accounts for every mode instruction.
      return build(guidance ? { ...options, systemPrompt: [options.systemPrompt, guidance].filter(Boolean).join("\n\n") } : options);
    };
    const execute = owner.orchestrator.execute.bind(owner.orchestrator);
    const executeBound = owner.orchestrator.executeBound.bind(owner.orchestrator);
    owner.orchestrator.execute = async (request, context) => {
      const definition = owner.registry.get(request.call.name);
      return definition === undefined ? execute(request, context) : controlled(host.externalSessionId(context.sessionId), definition, context, next => execute(request, next));
    };
    owner.orchestrator.executeBound = (request, context) => controlled(host.externalSessionId(context.sessionId), request.binding.definition, context, next => executeBound(request, next));
  }
  function expectGoal(state: SessionControls, ref: Record<string, unknown>): Goal {
    keys(ref, ["id", "revision"]);
    const goal = state.goal;
    if (goal === undefined) fail("goal/not-found", "No current goal");
    if (goal!.id !== ref.id || goal!.revision !== ref.revision) fail("goal/conflict", "Goal changed; refresh and retry");
    return goal!;
  }
  function goalView(goal: Goal | undefined) {
    if (goal === undefined) return undefined;
    const { pending: _pending, ...view } = goal;
    return { ...view, activation: goal.phase === "active" ? "armed" : "disarmed" };
  }
  function objective(value: unknown) {
    const text = string(value, "objective").trim();
    if (!text || text.length > 16000) fail("goal/invalid-objective", "Goal must contain 1–16000 characters");
    return text;
  }
  function rounds(value: unknown) {
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 100) fail("goal/invalid-rounds", "Goal round limit must be 1–100");
    return Number(value);
  }
  async function goalCall(endpoint: string, args: Record<string, unknown>, abort: AbortSignal) {
    if (closed) fail("gateway/cancelled", "Session controls are closed");
    const id = string(args.agentId, "agentId");
    keys(args, ["agentId"], endpoint === "goals/get" ? [] : endpoint === "goals/create" ? ["request"] : endpoint === "goals/edit" ? ["ref", "request"] : ["ref"]);
    return serial(id, async () => {
      await session(id); const state = await read(id);
      if (endpoint === "goals/get") return goalView(state.goal);
      if (endpoint === "goals/create") {
        const request = object(args.request); keys(request, ["objective"], ["maxGoalRounds"]);
        if (state.goal !== undefined) fail("goal/exists", "Clear the existing goal before creating another");
        const text = objective(request.objective), maxGoalRounds = request.maxGoalRounds === undefined ? 10 : rounds(request.maxGoalRounds);
        const next = await write(id, data => { data.goal = { id: randomUUID(), revision: 1, objective: text, phase: "active", maxGoalRounds, roundsStarted: 0, createdAt: Date.now(), updatedAt: Date.now() }; }, abort);
        return { ref: { id: next.goal!.id, revision: next.goal!.revision } };
      }
      expectGoal(state, object(args.ref));
      const request = endpoint === "goals/edit" ? object(args.request) : undefined;
      if (request !== undefined) {
        keys(request, [], ["objective", "maxGoalRounds"]);
        if (!Object.keys(request).length) fail("goal/invalid-edit", "Provide an objective or round limit");
        if (request.objective !== undefined) objective(request.objective);
        if (request.maxGoalRounds !== undefined) rounds(request.maxGoalRounds);
      }
      if (!["goals/edit", "goals/pause", "goals/resume", "goals/complete", "goals/clear"].includes(endpoint)) fail("goal/unavailable", "Unknown goal operation");
      if (state.goal!.phase === "complete" && ["goals/pause", "goals/resume"].includes(endpoint)) fail("goal/invalid-phase", "A completed goal must be cleared before starting new work");
      if (endpoint === "goals/resume" && state.goal!.roundsStarted >= state.goal!.maxGoalRounds) fail("goal/budget-exhausted", "Increase the round limit before resuming");
      const next = await write(id, data => {
        const goal = data.goal!; goal.revision++; goal.updatedAt = Date.now();
        if (endpoint === "goals/edit") {
          if (request!.objective !== undefined) { goal.objective = objective(request!.objective); delete goal.pending; }
          if (request!.maxGoalRounds !== undefined) goal.maxGoalRounds = rounds(request!.maxGoalRounds);
        } else if (endpoint === "goals/clear") delete data.goal;
        else { goal.phase = endpoint === "goals/pause" ? "paused" : endpoint === "goals/resume" ? "active" : "complete"; delete goal.blockedReason; }
      }, abort);
      return endpoint === "goals/clear" ? { id: state.goal!.id, revision: state.goal!.revision + 1 } : goalView(next.goal);
    });
  }
  async function command(id: string, line: string, abort: AbortSignal): Promise<string | undefined> {
    if (closed) fail("gateway/cancelled", "Session controls are closed");
    const match = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/.exec(line);
    if (match === null || !commands.includes(match[1]!)) return undefined;
    await session(id); const name = match[1]!, value = (match[2] ?? "").trim();
    if (name === "goal") {
      const state = await read(id);
      // Like the native command, a bare /goal is a read, never an empty goal.
      if (value === "") return state.goal === undefined
        ? "No goal is currently set. Use /goal <objective>, /goal pause, /goal resume, /goal edit <objective>, or /goal clear."
        : `Goal: ${state.goal.objective}\nStatus: ${state.goal.phase}\nRounds: ${state.goal.roundsStarted}/${state.goal.maxGoalRounds}`;
      const action = /^(pause|resume|clear|complete|edit)(?:\s|$)/u.exec(value)?.[1];
      if (action === undefined) { await goalCall("goals/create", { agentId: id, request: { objective: value } }, abort); return "Goal saved; bounded continuation is active."; }
      if (state.goal === undefined) fail("goal/not-found", "No current goal");
      await goalCall(`goals/${action}`, { agentId: id, ref: { id: state.goal!.id, revision: state.goal!.revision },
        ...(action === "edit" ? { request: { objective: value.slice(4).trim() } } : {}) }, abort);
      return `Goal ${action} saved.`;
    }
    if (name === "compact") {
      if (value) fail("context/invalid-command", "Use /compact without arguments");
      await serial(id, () => write(id, data => { data.compaction = { ...data.compaction, pending: true, requestedAt: Date.now() }; }, abort));
      (await host.resolveHarness(id)).context.pipeline.requestCompaction(host.nativeSessionId(id));
      return "Manual compression queued for the next model request; the full transcript is retained.";
    }
    let approved: string | undefined, approvedRequestId: string | undefined;
    await serial(id, async () => {
      if (name === "permission") {
        const [preset, confirmation, extra] = value.split(/\s+/u);
        if (!permissionPresets.includes(preset as typeof permissionPresets[number]) || extra !== undefined || (confirmation !== undefined && confirmation !== "--confirmed")) fail("permission/invalid", "Choose read-only, workspace-write or danger-full-access");
        if (preset === "danger-full-access" && confirmation !== "--confirmed") fail("permission/confirmation-required", "Full access requires explicit human confirmation");
        await write(id, state => { state.permission = preset as SessionControls["permission"]; }, abort); revoke(id);
      } else {
        const state = await read(id);
        if (value.startsWith("approve")) {
          const revision = Number(value.split(/\s+/u)[1]);
          const retry = state.plan.status === "approved" && state.plan.requestId !== undefined && revision + 1 === state.plan.revision;
          if ((!retry && state.plan.status !== "review") || !state.plan.content || (!retry && revision !== state.plan.revision)) fail("plan/conflict", "Review the current plan before approving its revision");
          approved = state.plan.content;
          approvedRequestId = retry ? state.plan.requestId : `plan-${randomUUID()}`;
          if (!retry) await write(id, data => { data.plan.status = "approved"; data.plan.revision++; data.plan.requestId = approvedRequestId; data.plan.admitted = false; }, abort);
        } else {
          if (!["on", "off", ""].includes(value)) fail("plan/invalid", "Use /plan on, /plan off or /plan approve <revision>");
          const active = value === "on" || (value === "" && !["draft", "review"].includes(state.plan.status));
          await write(id, data => { data.plan = { status: active ? "draft" : "off", revision: data.plan.revision + 1 }; }, abort); revoke(id);
        }
      }
    });
    if (approved !== undefined) {
      await host.submitPrompt({ sessionId: id, requestId: approvedRequestId!, mode: "queue", content: [{ type: "text", text: `I approve this plan. Implement it and verify the result:\n${approved}` }] }, abort);
      await serial(id, async () => { if ((await read(id)).plan.requestId === approvedRequestId) await write(id, data => { data.plan.admitted = true; }); });
    }
    return name === "permission" ? "Session permission saved." : approved === undefined ? "Plan mode saved; unapproved plans cannot change project state." : "Plan approved and execution queued.";
  }
  /** Admission guard runs under the SAME owner lock as pause/edit/clear. */
  async function beforePrompt(id: string, requestId: string) {
    if (closed) fail("gateway/cancelled", "Session controls are closed");
    if ((await read(id)).compaction?.pending) (await host.resolveHarness(id)).context.pipeline.requestCompaction(host.nativeSessionId(id));
    if (!isGoalRequestId(requestId)) return;
    const goal = (await read(id)).goal;
    if (goal?.phase !== "active" || goal.pending?.requestId !== requestId) fail("goal/stale-dispatch", "Goal continuation was paused or changed before admission");
  }
  async function drive() {
    for (const externalId of activeGoals) {
      const id = externalId as SessionId;
      if (closed) return;
      const row = await host.harness.store.getSession(id as SessionId);
      if (row === undefined || row.status === "failed" || row.parentId !== undefined) { activeGoals.delete(id); continue; }
      const claim = await serial(id, async () => {
        const state = await read(id), goal = state.goal;
        if (goal?.phase !== "active" || ["draft", "review"].includes(state.plan.status)) return;
        const turns = await host.harness.store.listTurns(id);
        if (turns.some(turn => ["waiting_for_user", "waiting_for_approval"].includes(turn.status))) return;
        const inbox = await host.harness.inbox.listAll(id);
        if (inbox.some(prompt => prompt.status !== "consumed")) {
          const actor = await host.harness.sessions.load(id);
          if (actor.executionState === "idle") actor.wakePending?.();
          return;
        }
        if (turns.some(turn => turn.status === "running")) return;
        if (goal.pending !== undefined) {
          const receipt = (await store.read(id)).requests[goal.pending.requestId];
          if (receipt?.status !== "accepted") return goal.pending;
          const prompt = inbox.find(item => item.id === receipt.promptId);
          const turn = turns.find(item => item.id === prompt?.promotedTurnId);
          if (turn === undefined) return;
          const end = (await host.harness.events.list(id)).findLast(event => event.turnId === turn.id && event.type === "turn.completed");
          if (end?.payload.grade === "verified_complete") { await write(id, data => { data.goal!.phase = "complete"; data.goal!.revision++; data.goal!.updatedAt = Date.now(); delete data.goal!.pending; }); return; }
          if (turn.status !== "completed") { await write(id, data => { data.goal!.phase = "blocked"; data.goal!.blockedReason = { code: "turn-failed", message: "Continuation did not complete; inspect the actual turn before resuming." }; data.goal!.revision++; data.goal!.updatedAt = Date.now(); delete data.goal!.pending; }); return; }
        }
        if (goal.roundsStarted >= goal.maxGoalRounds) { await write(id, data => { data.goal!.phase = "blocked"; data.goal!.blockedReason = { code: "round-limit", message: "Goal round limit reached without verified completion." }; data.goal!.revision++; data.goal!.updatedAt = Date.now(); delete data.goal!.pending; }); return; }
        const next = await write(id, data => {
          // Ordinary progress must not invalidate the human's rendered pause /
          // edit ref. Human edits and lifecycle transitions still advance the
          // goal revision; the metadata revision + committed fence publish all
          // progress. A persisted round ordinal owns each dispatch independently.
          const current = data.goal!; current.roundsStarted++; current.updatedAt = Date.now();
          current.pending = { requestId: `goal-${current.id}-round-${current.roundsStarted}`, text: `Continue the user goal (${current.roundsStarted}/${current.maxGoalRounds}):\n${current.objective}\nUse the repository tools, verify concrete results, and report remaining blockers. Do not claim completion without evidence.` };
        }); return next.goal!.pending;
      });
      if (claim !== undefined && !closed) {
        try { await host.submitPrompt({ sessionId: id, requestId: claim.requestId, mode: "queue", content: [{ type: "text", text: claim.text }] }, signal()); }
        catch (error) {
          if (error instanceof Error && "code" in error && error.code === "goal/stale-dispatch") continue;
          await serial(id, async () => {
            const goal = (await read(id)).goal;
            if (goal?.phase !== "active" || goal.pending?.requestId !== claim.requestId) return;
            await write(id, data => { data.goal!.phase = "blocked"; data.goal!.revision++; data.goal!.updatedAt = Date.now();
              data.goal!.blockedReason = { code: "admission-failed", message: "Goal continuation could not be admitted. Inspect session status and resume explicitly; the durable claim is retained." }; });
          });
        }
      }
    }
  }
  return {
    commands, read, attach, controlled, beforePrompt, goalCall, command,
    async selectReasoning(id: string, selected: { provider: string; model: string; reasoningEffort?: string }, abort: AbortSignal) {
      if (closed) fail("gateway/cancelled", "Session controls are closed");
      await serial(id, () => write(id, data => { data.reasoning = { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort === undefined ? {} : { effort: selected.reasoningEffort }) }; }, abort));
    },
    async transform(request: ModelRequest): Promise<ModelRequest> {
      if (closed) fail("gateway/cancelled", "Session controls are closed");
      return request;
    },
    observe(event: AgentEvent) {
      if (closed) return;
      if (event.type === "context.compacted" && event.payload.phase === "started") {
        const action = serial(event.sessionId, () => write(event.sessionId, data => {
          data.compaction = { ...(data.compaction ?? { pending: false, requestedAt: event.timestamp }), running: true };
        }));
        pending.add(action); void action.catch(error => reportBackgroundFailure("compaction-start", error)).finally(() => pending.delete(action)); return;
      }
      if (event.type === "context.compacted" && event.payload.phase === "completed") {
        const action = serial(event.sessionId, async () => {
          const current = (await read(event.sessionId)).compaction;
          await write(event.sessionId, data => { data.compaction = { pending: current?.pending === true && (event.payload.manual !== true || current.requestedAt > event.timestamp),
            requestedAt: current?.requestedAt ?? event.timestamp, running: false, lastCompletedAt: event.timestamp,
            ...(event.payload.summarySource === "model" || event.payload.summarySource === "extractive" ? { lastSummarySource: event.payload.summarySource } : {}) }; });
        });
        pending.add(action); void action.catch(error => reportBackgroundFailure("compaction-projection", error)).finally(() => pending.delete(action)); return;
      }
      if (!["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)) return;
      const action = serial(event.sessionId, async () => {
        const state = await read(event.sessionId);
        if (state.compaction?.running) await write(event.sessionId, data => { data.compaction!.running = false; });
        if (event.type !== "turn.completed" || state.plan.status !== "draft" && state.plan.status !== "review") return;
        const messages = await host.harness.store.listMessages(event.sessionId);
        const content = messages.filter(message => message.turnId === event.turnId && message.role === "assistant" && message.contextCheckpoint === undefined && !message.toolCalls?.length).map(message => message.content).filter(Boolean).join("\n\n").slice(0, 32000);
        if (content) await write(event.sessionId, data => { data.plan = { status: "review", revision: data.plan.revision + 1, content }; });
      });
      pending.add(action); void action.catch(error => reportBackgroundFailure("plan-projection", error)).finally(() => pending.delete(action));
    },
    async start() {
      if (closed || timer !== undefined) return;
      for (const row of await store.listControls()) {
        if (row.controls.compaction?.running) await serial(row.sessionId, () => write(row.sessionId, data => { data.compaction!.running = false; }));
        if (row.controls.goal?.phase === "active") activeGoals.add(row.sessionId);
        if (row.controls.compaction?.pending) {
          const current = await host.harness.store.getSession(row.sessionId as SessionId);
          if (current !== undefined && current.status !== "failed") (await host.resolveHarness(row.sessionId)).context.pipeline.requestCompaction(host.nativeSessionId(row.sessionId));
        }
      }
      if (closed) return;
      timer = setInterval(() => { if (driving !== undefined || closed || activeGoals.size === 0) return; driving = drive().catch(error => reportBackgroundFailure("goal-drive", error)).finally(() => { driving = undefined; }); }, 1000); timer.unref();
    },
    async stopGoal(id: string) { await serial(id, async () => { if ((await read(id)).goal?.phase === "active") await write(id, data => { data.goal!.phase = "paused"; data.goal!.revision++; data.goal!.updatedAt = Date.now(); }); }); },
    async close() { closed = true; activeGoals.clear(); if (timer !== undefined) clearInterval(timer); for (const id of inflight.keys()) revoke(id); await driving; await Promise.allSettled([...pending]); },
  };
}
