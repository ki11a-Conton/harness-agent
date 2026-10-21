import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createHarness } from "@ar/harness";
import { ScriptedModelProvider } from "@ar/model";
import { createHostTools } from "./deepseek/host-tools.js";
import { createOwnerManager } from "./deepseek/owners.js";

it.each([undefined, 23])("a real Web workspace owner inherits server budget %s", async ceiling => {
  const cwd = await mkdtemp(join(tmpdir(), "ar-web-owner-iterations-"));
  const secondary = join(cwd, "secondary");
  await mkdir(secondary);
  for (let i = 0; i < 22; i++) await writeFile(join(secondary, `file-${i}.txt`), `owner evidence ${i}`);
  const provider = new ScriptedModelProvider([...Array.from({ length: 22 }, (_, i) => ScriptedModelProvider.toolCall("read_file", { path: `file-${i}.txt` })), ScriptedModelProvider.text("Twenty-two owner reads complete.")]);
  const base = await createHarness({ cwd, profile: "test", modelProvider: provider, model: { providerId: provider.id, modelId: "scripted-model" }, ...(ceiling === undefined ? {} : { maxIterationsPerTurn: ceiling }) });
  const tools = createHostTools(base, cwd);
  const manager = await createOwnerManager(base, { workspace: async () => ({ path: secondary, workspaceId: "secondary" }), executeHostTool: tools.executeHostTool });
  try {
    const session = await manager.createSession("secondary", new AbortController().signal);
    const owner = await manager.ownerOf(session.id);
    expect(owner).not.toBe(base);
    expect(owner.config.maxIterationsPerTurn).toBe(ceiling);
    const actor = await manager.harnessFacade.sessions.load(session.id);
    const handle = await actor.startTurn({ sessionId: session.id, text: "Read the twenty-two files in this workspace." });
    const outcome = await handle.outcome;
    expect(outcome.status).toBe(ceiling === undefined ? "failed" : "completed");
    expect((await owner.events.list(session.id)).filter(event => event.type === "model.started")).toHaveLength(ceiling ?? 20);
    if (ceiling === undefined) expect(outcome.error?.message).toContain("maxIterationsPerTurn (20)");
    const messages = await owner.store.listMessages(session.id);
    const results = messages.filter(message => message.role === "tool");
    expect(results).toHaveLength(ceiling === undefined ? 20 : 22);
    for (let i = 0; i < results.length; i++) expect(results[i]!.content).toContain(`owner evidence ${i}`);
  } finally { await manager.close(); await base.close(); await rm(cwd, { recursive: true, force: true }); }
});

it("the real Web entry forwards the environment ceiling through HTTP to twenty-three model requests", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ar-web-iterations-"));
  for (let i = 0; i < 22; i++) await writeFile(join(cwd, `file-${i}.txt`), `web evidence ${i}`);
  let requests = 0; const observedResults: string[] = [];
  const endpoint = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
    const index = requests++;
    if (index > 0) observedResults.push(input.messages.findLast(message => message.role === "tool")?.content ?? "");
    const delta = index < 22 ? { tool_calls: [{ index: 0, id: `local-read-${index}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `file-${index}.txt` }) } }] } : { content: "Twenty-two Web reads complete." };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: index < 22 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done => endpoint.listen(0, "127.0.0.1", done));
  // A fresh environment and a loopback-only endpoint ensure this fixture cannot
  // use an inherited provider credential or contact a paid provider.
  const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/main.js", import.meta.url))], { cwd, env: {
    PATH: process.env.PATH, ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, TEMP: tmpdir() } : {}),
    OPENAI_API_KEY: "local-nonbillable-fixture", OPENAI_BASE_URL: `http://127.0.0.1:${(endpoint.address() as { port: number }).port}/v1`,
    OPENAI_MODEL: "local-scripted", HARNESS_WEB_HOST: "127.0.0.1", HARNESS_WEB_PORT: "0", HARNESS_MAX_ITERATIONS_PER_TURN: "23",
  }, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close"); let output = "", errors = "";
  child.stderr.on("data", chunk => { errors += String(chunk); });
  const controller = new AbortController();
  try {
    const base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Web entry did not listen: ${errors}`)), 15000);
      child.once("close", code => { clearTimeout(timeout); reject(new Error(`Web entry exited ${code}: ${errors}`)); });
      child.stdout.on("data", chunk => { output += String(chunk); const found = /listening on (http:\/\/127\.0\.0\.1:\d+)/u.exec(output); if (found) { clearTimeout(timeout); resolve(found[1]!); } });
    });
    const events = await fetch(`${base}/api/events?from=longrun-budget`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
    const posted = await fetch(`${base}/api/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "longrun-budget", text: "Read the twenty-two files and report completion." }) });
    expect(posted.status).toBe(200);
    let stream = "";
    for await (const chunk of events.body!) {
      stream += new TextDecoder().decode(chunk);
      if (/"type":"turn\.(?:completed|failed|cancelled)"/u.test(stream)) break;
    }
    expect(stream, errors).toContain('"type":"turn.completed"'); expect(requests).toBe(23);
    expect(observedResults).toHaveLength(22); for (let i = 0; i < 22; i++) expect(observedResults[i]).toContain(`web evidence ${i}`);
    const history = await (await fetch(`${base}/api/history?from=longrun-budget`)).json() as { messages: Array<{ role: string; content: string }> };
    expect(history.messages.filter(message => message.role === "tool")).toHaveLength(22);
    expect(history.messages.at(-1)?.content).toBe("Twenty-two Web reads complete.");
  } finally {
    controller.abort(); child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
    await closed; clearTimeout(timeout);
    await new Promise<void>(done => endpoint.close(() => done()));
    await rm(cwd, { recursive: true, force: true });
  }
}, 30000);
