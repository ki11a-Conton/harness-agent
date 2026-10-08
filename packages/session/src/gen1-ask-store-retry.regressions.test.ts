import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newAskId, newSessionId, type AskUserRequest } from "@ar/contracts";
import { JSONLAskUserStore } from "./ask-user-store.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
function ask(sessionId = newSessionId()): AskUserRequest {
  return { id: newAskId(), sessionId, reason: "missing_critical_input", question: "which target?", status: "pending", createdAt: 1 };
}

describe("Gen1 durable question read recovery", () => {
  it("retries a failed first read and preserves recovered questions on the next write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gen1-ask-retry-")); dirs.push(dir);
    const file = join(dir, "ask-users.jsonl");
    await mkdir(file);
    const store = new JSONLAskUserStore({ dataDir: dir });
    const previous = ask();
    await expect(store.listPending(previous.sessionId)).rejects.toThrow();
    await rm(file, { recursive: true });
    await writeFile(file, `${JSON.stringify({ schemaVersion: 1, ask: previous })}\n`);
    expect(await store.listPending(previous.sessionId)).toEqual([previous]);
    const next = ask(previous.sessionId);
    await store.create(next);
    expect(await new JSONLAskUserStore({ dataDir: dir }).listPending(previous.sessionId)).toEqual([previous, next]);
    expect(await readFile(file, "utf8")).toContain(previous.id);
  });

  it("serializes an initial read with a concurrent create so neither caller sees a premature empty cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gen1-ask-concurrent-")); dirs.push(dir);
    const previous = ask();
    const next = ask(previous.sessionId);
    await writeFile(join(dir, "ask-users.jsonl"), `${JSON.stringify({ schemaVersion: 1, ask: previous })}\n`);
    const store = new JSONLAskUserStore({ dataDir: dir });
    const initialRead = store.listPending(previous.sessionId);
    await store.create(next);
    expect(await initialRead).toContainEqual(previous);
    expect(await new JSONLAskUserStore({ dataDir: dir }).listPending(previous.sessionId)).toEqual([previous, next]);
  });

  it.each(["create", "answer", "withdraw"])("does not publish a ghost %s mutation after a native persistence failure", async mode => {
    const dir = await mkdtemp(join(tmpdir(), "gen1-ask-write-failure-")); dirs.push(dir);
    const file = join(dir, "ask-users.jsonl"), backup = `${file}.backup`;
    const previous = ask(), next = ask(previous.sessionId);
    const store = new JSONLAskUserStore({ dataDir: dir });
    await store.create(previous);
    const originalBytes = await readFile(file, "utf8");
    await rename(file, backup); await mkdir(file);
    const mutate = () => mode === "create" ? store.create(next) : mode === "answer"
      ? store.markAnswered(previous.id, { requestId: previous.id, text: "chosen", answeredAt: 2 })
      : store.markWithdrawn(previous.id);
    await expect(mutate()).rejects.toThrow();
    expect(await store.get(previous.id)).toEqual(previous);
    expect(await store.listPending(previous.sessionId)).toEqual([previous]);
    expect(await store.get(next.id)).toBeUndefined();
    expect(await readFile(backup, "utf8")).toBe(originalBytes);
    await rm(file, { recursive: true }); await rename(backup, file);
    await expect(mutate()).resolves.toBeUndefined();
    const reopened = new JSONLAskUserStore({ dataDir: dir });
    if (mode === "create") expect(await reopened.listPending(previous.sessionId)).toEqual([previous, next]);
    else expect((await reopened.get(previous.id))?.status).toBe(mode === "answer" ? "answered" : "withdrawn");
  });
});
