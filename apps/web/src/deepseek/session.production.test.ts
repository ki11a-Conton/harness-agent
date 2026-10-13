import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHarness } from "@ar/harness";
import { ScriptedModelProvider } from "@ar/model";
import type { SessionId } from "@ar/contracts";
import { createDeepseekComposition } from "./composition.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

it("production composition admits a prompt while official event and follow streams remain open", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dsh-production-prompt-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), dataDir = join(root, "data"); await mkdir(cwd);
  const provider = new ScriptedModelProvider([ScriptedModelProvider.text("Actual production answer")]);
  const base = await createHarness({ cwd, dataDir, profile: "interactive", modelProvider: provider,
    model: { providerId: provider.id, modelId: "scripted-model" } });
  cleanup.push(() => base.close());
  const stack = await createDeepseekComposition(base, dataDir); cleanup.push(() => stack.close());
  const controller = new AbortController(); cleanup.push(async () => { controller.abort(); });
  const signal = controller.signal;
  const created = await stack.sessions.call("session/create", { request: {} }, signal) as { sessionId: SessionId };
  const id = created.sessionId;
  const events = stack.sessions.stream("$events", {}, signal)[Symbol.asyncIterator]();
  const follow = stack.sessions.stream("session/follow", { request: { address: { kind: "session", sessionId: id }, assistantStream: true } }, signal)[Symbol.asyncIterator]();
  expect((await events.next()).value).toMatchObject({ type: "ready" });
  expect((await events.next()).value).toMatchObject({ type: "emit", event: "api-session/added" });
  expect((await follow.next()).value).toMatchObject({ type: "snapshot" });
  const control = stack.sessions.stream("session/control", {}, signal)[Symbol.asyncIterator]();
  expect((await control.next()).value).toMatchObject({ type: "baseline" });
  const pumps = [events, follow, control].map(async iterator => {
    try { while (!(await iterator.next()).done) { /* Real stream subscribers drain frames continuously. */ } }
    catch (error) { if (!signal.aborted) throw error; }
  });
  const admission = stack.sessions.call("session/prompt", { request: { sessionId: id, requestId: "production-request", mode: "queue", content: [{ type: "text", text: "Please answer" }] } }, signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([admission, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Production admission timed out")), 1500); })]);
    expect(result).toEqual({ accepted: true });
  } finally { if (timer) clearTimeout(timer); controller.abort(); await Promise.all(pumps); }
  expect(await stack.harness.inbox.listAll(id)).toHaveLength(1);
  let completed = false;
  for (let i = 0; i < 100 && !completed; i++) {
    completed = (await stack.harness.store.listTurns(id))[0]?.status === "completed";
    if (!completed) await new Promise(done => setTimeout(done, 5));
  }
  expect(completed).toBe(true);
  expect((await stack.harness.store.listMessages(id)).some(message => message.content === "Actual production answer")).toBe(true);
}, 10_000);
