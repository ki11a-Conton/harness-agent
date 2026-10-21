import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newAgentId } from "@ar/contracts";
import type { AgentDefinition, ModelProvider, ModelRequest } from "@ar/contracts";
import { AgentRuntime, DefaultSessionActor } from "@ar/core";
import { JSONLInboxStore, JSONLSessionStore } from "@ar/session";
import { JSONLEventStore } from "@ar/events";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function fixture(beforeCall: (index: number) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), "ar-steer-admission-cap-")); roots.push(dataDir);
  const store = new JSONLSessionStore({ dataDir }), events = new JSONLEventStore({ dataDir });
  const inbox = new JSONLInboxStore({ dataDir, maxPending: 1 }), requests: ModelRequest[] = [];
  const modelProvider: ModelProvider = { id: "steer-cap", listModels: async () => [], createClient: () => ({
    async *generate(request) {
      requests.push(structuredClone(request));
      const index = requests.length;
      await beforeCall(index);
      yield { type: "completed", result: { finishReason: "stop", text: `answer ${index}` }, timestamp: index };
    },
  }) };
  const agent: AgentDefinition = { id: newAgentId(), name: "steer-cap", description: "bounded correction admission", mode: "primary",
    model: { providerId: modelProvider.id, modelId: "scripted-model" }, systemPrompt: "Complete the task.",
    tools: {}, permissions: { rules: [] }, skills: {}, limits: {} };
  const runtime = new AgentRuntime({ store, events, inbox, modelProvider, agents: [agent], permissiveToolResolution: true,
    orchestrator: { async execute() { throw new Error("no tool may execute in this fixture"); },
      async executeBound() { throw new Error("no tool may execute in this fixture"); } } });
  const session = await runtime.createSession({ agent, cwd: dataDir });
  const actor = new DefaultSessionActor({ persistent: session, runtime, store, inbox });
  return { actor, runtime, store, inbox, events, session, dataDir, requests };
}

describe("bound steering retains the JSONL inbox capacity", () => {
  it("rejects a second correction at maxPending=1 and admits again after the first is consumed", async () => {
    const firstEntered = gate(), firstRelease = gate(), secondEntered = gate(), secondRelease = gate();
    const f = await fixture(async index => {
      if (index === 1) { firstEntered.release(); await firstRelease.promise; }
      if (index === 2) { secondEntered.release(); await secondRelease.promise; }
    });
    try {
      const run = await f.actor.startTurn({ sessionId: f.session.id, text: "original task" }); await firstEntered.promise;
      await f.actor.steer({ sessionId: f.session.id, text: "FIRST CORRECTION" });
      const rejected = await f.actor.steer({ sessionId: f.session.id, text: "OVER CAP" }).then(() => undefined, error => error);
      expect(rejected).toMatchObject({ code: "QUEUE_FULL" });
      firstRelease.release(); await secondEntered.promise;
      expect((await new JSONLInboxStore({ dataDir: f.dataDir, maxPending: 1 }).listAll(f.session.id))[0])
        .toMatchObject({ status: "consumed", promotedTurnId: run.turnId });
      await f.actor.steer({ sessionId: f.session.id, text: "SECOND CORRECTION" }); secondRelease.release();
      expect((await run.outcome).status).toBe("completed");
      expect(f.requests).toHaveLength(3);
      expect((await f.inbox.listAll(f.session.id)).map(row => row.status)).toEqual(["consumed", "consumed"]);
      const injected = (await f.store.listMessages(f.session.id)).filter(message => message.promptId !== undefined);
      expect(injected.map(message => message.content)).toEqual(["[steering] FIRST CORRECTION", "[steering] SECOND CORRECTION"]);
      expect(injected.every(message => message.turnId === run.turnId)).toBe(true);
    } finally { firstRelease.release(); secondRelease.release(); await f.actor.close(); }
  });

  it.each([false, true])("settles a rejected late admission on its original turn and releases capacity for the next task (write-then-error=%s)", async throwAfterCommit => {
    const firstEntered = gate(), firstRelease = gate(), nextEntered = gate(), nextRelease = gate();
    const admissionEntered = gate(), admissionRelease = gate();
    const f = await fixture(async index => {
      if (index === 1) { firstEntered.release(); await firstRelease.promise; }
      if (index === 2) { nextEntered.release(); await nextRelease.promise; }
    });
    const admit = f.inbox.admit.bind(f.inbox); let delayed = false;
    f.inbox.admit = async prompt => {
      if (prompt.kind === "steer" && !delayed) { delayed = true; admissionEntered.release(); await admissionRelease.promise; }
      await admit(prompt);
      if (throwAfterCommit && prompt.text === "LATE OLD CORRECTION") throw new Error("admit failed after durable commit");
    };
    try {
      const first = await f.actor.startTurn({ sessionId: f.session.id, text: "old task" }); await firstEntered.promise;
      const late = f.actor.steer({ sessionId: f.session.id, text: "LATE OLD CORRECTION" }).then(() => undefined, error => error);
      await admissionEntered.promise; firstRelease.release(); expect((await first.outcome).status).toBe("completed");
      admissionRelease.release();
      expect(await late).toMatchObject(throwAfterCommit ? { message: "admit failed after durable commit" } : { info: { code: "NO_ACTIVE_TURN" } });
      const persisted = await new JSONLInboxStore({ dataDir: f.dataDir, maxPending: 1 }).listAll(f.session.id);
      expect(persisted).toHaveLength(1); expect(persisted[0]).toMatchObject({ status: "consumed", promotedTurnId: first.turnId });
      const next = await f.actor.startTurn({ sessionId: f.session.id, text: "new task" }); await nextEntered.promise;
      await f.actor.steer({ sessionId: f.session.id, text: "NEW TASK CORRECTION" }); nextRelease.release();
      expect((await next.outcome).status).toBe("completed"); expect(f.requests).toHaveLength(3);
      expect(f.requests.slice(1).every(request => request.messages.every(message => !message.content.includes("LATE OLD CORRECTION")))).toBe(true);
      const rows = await new JSONLInboxStore({ dataDir: f.dataDir, maxPending: 1 }).listAll(f.session.id);
      expect(rows.map(row => [row.status, row.promotedTurnId])).toEqual([["consumed", first.turnId], ["consumed", next.turnId]]);
    } finally { firstRelease.release(); nextRelease.release(); admissionRelease.release(); await f.actor.close(); }
  });

  it("acknowledges an admission already consumed by its original turn even if its IO promise settles after completion", async () => {
    const firstEntered = gate(), firstRelease = gate(), admissionEntered = gate(), admissionRelease = gate();
    const f = await fixture(async index => { if (index === 1) { firstEntered.release(); await firstRelease.promise; } });
    const admit = f.inbox.admit.bind(f.inbox);
    f.inbox.admit = async prompt => { await admit(prompt); admissionEntered.release(); await admissionRelease.promise; };
    try {
      const run = await f.actor.startTurn({ sessionId: f.session.id, text: "old task" }); await firstEntered.promise;
      const admission = f.actor.steer({ sessionId: f.session.id, text: "ACTUALLY APPLIED" }).then(() => undefined, error => error);
      await admissionEntered.promise; firstRelease.release(); expect((await run.outcome).status).toBe("completed");
      const rows = await new JSONLInboxStore({ dataDir: f.dataDir, maxPending: 1 }).listAll(f.session.id);
      expect(rows[0]).toMatchObject({ status: "consumed", promotedTurnId: run.turnId });
      expect(f.requests[1]!.messages.some(message => message.promptId === rows[0]!.id && message.content === "[steering] ACTUALLY APPLIED")).toBe(true);
      admissionRelease.release(); expect(await admission).toBeUndefined();
      expect((await f.store.listMessages(f.session.id)).filter(message => message.promptId === rows[0]!.id)).toHaveLength(1);
    } finally { firstRelease.release(); admissionRelease.release(); await f.actor.close(); }
  });
});
