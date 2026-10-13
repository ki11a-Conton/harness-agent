import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHarness, type Harness } from "@ar/harness";
import { createRuntimeRpc } from "@ar/gateway";
import { ScriptedModelProvider } from "@ar/model";
import { createHostTools } from "./host-tools.js";
import { createSessionService } from "./session.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function service(harness: Harness, directory: string) {
  return createSessionService({ harness, cwd: directory, dataDir: directory,
    rpc: createRuntimeRpc(harness.runtime, { sessionService: harness.sessionService, sessions: harness.sessions,
      events: harness.events, approvalStore: harness.approvalStore }),
    ...createHostTools(harness, directory, directory) });
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-agent-availability-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const provider = new ScriptedModelProvider([ScriptedModelProvider.text("actual answer")]);
  const options = { cwd: directory, dataDir: directory, profile: "interactive" as const, modelProvider: provider,
    model: { providerId: provider.id, modelId: "scripted-model" } };
  const harness = await createHarness(options);
  cleanup.push(() => harness.close());
  const session = await harness.runtime.createSession({ cwd: directory, agent: harness.agents[0]! });
  return { directory, options, harness, session };
}

it("a real lazy blank session advertises its resolvable frozen agent without loading an actor", async () => {
  const stack = await fixture();
  expect(stack.harness.sessions.listLoaded()).not.toContain(stack.session.id);
  const summary = await service(stack.harness, stack.directory).summary(stack.session.id);
  expect(summary).toMatchObject({ sessionId: stack.session.id, agentAvailable: true, blank: true, running: false });
  expect(stack.harness.sessions.listLoaded()).not.toContain(stack.session.id);
  expect(await stack.harness.store.listTurns(stack.session.id)).toEqual([]);
});

it("a process-reopened blank session remains available before its first actor load or model call", async () => {
  const stack = await fixture();
  await stack.harness.close();
  const reopened = await createHarness(stack.options);
  cleanup.push(() => reopened.close());
  expect(reopened.sessions.listLoaded()).not.toContain(stack.session.id);
  const current = service(reopened, stack.directory);
  const listed = await current.call("session/list", { _request: {} }, new AbortController().signal) as { items: unknown[] };
  expect(listed.items).toContainEqual(expect.objectContaining({ sessionId: stack.session.id, agentAvailable: true, blank: true }));
  expect(reopened.sessions.listLoaded()).not.toContain(stack.session.id);
  expect(await reopened.store.listTurns(stack.session.id)).toEqual([]);
});
