import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { newEventId, type Session, type SessionId, type ToolDefinition, type Turn } from "@ar/contracts";
import type { Harness } from "@ar/harness";
import { resolveProfile } from "@ar/harness";
import { fail, keys, object, pause, string } from "./events.js";
import type { SessionHost } from "./session.js";
import { activityStore, type ScheduleDocument, type ScheduleTask } from "./activity-store.js";
import {
  ScheduleId, ScheduleInputError, createAfterScheduleRecord, createAtScheduleRecord, createEveryScheduleRecord,
  createDailyScheduleRecord, createWeeklyScheduleRecord, createCronScheduleRecord, isRecurringScheduleRecord,
  resolveRecurringOccurrence, scheduleView,
} from "./schedule-pure/domain.js";
import { resolveScheduleUpdate } from "./schedule-pure/update.js";
import type { ScheduleCreateRequest, ScheduleRecord, ScheduleTimingChange } from "./schedule-pure/types.js";

export interface ActivityHost extends SessionHost {
  now?(): number;
  /** Actual shipped client inventory, from the verified local boot manifest. */
  pluginEntries?: readonly { id: string; version?: string; description?: string }[];
  /** Receipts come from the durable receiving inbox; no random receipt ids. */
  submitPrompt?(request: { sessionId: string; requestId: string; mode: "queue" | "steer"; content: Array<{ type: "text"; text: string }> }, signal: AbortSignal): Promise<{ messageId: string }>;
  publish?(event: string, args: readonly unknown[]): void;
  resolveHarness?(sessionId: string): Promise<Harness>;
  /** Model contexts keep native identity; Web task ownership uses its stable alias. */
  externalSessionId?(nativeId: string): string;
}
interface Job { view: JobView; child: Session; turn: Turn; bytes: Buffer }
export interface JobView {
  id: string; kind: "subagent"; label: string; owner: string;
  status: "running" | "completed" | "killed" | "failed";
  startedAt: number; finishedAt?: number; detail?: string;
  output: { total: number; earliest: number };
}

/** Official activity Remote DTOs backed by durable Harness owners. */
export function createActivityService(host: ActivityHost) {
  const schedulePath = resolve(host.dataDir ?? host.cwd, "deepseek", "schedules.json");
  const store = activityStore(schedulePath);
  const now = host.now ?? Date.now;
  const lifetime = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  let driving: Promise<void> | undefined;
  const dispatches = new Map<string, { sessionId: string; controller: AbortController; settled: Promise<void> }>();
  const stoppingSessions = new Map<string, number>();
  const inspectProviders = new Map<string, Record<string, unknown>>();
  // Native Harness does not mount dynamic Cordis host/package activations.
  const dynamicPlugins = new Map<string, never>();
  const ownerHarness = (id: string) => host.resolveHarness?.(id) ?? Promise.resolve(host.harness);
  const serial = <T>(id: string, action: () => Promise<T>): Promise<T> =>
    host.withSessionLock?.(host.externalSessionId?.(id) ?? id, action) ?? action();

  async function session(value: unknown): Promise<Session> {
    const id = string(value, "sessionId") as SessionId;
    const current = await host.harness.store.getSession(id);
    if (current === undefined || current.status === "failed") fail("session/not-found", "Session is unavailable");
    return current!;
  }
  async function state<T>(owner: string | undefined, signal: AbortSignal, change?: (document: ScheduleDocument) => T): Promise<T | ScheduleDocument> {
    if (host.executeHostTool === undefined || host.dataDir === undefined) fail("schedule/unavailable", "Durable controlled task storage is unavailable");
    const name = "web_activity_metadata";
    const definition: ToolDefinition = {
      name, description: "Read or update this host's fixed task file", risk: change === undefined ? "readonly" : "side_effect",
      inputSchema: z.object({ path: z.literal(schedulePath) }).strict(),
      metadata: { name, version: "1", sideEffect: change !== undefined, filesystem: true, process: false, network: false, interactive: false, retry: "none", concurrencySafe: false },
      async execute() { return { status: "success", output: change === undefined ? await store.read() : await store.update(change) }; },
    };
    const result = await host.executeHostTool!(owner, definition, { path: schedulePath }, signal);
    if (result.status !== "success") fail(result.error?.code ?? "schedule/storage-failed", result.error?.message ?? "Task state operation failed");
    return result.output as T | ScheduleDocument;
  }
  const read = (owner: string | undefined, signal: AbortSignal) => state(owner, signal) as Promise<ScheduleDocument>;
  const mutate = <T>(owner: string | undefined, signal: AbortSignal, action: (document: ScheduleDocument) => T) => state(owner, signal, action) as Promise<T>;
  function changed(): void {
    try { host.publish?.("schedule/changed", []); } catch (error) { console.error("Web task notification failed", error instanceof Error ? error.message : String(error)); }
  }

  async function createSchedule(id: string, value: unknown, signal: AbortSignal): Promise<unknown> {
    return serial(id, () => createScheduleUnlocked(id, value, signal));
  }
  async function createScheduleUnlocked(id: string, value: unknown, signal: AbortSignal): Promise<unknown> {
    const owner = await session(id);
    if (owner.parentId !== undefined) return { code: "subagent_session", message: "Scheduled followups require a root session." };
    const request = object(value);
    keys(request, ["title", "prompt"], ["after_seconds", "at", "every_seconds", "daily", "weekly", "cron", "path"]);
    const title = string(request.title, "title"); const prompt = string(request.prompt, "prompt");
    if (prompt.length > 64_000) return { code: "invalid_prompt", message: "Task instruction is too long." };
    const selectors = ["after_seconds", "at", "every_seconds", "daily", "weekly", "cron"].filter(key => request[key] !== undefined);
    if (selectors.length !== 1) return { code: "invalid_selector", message: "Provide exactly one timing selector." };
    let record: ScheduleRecord;
    try {
      const taskId = ScheduleId(`schedule-${randomUUID()}`); const acceptedAt = now();
      switch (selectors[0]) {
        case "after_seconds": record = createAfterScheduleRecord(taskId, prompt, request.after_seconds as number, acceptedAt, title); break;
        case "at": record = createAtScheduleRecord(taskId, prompt, request.at as ScheduleCreateRequest["at"] & {}, acceptedAt, title); break;
        case "every_seconds": record = createEveryScheduleRecord(taskId, prompt, request.every_seconds as number, acceptedAt, title); break;
        case "daily": record = createDailyScheduleRecord(taskId, prompt, request.daily as ScheduleCreateRequest["daily"] & {}, acceptedAt, title); break;
        case "weekly": record = createWeeklyScheduleRecord(taskId, prompt, request.weekly as ScheduleCreateRequest["weekly"] & {}, acceptedAt, title); break;
        case "cron": record = createCronScheduleRecord(taskId, prompt, request.cron as ScheduleCreateRequest["cron"] & {}, acceptedAt, title); break;
        default: fail("gateway/bad-request", "Unknown task selector");
      }
    } catch (error) { if (error instanceof ScheduleInputError) return { code: error.code, message: error.message }; throw error; }
    if (host.submitPrompt === undefined) fail("schedule/unavailable", "Task inbox admission is unavailable");
    await mutate(owner.id, signal, document => {
      if (Object.keys(document.tasks).length >= 1000) fail("schedule/capacity", "Task retention capacity reached");
      document.tasks[record!.id] = { sessionId: owner.id, record: record!, status: "active", deliveries: [] };
    });
    changed(); return scheduleView(record!, now());
  }

  async function scheduleCall(endpoint: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (!["schedule/catalog", "schedule/list", "schedule/history", "schedule/delete", "schedule/update"].includes(endpoint)) fail("gateway/not-found", "Unknown schedule endpoint");
    if (endpoint === "schedule/delete" || endpoint === "schedule/update") {
      keys(args, ["request"]); const request = object(args.request);
      return serial(string(request.sessionId, "sessionId"), () => scheduleCallUnlocked(endpoint, args, signal));
    }
    return scheduleCallUnlocked(endpoint, args, signal);
  }
  async function scheduleCallUnlocked(endpoint: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (endpoint === "schedule/catalog") {
      keys(args, []);
      const document = await read(undefined, signal);
      return Object.values(document.tasks).map(task => ({ ...task.record, sessionId: task.sessionId, status: task.status,
        ...(task.deliveries.at(-1) === undefined ? {} : { lastDelivery: task.deliveries.at(-1) }) }))
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.id.localeCompare(b.id));
    }
    keys(args, ["request"]); const request = object(args.request);
    const owner = await session(request.sessionId);
    if (endpoint === "schedule/list") {
      keys(request, ["sessionId"]);
      return Object.values((await read(owner.id, signal)).tasks).filter(task => task.sessionId === owner.id && task.status === "active").map(task => task.record);
    }
    const id = string(request.id, "id");
    if (endpoint === "schedule/history") {
      keys(request, ["sessionId", "id", "limit"], ["before"]);
      if (!Number.isSafeInteger(request.limit) || Number(request.limit) < 1 || Number(request.limit) > 100) fail("gateway/bad-request", "Invalid history page size");
      const task = (await read(owner.id, signal)).tasks[id];
      if (task === undefined || task.sessionId !== owner.id) return { id, code: "schedule_not_found" };
      let upper = task.deliveries.length;
      if (request.before !== undefined) {
        const before = string(request.before, "before"); upper = task.deliveries.findIndex(receipt => receipt.messageId === before);
        if (upper === -1) return { id, code: "delivery_cursor_not_found" };
      }
      const lower = Math.max(0, upper - Number(request.limit)); const records = task.deliveries.slice(lower, upper).reverse();
      return { id, records, earlierRecordsUnavailable: task.pruned === true, earlierRecordsPruned: task.pruned === true,
        retention: { days: 30, records: 1000 }, ...(lower === 0 ? {} : { nextBefore: records.at(-1)!.messageId }) };
    }
    if (endpoint === "schedule/delete") {
      keys(request, ["sessionId", "id"]);
      const result = await mutate(owner.id, signal, document => {
        const task = document.tasks[id];
        if (task === undefined || task.sessionId !== owner.id) return { id, deleted: false, code: "schedule_not_found" };
        if (task.claim !== undefined) fail("schedule/delivery-in-progress", "Wait for the admitted occurrence before deleting its task");
        delete document.tasks[id]; return { id, deleted: true };
      });
      if (result.deleted) changed(); return result;
    }
    keys(request, ["sessionId", "id", "expected"], ["title", "prompt", "change"]);
    if (owner.parentId !== undefined) return { code: "subagent_session", message: "A delegated session cannot rearm a reminder." };
    const result = await mutate(owner.id, signal, document => {
      const task = document.tasks[id];
      if (task === undefined || task.sessionId !== owner.id) return { id, updated: false, code: "schedule_not_found" };
      if (task.status === "inactive") return { id, updated: false, code: "schedule_ended" };
      if (task.claim !== undefined) return { id, updated: false, code: "schedule_conflict" };
      const update = resolveScheduleUpdate(task.record, request.expected as ScheduleRecord, request.change as ScheduleTimingChange | undefined, now(), {
        ...(request.title === undefined ? {} : { title: request.title as string }), ...(request.prompt === undefined ? {} : { prompt: request.prompt as string }),
      });
      if ("record" in update && update.updated) task.record = update.record;
      return update;
    });
    if ("updated" in result && result.updated) changed(); return result;
  }

  /** Claim before delivery. A restart repeats only the original admission id. */
  async function drive(): Promise<void> {
    if (host.submitPrompt === undefined || lifetime.signal.aborted) return;
    const document = await read(undefined, lifetime.signal);
    for (const [id, observed] of Object.entries(document.tasks)) {
      if (lifetime.signal.aborted) break;
      if (observed.status !== "active" || observed.failure !== undefined || (observed.claim === undefined && Date.parse(observed.record.scheduledAt) > now())) continue;
      if (stoppingSessions.has(observed.sessionId)) continue;
      const controller = new AbortController();
      let settle!: () => void;
      const settled = new Promise<void>(done => { settle = done; });
      // Register before the first claim await: stop/archive must also own an
      // operation whose durable claim has committed but not returned yet.
      dispatches.set(id, { sessionId: observed.sessionId, controller, settled });
      let claim: ScheduleTask["claim"];
      try {
        const signal = AbortSignal.any([lifetime.signal, controller.signal]);
        claim = await mutate(observed.sessionId, signal, current => {
          const task = current.tasks[id];
          if (task === undefined || task.status !== "active" || task.failure !== undefined) return undefined;
          if (task.claim !== undefined) return task.claim;
          // CAS can postpone a task after the scan snapshot. Its current
          // committed target, rather than that snapshot, owns admission.
          if (Date.parse(task.record.scheduledAt) > now()) return undefined;
          const occurrence = isRecurringScheduleRecord(task.record) ? resolveRecurringOccurrence(task.record, now()) : { occurrenceAt: task.record.scheduledAt };
          const requestId = `schedule_${createHash("sha256").update(`${id}\0${occurrence.occurrenceAt}`).digest("hex")}`;
          task.claim = { requestId, scheduledAt: occurrence.occurrenceAt, prompt: task.record.prompt,
            ...(occurrence.nextScheduledAt === undefined ? {} : { nextScheduledAt: occurrence.nextScheduledAt }) };
          return task.claim;
        });
        if (claim === undefined) continue;
        const admittedClaim = claim;
        if (lifetime.signal.aborted) break;
        if (controller.signal.aborted) {
          // No inbox submission has begun, so this stopped carrier is known
          // safe to release. Uncertain submissions retain their claims below.
          await mutate(observed.sessionId, lifetime.signal, current => {
            const task = current.tasks[id]; if (task?.claim?.requestId === admittedClaim.requestId) delete task.claim;
          });
          continue;
        }
        const receipt = await host.submitPrompt({ sessionId: observed.sessionId, requestId: admittedClaim.requestId, mode: "queue", content: [{ type: "text", text: admittedClaim.prompt }] }, signal);
        string(receipt.messageId, "messageId");
        await mutate(observed.sessionId, lifetime.signal, current => {
          const task = current.tasks[id];
          if (task?.claim?.requestId !== admittedClaim.requestId) fail("schedule/dispatch-conflict", "Task dispatch claim changed");
          task!.deliveries.push({ scheduledAt: admittedClaim.scheduledAt, deliveredAt: new Date(now()).toISOString(), messageId: receipt.messageId, prompt: admittedClaim.prompt });
          const cutoff = now() - 30 * 86_400_000;
          const retained = task!.deliveries.filter(item => Date.parse(item.deliveredAt) >= cutoff).slice(-1000);
          if (retained.length !== task!.deliveries.length) task!.pruned = true;
          task!.deliveries = retained;
          if (admittedClaim.nextScheduledAt === undefined) task!.status = "inactive";
          else task!.record = { ...task!.record, scheduledAt: admittedClaim.nextScheduledAt };
          delete task!.claim;
        });
        changed();
      } catch (error) {
        if (lifetime.signal.aborted) break; // Keep the durable claim for the next owning process.
        if (claim === undefined && controller.signal.aborted) continue;
        if (claim === undefined) throw error;
        const failedClaim = claim;
        await mutate(observed.sessionId, lifetime.signal, current => {
          const task = current.tasks[id];
          if (task?.claim?.requestId === failedClaim.requestId) { task.failure = "Inbox admission or receipt failed; explicit recovery is required."; task.status = "inactive"; }
        });
        changed();
        console.error("Web scheduled task delivery failed", id, error instanceof Error ? error.message : String(error));
      } finally { if (dispatches.get(id)?.controller === controller) dispatches.delete(id); settle(); }
    }
  }

  async function projectJob(owner: Session, child: Session, turn: Turn): Promise<Job> {
    const messages = await host.harness.store.listMessagesByTurn(child.id, turn.id);
    const bytes = Buffer.from(messages.filter(message => message.role === "assistant" || message.role === "tool").map(message => message.content).join("\n"));
    return { child, turn, bytes, view: { id: `subagent-${turn.id}`, kind: "subagent", label: turn.input.text.replace(/\s+/gu, " ").slice(0, 160), owner: owner.id,
      status: turn.status === "completed" ? "completed" : turn.status === "failed" ? "failed" : turn.status === "cancelled" ? "killed" : "running",
      startedAt: turn.startedAt, ...(turn.completedAt === undefined ? {} : { finishedAt: turn.completedAt }),
      ...(turn.status === "waiting_for_user" ? { detail: "Waiting for user answer" } : turn.status === "waiting_for_approval" ? { detail: "Waiting for approval" } : {}),
      output: { total: bytes.byteLength, earliest: 0 } } };
  }
  async function jobs(owner: Session): Promise<Job[]> {
    const output: Job[] = [];
    for (const child of await host.harness.store.listSessions({ parentId: owner.id })) {
      const turns = await host.harness.store.listTurns(child.id);
      for (const turn of turns) {
        output.push(await projectJob(owner, child, turn));
      }
    }
    return output.sort((a, b) => a.view.startedAt - b.view.startedAt || a.view.id.localeCompare(b.view.id));
  }
  async function job(owner: Session, id: unknown): Promise<Job> {
    const value = string(id, "jobId");
    if (!value.startsWith("subagent-")) fail("job/not-found", "Job is not owned by this session");
    const turn = await host.harness.store.getTurn(value.slice("subagent-".length) as Turn["id"]);
    const child = turn === undefined ? undefined : await host.harness.store.getSession(turn.sessionId);
    if (turn === undefined || child?.parentId !== owner.id) fail("job/not-found", "Job is not owned by this session");
    return projectJob(owner, child!, turn!);
  }
  async function interrupt(owner: Session, signal: AbortSignal): Promise<void> {
    await host.rpc.invoke("session.interrupt", { sessionId: owner.id }, { signal });
    for (const turn of await host.harness.store.listTurns(owner.id)) if (turn.status === "waiting_for_user") {
      const actor = await host.harness.sessions.load(owner.id); const cancelled = new AbortController(); cancelled.abort(); await actor.runTurn(turn.id, cancelled.signal);
    }
  }
  async function recordCommand(owner: Session, command: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    if (host.executeHostTool === undefined) fail("command/unavailable", "Command journal owner is unavailable");
    const name = "web_activity_command";
    const definition: ToolDefinition = { name, description: "Record this actual host command's lifecycle", risk: "side_effect",
      inputSchema: z.object({ path: z.literal(schedulePath) }).strict(),
      metadata: { name, version: "1", sideEffect: true, filesystem: true, process: false, network: false, interactive: false, retry: "none", concurrencySafe: false },
      async execute() {
        await host.harness.events.appendNew({ id: newEventId(), sessionId: owner.id, timestamp: now(), type: "human.message", payload: { component: "web-command", webCommand: command } });
        return { status: "success", output: undefined };
      } };
    const result = await host.executeHostTool(owner.id, definition, { path: schedulePath }, signal);
    if (result.status !== "success") fail(result.error?.code ?? "command/journal-failed", result.error?.message ?? "Command lifecycle could not be recorded");
  }
  function plugins() {
    if (host.pluginEntries === undefined) fail("plugin-manager/unavailable", "Verified installed plugin inventory is unavailable");
    return host.pluginEntries!.map(entry => ({ entryId: entry.id, moduleName: entry.id, enabled: true, fiberPhase: null,
      readOnlyReason: "management-required", meta: {
        title: `Harness Agent · ${entry.id.replace(/^@deepseek-ai\/dsh-(?:client-)?/, "").replaceAll("-", " ")}`,
        ...(entry.description === undefined ? {} : { description: entry.description.replaceAll("DeepSeek Harness", "Harness Agent") }),
      } }));
  }

  const endpoints = ["skills/list", "job/list", "job/follow", "job/kill", "schedule/list", "schedule/catalog", "schedule/history", "schedule/delete", "schedule/update",
    "pluginInventory/list", "pluginManager/listPlugins", "pluginManager/listBundles", "pluginManager/listVersionExemptions", "pluginManager/registries", "pluginRegistryProbe/fastest",
    "pluginManager/inspect", "pluginManager/setPluginEnabled", "pluginManager/setBundleEnabled", "pluginManager/installBundle", "pluginManager/removeBundle", "pluginManager/setVersionExemption", "pluginManager/waitForInstall", "pluginManager/cancelInstall",
    "commands/list", "commands/execute", "goals/get", "goals/create", "goals/edit", "goals/pause", "goals/resume", "goals/complete", "goals/clear", "subagent/prompt", "subagent/interruptByParent"];
  endpoints.push("agentPresets/list", "agentPresets/read", "agentPresets/select", "permissionPresets/catalog", "dynamicCordisRunner/syncInspectManifest", "dynamicCordisRunner/inventory",
    ...["undefineFromPanel", "runHostHalf", "getClientCode", "resolveRequestRun", "settleUserRun", "stopFromPanel", "resolveInspectQuery", "reportRenderFailure", "reportClientGuardFailure", "invoke"].map(name => `dynamicCordisRunner/${name}`));

  const modelTools: ToolDefinition[] = ["create", "list", "delete", "update"].map(operation => {
    const name = `schedule_${operation}`;
    const base = operation === "create" ? z.object({ title: z.string().min(1).max(120), prompt: z.string().min(1).max(64_000), after_seconds: z.number().optional(), at: z.unknown().optional(), every_seconds: z.number().optional(), daily: z.unknown().optional(), weekly: z.unknown().optional(), cron: z.unknown().optional() }).strict()
      : operation === "list" ? z.object({}).strict() : operation === "delete" ? z.object({ id: z.string().min(1) }).strict()
        : z.object({ id: z.string().min(1), expected: z.unknown(), title: z.string().optional(), prompt: z.string().optional(), change: z.unknown().optional() }).strict();
    return { name, description: operation === "create" ? "Create an approved durable reminder that delivers the instruction to this root session's inbox at the specified time. Exactly one timing selector is required; recurring interval must be at least 60 seconds." : `Read or manage this session's actual durable reminders (${operation}).`,
      inputSchema: base.transform(input => ({ ...input, path: schedulePath })), risk: operation === "list" ? "readonly" : "elevated",
      metadata: { name, version: "1", sideEffect: operation !== "list", filesystem: true, network: false, process: false, interactive: false, retry: operation === "list" ? "safe" : "none", concurrencySafe: false },
      async execute(input: unknown, context) {
        try {
          const { path: _fixedPath, ...request } = input as Record<string, unknown>;
          const sessionId = host.externalSessionId?.(context.sessionId) ?? context.sessionId;
          const output = operation === "create" ? await createSchedule(sessionId, request, context.signal)
            : await scheduleCall(`schedule/${operation}`, { request: { ...request, sessionId } }, context.signal);
          return { status: "success", output };
        } catch (error) { return { status: "failed", error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) } }; }
      } } as ToolDefinition;
  });

  return {
    endpoints, modelTools, schedulePath,
    async sessionActivity(sessionId: string, signal: AbortSignal) {
      const owner = await session(sessionId); const tasks = Object.values((await read(owner.id, signal)).tasks).filter(task => task.sessionId === owner.id);
      return { activeSchedules: tasks.filter(task => task.status === "active").length, pendingDispatches: [...dispatches.values()].filter(item => item.sessionId === owner.id).length,
        unresolvedClaims: tasks.filter(task => task.claim !== undefined).length, jobs: (await jobs(owner)).map(item => item.view) };
    },
    async stopSessionActivity(sessionId: string, signal: AbortSignal) {
      const owner = await session(sessionId);
      stoppingSessions.set(owner.id, (stoppingSessions.get(owner.id) ?? 0) + 1);
      try {
        const active = [...dispatches.values()].filter(item => item.sessionId === owner.id);
        for (const item of active) item.controller.abort();
        await mutate(owner.id, signal, document => { for (const task of Object.values(document.tasks)) if (task.sessionId === owner.id) task.status = "inactive"; });
        changed();
        await Promise.all(active.map(item => item.settled));
        const tasks = Object.values((await read(owner.id, signal)).tasks).filter(task => task.sessionId === owner.id);
        return { activeSchedules: tasks.filter(task => task.status === "active").length, pendingDispatches: [...dispatches.values()].filter(item => item.sessionId === owner.id).length,
          unresolvedClaims: tasks.filter(task => task.claim !== undefined).length, jobs: (await jobs(owner)).map(item => item.view) };
      } finally {
        const count = stoppingSessions.get(owner.id)! - 1;
        if (count === 0) stoppingSessions.delete(owner.id); else stoppingSessions.set(owner.id, count);
      }
    },
    async start(): Promise<void> {
      if (timer !== undefined || host.dataDir === undefined || host.submitPrompt === undefined) return;
      await read(undefined, lifetime.signal);
      const tick = () => { if (driving === undefined && !lifetime.signal.aborted) { driving = drive().finally(() => { driving = undefined; }); driving.catch(error => { if (!lifetime.signal.aborted) console.error("Web task drive failed", error instanceof Error ? error.message : String(error)); }); } };
      timer = setInterval(tick, Math.max(10, host.pollDelayMs ?? 1000)); timer.unref(); tick();
    },
    async close(): Promise<void> { lifetime.abort(); if (timer !== undefined) clearInterval(timer); try { await driving; } catch (error) { console.error("Web task drive shutdown failed", error instanceof Error ? error.message : String(error)); } },
    async drive(): Promise<void> { if (driving === undefined) driving = drive().finally(() => { driving = undefined; }); await driving; },
    async call(endpoint: string, input: unknown, signal: AbortSignal): Promise<unknown> {
      signal.throwIfAborted(); const args = object(input);
      if (endpoint.startsWith("schedule/")) return scheduleCall(endpoint, args, signal);
      if (endpoint === "skills/list") {
        keys(args, ["request"]); const request = object(args.request); keys(request, ["sessionId"]); await session(request.sessionId);
        const skills = await (await ownerHarness(string(request.sessionId, "sessionId"))).listSkills(); signal.throwIfAborted();
        return { skills: skills.filter(skill => skill.headers?.["user-invocable"] !== "false" && skill.status !== "deprecated" && skill.status !== "removed").map(skill => ({ name: skill.manifest.name, description: skill.manifest.description, path: skill.path, modelInvocable: skill.headers?.["disable-model-invocation"] !== "true" })) };
      }
      if (endpoint === "job/kill") {
        keys(args, ["request"]); const request = object(args.request); keys(request, ["sessionId", "jobId"]);
        const current = await job(await session(request.sessionId), request.jobId);
        if (current.view.status !== "running") return { outcome: "already-finished" };
        const actor = await host.harness.sessions.load(current.child.id);
        const cancelled = await actor.cancelTurn(current.turn.id);
        if (cancelled.disposition === "cancel_requested") return { outcome: "requested" };
        const actual = await host.harness.store.getTurn(current.turn.id);
        if (actual?.status === "completed" || actual?.status === "failed" || actual?.status === "cancelled") return { outcome: "already-finished" };
        if (actual?.status === "waiting_for_user" && actor.status().activeTurn === undefined) {
          const aborted = new AbortController(); aborted.abort(); await actor.runTurn(actual.id, aborted.signal); return { outcome: "requested" };
        }
        fail("job/cancellation-unavailable", "The selected turn has no cancellable actor slot; another turn was not interrupted");
      }
      if (endpoint === "pluginInventory/list") { keys(args, []); return { managementAvailable: false, entries: plugins().map(({ readOnlyReason: _readOnly, ...entry }) => entry) }; }
      if (endpoint === "pluginManager/listPlugins") { keys(args, []); return plugins(); }
      if (endpoint === "pluginManager/listBundles") {
        keys(args, []); plugins(); return []; // No Cordis bundle manifests are mounted; client assets are not installable host bundles.
      }
      if (endpoint === "pluginManager/listVersionExemptions") { keys(args, []); return { exemptions: {}, warnings: ["This host loads only the pinned shipped client modules; arbitrary Cordis host bundles are not executable."] }; }
      if (endpoint === "pluginManager/registries") { keys(args, []); return { registry: null, fallbackRegistries: [], resolved: null }; }
      if (endpoint === "pluginRegistryProbe/fastest") { keys(args, []); return null; } // Registry probing is disabled; no hidden network call.
      if (endpoint.startsWith("pluginManager/")) fail("plugin-manager/unavailable", "Dynamic Cordis bundle installation is not supported by this Harness host");
      if (endpoint === "agentPresets/list") {
        keys(args, []); return { presets: host.harness.agents.map((agent, index) => ({ id: agent.name, name: agent.name, isDefault: index === 0,
          description: index === 0 ? "Native Harness coding composition" : "Native Harness specialist role",
          ...(index === 0 ? {} : { broken: "Specialist roles are delegated by the native runtime; this host currently creates root sessions with its default coding agent." }) })) };
      }
      if (endpoint === "agentPresets/read") {
        keys(args, ["agentPreset"]); const preset = string(args.agentPreset, "agentPreset");
        const agent = host.harness.agents.find(agent => agent.id === preset || agent.name === preset);
        if (agent === undefined) fail("agent-preset/not-found", "Agent preset is unavailable");
        return { agentPreset: agent!.name, name: agent!.name, description: "Native Harness frozen composition; no Cordis host bundle is mounted.",
          content: `# Native Harness agent definition\n${JSON.stringify({ id: agent!.id, name: agent!.name, model: agent!.model, tools: agent!.tools, permissions: agent!.permissions, limits: agent!.limits }, null, 2)}\n` };
      }
      if (endpoint === "agentPresets/select") {
        keys(args, ["agentId", "agentPreset"]);
        return serial(string(args.agentId, "agentId"), async () => {
          const owner = await session(args.agentId); const requested = string(args.agentPreset, "agentPreset");
          const actual = await host.harness.runtime.getSessionAgent(owner.id);
          // Selecting the already frozen native composition changes nothing.
          // It is also the official client's blank-session default handshake.
          if (requested === actual.id || requested === actual.name) return actual.name;
          if (!host.harness.agents.some(agent => agent.id === requested || agent.name === requested)) fail("agent-preset/not-found", "Unknown native agent preset");
          fail("agent-preset/locked", "This session keeps its frozen native agent identity; other native roles are delegated by the runtime");
        });
      }
      if (endpoint === "permissionPresets/catalog") {
        keys(args, []); const permissions = host.harness.agents[0]?.permissions ?? resolveProfile(host.harness.profile).permissions;
        const edits = permissions.rules.find(rule => rule.action === "edit" && rule.resource === "file" && rule.pattern === undefined)?.effect ?? permissions.defaultEffect ?? "ask";
        const option = { value: host.harness.profile, name: host.harness.profile, description: `Native ${host.harness.profile} composition: file edits ${edits}; existing sessions retain frozen permissions.` };
        return { options: [option], defaultOptions: [option], defaultPreset: option.value };
      }
      if (endpoint === "dynamicCordisRunner/syncInspectManifest") {
        keys(args, ["providers"]);
        if (!Array.isArray(args.providers) || args.providers.length > 200) fail("gateway/bad-request", "Invalid client inspect provider manifest");
        const accepted = new Map<string, Record<string, unknown>>();
        for (const raw of args.providers as unknown[]) {
          const provider = object(raw); keys(provider, ["id", "description", "methods"]);
          const id = string(provider.id, "id"); string(provider.description, "description", true);
          if (id.length > 200 || accepted.has(id) || !Array.isArray(provider.methods) || provider.methods.length > 100) fail("gateway/bad-request", "Invalid inspect provider identity or methods");
          const methodNames = new Set<string>();
          for (const rawMethod of provider.methods as unknown[]) {
            const method = object(rawMethod); keys(method, ["name", "description", "inputSchema", "outputSchema"]);
            const name = string(method.name, "name"); string(method.description, "description", true);
            if (name.length > 200 || methodNames.has(name)) fail("gateway/bad-request", "Duplicate inspect method");
            methodNames.add(name); validateJson(method.inputSchema); validateJson(method.outputSchema);
          }
          accepted.set(id, structuredClone(provider));
        }
        inspectProviders.clear(); for (const [id, provider] of accepted) inspectProviders.set(id, provider);
        return null;
      }
      if (endpoint === "dynamicCordisRunner/inventory") { keys(args, []); return [...dynamicPlugins.values()]; }
      if (endpoint.startsWith("dynamicCordisRunner/")) fail("cordis/unavailable", "Dynamic Cordis host execution is not mounted in this native Harness process");
      if (endpoint === "goals/get") { keys(args, ["agentId"]); await session(args.agentId); return undefined; } // No goal continuation owner is mounted.
      if (endpoint.startsWith("goals/")) fail("goal/unavailable", "This host has no durable goal continuation owner");
      if (endpoint === "commands/list") {
        keys(args, ["agentId"]); await session(args.agentId);
        return [{ name: "cancel", description: "Cancel this session's actual active or waiting turn" }, { name: "skills", description: "List the actual skills available to this session" },
          { name: "schedule", description: "Create a durable reminder from JSON timing/title/prompt", input: { hint: '{"title":"Review","prompt":"Run tests","after_seconds":60}' } }];
      }
      if (endpoint === "commands/execute") {
        keys(args, ["agentId", "line", "submittedAttachments"]); const owner = await session(args.agentId); const line = string(args.line, "line");
        if (!Array.isArray(args.submittedAttachments) || args.submittedAttachments.length > 0) fail("command/attachment-invalid", "These commands accept no attachments");
        const match = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(line); if (match === null || !["cancel", "skills", "schedule"].includes(match[1]!)) return undefined;
        const commandId = `command-${randomUUID()}`;
        await recordCommand(owner, { phase: "run", commandId, name: match[1]!, args: match[2] ?? "" }, signal);
        let result: { kind: "success" | "error"; text?: string };
        try {
          if (match[1] === "cancel") { await interrupt(owner, signal); result = { kind: "success", text: "Cancellation was admitted." }; }
          else if (match[1] === "skills") result = { kind: "success", text: (await (await ownerHarness(owner.id)).listSkills())
            .filter(skill => skill.headers?.["user-invocable"] !== "false" && skill.status !== "deprecated" && skill.status !== "removed")
            .map(skill => `${skill.manifest.name}: ${skill.manifest.description}`).join("\n") || "No user-invocable skills are installed." };
          else {
            const value = await createSchedule(owner.id, JSON.parse(match[2] ?? ""), signal);
            result = { kind: typeof value === "object" && value !== null && "code" in value ? "error" : "success", text: JSON.stringify(value) };
          }
        } catch (error) { result = { kind: "error", text: error instanceof Error ? error.message : String(error) }; }
        await recordCommand(owner, { phase: "done", commandId, ...result }, new AbortController().signal);
        return { commandId, result };
      }
      if (endpoint === "subagent/interruptByParent") {
        keys(args, ["childSessionId", "parentSessionId", "mode"]); if (args.mode !== "continuable") fail("gateway/bad-request", "Invalid child control mode");
        const parent = await session(args.parentSessionId); const child = await session(args.childSessionId);
        if (child.parentId !== parent.id) fail("subagent/unauthorized", "Child belongs to another direct parent");
        await interrupt(child, signal); return { accepted: true };
      }
      if (endpoint === "subagent/prompt") fail("subagent/not-resumable", "Native Harness delegations are one-shot; no continuable child inbox owner is mounted");
      fail("gateway/not-found", `Unknown activity endpoint: ${endpoint}`);
    },
    async *stream(endpoint: string, input: unknown, signal: AbortSignal, _uplink?: AsyncIterable<unknown>): AsyncIterable<unknown> {
      signal.throwIfAborted(); const args = object(input); keys(args, ["request"]); const request = object(args.request);
      if (endpoint === "job/list") {
        keys(request, ["sessionId"]); const owner = await session(request.sessionId); let previous: string | undefined;
        while (!signal.aborted) {
          const rows = (await jobs(owner)).map(item => item.view); const encoded = JSON.stringify(rows);
          if (encoded !== previous) { yield { type: "rows", jobs: rows }; previous = encoded; }
          await pause(host.pollDelayMs ?? 100, signal);
        }
        return;
      }
      if (endpoint !== "job/follow") fail("gateway/not-found", `Unknown activity stream: ${endpoint}`);
      keys(request, ["jobId"], ["sessionId", "from"]);
      if (request.sessionId === undefined) fail("job/not-found", "This host has no unowned jobs");
      if (request.from !== undefined && (!Number.isSafeInteger(request.from) || Number(request.from) < 0)) fail("gateway/bad-request", "Invalid output resume offset");
      const owner = await session(request.sessionId); let current = await job(owner, request.jobId); let cursor = Number(request.from ?? 0);
      if (cursor > current.bytes.byteLength) fail("job/invalid-offset", "Output resume offset is beyond retained output");
      if (cursor < current.bytes.byteLength && (current.bytes[cursor]! & 0xc0) === 0x80) fail("job/invalid-offset", "Output resume offset splits a UTF-8 codepoint");
      yield { type: "opened", job: current.view, from: cursor };
      while (!signal.aborted) {
        if (current.bytes.byteLength > cursor) {
          const at = cursor; const text = current.bytes.subarray(at).toString("utf8"); cursor = current.bytes.byteLength;
          yield { type: "output", chunks: [{ at, text, channel: "log" }], next: cursor };
        }
        if (current.view.status !== "running") { yield { type: "status", job: current.view }; return; }
        await pause(host.pollDelayMs ?? 100, signal); if (!signal.aborted) current = await job(owner, request.jobId);
      }
    },
  };
}

function validateJson(value: unknown, depth = 0, seen = new Set<object>()): void {
  if (depth > 20) fail("gateway/bad-request", "Inspect schema exceeds its depth limit");
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (typeof value !== "object" || seen.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail("gateway/bad-request", "Inspect schemas must be bounded lossless JSON");
  seen.add(value as object);
  for (const item of Object.values(value as object)) validateJson(item, depth + 1, seen);
  seen.delete(value as object);
}
