import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHarness } from "@ar/harness";
import { createRuntimeRpc } from "@ar/gateway";
import { ScriptedModelProvider } from "@ar/model";
import type { ModelEvent, ModelProvider, SessionId } from "@ar/contracts";
import { createHostTools } from "./host-tools.js";
import { createSessionService, type SessionHost } from "./session.js";
import { createActivityService, type ActivityHost } from "./activity.js";
import { projectSessionHistory } from "./projections.js";
import { createOwnerManager } from "./owners.js";
import { createDeepseekComposition } from "./composition.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); vi.unstubAllEnvs(); });
async function setup(options: { provider?: ModelProvider; clock?: "real"; denyModelEdits?: boolean; admitTaskPath?: boolean } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "dsh-activity-real-"))); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "project"); const dataDir = join(directory, "state"); await mkdir(cwd); await mkdir(dataDir);
  const clock = { value: Date.parse("2026-10-11T00:00:00.000Z") };
  const now = options.clock === "real" ? Date.now : () => clock.value;
  const provider = options.provider ?? new ScriptedModelProvider([ScriptedModelProvider.text("真实执行 completed")]);
  const path = join(dataDir, "deepseek", "schedules.json");
  const harness = await createHarness({ cwd, dataDir, profile: "interactive", modelProvider: provider,
    model: { providerId: provider.id, modelId: "scripted-model" }, sandboxPolicy: { filesystem: { mode: "workspace-write", allowedPaths: options.admitTaskPath === false ? [cwd] : [cwd, path] }, network: { mode: "deny" }, process: {} } });
  cleanup.push(() => harness.close());
  const tools = createHostTools(harness, cwd, dataDir);
  const rpc = createRuntimeRpc(harness.runtime, { sessions: harness.sessions, sessionService: harness.sessionService, events: harness.events, approvalStore: harness.approvalStore });
  const sessionHost: SessionHost = { harness, rpc, cwd, dataDir, pollDelayMs: 10, ...tools };
  const sessions = createSessionService(sessionHost); cleanup.push(() => sessions.close()); const signal = new AbortController().signal;
  const submissions: Array<{ requestId: string; messageId: string }> = [];
  const publications: Array<{ topic: string; args: readonly unknown[] }> = [];
  const host: ActivityHost = { ...sessionHost, now,
    pluginEntries: [{ id: "@deepseek-ai/dsh-client-ui-schedule" }],
    publish(topic, args) { publications.push({ topic, args }); sessions.publish(topic, args); },
    submitPrompt: async (request, lifetime) => {
      await sessions.call("session/prompt", { request }, lifetime);
      const messageId = (await sessions.metadata.read(request.sessionId)).requests[request.requestId]?.promptId;
      if (messageId === undefined) throw new Error("Actual inbox receipt is missing");
      submissions.push({ requestId: request.requestId, messageId }); return { messageId };
    },
  };
  const activity = createActivityService(host); cleanup.push(() => activity.close());
  for (const definition of activity.modelTools) harness.registry.register(definition);
  for (const agent of harness.agents) {
    if (agent.tools.allow !== undefined) agent.tools.allow = [...agent.tools.allow, ...activity.modelTools.map(tool => tool.name)];
    if (options.denyModelEdits) agent.permissions = { rules: [{ action: "read", resource: "file", effect: "allow" }, { action: "edit", resource: "file", effect: "deny" }] };
  }
  const created = await sessions.call("session/create", { request: {} }, signal) as { sessionId: SessionId };
  const command = (line: string) => activity.call("commands/execute", { agentId: created.sessionId, line, submittedAttachments: [] }, signal);
  const create = async (timing: Record<string, unknown> = { after_seconds: 1 }) => {
    const reply = await command(`/schedule ${JSON.stringify({ title: "真实 reminder", prompt: "run coding followup", ...timing })}`) as { commandId: string; result: { kind: string; text: string } };
    expect(reply.result.kind).toBe("success"); return JSON.parse(reply.result.text) as { id: string; kind: string; title: string; prompt: string; scheduledAt: string };
  };
  const call = (endpoint: string, request: Record<string, unknown>) => activity.call(endpoint, { request }, signal);
  return { directory, cwd, dataDir, path, clock, harness, tools, host, sessions, activity, signal, id: created.sessionId, command, create, call, submissions, publications };
}
async function eventually<T>(read: () => Promise<T>, accepts: (value: T) => boolean, attempts = 400): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < attempts; i++) { last = await read(); if (accepts(last)) return last; await new Promise(done => setTimeout(done, 5)); }
  throw new Error(`Actual activity owner did not settle: ${JSON.stringify(last)}`);
}

it("presents Harness Agent component metadata while retaining actual module identities", async () => {
  const stack = await setup();
  stack.host.pluginEntries = [{ id: "@deepseek-ai/dsh-client-ui-brand-official", description: "Official DeepSeek Harness brand occupants" }];
  const entries = await stack.activity.call("pluginManager/listPlugins", {}, stack.signal);
  expect(entries).toMatchObject([{ moduleName: "@deepseek-ai/dsh-client-ui-brand-official", meta: {
    title: "Harness Agent · ui brand official", description: "Official Harness Agent brand occupants",
  } }]);
  expect(JSON.stringify(entries)).not.toContain("DeepSeek Harness");
});

it("the real wall-clock timer durably admits one reminder and the actual actor executes it", async () => {
  const stack = await setup({ clock: "real" }); const task = await stack.create(); await stack.activity.start();
  const turns = await eventually(() => stack.harness.store.listTurns(stack.id), values => values.length === 1 && values[0]?.status === "completed");
  expect(turns[0]!.input.text).toBe("run coding followup");
  const catalog = await stack.activity.call("schedule/catalog", {}, stack.signal) as Array<{ id: string; status: string; lastDelivery: { messageId: string } }>;
  expect(catalog).toMatchObject([{ id: task.id, status: "inactive" }]);
  const inbox = await stack.harness.inbox.listAll(stack.id);
  expect(inbox).toHaveLength(1); expect(catalog[0]!.lastDelivery.messageId).toBe(inbox[0]!.id);
  expect((await stack.harness.store.listMessages(stack.id)).filter(message => message.role === "assistant").map(message => message.content)).toContain("真实执行 completed");
  const disk = JSON.parse(await readFile(stack.path, "utf8")) as { tasks: Record<string, { claim?: unknown; deliveries: unknown[] }> };
  expect(disk.tasks[task.id]!.claim).toBeUndefined(); expect(disk.tasks[task.id]!.deliveries).toHaveLength(1);
});

it("concurrent drives share their durable claim and never enqueue a duplicate model turn", async () => {
  const stack = await setup(); const task = await stack.create(); stack.clock.value += 1001;
  await Promise.all([stack.activity.drive(), stack.activity.drive(), stack.activity.drive()]);
  await eventually(() => stack.harness.store.listTurns(stack.id), values => values[0]?.status === "completed");
  expect(stack.submissions).toHaveLength(1); expect(await stack.harness.inbox.listAll(stack.id)).toHaveLength(1);
  const history = await stack.call("schedule/history", { sessionId: stack.id, id: task.id, limit: 20 }) as { records: Array<{ messageId: string; prompt: string }> };
  expect(history.records).toMatchObject([{ messageId: stack.submissions[0]!.messageId, prompt: "run coding followup" }]);
  const restarted = createActivityService(stack.host); cleanup.push(() => restarted.close()); await restarted.drive();
  expect(await stack.harness.store.listTurns(stack.id)).toHaveLength(1); expect(stack.submissions).toHaveLength(1);
});

it("shutdown after durable inbox admission but before task receipt recovers only the same admission identity", async () => {
  const stack = await setup(); const task = await stack.create(); stack.clock.value += 1001;
  const original = stack.host.executeHostTool!; let holdReceipt = true; let arrived!: () => void;
  const atReceipt = new Promise<void>(done => { arrived = done; });
  stack.host.executeHostTool = async (owner, definition, args, signal) => {
    if (holdReceipt && stack.submissions.length > 0 && definition.name === "web_activity_metadata" && definition.risk !== "readonly") {
      arrived(); await new Promise<void>((_resolve, reject) => {
        const aborted = () => reject(new Error("Simulated process exit before receipt write"));
        if (signal.aborted) aborted(); else signal.addEventListener("abort", aborted, { once: true });
      });
    }
    return original(owner, definition, args, signal);
  };
  const drive = stack.activity.drive(); await atReceipt; await stack.activity.close(); await drive;
  const interrupted = JSON.parse(await readFile(stack.path, "utf8")) as { tasks: Record<string, { claim: { requestId: string }; deliveries: unknown[]; status: string }> };
  expect(interrupted.tasks[task.id]!.status).toBe("active"); expect(interrupted.tasks[task.id]!.deliveries).toEqual([]);
  expect(interrupted.tasks[task.id]!.claim.requestId).toBe(stack.submissions[0]!.requestId);
  holdReceipt = false; const restarted = createActivityService(stack.host); cleanup.push(() => restarted.close()); await restarted.drive();
  await eventually(() => stack.harness.store.listTurns(stack.id), values => values[0]?.status === "completed");
  expect(stack.submissions).toHaveLength(2); expect(new Set(stack.submissions.map(item => item.requestId)).size).toBe(1);
  expect(await stack.harness.inbox.listAll(stack.id)).toHaveLength(1); expect(await stack.harness.store.listTurns(stack.id)).toHaveLength(1);
  expect(await restarted.call("schedule/catalog", {}, stack.signal)).toMatchObject([{ id: task.id, status: "inactive" }]);
});

it("an uncertain admission is retained as unresolved and never silently retried or shown as delivered", async () => {
  const stack = await setup(); const task = await stack.create(); stack.clock.value += 1001;
  const admitted = stack.host.submitPrompt!;
  stack.host.submitPrompt = async (request, signal) => { await admitted(request, signal); throw Object.assign(new Error("Lost admission acknowledgement"), { code: "session/admission-uncertain" }); };
  await stack.activity.drive(); const restarted = createActivityService(stack.host); cleanup.push(() => restarted.close()); await restarted.drive();
  expect(stack.submissions).toHaveLength(1); expect(await stack.harness.inbox.listAll(stack.id)).toHaveLength(1);
  const rows = await stack.activity.call("schedule/catalog", {}, stack.signal) as Array<{ status: string; lastDelivery?: unknown }>;
  expect(rows[0]).toMatchObject({ status: "inactive" }); expect(rows[0]!.lastDelivery).toBeUndefined();
  expect(await stack.activity.sessionActivity(stack.id, stack.signal)).toMatchObject({ activeSchedules: 0, pendingDispatches: 0, unresolvedClaims: 1 });
  await expect(stack.call("schedule/update", { sessionId: stack.id, id: task.id, expected: task, title: "retry" })).resolves.toMatchObject({ code: "schedule_ended" });
});

it("task CAS persists one edit, preserves equivalent targets, and fences another session's task", async () => {
  const stack = await setup(); await stack.create({ every_seconds: 60 });
  const task = (await stack.call("schedule/list", { sessionId: stack.id }) as Array<{ id: string; scheduledAt: string }>)[0]!;
  const requests = ["first", "second"].map(title => stack.call("schedule/update", { sessionId: stack.id, id: task.id, expected: task, title }));
  const results = await Promise.all(requests) as Array<{ updated: boolean; code?: string; record?: { scheduledAt: string; title: string } }>;
  expect(results.filter(item => item.updated)).toHaveLength(1); expect(results.filter(item => item.code === "schedule_conflict")).toHaveLength(1);
  expect(results.find(item => item.updated)!.record!.scheduledAt).toBe(task.scheduledAt);
  const foreign = await stack.sessions.call("session/create", { request: {} }, stack.signal) as { sessionId: string };
  expect(await stack.call("schedule/delete", { sessionId: foreign.sessionId, id: task.id })).toMatchObject({ deleted: false, code: "schedule_not_found" });
  expect(await stack.call("schedule/history", { sessionId: foreign.sessionId, id: task.id, limit: 10 })).toMatchObject({ code: "schedule_not_found" });
  expect(await stack.call("schedule/list", { sessionId: stack.id })).toHaveLength(1);
  await expect(stack.call("schedule/history", { sessionId: stack.id, id: task.id, limit: 0 })).rejects.toMatchObject({ code: "gateway/bad-request" });
});

it("an unknown schedule namespace cannot fall through into a real durable task update", async () => {
  const stack = await setup(); await stack.create({ every_seconds: 60 });
  const task = (await stack.call("schedule/list", { sessionId: stack.id }) as Array<{ id: string; title: string }>)[0]!;
  await expect(stack.call("schedule/unknown", { sessionId: stack.id, id: task.id, expected: task, title: "unowned endpoint mutation" })).rejects.toMatchObject({ code: "gateway/not-found" });
  expect(await stack.call("schedule/list", { sessionId: stack.id })).toMatchObject([{ title: task.title }]);
});

it("a task postponed after the timer snapshot is never admitted before its current committed target", async () => {
  const stack = await setup(); await stack.create();
  const record = (await stack.call("schedule/list", { sessionId: stack.id }) as Array<{ id: string }>)[0]!;
  stack.clock.value += 1001;
  const original = stack.host.executeHostTool!; let armed = true; let arrived!: () => void; let release!: () => void;
  const observed = new Promise<void>(done => { arrived = done; }); const held = new Promise<void>(done => { release = done; });
  stack.host.executeHostTool = async (owner, definition, args, signal) => {
    const result = await original(owner, definition, args, signal);
    if (armed && owner === undefined && definition.name === "web_activity_metadata" && definition.risk === "readonly") {
      armed = false; arrived(); await held;
    }
    return result;
  };
  const drive = stack.activity.drive(); await observed;
  const target = new Date(stack.clock.value + 60_000).toISOString();
  expect(await stack.call("schedule/update", { sessionId: stack.id, id: record.id, expected: record, change: { kind: "at", at: target } })).toMatchObject({ updated: true });
  release(); await drive;
  expect(stack.submissions).toHaveLength(0); expect(await stack.harness.inbox.listAll(stack.id)).toHaveLength(0);
  stack.clock.value += 60_001; await stack.activity.drive();
  expect(stack.submissions).toHaveLength(1); expect(await stack.harness.inbox.listAll(stack.id)).toHaveLength(1);
});

it("stop owns the gap after a durable claim commit and before its carrier receives that claim", async () => {
  const stack = await setup(); const task = await stack.create(); stack.clock.value += 1001;
  const original = stack.host.executeHostTool!; let armed = true; let arrived!: () => void; let release!: () => void;
  const committed = new Promise<void>(done => { arrived = done; }); const held = new Promise<void>(done => { release = done; });
  stack.host.executeHostTool = async (owner, definition, args, signal) => {
    const result = await original(owner, definition, args, signal);
    if (armed && owner === stack.id && definition.name === "web_activity_metadata" && definition.risk !== "readonly") {
      armed = false; arrived(); await held;
    }
    return result;
  };
  const drive = stack.activity.drive(); await committed;
  expect(await stack.activity.sessionActivity(stack.id, stack.signal)).toMatchObject({ pendingDispatches: 1, unresolvedClaims: 1 });
  const stopping = stack.activity.stopSessionActivity(stack.id, stack.signal);
  await eventually(() => stack.activity.call("schedule/catalog", {}, stack.signal) as Promise<Array<{ status: string }>>, rows => rows[0]?.status === "inactive");
  release(); await drive;
  expect(await stopping).toMatchObject({ activeSchedules: 0, pendingDispatches: 0, unresolvedClaims: 0 });
  expect(stack.submissions).toHaveLength(0); expect(await stack.harness.inbox.listAll(stack.id)).toHaveLength(0);
  const disk = JSON.parse(await readFile(stack.path, "utf8")) as { tasks: Record<string, { claim?: unknown }> };
  expect(disk.tasks[task.id]!.claim).toBeUndefined();
});

it("two browser generations independently receive only committed task invalidations", async () => {
  const stack = await setup();
  const controllers = [new AbortController(), new AbortController()];
  const streams = controllers.map(controller => stack.sessions.stream("$events", {}, controller.signal)[Symbol.asyncIterator]());
  cleanup.push(async () => { controllers.forEach(controller => controller.abort()); await Promise.all(streams.map(stream => stream.return?.())); });
  const ready = await Promise.all(streams.map(stream => stream.next()));
  expect(ready.map(item => item.value)).toMatchObject([{ type: "ready" }, { type: "ready" }]);
  expect((ready[0]!.value as { clientId: string }).clientId).not.toBe((ready[1]!.value as { clientId: string }).clientId);
  async function changed(stream: AsyncIterator<unknown>) {
    for (let i = 0; i < 30; i++) {
      const message = await stream.next();
      if ((message.value as { event?: string })?.event === "schedule/changed") return message.value;
      if (message.done) break;
    }
    throw new Error("Actual session event generation did not deliver committed task invalidation");
  }
  const task = await stack.create();
  expect(await Promise.all(streams.map(changed))).toEqual([{ type: "emit", event: "schedule/changed", args: [] }, { type: "emit", event: "schedule/changed", args: [] }]);
  expect(stack.publications).toEqual([{ topic: "schedule/changed", args: [] }]);
  const foreign = await stack.sessions.call("session/create", { request: {} }, stack.signal) as { sessionId: string };
  await stack.call("schedule/delete", { sessionId: foreign.sessionId, id: task.id });
  expect(stack.publications).toHaveLength(1);
  await stack.call("schedule/delete", { sessionId: stack.id, id: task.id });
  expect(await Promise.all(streams.map(changed))).toEqual([{ type: "emit", event: "schedule/changed", args: [] }, { type: "emit", event: "schedule/changed", args: [] }]);
  expect(stack.publications).toHaveLength(2);
});

it("stopping one session's actual schedules never disables a different session's timers", async () => {
  const stack = await setup(); await stack.create(); const other = await stack.sessions.call("session/create", { request: {} }, stack.signal) as { sessionId: string };
  await stack.activity.call("commands/execute", { agentId: other.sessionId, line: '/schedule {"title":"other","prompt":"other followup","after_seconds":1}', submittedAttachments: [] }, stack.signal);
  expect(await stack.activity.stopSessionActivity(stack.id, stack.signal)).toMatchObject({ activeSchedules: 0, pendingDispatches: 0 });
  stack.clock.value += 1001; await stack.activity.drive();
  expect(await stack.harness.inbox.listAll(stack.id)).toHaveLength(0); expect(await stack.harness.inbox.listAll(other.sessionId as SessionId)).toHaveLength(1);
});

it("model task writes obey the actual frozen deny policy and never dispatch the inner metadata write", async () => {
  const provider = new ScriptedModelProvider([ScriptedModelProvider.toolCall("schedule_create", { title: "Denied", prompt: "never run", after_seconds: 60 }), ScriptedModelProvider.text("Denied observed")]);
  const stack = await setup({ provider, denyModelEdits: true });
  await stack.sessions.call("session/prompt", { request: { requestId: "deny-task", sessionId: stack.id, mode: "queue", content: [{ type: "text", text: "Attempt denied task" }] } }, stack.signal);
  await eventually(() => stack.harness.store.listTurns(stack.id), values => values[0]?.status === "completed");
  expect(await stack.activity.call("schedule/catalog", {}, stack.signal)).toEqual([]);
  expect((await stack.harness.events.list(stack.id)).some(event => event.type === "security.permission_denied" && event.payload.tool === "schedule_create")).toBe(true);
  expect((await stack.harness.events.list(stack.id)).some(event => event.type === "tool.started" && event.payload.tool === "schedule_create")).toBe(false);
});

it("model task creation requires the real outer approval and denial leaves no task", async () => {
  const provider = new ScriptedModelProvider([ScriptedModelProvider.toolCall("schedule_create", { title: "Approval", prompt: "guarded", after_seconds: 60 }), ScriptedModelProvider.text("Declined")]);
  const stack = await setup({ provider });
  await stack.sessions.call("session/prompt", { request: { requestId: "approve-task", sessionId: stack.id, mode: "queue", content: [{ type: "text", text: "Create reminder" }] } }, stack.signal);
  const approvals = await eventually(async () => stack.harness.approvalStore.listPending(stack.id), values => values.length === 1);
  expect(approvals[0]!.target).toBe(stack.path); expect(approvals[0]!.action).toBe("edit");
  expect(await stack.activity.call("schedule/catalog", {}, stack.signal)).toEqual([]);
  stack.harness.approvalStore.resolve(approvals[0]!.id, "deny", "web");
  await eventually(() => stack.harness.store.listTurns(stack.id), values => values[0]?.status === "completed");
  expect(await stack.activity.call("schedule/catalog", {}, stack.signal)).toEqual([]);
});

it("a granted model approval persists the true task, while an absent sandbox capability still refuses it", async () => {
  for (const admitted of [true, false]) {
    const provider = new ScriptedModelProvider([ScriptedModelProvider.toolCall("schedule_create", { title: "Approved", prompt: "guarded followup", after_seconds: 60 }), ScriptedModelProvider.text("Tool outcome observed")]);
    const stack = await setup({ provider, admitTaskPath: admitted });
    await stack.sessions.call("session/prompt", { request: { requestId: "approve-actual-task", sessionId: stack.id, mode: "queue", content: [{ type: "text", text: "Create controlled reminder" }] } }, stack.signal);
    const requests = await eventually(async () => stack.harness.approvalStore.listPending(stack.id), values => values.length === 1);
    expect(requests[0]!.target).toBe(stack.path); stack.harness.approvalStore.resolve(requests[0]!.id, "allow", "web");
    await eventually(() => stack.harness.store.listTurns(stack.id), values => values[0]?.status === "completed");
    const catalog = await stack.activity.call("schedule/catalog", {}, stack.signal) as unknown[];
    expect(catalog).toHaveLength(admitted ? 1 : 0);
    if (!admitted) expect((await stack.harness.events.list(stack.id)).some(event => event.type === "security.filesystem_denied" && event.payload.tool === "schedule_create")).toBe(true);
  }
});

it("the model cannot replace the server-owned schedule path through extra tool arguments", async () => {
  const provider = new ScriptedModelProvider([ScriptedModelProvider.toolCall("schedule_create", { title: "Injected path", prompt: "guarded", after_seconds: 60, path: "/tmp/arbitrary-task.json" }), ScriptedModelProvider.text("Schema rejection observed")]);
  const stack = await setup({ provider });
  await stack.sessions.call("session/prompt", { request: { requestId: "bad-task-path", sessionId: stack.id, mode: "queue", content: [{ type: "text", text: "Attempt invalid path" }] } }, stack.signal);
  await eventually(() => stack.harness.store.listTurns(stack.id), values => values[0]?.status === "completed");
  expect(stack.harness.approvalStore.listPending(stack.id)).toEqual([]); expect(await stack.activity.call("schedule/catalog", {}, stack.signal)).toEqual([]);
  expect((await stack.harness.store.listMessages(stack.id)).find(message => message.role === "tool")?.content).toContain("schema validation failed");
});

it("upstream calendar rules skip a DST gap and use the earlier instant of an overlap", async () => {
  const stack = await setup(); stack.clock.value = Date.parse("2026-03-08T00:00:00.000Z");
  const gap = await stack.create({ daily: { time: "02:30:00", time_zone: "America/New_York" } });
  expect(gap.scheduledAt).toBe("2026-03-09T06:30:00.000Z");
  stack.clock.value = Date.parse("2026-11-01T00:00:00.000Z");
  const overlap = await stack.create({ daily: { time: "01:30:00", time_zone: "America/New_York" } });
  expect(overlap.scheduledAt).toBe("2026-11-01T05:30:00.000Z");
});

it("real child-turn jobs expose retained UTF-8 output and reject a foreign parent and split-byte resume", async () => {
  const stack = await setup(); const child = await stack.harness.runtime.createSession({ agent: stack.harness.agents[0]!, cwd: stack.cwd, parentId: stack.id });
  const turn = await stack.harness.runtime.startTurn(child.id, "actual child coding task"); await (await stack.harness.sessions.load(child.id)).runTurn(turn.id);
  const controller = new AbortController(); const list = stack.activity.stream("job/list", { request: { sessionId: stack.id } }, controller.signal)[Symbol.asyncIterator]();
  const rows = (await list.next()).value as { jobs: Array<{ id: string; owner: string; status: string }> };
  expect(rows.jobs).toMatchObject([{ id: `subagent-${turn.id}`, owner: stack.id, status: "completed" }]); controller.abort(); await list.return?.();
  const frames = []; for await (const frame of stack.activity.stream("job/follow", { request: { sessionId: stack.id, jobId: rows.jobs[0]!.id } }, stack.signal)) frames.push(frame);
  expect(frames).toMatchObject([{ type: "opened", from: 0 }, { type: "output", chunks: [{ at: 0, text: "真实执行 completed" }] }, { type: "status", job: { status: "completed" } }]);
  const split = stack.activity.stream("job/follow", { request: { sessionId: stack.id, jobId: rows.jobs[0]!.id, from: 1 } }, stack.signal)[Symbol.asyncIterator]();
  await expect(split.next()).rejects.toMatchObject({ code: "job/invalid-offset" });
  const foreign = await stack.sessions.call("session/create", { request: {} }, stack.signal) as { sessionId: string };
  await expect(stack.call("job/kill", { sessionId: foreign.sessionId, jobId: rows.jobs[0]!.id })).rejects.toMatchObject({ code: "job/not-found" });
  expect(await stack.call("job/kill", { sessionId: stack.id, jobId: rows.jobs[0]!.id })).toEqual({ outcome: "already-finished" });
});

it("killing an old waiting child job never cancels a different running turn in that child", async () => {
  let calls = 0;
  const provider: ModelProvider = { id: "precise-child-job", getConfigIdentity: () => ({ implementation: "precise-child-job/v1" }), listModels: async () => [], createClient: () => ({
    async *generate(_request, signal): AsyncIterable<ModelEvent> {
      calls += 1;
      if (calls === 1) { yield* ScriptedModelProvider.toolCall("ask_user", { question: "Need original answer", reason: "choice_required", options: ["yes", "no"] }); return; }
      yield { type: "text_delta", text: "running another turn", timestamp: Date.now() };
      await new Promise<void>(done => { if (signal.aborted) done(); else signal.addEventListener("abort", () => done(), { once: true }); });
    },
  }) };
  const stack = await setup({ provider });
  const child = await stack.harness.runtime.createSession({ agent: stack.harness.agents[0]!, cwd: stack.cwd, parentId: stack.id });
  const actor = await stack.harness.sessions.load(child.id);
  const old = await stack.harness.runtime.startTurn(child.id, "old waiting task"); await actor.runTurn(old.id);
  expect((await stack.harness.store.getTurn(old.id))!.status).toBe("waiting_for_user");
  const next = await stack.harness.runtime.startTurn(child.id, "different current task"); const running = actor.runTurn(next.id);
  await eventually(() => stack.harness.events.list(child.id), values => values.some(event => event.type === "model.delta" && event.turnId === next.id));
  await expect(stack.call("job/kill", { sessionId: stack.id, jobId: `subagent-${old.id}` })).rejects.toMatchObject({ code: "job/cancellation-unavailable" });
  expect(actor.status().activeTurn?.turnId).toBe(next.id); expect((await stack.harness.store.getTurn(next.id))!.status).toBe("running");
  expect(await stack.call("job/kill", { sessionId: stack.id, jobId: `subagent-${next.id}` })).toEqual({ outcome: "requested" });
  await running;
  expect((await stack.harness.store.getTurn(next.id))!.status).toBe("cancelled"); expect((await stack.harness.store.getTurn(old.id))!.status).toBe("waiting_for_user");
});

it("official boot catalog DTOs use real native roles and validate the observed inspect directory", async () => {
  const stack = await setup();
  const roles = await stack.activity.call("agentPresets/list", {}, stack.signal) as { presets: Array<{ id: string; isDefault: boolean }> };
  expect(roles.presets.map(row => row.id)).toEqual(stack.harness.agents.map(agent => agent.name)); expect(roles.presets[0]!.isDefault).toBe(true);
  expect(await stack.activity.call("permissionPresets/catalog", {}, stack.signal)).toMatchObject({ defaultPreset: "interactive", options: [{ value: "interactive" }] });
  expect(await stack.activity.call("dynamicCordisRunner/syncInspectManifest", { providers: [{ id: "actual-observed-client-provider", description: "client-side read directory", methods: [{ name: "read", description: "read-only", inputSchema: { type: "object" }, outputSchema: { type: "object" } }] }] }, stack.signal)).toBeNull();
  await expect(stack.activity.call("dynamicCordisRunner/syncInspectManifest", { providers: [{ id: "duplicate", description: "", methods: [] }, { id: "duplicate", description: "", methods: [] }] }, stack.signal)).rejects.toMatchObject({ code: "gateway/bad-request" });
  await expect(stack.activity.call("dynamicCordisRunner/invoke", {}, stack.signal)).rejects.toMatchObject({ code: "cordis/unavailable" });
  await expect(stack.activity.call("pluginManager/installBundle", { spec: "anything" }, stack.signal)).rejects.toMatchObject({ code: "plugin-manager/unavailable" });
  await expect(stack.activity.call("activity/unknown", {}, stack.signal)).rejects.toMatchObject({ code: "gateway/not-found" });
});

it("native preset identity is projected and selecting that same frozen preset is idempotent", async () => {
  const stack = await setup();
  const actual = await stack.harness.runtime.getSessionAgent(stack.id);
  expect(await stack.activity.call("agentPresets/select", { agentId: stack.id, agentPreset: actual.id }, stack.signal)).toBe(actual.name);
  expect(await stack.activity.call("agentPresets/select", { agentId: stack.id, agentPreset: actual.name }, stack.signal)).toBe(actual.name);
  await expect(stack.activity.call("agentPresets/select", { agentId: stack.id, agentPreset: "missing-native-role" }, stack.signal)).rejects.toMatchObject({ code: "agent-preset/not-found" });
  const projected = projectSessionHistory({ session: (await stack.harness.store.getSession(stack.id))!, messages: [], events: [] });
  expect(projected.projections.values.agentPreset).toBe(actual.id);
});

it("the process permission catalog describes the actual registered default agent policy", async () => {
  const stack = await setup({ denyModelEdits: true });
  const catalog = await stack.activity.call("permissionPresets/catalog", {}, stack.signal) as { options: Array<{ description: string }> };
  expect(catalog.options[0]!.description).toContain("file edits deny");
  expect(catalog.options).toHaveLength(1);
});

it("the displayed todo timeline is derived from actual successful native update_plan calls", async () => {
  const provider = new ScriptedModelProvider([ScriptedModelProvider.toolCall("update_plan", { mutations: [{ op: "set_plan", steps: ["Inspect", "Verify"] }] }),
    ScriptedModelProvider.toolCall("update_plan", { mutations: [{ op: "mark_completed", step: "Inspect" }] }), ScriptedModelProvider.text("Verified actual plan")]);
  const stack = await setup({ provider });
  await stack.sessions.call("session/prompt", { request: { requestId: "native-plan", sessionId: stack.id, mode: "queue", content: [{ type: "text", text: "Make and complete plan" }] } }, stack.signal);
  await eventually(() => stack.harness.store.listTurns(stack.id), values => values[0]?.status === "completed");
  const projection = projectSessionHistory({ session: (await stack.harness.store.getSession(stack.id))!, messages: await stack.harness.store.listMessages(stack.id), events: await stack.harness.events.list(stack.id) });
  expect(projection.projections.values.todos).toEqual([{ content: "Inspect", status: "completed" }, { content: "Verify", status: "pending" }]);
  expect(projection.records.filter(record => record.event.type === "todo/write")).toHaveLength(2);
  expect(projection.records.some(record => record.event.type === "tool/call" && (record.event.data as { name?: string }).name === "exit_plan_mode")).toBe(false);
});

it("a real secondary workspace skill catalog resolves its own captured Harness roots", async () => {
  const skillA = await realpath(await mkdtemp(join(tmpdir(), "actual-skill-A-"))); const skillB = await realpath(await mkdtemp(join(tmpdir(), "actual-skill-B-")));
  cleanup.push(() => rm(skillA, { recursive: true, force: true })); cleanup.push(() => rm(skillB, { recursive: true, force: true }));
  for (const [path, name] of [[skillA, "primary-skill"], [skillB, "secondary-skill"]] as const) {
    await mkdir(join(path, name)); await writeFile(join(path, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} real metadata\nversion: "1.0.0"\n---\nActual body\n`);
  }
  vi.stubEnv("AR_SKILL_ROOTS", skillA); const stack = await setup();
  const workspace = join(stack.directory, "secondary"); await mkdir(workspace); vi.stubEnv("AR_SKILL_ROOTS", skillB);
  const owners = await createOwnerManager(stack.harness, { dataDir: stack.dataDir, executeHostTool: stack.tools.executeHostTool,
    workspace: async () => ({ path: workspace, workspaceId: "secondary" }) }); cleanup.push(() => owners.close());
  const child = await owners.createSession("secondary", stack.signal);
  const service = createActivityService({ ...stack.host, harness: owners.harnessFacade, rpc: owners.rpcFacade, resolveHarness: owners.ownerOf }); cleanup.push(() => service.close());
  const primary = await service.call("skills/list", { request: { sessionId: stack.id } }, stack.signal) as { skills: Array<{ name: string }> };
  const secondary = await service.call("skills/list", { request: { sessionId: child.id } }, stack.signal) as { skills: Array<{ name: string }> };
  expect(primary.skills.map(skill => skill.name)).toEqual(["primary-skill"]); expect(secondary.skills.map(skill => skill.name)).toEqual(["secondary-skill"]);
});

it("a replaced Web draft schedules through its native model context and the real timer returns to the stable owner's inbox", async () => {
  const requests: Array<{ model: string; latestUser: string; tools: string[] }> = [];
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as { model: string; messages: Array<{ role: string; content: string }>; tools: Array<{ function: { name: string } }> };
    requests.push({ model: body.model, latestUser: body.messages.findLast(message => message.role === "user")?.content ?? "", tools: body.tools.map(tool => tool.function.name) });
    const delta = requests.length === 1
      ? { tool_calls: [{ index: 0, id: "actual_native_reminder_call", type: "function", function: { name: "schedule_create", arguments: JSON.stringify({ title: "Alias reminder", prompt: "Actual timer coding followup", after_seconds: 1 }) } }] }
      : { content: requests.length === 2 ? "Approved reminder created" : "Actual timer model completed" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  cleanup.push(() => new Promise<void>((done, reject) => server.close(error => error === undefined ? done() : reject(error))));
  const directory = await realpath(await mkdtemp(join(tmpdir(), "dsh-alias-real-timer-"))); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "project"), dataDir = join(directory, "data"); await mkdir(cwd);
  const baseProvider = new ScriptedModelProvider([ScriptedModelProvider.text("Unselected base route")]);
  const base = await createHarness({ cwd, dataDir, profile: "interactive", modelProvider: baseProvider, model: { providerId: baseProvider.id, modelId: "scripted-model" } }); cleanup.push(() => base.close());
  const composition = await createDeepseekComposition(base, dataDir); cleanup.push(() => composition.close()); const signal = new AbortController().signal;
  await composition.catalog.call("credentials/set", { ref: "ACTUAL_TIMER_LOCAL_KEY", value: "loopback-only-timer-key" }, signal);
  await composition.catalog.call("settings/update", { ns: "llm-pi-ai", patch: { providers: { timer: { api: "openai-completions", baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKeyEnv: "ACTUAL_TIMER_LOCAL_KEY", models: [{ id: "actual-timer-model", name: "Actual local timer" }] } } } }, signal);
  const { sessionId: external } = await composition.sessions.call("session/create", { request: {} }, signal) as { sessionId: SessionId };
  await composition.owners.selectModel(external, { providerKey: "timer", modelId: "actual-timer-model" }, signal);
  const native = composition.owners.nativeSessionId(external); expect(native).not.toBe(external); expect(composition.owners.externalSessionId(native)).toBe(external);
  await expect(composition.activity.call("schedule/list", { request: { sessionId: native } }, signal)).rejects.toMatchObject({ code: "session/not-found" });
  const owner = await composition.owners.ownerOf(external);
  expect((await owner.store.getSession(native))!.model).toEqual({ providerId: "timer", modelId: "actual-timer-model" });
  await composition.sessions.call("session/prompt", { request: { sessionId: external, requestId: "actual-alias-task", mode: "queue", content: [{ type: "text", text: "Create the real one-second reminder" }] } }, signal);
  const approvals = await eventually(async () => composition.harness.approvalStore.listPending(external), rows => rows.length === 1);
  expect(approvals[0]!.sessionId).toBe(external); expect(owner.approvalStore.listPending(native)).toHaveLength(1);
  expect(approvals[0]!.target).toBe(join(dataDir, "deepseek", "schedules.json"));
  composition.harness.approvalStore.resolve(approvals[0]!.id, "allow", "web");
  await eventually(() => owner.store.listTurns(native), turns => turns.length === 2 && turns.every(turn => turn.status === "completed"), 1200);
  const taskFile = JSON.parse(await readFile(join(dataDir, "deepseek", "schedules.json"), "utf8")) as { tasks: Record<string, { sessionId: string; status: string; deliveries: Array<{ messageId: string }> }> };
  const tasks = Object.values(taskFile.tasks); expect(tasks).toHaveLength(1); expect(tasks[0]).toMatchObject({ sessionId: external, status: "inactive" });
  const actualInbox = await owner.inbox.listAll(native), projectedInbox = await composition.harness.inbox.listAll(external);
  expect(actualInbox).toHaveLength(2); expect(projectedInbox.every(item => item.sessionId === external)).toBe(true);
  expect(tasks[0]!.deliveries[0]!.messageId).toBe(actualInbox.find(item => item.text === "Actual timer coding followup")!.id);
  expect(requests).toHaveLength(3); expect(requests.every(item => item.model === "actual-timer-model")).toBe(true); expect(requests[0]!.tools).toContain("schedule_create");
  expect(requests[2]!.latestUser).toBe("Actual timer coding followup");
  expect((await owner.store.listMessages(native)).filter(message => message.role === "assistant").map(message => message.content)).toContain("Actual timer model completed");
  expect(await base.store.listTurns(external)).toEqual([]);
});

it("a human task commit holds the real owner's draft lock until its durable acknowledgement and fences model replacement", async () => {
  const stack = await setup();
  const selected = new ScriptedModelProvider([ScriptedModelProvider.text("Selected route")]);
  const owners = await createOwnerManager(stack.harness, { dataDir: stack.dataDir, executeHostTool: stack.tools.executeHostTool,
    workspace: async () => ({ path: stack.cwd }), newSessionsUseChildren: true,
    extraSandboxPaths: [stack.path],
    resolveSelection: async selection => ({ modelProvider: selected, model: { providerId: selected.id, modelId: selection.modelId } }),
  }); cleanup.push(() => owners.close());
  const draft = await owners.createSession(undefined, stack.signal); const native = owners.nativeSessionId(draft.id);
  const tools = createHostTools(owners.harnessFacade, stack.cwd, stack.dataDir, owners.ownerOf, owners.nativeSessionId);
  let atWrite!: () => void, release!: () => void;
  const committed = new Promise<void>(done => { atWrite = done; }), held = new Promise<void>(done => { release = done; });
  const activity = createActivityService({ ...stack.host, harness: owners.harnessFacade, rpc: owners.rpcFacade, ...tools,
    withSessionLock: owners.withSessionLock, externalSessionId: owners.externalSessionId,
    executeHostTool: async (id, definition, args, signal) => {
      const result = await tools.executeHostTool(id, definition, args, signal);
      if (definition.name === "web_activity_metadata" && definition.risk !== "readonly") { atWrite(); await held; }
      return result;
    },
  }); cleanup.push(() => activity.close());
  const creating = activity.call("commands/execute", { agentId: draft.id, line: '/schedule {"title":"held","prompt":"real held task","after_seconds":60}', submittedAttachments: [] }, stack.signal);
  await committed;
  let finished = false;
  const selecting = owners.selectModel(draft.id, { providerKey: "selected", modelId: "another-model" }, stack.signal)
    .then(() => ({ accepted: true }), error => ({ accepted: false, code: (error as { code?: string }).code })).finally(() => { finished = true; });
  await new Promise<void>(done => setTimeout(done, 20)); expect(finished).toBe(false); expect(owners.nativeSessionId(draft.id)).toBe(native);
  release(); expect(await creating).toMatchObject({ result: { kind: "success" } });
  expect(await selecting).toMatchObject({ accepted: false, code: "session/model-frozen" });
  expect(owners.nativeSessionId(draft.id)).toBe(native);
  expect(await activity.call("schedule/list", { request: { sessionId: draft.id } }, stack.signal)).toHaveLength(1);
});
