#!/usr/bin/env node
/** Production host plus a loopback HTTP model fixture. No browser RPC mocks. */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { verifyPortable } from "../release/portable-lib.mjs";

const { values } = parseArgs({ options: {
  root: { type: "string" }, "provider-port": { type: "string", default: "0" },
  "web-port": { type: "string", default: "0" },
  "portable-root": { type: "string" },
  "ipc-control": { type: "boolean", default: false },
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
  await appendFile(resolve(evidence, "requests.jsonl"), JSON.stringify({ launchId, call, model: request.model,
    messages: request.messages, tools: request.tools?.map(tool => tool.function.name) }) + "\n");
  const userIndex = request.messages.findLastIndex(message => message.role === "user");
  const text = String(request.messages[userIndex]?.content ?? "");
  const tail = request.messages.slice(userIndex + 1);
  const hasTool = tail.some(message => message.role === "tool");
  const hasAnsweredQuestion = request.messages.slice(userIndex).some(message => /User answer|target-blue|target-red/i.test(JSON.stringify(message)));
  let tool;
  if (/\[fixture:read\]/.test(text) && !hasTool) tool = { name: "read_file", args: { path: "demo.js" } };
  if (/\[fixture:write\]/.test(text) && !hasTool) tool = { name: "write_file", args: { path: "browser-created.txt", content: "Actual approved browser coding output\n" } };
  if (/\[fixture:write-deny\]/.test(text) && !hasTool) tool = { name: "write_file", args: { path: "browser-rejected.txt", content: "This write must never occur\n" } };
  if (/\[fixture:ask\]/.test(text) && !hasTool && !hasAnsweredQuestion) tool = { name: "ask_user", args: { question: "Which browser target?", reason: "choice_required", options: ["target-blue", "target-red"] } };
  if (tool && !request.tools?.some(candidate => candidate.function.name === tool.name)) throw new Error(`Actual model catalog lacks ${tool.name}`);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const frame = (delta, finish_reason = null, usage) => res.write("data: " + JSON.stringify({ id: "local-" + call,
    object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) }) + "\n\n");
  if (tool) {
    const args = JSON.stringify(tool.args), id = `fixture-tool-${call}`;
    frame({ tool_calls: [{ index: 0, id, type: "function", function: { name: tool.name, arguments: args.slice(0, 12) } }] });
    await new Promise(done => setTimeout(done, 150));
    frame({ tool_calls: [{ index: 0, function: { arguments: args.slice(12) } }] });
    frame({}, "tool_calls", { prompt_tokens: 32, completion_tokens: 20, total_tokens: 52 });
  } else {
    const answer = "# Actual Harness browser answer\n\n**Bold result** and [local documentation](https://example.invalid/docs).\n\n- First item\n- Second item\n\n| File | Status |\n| --- | --- |\n| demo.js | reviewed |\n\n```js\nexport const value = 1;\n```\n\n" +
      (hasTool ? "The actual tool result was received.\n" : "") + (hasAnsweredQuestion ? "The browser answer was received.\n" : "");
    for (const chunk of [answer.slice(0, 30), answer.slice(30, 95), answer.slice(95)]) {
      if (res.destroyed) break; frame({ content: chunk }); await new Promise(done => setTimeout(done, 250));
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
const childArgs = values["ipc-control"] ? ["--input-type=module", "--eval",
  `import { main } from ${JSON.stringify(pathToFileURL(entry).href)}; process.once("message", message => { if (message?.type === "fixture-stop") { process.disconnect(); process.emit("SIGTERM"); } }); process.exitCode = await main();`] : [entry];
const child = spawn(process.execPath, childArgs, { cwd,
  env: { ...process.env, OPENAI_API_KEY: "local-fixture-credential", OPENAI_BASE_URL: providerOrigin,
    OPENAI_MODEL: "web-loopback-fixture", HARNESS_DATA_DIR: resolve(root, "data"), HARNESS_WEB_PORT: values["web-port"] },
  stdio: values["ipc-control"] ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"] });
const launch = { launchId, compiledDigest, providerOrigin, cwd, source: artifactRoot,
  ...(manifest ? { installed: true, sourceSha: manifest.sourceSha, version: manifest.version } : {}),
  ...(values["ipc-control"] ? { shutdownControl: "test-only IPC invokes the actual production SIGTERM handler; not native OS signal delivery" } : {}),
  model: "web-loopback-fixture", paidModelCalls: 0, pid: child.pid, parentPid: process.pid };
await writeFile(resolve(evidence, "launch.json"), JSON.stringify(launch, null, 2) + "\n");
await appendFile(resolve(evidence, "launch-history.jsonl"), JSON.stringify(launch) + "\n");
child.stdout.on("data", chunk => process.stdout.write(chunk)); child.stderr.on("data", chunk => process.stderr.write(chunk));
child.on("exit", async code => {
  const receipt = { launchId, code, paidModelCalls: 0, loopbackModelRequests: calls };
  await writeFile(resolve(evidence, "host-exit.json"), JSON.stringify(receipt) + "\n");
  await appendFile(resolve(evidence, "host-exit-history.jsonl"), JSON.stringify(receipt) + "\n");
  server.close(); for (const socket of sockets) socket.destroy();
  if (process.connected) process.disconnect(); process.exitCode = code ?? 1;
});
if (values["ipc-control"]) process.once("message", message => {
  if (message?.type === "fixture-stop" && child.connected) child.send(message);
});
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => child.kill(signal));
