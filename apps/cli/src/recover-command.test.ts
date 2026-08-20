import { describe, expect, it } from "vitest";
import { newAgentId, newSessionId, newTurnId } from "@ar/contracts";
import { MemSessionStore } from "@ar/harness";
import { recoverListCmd } from "./recover-command.js";

describe("P12-3: agent recover list", () => {
  it("reports unfinished sessions and skips terminal ones", async () => {
    const store = new MemSessionStore();
    const base = {
      agentId: newAgentId(),
      model: { providerId: "p", modelId: "m" },
      cwd: "/w",
      createdAt: 1,
      updatedAt: 2,
    };
    const running = { id: newSessionId(), status: "active" as const, ...base };
    const done = { id: newSessionId(), status: "active" as const, ...base };
    await store.createSession(running);
    await store.createSession(done);
    await store.createTurn({
      id: newTurnId(),
      sessionId: done.id,
      input: { sessionId: done.id, text: "t" },
      status: "completed" as const,
      startedAt: 1,
      completedAt: 2,
    });

    const result = await recoverListCmd({ store, approvalStore: undefined });
    expect(result.scan.unfinishedSessions.map((s) => s.sessionId)).toContain(running.id);
    expect(result.scan.unfinishedSessions.map((s) => s.sessionId)).not.toContain(done.id);
    expect(result.exitCode).toBe(1);
  });

  it("reports orphan children whose parent is gone", async () => {
    const store = new MemSessionStore();
    const base = {
      agentId: newAgentId(),
      model: { providerId: "p", modelId: "m" },
      cwd: "/w",
      status: "active" as const,
      createdAt: 1,
      updatedAt: 2,
    };
    const orphan = { id: newSessionId(), parentId: newSessionId(), ...base };
    await store.createSession(orphan);
    const result = await recoverListCmd({ store, approvalStore: undefined });
    expect(result.scan.orphanChildren.map((o) => o.sessionId)).toContain(orphan.id);
  });
});
