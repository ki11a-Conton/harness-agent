import { describe, expect, it } from "vitest";
import type { AdmittedPrompt, AgentDefinition, InboxStore, ModelProvider, ModelRequest, PromptId, SessionId, TurnId, Verifier } from "@ar/contracts";
import { newAgentId } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime, type AgentRuntimeDeps } from "./runtime.js";
import { DefaultSessionActor } from "./session-actor.js";
import { defaultTestToolCatalog, MemoryEventStore, MemorySessionStore } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
class Inbox implements InboxStore {
  rows: AdmittedPrompt[] = [];
  consumed = 0;
  async admit(row: AdmittedPrompt) { this.rows.push(structuredClone(row)); }
  async listPending(id: SessionId) { return this.rows.filter(p => p.sessionId === id && p.status === "pending"); }
  async listRecoverable(id: SessionId) { return this.rows.filter(p => p.sessionId === id && p.status !== "consumed"); }
  async listAll(id: SessionId) { return this.rows.filter(p => p.sessionId === id); }
  async markPromoted(id: PromptId) { this.rows.find(p => p.id === id)!.status = "promoted"; }
  async bindPromotion(id: PromptId, turnId: TurnId) {
    const row = this.rows.find(p => p.id === id)!;
    if (row.promotedTurnId !== undefined && row.promotedTurnId !== turnId) throw new Error("lineage conflict");
    row.status = "promoted"; row.promotedTurnId = turnId;
  }
  async markConsumed(id: PromptId) { this.rows.find(p => p.id === id)!.status = "consumed"; this.consumed++; }
}
async function fixture(options: { beforeFirst?: () => Promise<void>; verifier?: Verifier; iterations?: number; maxVerificationFailures?: number; failpoint?: AgentRuntimeDeps["failpoint"] } = {}) {
  const store = new MemorySessionStore(), events = new MemoryEventStore(), inbox = new Inbox();
  const requests: ModelRequest[] = [];
  const scripted = new ScriptedModelProvider(["old answer", "corrected answer", "new task answer"].map(ScriptedModelProvider.text));
  const provider: ModelProvider = { id: "scripted", listModels: () => scripted.listModels(), createClient(model, config) {
    const client = scripted.createClient(model, config);
    return { async *generate(request, signal) {
      requests.push(structuredClone(request));
      if (requests.length === 1) await options.beforeFirst?.();
      yield* client.generate(request, signal);
    } };
  } };
  const agent: AgentDefinition = { id: newAgentId(), name: "completion-steer", description: "test", mode: "primary",
    model: { providerId: "scripted", modelId: "scripted-model" }, systemPrompt: "Complete the current task.", tools: {},
    permissions: { rules: [] }, skills: {}, limits: {} };
  const runtime = new AgentRuntime({ store, events, inbox, modelProvider: provider, orchestrator: new FakeOrchestrator(), agents: [agent],
    toolRegistry: defaultTestToolCatalog(), permissiveToolResolution: true,
    ...(options.iterations !== undefined ? { maxIterationsPerTurn: options.iterations } : {}),
    ...(options.failpoint ? { failpoint: options.failpoint } : {}),
    ...(options.maxVerificationFailures !== undefined ? { maxVerificationFailures: options.maxVerificationFailures } : {}),
    ...(options.verifier ? { task: { id: "steer-task", goal: "modify code", constraints: [], verification: [{ kind: "command" as const, command: "test" }] }, verifier: options.verifier } : {}),
  });
  const session = await runtime.createSession({ agent, cwd: "/completion-steer" });
  const actor = new DefaultSessionActor({ persistent: session, runtime, store, inbox });
  return { store, events, inbox, runtime, actor, session, requests };
}

describe("long-task final sampling respects accepted corrections", () => {
  it("consumes a correction accepted during final sampling in the original turn exactly once", async () => {
    const entered = gate(), release = gate();
    const f = await fixture({ beforeFirst: async () => { entered.release(); await release.promise; } });
    try {
      const first = await f.actor.startTurn({ sessionId: f.session.id, text: "ORIGINAL TASK" });
      await entered.promise;
      await f.actor.steer({ sessionId: f.session.id, text: "KEEP THE PUBLIC API 中文🙂" });
      release.release();
      const outcome = await first.outcome;
      expect(outcome.status).toBe("completed");
      expect(f.requests).toHaveLength(2);
      const corrections = f.requests[1]!.messages.filter(m => m.promptId === f.inbox.rows[0]!.id);
      expect(corrections).toHaveLength(1);
      expect(corrections[0]).toMatchObject({ turnId: first.turnId, role: "user", content: "[steering] KEEP THE PUBLIC API 中文🙂" });
      expect(f.inbox.rows[0]).toMatchObject({ status: "consumed", promotedTurnId: first.turnId });
      expect(f.inbox.consumed).toBe(1);
      expect(f.events.events.filter(e => e.type === "turn.completed" && e.turnId === first.turnId)).toHaveLength(1);
      const second = await f.actor.startTurn({ sessionId: f.session.id, text: "UNRELATED NEW TASK" });
      await second.outcome;
      expect(f.inbox.consumed).toBe(1);
      expect((await f.store.listMessages(f.session.id)).filter(m => m.turnId === second.turnId && m.promptId !== undefined)).toEqual([]);
    } finally { release.release(); await f.actor.close(); }
  });

  it("rechecks corrections arriving during verification before declaring verified completion", async () => {
    const entered = gate(), release = gate(); let verified = 0;
    const f = await fixture({ verifier: { async verify() {
      if (++verified === 1) { entered.release(); await release.promise; }
      return { level: 3, passed: true, checks: [{ id: "check", kind: "command", description: "check", passed: true }], evidence: [], startedAt: 0, completedAt: 0 };
    } } });
    try {
      const run = await f.actor.startTurn({ sessionId: f.session.id, text: "implement" });
      await entered.promise;
      await f.actor.steer({ sessionId: f.session.id, text: "ALSO KEEP COMPATIBILITY" });
      release.release();
      const outcome = await run.outcome;
      expect(outcome.status).toBe("completed"); expect(outcome.grade).toBe("verified_complete");
      expect(verified).toBe(2); expect(f.requests).toHaveLength(2);
      expect(f.requests[1]!.messages.some(m => m.content === "[steering] ALSO KEEP COMPATIBILITY")).toBe(true);
      expect(f.events.events.filter(e => e.type === "turn.completed")).toHaveLength(1);
      expect(f.inbox.consumed).toBe(1);
    } finally { release.release(); await f.actor.close(); }
  });

  it("cannot bypass the configured iteration ceiling with final-sampling corrections", async () => {
    const entered = gate(), release = gate();
    const f = await fixture({ iterations: 1, beforeFirst: async () => { entered.release(); await release.promise; } });
    try {
      const run = await f.actor.startTurn({ sessionId: f.session.id, text: "implement" }); await entered.promise;
      await f.actor.steer({ sessionId: f.session.id, text: "CORRECTION" }); release.release();
      const outcome = await run.outcome;
      expect(outcome.status).toBe("failed"); expect(outcome.error?.code).toBe("RESOURCE_LIMIT");
      expect(f.requests).toHaveLength(1);
      expect(f.events.events.filter(e => e.type === "turn.completed")).toEqual([]);
      expect(f.events.events.some(e => e.type === "run.limit_reached" && e.payload.limit === "maxIterationsPerTurn")).toBe(true);
    } finally { release.release(); await f.actor.close(); }
  });

  it("closes admission before the verification completion event is committing", async () => {
    const entered = gate(), release = gate(); let verified = 0;
    const f = await fixture({ verifier: { async verify() {
      verified++;
      return { level: 3, passed: true, checks: [{ id: "check", kind: "command", description: "check", passed: true }], evidence: [], startedAt: 0, completedAt: 0 };
    } } });
    const append = f.events.append.bind(f.events); let gated = false;
    f.events.append = async event => {
      if (event.type === "verification.completed" && !gated) { gated = true; entered.release(); await release.promise; }
      return append(event);
    };
    try {
      const run = await f.actor.startTurn({ sessionId: f.session.id, text: "implement" }); await entered.promise;
      const rejection = await f.actor.steer({ sessionId: f.session.id, text: "VERIFY THIS CORRECTION TOO" }).then(() => undefined, error => error);
      release.release();
      expect((await run.outcome).status).toBe("completed");
      expect(rejection).toMatchObject({ info: { code: "NO_ACTIVE_TURN" } });
      expect(verified).toBe(1); expect(f.requests).toHaveLength(1); expect(f.inbox.rows).toEqual([]);
      expect(f.events.events.filter(event => event.type === "turn.completed")).toHaveLength(1);
    } finally { release.release(); await f.actor.close(); }
  });


  it("closes admission before awaiting the turn.completing crash boundary", async () => {
    const entered = gate(), release = gate();
    const f = await fixture({ failpoint: async point => {
      if (point === "turn.completing") { entered.release(); await release.promise; }
    } });
    try {
      const run = await f.actor.startTurn({ sessionId: f.session.id, text: "original task" });
      await entered.promise;
      const rejection = await f.actor.steer({ sessionId: f.session.id, text: "TOO LATE FOR ORIGINAL TASK" }).then(() => undefined, error => error);
      release.release();
      expect((await run.outcome).status).toBe("completed");
      expect(rejection).toMatchObject({ info: { code: "NO_ACTIVE_TURN" } });
      expect(f.requests).toHaveLength(1); expect(f.inbox.rows).toEqual([]);
      expect(f.events.events.filter(event => event.type === "turn.completed")).toHaveLength(1);
      const next = await f.actor.startTurn({ sessionId: f.session.id, text: "new task" }); await next.outcome;
      expect(f.requests[1]!.messages.some(message => message.content.includes("TOO LATE FOR ORIGINAL TASK"))).toBe(false);
    } finally { release.release(); await f.actor.close(); }
  });


  it("rejects admission during the final pending read and still honors cancellation", async () => {
    const entered = gate(), release = gate();
    const f = await fixture();
    const listRecoverable = f.inbox.listRecoverable.bind(f.inbox);
    f.inbox.listRecoverable = async sessionId => {
      const turnId = f.actor.status().activeTurn?.turnId;
      if (turnId !== undefined && !f.runtime.isSteeringOpen(sessionId, turnId)) {
        entered.release(); await release.promise;
      }
      return listRecoverable(sessionId);
    };
    try {
      const run = await f.actor.startTurn({ sessionId: f.session.id, text: "original task" }); await entered.promise;
      const rejection = await f.actor.steer({ sessionId: f.session.id, text: "CLOSED WHILE READING" }).then(() => undefined, error => error);
      const cancelled = f.actor.interrupt(); release.release();
      expect((await run.outcome).status).toBe("cancelled"); await cancelled;
      expect(rejection).toMatchObject({ info: { code: "NO_ACTIVE_TURN" } });
      expect(f.inbox.rows).toEqual([]); expect(f.requests).toHaveLength(1);
      expect(f.events.events.filter(event => event.type === "turn.completed")).toEqual([]);
    } finally { release.release(); await f.actor.close(); }
  });

  it("does not let an accepted correction bypass an exhausted verification gate", async () => {
    const entered = gate(), release = gate();
    const f = await fixture({ maxVerificationFailures: 1, verifier: { async verify() {
      entered.release(); await release.promise;
      return { level: 3, passed: false, checks: [{ id: "check", kind: "command", description: "check", passed: false }], evidence: [], startedAt: 0, completedAt: 0 };
    } } });
    try {
      const run = await f.actor.startTurn({ sessionId: f.session.id, text: "implement" }); await entered.promise;
      await f.actor.steer({ sessionId: f.session.id, text: "CANNOT REOPEN FAILED VERIFICATION" }); release.release();
      const outcome = await run.outcome;
      expect(outcome.status).toBe("failed"); expect(outcome.terminationReason).toBe("verification_failed");
      expect(f.requests).toHaveLength(1); expect(f.inbox.consumed).toBe(0);
      expect(f.inbox.rows[0]).toMatchObject({ promotedTurnId: run.turnId });
      expect(f.events.events.filter(event => event.type === "turn.completed")).toEqual([]);
    } finally { release.release(); await f.actor.close(); }
  });

  it("rejects a durable admission that finishes after its turn ends and never leaks it into the next task", async () => {
    const modelEntered = gate(), modelRelease = gate(), admissionEntered = gate(), admissionRelease = gate();
    const f = await fixture({ beforeFirst: async () => { modelEntered.release(); await modelRelease.promise; } });
    const admit = f.inbox.admit.bind(f.inbox);
    f.inbox.admit = async prompt => {
      if (prompt.kind === "steer") { admissionEntered.release(); await admissionRelease.promise; }
      await admit(prompt);
    };
    try {
      const run = await f.actor.startTurn({ sessionId: f.session.id, text: "original task" }); await modelEntered.promise;
      const steering = f.actor.steer({ sessionId: f.session.id, text: "BELONGS ONLY TO ORIGINAL TASK" });
      const rejected = steering.then(() => undefined, error => error);
      await admissionEntered.promise; modelRelease.release(); await run.outcome;
      admissionRelease.release();
      expect(await rejected).toMatchObject({ info: { code: "NO_ACTIVE_TURN" } });
      expect(f.inbox.rows[0]).toMatchObject({ status: "consumed", promotedTurnId: run.turnId });
      const next = await f.actor.startTurn({ sessionId: f.session.id, text: "unrelated next task" }); await next.outcome;
      expect(f.requests).toHaveLength(2);
      expect(f.requests[1]!.messages.some(message => message.content.includes("BELONGS ONLY TO ORIGINAL TASK"))).toBe(false);
      expect(f.inbox.consumed).toBe(1);
    } finally { modelRelease.release(); admissionRelease.release(); await f.actor.close(); }
  });
});
