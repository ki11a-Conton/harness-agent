#!/usr/bin/env node
/** Production host plus a loopback HTTP model fixture. No browser RPC mocks. */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { verifyPortable } from "../release/portable-lib.mjs";
import { prepareFreshFixture, readFixtureDirectory, rememberFixtureDirectory } from "./fixture-availability.mjs";

const { values } = parseArgs({ options: {
  root: { type: "string" }, "provider-port": { type: "string", default: "0" },
  "web-port": { type: "string", default: "0" },
  "portable-root": { type: "string" },
  "ipc-control": { type: "boolean", default: false },
  "preflight-owner": { type: "boolean", default: false },
} });
if (!values.root) throw new Error("Use --root <fresh fixture directory>");
const root = resolve(values.root), evidence = resolve(root, "evidence"), cwd = resolve(root, "project");
const launchId = randomUUID();
await Promise.all([mkdir(evidence, { recursive: true }), mkdir(cwd, { recursive: true })]);
for (const [name, content] of [["README.md", "# Browser fixture\n"], ["demo.js", "export const value = 1;\n"]]) {
  try { await readFile(resolve(cwd, name)); } catch (error) {
    if (error.code !== "ENOENT") throw error; await writeFile(resolve(cwd, name), content);
  }
}
let calls = 0;
const interruptedPrompts = new Set();
const sockets = new Set();
const server = createServer((req, res) => { void serve(req, res).catch(error => {
  void appendFile(resolve(evidence, "provider-errors.jsonl"), JSON.stringify({ message: error.message }) + "\n");
  if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Local fixture failure" } }));
}); });
server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
async function serve(req, res) {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "web-loopback-fixture" }, { id: "web-loopback-alternate" }] })); return;
  }
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
  let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 2_000_000) throw new Error("Fixture request too large"); }
  const request = JSON.parse(raw), call = ++calls;
  const compaction = request.messages.some(message => message.role === "system" && String(message.content).includes("CONTEXT CHECKPOINT COMPACTION"));
  await appendFile(resolve(evidence, "requests.jsonl"), JSON.stringify({ launchId, call, model: request.model,
    messages: request.messages, purpose: compaction ? "compaction" : "coding", maxTokens: request.max_tokens ?? request.max_completion_tokens,
    tools: request.tools?.map(tool => tool.function.name), ...(request.reasoning_effort === undefined ? {} : { reasoningEffort: request.reasoning_effort }) }) + "\n");
  const userIndex = request.messages.findLastIndex(message => message.role === "user");
  const text = String(request.messages[userIndex]?.content ?? "");
  if (compaction) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const handoff = "Progress: inspected demo.js and retained previous coding actions. Decision: BROWSER-CONTEXT-EARLY-FACT uses invoiceId. Next: continue the current human task and verify the actual files. This is a deterministic local fixture handoff.";
    res.end("data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: handoff }, finish_reason: "stop" }], usage: { prompt_tokens: 1800, completion_tokens: 60 } }) + "\n\ndata: [DONE]\n\n"); return;
  }
  const tail = request.messages.slice(userIndex + 1);
  const hasTool = tail.some(message => message.role === "tool");
  const hasAnsweredQuestion = request.messages.slice(userIndex).some(message => /User answer|target-blue|target-red/i.test(JSON.stringify(message)));
  let tool;
  if (/\[fixture:read\]/.test(text) && !hasTool) tool = { name: "read_file", args: { path: "demo.js" } };
  if (/\[fixture:write\]/.test(text) && !hasTool) tool = { name: "write_file", args: { path: "browser-created.txt", content: "Actual approved browser coding output\n" } };
  if (/\[fixture:write-deny\]/.test(text) && !hasTool) tool = { name: "write_file", args: { path: "browser-rejected.txt", content: "This write must never occur\n" } };
  if (/\[fixture:plan\]/.test(text) && !hasTool) tool = { name: "write_file", args: { path: "plan-approved.txt", content: "Actual human approved plan output\n" } };
  if (/\[fixture:ask\]/.test(text) && !hasTool && !hasAnsweredQuestion) tool = { name: "ask_user", args: { question: "Which browser target?", reason: "choice_required", options: ["target-blue", "target-red"] } };
  if (/\[fixture:reset-before-output\]/.test(text) && !hasTool) tool = { name: "write_file", args: { path: "browser-reset-recovered.txt", content: "Actual recovered write exactly once\n" } };
  if (tool && !request.tools?.some(candidate => candidate.function.name === tool.name)) throw new Error(`Actual model catalog lacks ${tool.name}`);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const frame = (delta, finish_reason = null, usage) => res.write("data: " + JSON.stringify({ id: "local-" + call,
    object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) }) + "\n\n");
  if (/\[fixture:reset-before-output\]/.test(text) && !interruptedPrompts.has(text)) {
    interruptedPrompts.add(text); res.flushHeaders(); res.write(": keepalive\n\n");
    setTimeout(() => res.destroy(), 30); return;
  }
  if (/\[fixture:length\]/.test(text)) {
    frame({ content: "Partial coding result retained before the output limit." });
    frame({}, "length", { prompt_tokens: 32, completion_tokens: 20, total_tokens: 52 });
    res.end("data: [DONE]\n\n"); return;
  }
  if (tool) {
    const args = JSON.stringify(tool.args), id = `fixture-tool-${call}`;
    frame({ tool_calls: [{ index: 0, id, type: "function", function: { name: tool.name, arguments: args.slice(0, 12) } }] });
    await new Promise(done => setTimeout(done, 150));
    frame({ tool_calls: [{ index: 0, function: { arguments: args.slice(12) } }] });
    frame({}, "tool_calls", { prompt_tokens: 32, completion_tokens: 20, total_tokens: 52 });
  } else {
    const answer = "# Actual Harness browser answer\n\n**Bold result** and [local documentation](https://example.invalid/docs).\n\n- First item\n- Second item\n\n| File | Status |\n| --- | --- |\n| demo.js | reviewed |\n\n```js\nexport const value = 1;\n```\n\n" +
      (hasTool ? "The actual tool result was received.\n" : "") + (hasAnsweredQuestion ? "The browser answer was received.\n" : "") +
      (/\[fixture:plan\]/.test(text) ? "Plan [fixture:plan]: inspect demo.js, write plan-approved.txt, then verify the actual bytes.\n" : "");
    for (const chunk of [answer.slice(0, 30), answer.slice(30, 95), answer.slice(95)]) {
      if (res.destroyed) break; frame({ content: chunk }); await new Promise(done => setTimeout(done, /\[fixture:slow\]/.test(text) ? 2500 : 250));
    }
    if (!res.destroyed) frame({}, "stop", { prompt_tokens: 32, completion_tokens: 40, total_tokens: 72 });
  }
  if (!res.destroyed) res.end("data: [DONE]\n\n");
}
await new Promise((done, reject) => { server.once("error", reject); server.listen(Number(values["provider-port"]), "127.0.0.1", done); });
const providerOrigin = `http://127.0.0.1:${server.address().port}/v1`;
const source = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Installed acceptance launches only the verified distributed application. The
// fixture and browser driver remain developer tooling, never model adapters.
const installation = values["portable-root"] ? resolve(values["portable-root"]) : undefined;
const manifest = installation ? await verifyPortable(installation) : undefined;
const web = installation ? resolve(installation, "node_modules/@ar/web") : resolve(source, "apps/web");
const artifactRoot = installation ?? source;
// Snapshot compiled workspace bytes before the child imports them. A dirty
// worktree's Git HEAD alone does not identify the code under acceptance.
const compiledFiles = [];
async function collectCompiled(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) await collectCompiled(file);
    else if (entry.isFile() && /\.(?:js|json|wasm|node)$/.test(entry.name)) await recordCompiled(file);
  }
}
async function recordCompiled(file) {
  const bytes = await readFile(file);
  compiledFiles.push({ path: relative(artifactRoot, file).replaceAll("\\", "/"), bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") });
}
if (installation) {
  await collectCompiled(resolve(installation, "node_modules"));
  await recordCompiled(resolve(installation, "PORTABLE-MANIFEST.json"));
} else {
  await collectCompiled(resolve(web, "dist"));
  for (const entry of await readdir(resolve(source, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try { await collectCompiled(resolve(source, "packages", entry.name, "dist")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await recordCompiled(resolve(source, "pnpm-lock.yaml"));
}
if (!installation) await recordCompiled(resolve(web, "public/deepseek/provenance.json"));
compiledFiles.sort((a, b) => a.path.localeCompare(b.path));
const compiledDigest = createHash("sha256").update(JSON.stringify(compiledFiles)).digest("hex");
await writeFile(resolve(evidence, `compiled-${launchId}.json`), JSON.stringify({ launchId, compiledDigest,
  scope: installation ? "verified installed application JavaScript/JSON/WASM/native bytes and portable manifest; no workspace application imports" : "compiled workspace JavaScript/JSON/WASM/native files, dependency lock and official frontend provenance; not a clean release archive claim",
  files: compiledFiles }, null, 2) + "\n");
const entry = resolve(web, "dist/main.js");
// Windows kill(SIGTERM) forcibly terminates Node instead of delivering the
// registered handler. Test-only IPC invokes the actual handler and disconnects
// its channel; it does not assert native operating-system signal delivery.
const controlled = values["ipc-control"] || values["preflight-owner"];
const childArgs = controlled ? ["--input-type=module", "--eval",
  `import { main } from ${JSON.stringify(pathToFileURL(entry).href)}; process.once("message", message => { if (message?.type === "fixture-stop") { process.disconnect(); process.emit("SIGTERM"); } }); process.exitCode = await main();`] : [entry];
const deadline = (promise, ms, label) => new Promise((done, reject) => {
  const timer = setTimeout(() => reject(new Error(label)), ms);
  promise.then(value => { clearTimeout(timer); done(value); }, error => { clearTimeout(timer); reject(error); });
});
let activeCandidate, restoredRoot, shutdownRequested = false;
if (values['ipc-control']) process.once('message', message => {
  if (message?.type !== 'fixture-stop') return;
  shutdownRequested = true;
  if (activeCandidate?.child.connected) activeCandidate.child.send(message);
  else activeCandidate?.child.kill('SIGTERM');
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { shutdownRequested = true; activeCandidate?.child.kill(signal); });
async function createCandidate(index) {
  if (shutdownRequested) throw new Error('Fixture shutdown requested during preparation');
  const candidateRoot = index === 0 ? restoredRoot ?? root : await mkdtemp(resolve(root, 'availability-'));
  const candidateCwd = resolve(candidateRoot, 'project');
  await mkdir(candidateCwd, { recursive: true });
  if (index !== 0) for (const name of ['README.md', 'demo.js']) await writeFile(resolve(candidateCwd, name), await readFile(resolve(cwd, name)));
  const child = spawn(process.execPath, childArgs, { cwd: candidateCwd,
    env: { ...process.env, OPENAI_API_KEY: 'local-fixture-credential', OPENAI_BASE_URL: providerOrigin,
      OPENAI_MODEL: 'web-loopback-fixture', HARNESS_DATA_DIR: resolve(candidateRoot, 'data'), HARNESS_WEB_PORT: values['web-port'] },
    stdio: controlled ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
  const candidate = { child, root: candidateRoot, cwd: candidateCwd, stdout: '', stderr: '', exposed: false, closed: false };
  activeCandidate = candidate;
  candidate.done = new Promise(done => child.once('close', (code, signal) => { candidate.closed = true; done({ code, signal }); }));
  candidate.ready = deadline(new Promise((done, reject) => {
    child.once('error', reject);
    child.stdout.on('data', bytes => { candidate.stdout += bytes; if (candidate.exposed) process.stdout.write(bytes);
      const match = candidate.stdout.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/); if (match) done(match[1]); });
    child.stderr.on('data', bytes => { candidate.stderr += bytes; process.stderr.write(bytes); });
    candidate.done.then(exit => reject(new Error(`Fixture host exited before readiness: ${JSON.stringify(exit)} ${candidate.stderr}`)));
  }), 15000, 'Fixture host readiness exceeded its deadline');
  void candidate.ready.catch(() => {});
  return candidate;
}
async function disposeCandidate(candidate) {
  const { child } = candidate;
  if (!candidate.closed && child.exitCode === null && child.signalCode === null) {
    if (child.connected) child.send({ type: 'fixture-stop' }); else child.kill('SIGTERM');
  }
  try { await deadline(candidate.done, 15000, 'Fixture candidate shutdown timed out'); }
  catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await deadline(candidate.done, 5000, 'Forced fixture candidate did not close'); throw error;
  }
}
let selected;
try {
  restoredRoot = values['preflight-owner'] ? await readFixtureDirectory(root) : undefined;
  selected = await prepareFreshFixture({ create: createCandidate, dispose: disposeCandidate,
    attempts: values['preflight-owner'] && restoredRoot === undefined ? 16 : 1,
    prepare: async (candidate, origin) => {
      if (!values['preflight-owner']) return;
      const response = await fetch(new URL('/api/deepseek/call', origin), { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), endpoint: 'session/create', args: { request: {} } }), signal: AbortSignal.timeout(15000) });
      const body = await response.json();
      if (!response.ok || body.ok !== true) throw new Error(body.error?.message ?? `Fixture owner preparation HTTP ${response.status}`);
      if (!/^session_[\w-]+$/.test(body.value?.sessionId ?? '')) throw new Error('Fixture owner preparation returned no real session identity');
      candidate.preparedSessionId = body.value.sessionId;
    } });
  if (values['preflight-owner']) await rememberFixtureDirectory(root, selected.candidate.root);
} catch (error) {
  let failure = error;
  if (selected) try { await disposeCandidate(selected.candidate); }
  catch (cleanup) { failure = new AggregateError([error, cleanup], 'Fixture publication and disposal both failed'); }
  server.close(); for (const socket of sockets) socket.destroy(); throw failure;
}
const { candidate } = selected, child = candidate.child;
const launch = { launchId, compiledDigest, providerOrigin, cwd: candidate.cwd, source: artifactRoot,
  ...(manifest ? { installed: true, sourceSha: manifest.sourceSha, version: manifest.version } : {}),
  ...(values["ipc-control"] ? { shutdownControl: "test-only IPC invokes the actual production SIGTERM handler; not native OS signal delivery" } : {}),
  model: "web-loopback-fixture", paidModelCalls: 0, pid: child.pid, parentPid: process.pid,
  ...(values['preflight-owner'] ? { fixtureOwnerPreflight: { preparedSessionId: candidate.preparedSessionId, rejected: selected.rejected,
    scope: 'Fresh fixture owner allocated before browser checks; no task input or model request; product lease policy unchanged' } } : {}) };
await writeFile(resolve(evidence, "launch.json"), JSON.stringify(launch, null, 2) + "\n");
await appendFile(resolve(evidence, "launch-history.jsonl"), JSON.stringify(launch) + "\n");
child.on("close", async code => {
  const receipt = { launchId, code, paidModelCalls: 0, loopbackModelRequests: calls };
  await writeFile(resolve(evidence, "host-exit.json"), JSON.stringify(receipt) + "\n");
  await appendFile(resolve(evidence, "host-exit-history.jsonl"), JSON.stringify(receipt) + "\n");
  server.close(); for (const socket of sockets) socket.destroy();
  if (process.connected) process.disconnect(); process.exitCode = code ?? 1;
});
candidate.exposed = true; process.stdout.write(candidate.stdout);
