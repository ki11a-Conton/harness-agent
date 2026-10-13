import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHarness } from "@ar/harness";
import { ScriptedModelProvider } from "@ar/model";
import { createHostTools } from "./host-tools.js";
import { createOwnerManager } from "./owners.js";
import { createSessionService } from "./session.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const signal = () => new AbortController().signal;

it("an existing follow and all snapshot reads wait for committed model-generation activation", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "dsh-model-snapshot-")));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const original = new ScriptedModelProvider([ScriptedModelProvider.text("original")]);
  const chosen = new ScriptedModelProvider([ScriptedModelProvider.text("chosen")]);
  const base = await createHarness({ cwd: directory, dataDir: directory, profile: "interactive", modelProvider: original,
    model: { providerId: original.id, modelId: "original" } });
  cleanup.push(() => base.close());
  const entered = gate(), activate = gate();
  const tools = createHostTools(base, directory, directory);
  const owners = await createOwnerManager(base, { dataDir: directory, newSessionsUseChildren: true,
    executeHostTool: tools.executeHostTool, workspace: async () => ({ path: directory }),
    resolveSelection: async () => ({ modelProvider: chosen, model: { providerId: chosen.id, modelId: "chosen" } }),
    configureOwner(owner) {
      const update = owner.store.updateSession.bind(owner.store);
      owner.store.updateSession = async session => {
        if (session.model.modelId === "chosen" && session.status === "active") { entered.resolve(); await activate.promise; }
        return update(session);
      };
    },
  });
  cleanup.push(() => owners.close());
  const harness = owners.harnessFacade;
  const sessions = createSessionService({ harness, cwd: directory, dataDir: directory, rpc: owners.rpcFacade,
    withSessionLock: owners.withSessionLock, pollDelayMs: 1,
    ...createHostTools(harness, directory, directory, owners.ownerOf, owners.nativeSessionId) });
  const session = await owners.createSession(undefined, signal());
  const controller = new AbortController();
  const following = sessions.stream("session/follow", { request: { address: { kind: "session", sessionId: session.id } } }, controller.signal)[Symbol.asyncIterator]();
  const opening = (await following.next()).value as { type: string; cursor: number; records: unknown[] };
  expect(opening).toMatchObject({ type: "snapshot", projections: { values: { modelSelection: { next: { model: "original" } } } } });
  const selecting = owners.selectModel(session.id, { providerKey: "chosen-route", modelId: "chosen" }, signal());
  await entered.promise;
  // The durable alias CAS has happened, but the real frozen replacement is
  // still intentionally failed/private until its activation commits.
  const reads = [following.next(), sessions.summary(session.id),
    sessions.call("session/projections", { request: { sessionId: session.id } }, signal()),
    sessions.call("session/page", { request: { address: { kind: "session", sessionId: session.id }, throughSeq: 0 } }, signal())];
  const observed = reads.map(async promise => {
    try { return { settled: true, value: await promise }; } catch (error) { return { settled: true, error }; }
  });
  try {
    const early = await Promise.race([Promise.all(observed), new Promise<null>(done => setTimeout(() => done(null), 80))]);
    expect(early).toBeNull();
  } finally { activate.resolve(); }
  await selecting;
  const results = await Promise.all(observed);
  expect(results.every(item => !("error" in item))).toBe(true);
  expect(results[1]!.value).toMatchObject({ agentAvailable: true, blank: true });
  expect(results[2]!.value).toMatchObject({ values: { modelSelection: { next: { model: "chosen" } } } });
  expect(results[3]!.value).toMatchObject({ records: opening.records });
  const first = results[0]!.value as { value: { type: string; event: { seq: number } } };
  expect(first.value.event.seq).toBeGreaterThan(opening.cursor);
  expect((await following.next()).value).toMatchObject({ type: "event", event: { type: "model/selection", data: { model: "chosen" } } });
  controller.abort(); await following.return?.();
});
