import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { newMessageId } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { createHarness, type Harness } from "./create-harness.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

it.each(["row-before", "row-after", "event-before", "event-after"])("restarts the real durable store after %s without splitting effective and displayed models", async stage => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "model-switch-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = new ScriptedModelProvider([ScriptedModelProvider.text("ok")]);
  const config = { cwd: root, dataDir: join(root, "data"), profile: "interactive" as const,
    modelProvider: provider, model: { providerId: provider.id, modelId: "original" } };
  const open = async () => { const harness = await createHarness(config); cleanup.push(() => harness.close()); return harness; };
  const h = await open();
  const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd: root });
  const target = { providerId: provider.id, modelId: "selected" };
  if (stage.startsWith("row")) {
    const update = h.store.updateSession.bind(h.store);
    vi.spyOn(h.store, "updateSession").mockImplementation(async row => {
      if (stage === "row-after") await update(row);
      throw new Error("interrupted row write");
    });
  } else {
    const append = h.events.appendNew.bind(h.events);
    vi.spyOn(h.events, "appendNew").mockImplementation(async event => {
      if (stage === "event-after") await append(event);
      throw new Error("interrupted event write");
    });
  }
  await expect(h.runtime.setSessionModel(session.id, target)).rejects.toThrow("interrupted");
  vi.restoreAllMocks();
  await h.close();
  const restarted = await open();
  const expected = stage === "row-before" ? session.model : target;
  expect((await restarted.store.getSession(session.id))!.model).toEqual(expected);
  expect((await restarted.runtime.getSessionAgent(session.id)).model).toEqual(expected);
  expect((await restarted.runtime.getSessionAgent(session.id)).tools).toEqual(h.agents[0]!.tools);
  const selections = (await restarted.events.list(session.id)).filter(event => event.payload.kind === "web_model_selection");
  expect(selections).toHaveLength(stage === "row-before" ? 0 : 1);
});

it("a durable conversational branch uses the selected model and stamps legacy copied answers with their original model", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "model-branch-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = new ScriptedModelProvider([ScriptedModelProvider.text("ok")]);
  const h: Harness = await createHarness({ cwd: root, dataDir: join(root, "data"), profile: "interactive",
    modelProvider: provider, model: { providerId: provider.id, modelId: "original" } });
  cleanup.push(() => h.close());
  const session = await h.sessionService.create({ agentId: h.agents[0]!.id, cwd: root, model: h.agents[0]!.model });
  for (const role of ["user", "assistant"] as const) await h.store.appendMessage({ id: newMessageId(), sessionId: session.id, role, content: role, createdAt: 1 });
  const model = { providerId: provider.id, modelId: "selected" };
  await h.runtime.setSessionModel(session.id, model);
  const branch = await h.sessionService.threadFork(session.id);
  expect(branch.model).toEqual(model);
  expect((await h.runtime.getSessionAgent(branch.id)).model).toEqual(model);
  expect((await h.store.listMessages(branch.id)).find(message => message.role === "assistant")!.model).toEqual(session.model);
  expect((await h.store.listMessages(session.id)).find(message => message.role === "assistant")!.model).toBeUndefined();
});
