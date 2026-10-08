import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { EFFECTIVE_AGENT_SNAPSHOT_KEY, newMessageId, newPromptId, newAskId, newToolCallId, newApprovalId } from "@ar/contracts";
import type { ModelRequest } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { createHarness } from "./create-harness.js";
import { createCodingPromptPolicy } from "./coding-prompt-policy.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), "ar-gen1-session-")); roots.push(cwd);
  const provider = new ScriptedModelProvider([ScriptedModelProvider.text("No changes required.")]);
  const requests: ModelRequest[] = []; const original = provider.createClient.bind(provider);
  provider.createClient = (model, config) => {
    const client = original(model, config);
    return { async *generate(request, signal) { requests.push(request as ModelRequest); yield* client.generate(request, signal); } };
  };
  const config = { cwd, dataDir: join(cwd, "data"), profile: "test" as const, modelProvider: provider, model: { providerId: provider.id, modelId: "scripted-model" } };
  return { cwd, requests, config, harness: await createHarness(config) };
}

it("public SessionService.create survives actor loading and executes a real model request", async () => {
  const { cwd, harness, requests } = await setup();
  try {
    const agent = harness.agents[0]!;
    const session = await harness.sessionService.create({ agentId: agent.id, model: agent.model, cwd });
    const actor = await harness.sessions.load(session.id);
    const handle = await actor.startTurn({ sessionId: session.id, text: "Inspect the repository." });
    expect((await handle.outcome).status).toBe("completed");
    expect(requests).toHaveLength(1);
    expect(await harness.store.loadStateSnapshot(session.id)).toHaveProperty(EFFECTIVE_AGENT_SNAPSHOT_KEY);
  } finally { await harness.close(); }
});

it("fork retains frozen policy and history without sharing parent prompt, ask or turn identities", async () => {
  const { cwd, harness, requests } = await setup();
  try {
    const base = harness.agents[0]!;
    const agent = { ...base, systemPrompt: "PARENT_FROZEN_POLICY", tools: { allow: ["read_file"] }, permissions: { rules: [{ action: "file.write", resource: "*", effect: "deny" as const }] } };
    const parent = await harness.runtime.createSession({ agent, cwd });
    await harness.sessions.load(parent.id);
    const turn = await harness.runtime.startTurn(parent.id, "Original task must survive branching.");
    await harness.store.appendMessage({ id: newMessageId(), sessionId: parent.id, turnId: turn.id, role: "user", content: "Historical clarification", promptId: newPromptId(), askId: newAskId(), createdAt: Date.now() });
    await harness.store.updateTurn({ ...turn, status: "completed", completedAt: Date.now() });
    const branch = await harness.sessionService.threadFork(parent.id);
    const copied = await harness.store.listMessages(branch.id);
    expect(copied.map(m => m.content)).toEqual(["Original task must survive branching.", "Historical clarification"]);
    expect(copied.every(m => m.turnId === undefined && m.promptId === undefined && m.askId === undefined)).toBe(true);
    expect(await harness.store.listTurns(branch.id)).toEqual([]);
    const state = await harness.store.loadStateSnapshot(branch.id);
    expect(state?.[EFFECTIVE_AGENT_SNAPSHOT_KEY]).toMatchObject({ systemPrompt: "PARENT_FROZEN_POLICY", tools: agent.tools, permissions: agent.permissions });
    const actor = await harness.sessions.load(branch.id);
    const handle = await actor.startTurn({ sessionId: branch.id, text: "Continue the branch." });
    expect((await handle.outcome).status).toBe("completed");
    expect(requests[0]!.system).toContain("PARENT_FROZEN_POLICY");
    expect(requests[0]!.messages.map(m => m.content)).toContain("Original task must survive branching.");
  } finally { await harness.close(); }
});

it("fork cannot bypass a changed frozen prompt policy after restart", async () => {
  const { cwd, harness, config } = await setup();
  const parent = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd });
  await harness.sessions.load(parent.id); await harness.close();
  const upgraded = await createHarness({ ...config, agentPromptPolicy: createCodingPromptPolicy() });
  try {
    await expect(upgraded.sessionService.threadFork(parent.id)).rejects.toThrow(/CONFIG_DRIFT_REJECTED|config drifted/i);
    expect(await upgraded.store.listSessions()).toHaveLength(1);
  } finally { await upgraded.close(); }
});

it("failed policy persistence cannot leave an active legacy-fallback session", async () => {
  const { cwd, harness, requests } = await setup();
  try {
    const save = harness.store.saveStateSnapshot.bind(harness.store);
    harness.store.saveStateSnapshot = async () => { throw new Error("injected policy store failure"); };
    await expect(harness.runtime.createSession({ agent: { ...harness.agents[0]!, tools: { allow: ["read_file"] } }, cwd })).rejects.toThrow("policy store failure");
    harness.store.saveStateSnapshot = save;
    const [partial] = await harness.store.listSessions();
    expect(partial!.status).toBe("failed");
    await expect(harness.runtime.startTurn(partial!.id, "write a file")).rejects.toThrow(/failed/);
    await expect(harness.sessionService.threadFork(partial!.id)).rejects.toThrow(/failed|initializ/i);
    expect(requests).toEqual([]);
  } finally { await harness.close(); }
});

it("fork rejects a partial tool snapshot captured while a new parent turn completes", async () => {
  const { cwd, harness } = await setup();
  try {
    const parent = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd });
    const list = harness.store.listMessages.bind(harness.store);
    harness.store.listMessages = async id => {
      const history = await list(id);
      if (id !== parent.id) return history;
      // A parent may start after the first busy check and finish before the
      // second; the captured middle view still has an unanswered tool call.
      return [...history, { id: newMessageId(), sessionId: id, role: "assistant", content: "", toolCalls: [{ id: newToolCallId(), name: "read_file", args: { path: "a.ts" } }], createdAt: Date.now() }];
    };
    await expect(harness.sessionService.threadFork(parent.id)).rejects.toThrow(/tool protocol|snapshot/i);
    expect(await harness.store.listSessions()).toHaveLength(1);
  } finally { await harness.close(); }
});

it("fork rejects a new parent turn admitted between the busy check and history read", async () => {
  const { cwd, harness } = await setup();
  try {
    const parent = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd });
    const list = harness.store.listMessages.bind(harness.store);
    let admitted = false;
    harness.store.listMessages = async id => {
      const snapshot = await list(id);
      if (id === parent.id && !admitted) { admitted = true; await harness.runtime.startTurn(parent.id, "Concurrent newly admitted work"); }
      return snapshot;
    };
    await expect(harness.sessionService.threadFork(parent.id)).rejects.toMatchObject({ info: { code: "SESSION_BUSY" } });
    expect(await harness.store.listSessions()).toHaveLength(1);
  } finally { await harness.close(); }
});

it("a fork copy failure leaves the incomplete branch blocked", async () => {
  const { cwd, harness } = await setup();
  try {
    const parent = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd });
    await harness.store.appendMessage({ id: newMessageId(), sessionId: parent.id, role: "user", content: "history", createdAt: Date.now() });
    const append = harness.store.appendMessage.bind(harness.store);
    harness.store.appendMessage = async message => { if (message.sessionId !== parent.id) throw new Error("injected fork copy failure"); return append(message); };
    await expect(harness.sessionService.threadFork(parent.id)).rejects.toThrow("fork copy failure");
    const branch = (await harness.store.listSessions()).find(session => session.parentId === parent.id)!;
    expect(branch.status).toBe("failed");
    await expect(harness.runtime.startTurn(branch.id, "continue")).rejects.toThrow(/failed/);
  } finally { await harness.close(); }
});

it("forked tool execution keeps parent denial and does not inherit its live approval", async () => {
  const { cwd, harness, config, requests } = await setup();
  config.modelProvider.scripts.splice(0, 1,
    ScriptedModelProvider.toolCall("write_file", { path: "forbidden.txt", content: "must not be written" }),
    ScriptedModelProvider.text("The write was denied."));
  try {
    const base = harness.agents[0]!;
    const parent = await harness.runtime.createSession({ agent: { ...base, tools: { allow: ["write_file"] }, permissions: { rules: [], defaultEffect: "deny" } }, cwd });
    const approvalId = newApprovalId();
    harness.approvalStore.create({ id: approvalId, sessionId: parent.id, agentId: base.id, action: "file.write", target: "forbidden.txt", reason: "parent-only request", scope: "session", createdAt: Date.now(), expiresAt: Date.now() + 60_000 });
    // Registry mutation must not widen a branch of the already frozen parent.
    base.permissions = { rules: [], defaultEffect: "allow" };
    const branch = await harness.sessionService.threadFork(parent.id);
    expect(harness.approvalStore.listPending(branch.id)).toEqual([]);
    expect(harness.approvalStore.listPending(parent.id).map(request => request.id)).toEqual([approvalId]);
    const actor = await harness.sessions.load(branch.id);
    const handle = await actor.startTurn({ sessionId: branch.id, text: "Try the requested write." });
    await handle.outcome;
    await expect(readFile(join(cwd, "forbidden.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(requests[0]!.tools?.map(tool => tool.name)).toContain("write_file");
    expect((await harness.events.list(branch.id)).some(event => event.type === "tool.permission_resolved" && event.payload.effect === "deny")).toBe(true);
    harness.approvalStore.resolve(approvalId, "deny");
  } finally { await harness.close(); }
});
