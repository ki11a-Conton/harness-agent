import { describe, expect, it } from "vitest";
import type { AdmittedPrompt, AgentDefinition, InboxStore, PromptId, SessionId, TurnId } from "@ar/contracts";
import { newAgentId } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime } from "./runtime.js";
import { DefaultSessionActor } from "./session-actor.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}
async function watchdog<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("admitted followup never woke without another user task")), 3_000); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
class GatedInbox implements InboxStore {
  readonly prompts: AdmittedPrompt[] = [];
  readonly admissionEntered = gate();
  readonly admissionRelease = gate();
  committedBeforeReturn = false;
  rejectAdmission = false;
  async admit(prompt: AdmittedPrompt) {
    if (prompt.kind !== "followup") { this.prompts.push(prompt); return; }
    if (this.committedBeforeReturn) this.prompts.push(prompt);
    this.admissionEntered.open(); await this.admissionRelease.promise;
    if (this.rejectAdmission) throw new Error("durable admission refused");
    if (!this.committedBeforeReturn) this.prompts.push(prompt);
  }
  async listPending(sessionId: SessionId) { return this.prompts.filter(prompt => prompt.sessionId === sessionId && prompt.status === "pending"); }
  async listRecoverable(sessionId: SessionId) { return this.prompts.filter(prompt => prompt.sessionId === sessionId && (prompt.status === "pending" || prompt.status === "promoted")); }
  async listAll(sessionId: SessionId) { return this.prompts.filter(prompt => prompt.sessionId === sessionId); }
  async markPromoted(id: PromptId) { const prompt = this.prompts.find(prompt => prompt.id === id); if (prompt) prompt.status = "promoted"; }
  async bindPromotion(id: PromptId, turnId: TurnId) { const prompt = this.prompts.find(prompt => prompt.id === id); if (prompt) { prompt.status = "promoted"; prompt.promotedTurnId = turnId; } }
  async markConsumed(id: PromptId) { const prompt = this.prompts.find(prompt => prompt.id === id); if (prompt) prompt.status = "consumed"; }
}
async function setup() {
  const store = new MemorySessionStore(); const inbox = new GatedInbox();
  const agent: AgentDefinition = { id: newAgentId(), name: "followup-wakeup", description: "deterministic admission barriers", mode: "primary", model: { providerId: "scripted", modelId: "scripted-model" }, systemPrompt: "test", tools: {}, permissions: { rules: [] }, skills: {}, limits: {} };
  const runtime = new AgentRuntime({ store, inbox, events: new MemoryEventStore(), agents: [agent],
    modelProvider: new ScriptedModelProvider(Array.from({ length: 12 }, () => ScriptedModelProvider.text("done"))),
    toolRegistry: defaultTestToolCatalog(), orchestrator: new FakeOrchestrator(), permissiveToolResolution: true });
  const session = await runtime.createSession({ agent, cwd: "/work" });
  const firstRunRelease = gate(); const executed: TurnId[] = []; const finished = Array.from({ length: 12 }, gate);
  let active = 0; let maxActive = 0;
  const actor = new DefaultSessionActor({ persistent: session, store, inbox, runtime: {
    startTurn: (sessionId, text) => runtime.startTurn(sessionId, text),
    async runTurn(sessionId, turnId, signal) {
      const index = executed.length; executed.push(turnId); active++; maxActive = Math.max(maxActive, active);
      try { if (index === 0) await firstRunRelease.promise; return await runtime.runTurn(sessionId, turnId, signal); }
      finally { active--; finished[index]!.open(); }
    },
  } });
  const originalReserve = actor.inputQueue.reservePendingFollowup.bind(actor.inputQueue);
  const reserveObserved = gate(); const reserveRelease = gate(); let reserved: Awaited<ReturnType<typeof originalReserve>>;
  let gated = true;
  actor.inputQueue.reservePendingFollowup = async () => {
    const result = await originalReserve();
    if (gated) { gated = false; reserved = result; reserveObserved.open(); await reserveRelease.promise; }
    return result;
  };
  return { actor, inbox, store, sessionId: session.id, firstRunRelease, executed, finished, reserveObserved, reserveRelease,
    get reserved() { return reserved; }, get maxActive() { return maxActive; },
    async close() { firstRunRelease.open(); inbox.admissionRelease.open(); reserveRelease.open(); await actor.close(); },
  };
}

describe("GEN1 actor admission wakeup", () => {
  it("late durable followup wakes an idle actor after the terminal drain observed an empty queue", async () => {
    const h = await setup();
    try {
      const first = await h.actor.startTurn({ sessionId: h.sessionId, text: "first" });
      const admission = h.actor.enqueueFollowup({ sessionId: h.sessionId, text: "queued later" });
      await h.inbox.admissionEntered.promise; h.firstRunRelease.open(); await first.outcome;
      await h.reserveObserved.promise; expect(h.reserved).toBeUndefined();
      h.reserveRelease.open(); h.inbox.admissionRelease.open(); await admission;
      await watchdog(h.finished[1]!.promise);
      expect(h.executed).toHaveLength(2); expect(new Set(h.executed).size).toBe(2); expect(h.maxActive).toBe(1);
      expect(h.inbox.prompts).toHaveLength(1);
    } finally { await h.close(); }
  });

  it("queued startTurn installs its future outcome before waking and retains the admitted running turn handle", async () => {
    const h = await setup();
    try {
      const first = await h.actor.startTurn({ sessionId: h.sessionId, text: "first" });
      const admission = h.actor.startTurn({ sessionId: h.sessionId, text: "queued future" }, { onConflict: "queue" });
      await h.inbox.admissionEntered.promise; h.firstRunRelease.open(); await first.outcome;
      await h.reserveObserved.promise; h.reserveRelease.open(); h.inbox.admissionRelease.open();
      const queued = await admission;
      expect(queued.turnId).toBe(first.turnId);
      const outcome = await watchdog(queued.outcome);
      expect(outcome.status).toBe("completed"); expect(outcome.turn.id).not.toBe(first.turnId);
      expect(h.executed).toHaveLength(2); expect(h.inbox.prompts).toHaveLength(1); expect(h.inbox.prompts[0]!.status).toBe("consumed");
    } finally { await h.close(); }
  });

  it("an admission completed while the empty drain is still in flight preserves one pending wake", async () => {
    const h = await setup();
    try {
      const first = await h.actor.startTurn({ sessionId: h.sessionId, text: "first" });
      const admission = h.actor.enqueueFollowup({ sessionId: h.sessionId, text: "queued during drain" });
      await h.inbox.admissionEntered.promise; h.firstRunRelease.open(); await first.outcome; await h.reserveObserved.promise;
      expect(h.actor.executionState).toBe("starting"); expect(h.reserved).toBeUndefined();
      h.inbox.admissionRelease.open(); await admission; h.reserveRelease.open();
      await watchdog(h.finished[1]!.promise); expect(h.executed).toHaveLength(2); expect(h.maxActive).toBe(1);
    } finally { await h.close(); }
  });

  it("a durable write visible before its admission promise returns is not hydrated or executed early", async () => {
    const h = await setup(); h.inbox.committedBeforeReturn = true;
    try {
      const first = await h.actor.startTurn({ sessionId: h.sessionId, text: "first" });
      const admission = h.actor.startTurn({ sessionId: h.sessionId, text: "queued committed-but-unacknowledged" }, { onConflict: "queue" });
      await h.inbox.admissionEntered.promise; h.firstRunRelease.open(); await first.outcome; await h.reserveObserved.promise;
      expect(h.reserved).toBeUndefined(); expect(h.executed).toHaveLength(1);
      h.reserveRelease.open(); h.inbox.admissionRelease.open(); const queued = await admission;
      const outcome = await watchdog(queued.outcome); expect(outcome.status).toBe("completed");
      expect(h.executed).toHaveLength(2); expect(h.inbox.prompts).toHaveLength(1);
      expect(await h.actor.inputQueue.reservePendingFollowup()).toBeUndefined();
    } finally { await h.close(); }
  });

  it("close during pending admission rejects the caller and cannot execute a followup on the unloaded actor", async () => {
    const h = await setup();
    try {
      const first = await h.actor.startTurn({ sessionId: h.sessionId, text: "first" });
      const admission = h.actor.startTurn({ sessionId: h.sessionId, text: "queued after close" }, { onConflict: "queue" });
      const rejected = admission.then(() => undefined, error => error as Error);
      await h.inbox.admissionEntered.promise; h.firstRunRelease.open(); await first.outcome; await h.reserveObserved.promise;
      h.reserveRelease.open(); await h.actor.close(); h.inbox.admissionRelease.open();
      expect(await watchdog(rejected)).toBeInstanceOf(Error); expect(h.executed).toHaveLength(1); expect(h.actor.status().loaded).toBe(false);
    } finally { await h.close(); }
  });

  it("failed durable admission cannot publish or execute an unadmitted queue entry", async () => {
    const h = await setup(); h.inbox.rejectAdmission = true;
    try {
      const first = await h.actor.startTurn({ sessionId: h.sessionId, text: "first" });
      const admission = h.actor.enqueueFollowup({ sessionId: h.sessionId, text: "queued refusal" });
      const rejected = admission.then(() => undefined, error => error as Error);
      await h.inbox.admissionEntered.promise; h.firstRunRelease.open(); await first.outcome; await h.reserveObserved.promise;
      h.inbox.admissionRelease.open(); expect(await rejected).toBeInstanceOf(Error); h.reserveRelease.open();
      expect(h.actor.inputQueue.pendingCount).toBe(0); expect(h.inbox.prompts).toHaveLength(0); expect(h.executed).toHaveLength(1);
    } finally { await h.close(); }
  });

  it("a write-then-error admission remains quarantined from first hydration in this actor", async () => {
    const h = await setup(); h.inbox.committedBeforeReturn = true; h.inbox.rejectAdmission = true;
    try {
      const admission = h.actor.enqueueFollowup({ sessionId: h.sessionId, text: "uncertain failed admission" });
      const rejected = admission.then(() => undefined, error => error as Error);
      await h.inbox.admissionEntered.promise; h.inbox.admissionRelease.open();
      expect(await rejected).toBeInstanceOf(Error); h.reserveRelease.open();
      expect(await h.actor.inputQueue.reservePendingFollowup()).toBeUndefined();
      expect(h.executed).toHaveLength(0);
    } finally { await h.close(); }
  });

  it("terminal acknowledgement wakes all admitted followups exactly once in FIFO with one active owner", async () => {
    const h = await setup();
    try {
      const first = await h.actor.startTurn({ sessionId: h.sessionId, text: "first" });
      const admissions = ["one", "two", "three"].map(text => h.actor.startTurn({ sessionId: h.sessionId, text }, { onConflict: "queue" }));
      await h.inbox.admissionEntered.promise; h.inbox.admissionRelease.open(); const queued = await Promise.all(admissions);
      h.firstRunRelease.open(); await first.outcome; await h.reserveObserved.promise; h.reserveRelease.open();
      const outcomes = await watchdog(Promise.all(queued.map(handle => handle.outcome)));
      expect(outcomes.every(outcome => outcome.status === "completed")).toBe(true);
      expect(h.executed).toHaveLength(4); expect(new Set(h.executed).size).toBe(4); expect(h.maxActive).toBe(1);
      expect(h.inbox.prompts.map(prompt => prompt.text)).toEqual(["one", "two", "three"]);
      expect(h.inbox.prompts.every(prompt => prompt.status === "consumed")).toBe(true);
    } finally { await h.close(); }
  });
});
