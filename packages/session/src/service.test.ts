import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentId, Message, ModelRef, Session } from "@ar/contracts";
import { newMessageId } from "@ar/contracts";
import { JSONLSessionStore, SessionStoreError } from "./session-store.js";
import { SessionService } from "./service.js";

let dataDir: string;
let store: JSONLSessionStore;
let clock: number;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "session-service-"));
  store = new JSONLSessionStore({ dataDir });
  clock = 0;
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const AGENT_ID = "agent_demo" as AgentId;
const MODEL: ModelRef = { providerId: "demo", modelId: "demo-1" };

function makeService(): SessionService {
  return new SessionService({ store, now: () => ++clock });
}

describe("SessionService (lifecycle)", () => {
  it("creates an active session with the given inputs", async () => {
    const service = makeService();
    const session = await service.create({ agentId: AGENT_ID, model: MODEL, cwd: "C:\\work" });
    expect(session.id).toMatch(/^session_/);
    expect(session.status).toBe("active");
    expect(session.agentId).toBe(AGENT_ID);
    expect(session.model).toEqual(MODEL);
    expect(session.cwd).toBe("C:\\work");
    expect(session.parentId).toBeUndefined();
    expect(session.createdAt).toBe(1);
    expect(session.updatedAt).toBe(2);
    expect(await store.getSession(session.id)).toEqual(session);
  });

  it("resumes an existing session without changing its status", async () => {
    const service = makeService();
    const created = await service.create({ agentId: AGENT_ID, model: MODEL, cwd: "." });
    await service.cancelSession(created.id);
    const resumed = await service.resume(created.id);
    expect(resumed.status).toBe("cancelled");
    expect(await store.getSession(created.id)).toEqual(resumed);
  });

  it("throws UNKNOWN_SESSION when resuming a missing session", async () => {
    const service = makeService();
    await expect(service.resume("session_nope" as Session["id"])).rejects.toMatchObject({
      code: "UNKNOWN_SESSION",
    });
  });

  it("forks a new active session pointing at the parent, inheriting agent/model/cwd", async () => {
    const service = makeService();
    const parent = await service.create({ agentId: AGENT_ID, model: MODEL, cwd: "C:\\work" });
    const fork = await service.fork(parent.id);

    expect(fork.id).not.toBe(parent.id);
    expect(fork.id).toMatch(/^session_/);
    expect(fork.parentId).toBe(parent.id);
    expect(fork.status).toBe("active");
    expect(fork.agentId).toBe(parent.agentId);
    expect(fork.model).toEqual(parent.model);
    expect(fork.cwd).toBe(parent.cwd);
    expect(await store.getSession(fork.id)).toEqual(fork);
  });

  it("throws UNKNOWN_SESSION when forking a missing session", async () => {
    const service = makeService();
    await expect(service.fork("session_nope" as Session["id"])).rejects.toMatchObject({
      code: "UNKNOWN_SESSION",
    });
  });

  it("cancels a session via updateSession", async () => {
    const service = makeService();
    const created = await service.create({ agentId: AGENT_ID, model: MODEL, cwd: "." });
    const cancelled = await service.cancelSession(created.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.updatedAt).toBe(created.updatedAt + 1);
    expect((await store.getSession(created.id))!.status).toBe("cancelled");
  });

  it("completes a session via updateSession", async () => {
    const service = makeService();
    const created = await service.create({ agentId: AGENT_ID, model: MODEL, cwd: "." });
    const completed = await service.completeSession(created.id);
    expect(completed.status).toBe("completed");
    expect((await store.getSession(created.id))!.status).toBe("completed");
  });

  it("throws UNKNOWN_SESSION for lifecycle ops on missing sessions", async () => {
    const service = makeService();
    const id = "session_nope" as Session["id"];
    await expect(service.cancelSession(id)).rejects.toMatchObject({ code: "UNKNOWN_SESSION" });
    await expect(service.completeSession(id)).rejects.toMatchObject({ code: "UNKNOWN_SESSION" });
    await expect(service.archive(id)).rejects.toMatchObject({ code: "UNKNOWN_SESSION" });
  });

  it("archives a session and returns the archive path", async () => {
    const service = makeService();
    const created = await service.create({ agentId: AGENT_ID, model: MODEL, cwd: "C:\\work" });

    const archivedPath = await service.archive(created.id);
    expect(archivedPath).toBe(path.join(dataDir, "archive", created.id));

    expect(await store.getSession(created.id)).toBeUndefined();
    expect(await store.listSessions()).toEqual([]);
    await expect(service.resume(created.id)).rejects.toMatchObject({ code: "UNKNOWN_SESSION" });
    expect(archivedPath).toContain("archive");
  });
  it("P25-7: spawnChild creates an EMPTY child — no copied history", async () => {
    const service = makeService();
    const parent = await service.create({ agentId: AGENT_ID, model: MODEL, cwd: "C:\\work" });
    await store.appendMessage({
      id: newMessageId(), sessionId: parent.id, role: "user", content: "hi", createdAt: 1,
    } as Message);
    const child = await service.spawnChild(parent.id);
    expect(child.parentId).toBe(parent.id);
    expect(child.id).not.toBe(parent.id);
    expect(await store.listMessages(child.id)).toEqual([]);
  });

  it("P25-7: threadFork copies the parent's message history into the branch", async () => {
    const service = makeService();
    const parent = await service.create({ agentId: AGENT_ID, model: MODEL, cwd: "C:\\work" });
    const seeded: Message[] = [
      { id: newMessageId(), sessionId: parent.id, role: "user", content: "first", createdAt: 1 },
      { id: newMessageId(), sessionId: parent.id, role: "assistant", content: "second", createdAt: 2 },
    ];
    for (const m of seeded) await store.appendMessage(m);

    const branch = await service.threadFork(parent.id);
    expect(branch.parentId).toBe(parent.id);
    const copied = await store.listMessages(branch.id);
    expect(copied).toHaveLength(2);
    expect(copied.map((m) => m.content)).toEqual(["first", "second"]);
    expect(copied.every((m) => m.sessionId === branch.id)).toBe(true);
    expect(copied.map((m) => m.id)).not.toEqual(seeded.map((m) => m.id));
  });
});
