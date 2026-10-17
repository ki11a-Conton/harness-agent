import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHarness } from "@ar/harness";
import { ScriptedModelProvider } from "@ar/model";
import type { ModelEvent, SessionId } from "@ar/contracts";
import { createDeepseekComposition } from "./composition.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

it.each([0, 2000])("production composition admits a prompt with %i ms metadata IO while official event and follow streams remain open", async metadataDelayMs => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dsh-production-prompt-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), dataDir = join(root, "data"); await mkdir(cwd);
  let releaseModel!: () => void;
  let modelReleased = false;
  const modelGate = new Promise<void>(resolve => { releaseModel = () => { modelReleased = true; resolve(); }; });
  cleanup.push(async () => { releaseModel(); });
  const provider = new ScriptedModelProvider([(async function* (): AsyncIterable<ModelEvent> {
    // Admission and subscriber shutdown must not depend on the model ending.
    await modelGate;
    yield { type: "text_delta", text: "Actual production answer", timestamp: 0 };
    yield { type: "completed", result: { finishReason: "stop", text: "Actual production answer" }, timestamp: 0 };
  })()]);
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
  const update = stack.sessions.metadata.update.bind(stack.sessions.metadata);
  let delay = metadataDelayMs;
  const slowWrite = vi.spyOn(stack.sessions.metadata, "update").mockImplementation(async (...args) => {
    if (delay > 0) { const wait = delay; delay = 0; await new Promise(done => setTimeout(done, wait)); }
    return update(...args);
  });
  cleanup.push(async () => slowWrite.mockRestore());
  const admission = stack.sessions.call("session/prompt", { request: { sessionId: id, requestId: "production-request", mode: "queue", content: [{ type: "text", text: "Please answer" }] } }, signal);
  try {
    // This is a liveness/ownership test, not a 1.5s storage benchmark. Keep
    // the model gate closed and all three real subscriptions active until the
    // prompt is DURABLY admitted. The existing outer 20s watchdog catches a
    // lock held across a yield or an admission that waits for model completion.
    const result = await admission;
    expect(result).toEqual({ accepted: true });
    expect(modelReleased).toBe(false);
    expect(await stack.harness.inbox.listAll(id)).toHaveLength(1);
  } finally {
    controller.abort();
    try { await Promise.all(pumps); } finally { releaseModel(); }
  }
  expect(await stack.harness.inbox.listAll(id)).toHaveLength(1);
  let completed = false;
  const completionDeadline = performance.now() + 5000;
  while (performance.now() < completionDeadline && !completed) {
    completed = (await stack.harness.store.listTurns(id))[0]?.status === "completed";
    if (!completed) await new Promise(done => setTimeout(done, 5));
  }
  expect(completed).toBe(true);
  expect((await stack.harness.store.listMessages(id)).some(message => message.content === "Actual production answer")).toBe(true);
}, 20_000);
