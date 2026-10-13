import { createServer } from "node:http";
import { link, mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHarness } from "@ar/harness";
import { ScriptedModelProvider } from "@ar/model";
import type { SessionId } from "@ar/contracts";
import { createDeepseekComposition } from "./composition.js";

const fileRace = vi.hoisted(() => ({ armed: false, path: "", outside: "" }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    const observed = await actual.lstat(...args);
    if (fileRace.armed && String(args[0]) === fileRace.path) {
      fileRace.armed = false;
      await actual.unlink(fileRace.path);
      await actual.symlink(fileRace.outside, fileRace.path);
    }
    return observed;
  } };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  fileRace.armed = false;
  for (const close of cleanups.splice(0).reverse()) await close();
});
const signal = () => new AbortController().signal;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "dsh-independent-security-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), dataDir = join(root, "data");
  await mkdir(cwd);
  const provider = new ScriptedModelProvider([ScriptedModelProvider.text("native fixture")]);
  const config = { cwd, dataDir, profile: "interactive" as const, modelProvider: provider,
    model: { providerId: provider.id, modelId: "scripted-model" } };
  const base = await createHarness(config); cleanups.push(() => base.close());
  const composed = await createDeepseekComposition(base, dataDir, { environment: {} });
  cleanups.push(() => composed.close());
  return { root, cwd, dataDir, config, base, composed };
}
async function configure(stack: Awaited<ReturnType<typeof setup>>, endpoint: string, key: string) {
  await stack.composed.catalog.call("credentials/set", { ref: "SECURITY_FIXTURE_KEY", value: key }, signal());
  await stack.composed.catalog.call("settings/update", { ns: "llm-pi-ai", patch: { providers: {
    securefixture: { api: "openai-completions", baseURL: endpoint, apiKeyEnv: "SECURITY_FIXTURE_KEY", models: [{ id: "coding-fixture" }] },
  } } }, signal());
}

it.skipIf(process.platform === "win32")("a credential reader refuses a real symlink swapped after the metadata observation", async () => {
  const stack = await setup();
  await configure(stack, "http://127.0.0.1:1/v1", "inside-credential-fixture");
  const path = join(stack.dataDir, "deepseek", "credentials.json");
  const outside = join(stack.root, "outside-credentials.json");
  const outsideBytes = JSON.stringify({ version: 1, revision: 0, values: { SECURITY_FIXTURE_KEY: "outside-credential-fixture" } });
  await writeFile(outside, outsideBytes, { mode: 0o600 });
  Object.assign(fileRace, { armed: true, path, outside });
  await expect(stack.composed.catalog.resolvedModelProfiles(signal())).rejects.toThrow();
  expect(fileRace.armed).toBe(false);
  expect(await readFile(outside, "utf8")).toBe(outsideBytes);
});

it("a private credential document cannot alias an outside retained file through a hard link", async () => {
  const stack = await setup();
  await configure(stack, "http://127.0.0.1:1/v1", "inside-credential-fixture");
  const path = join(stack.dataDir, "deepseek", "credentials.json");
  const outside = join(stack.root, "linked-credentials.json");
  const outsideBytes = JSON.stringify({ version: 1, revision: 0, values: { SECURITY_FIXTURE_KEY: "outside-linked-credential-fixture" } });
  await writeFile(outside, outsideBytes, { mode: 0o600 });
  await unlink(path); await link(outside, path);
  await expect(stack.composed.catalog.resolvedModelProfiles(signal())).rejects.toThrow();
  expect(await readFile(outside, "utf8")).toBe(outsideBytes);
});

it("byte-range previews cannot reconstruct a protected credential that the whole-file preview refuses", async () => {
  const stack = await setup();
  const secretFile = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890\n";
  await writeFile(join(stack.cwd, "fixture-config.txt"), secretFile);
  const id = (await stack.composed.sessions.call("session/create", { request: {} }, signal()) as { sessionId: SessionId }).sessionId;
  const base = { workspaceFileScopeId: id, path: "fixture-config.txt" };
  await expect(stack.composed.files.call("workspaceFiles/readBytes", { ...base, options: {} }, signal())).rejects.toThrow();
  await expect(stack.composed.files.call("workspaceFiles/readBytes", { ...base, options: { range: { offset: 0, length: 7 } } }, signal())).rejects.toThrow();
});

it("an owner consumes the final committed credential when rotation completes before the actual owner is frozen", async () => {
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Consume the actual provider request. */ }
    calls.push(req.headers.authorization ?? "");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "actual local HTTP answer" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  cleanups.push(() => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())));
  const stack = await setup();
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  await configure(stack, endpoint, "original-credential-fixture");
  const id = (await stack.composed.sessions.call("session/create", { request: {} }, signal()) as { sessionId: SessionId }).sessionId;
  const captured = deferred(), resume = deferred();
  const original = stack.composed.catalog.resolvedModelProfiles.bind(stack.composed.catalog);
  let intercepted = false;
  stack.composed.catalog.resolvedModelProfiles = async requested => {
    const value = await original(requested);
    if (!intercepted) { intercepted = true; captured.resolve(); await resume.promise; }
    return value;
  };
  const selecting = stack.composed.catalog.call("session/selectModel", { request: { sessionId: id, provider: "securefixture", model: "coding-fixture" } }, signal());
  try {
    await captured.promise;
    const rotation = await Promise.allSettled([stack.composed.catalog.call("credentials/set", { ref: "SECURITY_FIXTURE_KEY", value: "rotated-credential-fixture" }, signal())]);
    resume.resolve(); await selecting;
    const actor = await stack.composed.harness.sessions.load(id);
    const turn = await actor.createTurn({ sessionId: id, text: "Use the configured local provider" });
    expect((await actor.runTurn(turn.id)).status).toBe("completed");
    // The first resolver result is preliminary. The actual owner factory
    // rereads the committed source and freezes that final credential identity.
    expect(calls).toEqual(["Bearer rotated-credential-fixture"]);
    expect(rotation[0]?.status).toBe("fulfilled");
  } finally { resume.resolve(); await selecting.catch(() => {}); }
});
