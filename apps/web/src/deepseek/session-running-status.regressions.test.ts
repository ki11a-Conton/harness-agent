import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { createHarness } from "@ar/harness";
import { ScriptedModelProvider } from "@ar/model";
import type { ModelEvent, SessionId } from "@ar/contracts";
import { createDeepseekComposition } from "./composition.js";

type Client = {
  refreshList(): Promise<void>;
  get(id: string): { getSnapshot(): { running: boolean } };
  handleSessionAdded(summary: unknown): void;
  handleSessionStatus(id: string, running: boolean): void;
  dispose(): Promise<void>;
};
type Notice = { type: string; event?: string; args?: unknown[] };

/** Execute the exact pinned client state owner. The only source instrumentation
 * exposes its otherwise-private constructor; no state method is replaced.
 * Cold resident sessions do not open Gateway history or Cordis scopes. */
async function clientManager(list: () => Promise<unknown>): Promise<Client> {
  const source = await readFile(new URL("../../public/deepseek/plugins/dsh-api-session-controller/client.js", import.meta.url), "utf8");
  const marker = "exports.MutableSessionEventSource = MutableSessionEventSource;";
  expect(source).toContain(marker);
  let module: { inspectManager: new (remote: unknown) => Client } | undefined;
  const dependencies: Record<string, unknown> = {
    "@deepseek-ai/cordis": { Context: { filter: Symbol("filter") } },
    "@deepseek-ai/dsh-api-gateway/client": { RemoteJournalStream: class {}, RemoteStreamCarrierError: class extends Error {}, isRemoteFailure: () => false },
    "@deepseek-ai/dsh-client-store": { notifySubscribers: (listeners: Set<() => void>) => { for (const listener of listeners) listener(); } },
  };
  runInNewContext(source.replace(marker, "exports.inspectManager = SessionManager;\n" + marker), {
    window: { __ModuleLoader__: { load: ({ factory }: { factory: (require: (id: string) => unknown) => typeof module }) => {
      module = factory(id => { expect(id in dependencies).toBe(true); return dependencies[id]; });
    } } }, queueMicrotask, AbortController, console, setTimeout, clearTimeout, structuredClone,
  });
  expect(module).toBeDefined();
  return new module!.inspectManager({ session: { list: async () => ({ ok: true, value: await list() }) } });
}

it("production event notifications settle a resident client loaded while the model is running", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "web-running-status-")));
  const cwd = join(root, "project"), dataDir = join(root, "data"); await mkdir(cwd);
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  let entered!: () => void;
  const generating = new Promise<void>(done => { entered = done; });
  const provider = new ScriptedModelProvider([(async function* (): AsyncIterable<ModelEvent> {
    yield { type: "text_delta", text: "Actual answer", timestamp: 0 };
    entered(); await gate;
    yield { type: "completed", result: { text: "Actual answer", finishReason: "stop" }, timestamp: 0 };
  })()]);
  const base = await createHarness({ cwd, dataDir, profile: "interactive", modelProvider: provider,
    model: { providerId: provider.id, modelId: "scripted-model" } });
  let composition: Awaited<ReturnType<typeof createDeepseekComposition>> | undefined;
  let client: Client | undefined, pump: Promise<void> | undefined;
  const controller = new AbortController(), frames: Notice[] = [];
  try {
    composition = await createDeepseekComposition(base, dataDir);
    const service = composition.sessions, signal = controller.signal;
    const { sessionId } = await service.call("session/create", { request: {} }, signal) as { sessionId: SessionId };
    await service.call("session/prompt", { request: { sessionId, requestId: "load-during-generation", mode: "queue",
      content: [{ type: "text", text: "Answer while a client is opening" }] } }, signal);
    await generating;
    client = await clientManager(() => service.call("session/list", { _request: {} }, signal));
    await client.refreshList();
    const resident = client.get(sessionId);
    expect(resident.getSnapshot().running).toBe(true);
    const stream = service.stream("$events", {}, signal);
    pump = (async () => {
      try {
        for await (const value of stream) {
          const frame = value as Notice; frames.push(frame);
          if (frame.event === "api-session/added") client!.handleSessionAdded(frame.args![0]);
          if (frame.event === "api-session/status") client!.handleSessionStatus(frame.args![0] as string, frame.args![1] as boolean);
        }
      } catch (error) { if (!signal.aborted) throw error; }
    })();
    await vi.waitFor(() => expect(frames.some(frame => frame.event === "api-session/added"
      && (frame.args?.[0] as { sessionId?: string; running?: boolean })?.sessionId === sessionId
      && (frame.args?.[0] as { running?: boolean })?.running === true)).toBe(true), { timeout: 10_000 });
    release();
    // Wait for the authoritative *finished* summary, not the first streamed
    // answer token. The old backend sends this added(false) but never status.
    await vi.waitFor(() => expect(frames.some(frame => frame.event === "api-session/added"
      && (frame.args?.[0] as { sessionId?: string; running?: boolean })?.sessionId === sessionId
      && (frame.args?.[0] as { running?: boolean })?.running === false)).toBe(true), { timeout: 10_000 });
    await vi.waitFor(() => expect(resident.getSnapshot().running).toBe(false), { timeout: 1000, interval: 10 });
    expect(frames.some(frame => frame.event === "api-session/status" && frame.args?.[0] === sessionId && frame.args[1] === false)).toBe(true);
    expect((await composition.harness.store.listTurns(sessionId))[0]?.status).toBe("completed");
  } finally {
    release(); controller.abort(); await pump;
    await client?.dispose(); await composition?.close(); await base.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
}, 25_000);
