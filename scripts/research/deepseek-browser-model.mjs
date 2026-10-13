#!/usr/bin/env node
/** Official unmodified browser UI against production Web main and two real loopback model routes. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  output: { type: "string", default: "/tmp/deepseek-browser-model" },
  "playwright-module": { type: "string" }, chromium: { type: "string", default: "/usr/bin/chromium" },
} });
const source = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runnerSha256 = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex");
const output = resolve(values.output), project = resolve(output, "project"), dataDir = resolve(output, "data");
await Promise.all([mkdir(output, { recursive: true }), mkdir(project, { recursive: true })]);
await writeFile(resolve(project, "README.md"), "# Actual browser model selection fixture\n");
const trace = [], requests = [], assertions = [], children = [], launches = [], screenshots = [], sockets = new Set();
const baseline = "web-loopback-fixture", alternate = "web-loopback-alternate", route = "browser-alternate";
const fixtureCredential = "browser-local-fixture-credential";
let browser, child, origin, port, playwrightVersion, welcomed = false;
const deadline = async (operation, timeout = 12_000) => Promise.race([operation, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error("Operation deadline exceeded")), timeout); timer.unref();
})]);
async function until(check, message, timeout = 10_000) {
  const end = Date.now() + timeout;
  do { const result = await check(); if (result) return result; await new Promise(done => setTimeout(done, 40)); } while (Date.now() < end);
  throw new Error(message);
}
function prove(name, condition, details) { assert.ok(condition, name); assertions.push({ name, status: "PASS", ...(details === undefined ? {} : { details }) }); }
function safe(value) {
  if (typeof value === "string") return value.includes(fixtureCredential) ? value.replaceAll(fixtureCredential, "[fixture credential redacted]") : value;
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    ["apiKey", "value"].includes(key) && typeof item === "string" && item === fixtureCredential ? "[fixture credential redacted]" : safe(item)]));
  return value;
}
const provider = createServer((request, response) => { void (async () => {
  if (request.method === "GET" && request.url === "/v1/models") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: [{ id: baseline }, { id: alternate }] })); return; }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404); response.end(); return; }
  let body = ""; for await (const chunk of request) { body += chunk; if (body.length > 2_000_000) throw new Error("Request too large"); }
  const actual = JSON.parse(body); if (![baseline, alternate].includes(actual.model)) throw new Error("Unconfigured fixture model");
  if (request.headers.authorization !== `Bearer ${fixtureCredential}`) throw new Error("Wrong loopback credential");
  const receipt = { call: requests.length + 1, model: actual.model, messages: actual.messages, tools: actual.tools?.map(tool => tool.function.name) };
  requests.push(receipt); await appendFile(resolve(output, "provider-requests.jsonl"), JSON.stringify(receipt) + "\n");
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const frame = (delta, finish_reason = null, usage) => response.write("data: " + JSON.stringify({ id: `model-proof-${receipt.call}`, object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) }) + "\n\n");
  for (const text of ["# Actual selected model\n\n", `**${actual.model}** completed the actual Harness turn.\n`]) {
    if (response.destroyed) return; frame({ content: text }); await new Promise(done => setTimeout(done, 150));
  }
  if (!response.destroyed) { frame({}, "stop", { prompt_tokens: 32, completion_tokens: 20, total_tokens: 52 }); response.end("data: [DONE]\n\n"); }
})().catch(error => { trace.push({ kind: "provider-error", message: error.message }); if (!response.headersSent) response.writeHead(500); response.end(); }); });
provider.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
await new Promise(done => provider.listen(0, "127.0.0.1", done));
const providerOrigin = `http://127.0.0.1:${provider.address().port}/v1`;
async function launch() {
  const builtFiles = ["apps/web/dist/main.js", "apps/web/dist/deepseek/catalog.js", "apps/web/dist/deepseek/composition.js", "apps/web/dist/deepseek/owners.js", "apps/web/dist/deepseek/session.js"];
  launches.push({ at: new Date().toISOString(), artifacts: Object.fromEntries(await Promise.all(builtFiles.map(async file => [file,
    createHash("sha256").update(await readFile(resolve(source, file))).digest("hex")]))) });
  child = spawn(process.execPath, [resolve(source, "apps/web/dist/main.js")], { cwd: project,
    env: { ...process.env, OPENAI_API_KEY: fixtureCredential, OPENAI_BASE_URL: providerOrigin, OPENAI_MODEL: baseline,
      HARNESS_DATA_DIR: dataDir, HARNESS_WEB_PORT: String(port ?? 0), HARNESS_VERIFY_COMMAND: "" }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child); let accumulated = "";
  const ready = new Promise((done, reject) => {
    child.stdout.on("data", chunk => {
      const line = chunk.toString(); accumulated += line; void appendFile(resolve(output, "host-stdout.log"), line);
      const address = accumulated.match(/http:\/\/127\.0\.0\.1:(\d+)/u);
      if (address) { port = Number(address[1]); origin = `http://127.0.0.1:${port}`; done(); }
    });
    child.stderr.on("data", chunk => { void appendFile(resolve(output, "host-stderr.log"), chunk); });
    child.once("error", reject); child.once("exit", code => reject(new Error(`Production host exited before readiness (${code})`)));
  });
  await deadline(ready);
}
async function stopHost() {
  if (!child || child.exitCode !== null) return;
  const stopped = new Promise(done => child.once("exit", (code, signal) => { trace.push({ kind: "host-exit", code, signal }); done(); }));
  child.kill("SIGTERM"); await deadline(stopped);
}
async function rpc(endpoint, args) {
  const response = await fetch(origin + "/api/deepseek/call", { method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", origin }, body: JSON.stringify({ endpoint, args, requestId: randomUUID() }) });
  const result = await response.json(); trace.push({ kind: "verification-http", endpoint, status: response.status, result: safe(result) });
  if (!result.ok) throw Object.assign(new Error(`${result.error.code}: ${result.error.message}`), { code: result.error.code });
  return result.value;
}
async function follow(sessionId) {
  const abort = new AbortController(), frames = [];
  const response = await fetch(origin + "/api/deepseek/open", { method: "POST", signal: abort.signal,
    headers: { "content-type": "application/json", origin }, body: JSON.stringify({ endpoint: "session/follow",
      args: { request: { address: { kind: "session", sessionId }, assistantStream: true } }, streamId: randomUUID() }) });
  assert.equal(response.status, 200); const reader = response.body.getReader();
  const reading = (async () => { let buffered = ""; try { while (true) {
    const item = await reader.read(); if (item.done) break; buffered += new TextDecoder().decode(item.value);
    const lines = buffered.split("\n"); buffered = lines.pop();
    for (const line of lines) if (line.trim()) { const frame = JSON.parse(line); frames.push(frame); trace.push({ kind: "verification-follow", frame: safe(frame) }); }
  } } catch (error) { if (!abort.signal.aborted) throw error; } })();
  await until(() => frames.some(frame => frame.type === "snapshot"), "Follow did not produce its baseline");
  return { frames, close: async () => { abort.abort(); await reading; } };
}
function observe(page, name) {
  page.on("pageerror", error => trace.push({ kind: "pageerror", page: name, message: String(error) }));
  page.on("console", message => { if (message.type() === "error") trace.push({ kind: "console-error", page: name, message: message.text() }); });
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/deepseek")) {
    let payload; try { payload = request.postDataJSON(); } catch {}
    trace.push({ kind: "browser-http", page: name, path: new URL(request.url()).pathname, payload: safe(payload) });
  } });
  page.on("websocket", socket => {
    trace.push({ kind: "browser-websocket", page: name, url: socket.url() });
    for (const [event, direction] of [["framesent", "sent"], ["framereceived", "received"]]) socket.on(event, ({ payload }) => {
      try { trace.push({ kind: "browser-ws-frame", page: name, direction, payload: safe(JSON.parse(String(payload))) }); }
      catch { trace.push({ kind: "browser-ws-frame", page: name, direction, payload: "[non-JSON frame]" }); }
    });
  });
}
async function boot(page) {
  page.setDefaultTimeout(10_000);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  const preview = page.getByRole("button", { name: "Continue", exact: true });
  await page.locator('[contenteditable="true"]').waitFor({ state: "visible", timeout: 10_000 });
  // The official welcome scope resolves after the composer mounts. A mounted
  // editor is not proof that onboarding has finished or its overlay is absent.
  if (!welcomed) {
    await preview.waitFor({ state: "visible", timeout: 10_000 }); await preview.click();
    await preview.waitFor({ state: "hidden", timeout: 10_000 }); welcomed = true;
  }
}
async function select(page, model) {
  await page.getByRole("button", { name: /^Select model/ }).click();
  const drill = page.getByRole("menuitem", { name: /^Model/ }); if (await drill.isVisible()) await drill.click();
  await page.getByRole("menuitemradio", { name: model, exact: true }).click();
}
async function chooseSession(page, sessionId) {
  // The upstream deliberately displays blank drafts as New Session, even
  // after a title is saved. Its own durable row identity is the correct
  // selector both before the first prompt and after process restoration.
  await page.locator(`[data-row-key="session:${sessionId}"]`).click();
  await page.locator('[contenteditable="true"]').waitFor();
}
async function capture(page, name) {
  await writeFile(resolve(output, `${name}-text.txt`), safe(await page.locator("body").innerText()));
  try {
    await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true, animations: "disabled", timeout: 8_000 });
    screenshots.push({ name, status: "PASS" });
  } catch (error) {
    // Image capture is an artifact observation, not a prerequisite for a real
    // model request. Keep this failure explicit and continue the controls.
    screenshots.push({ name, status: "BLOCKED", message: String(error) });
    trace.push({ kind: "screenshot-blocked", name, message: String(error) });
  }
}
let stream;
try {
  await launch();
  if (values["playwright-module"]) playwrightVersion = JSON.parse(await readFile(resolve(dirname(resolve(values["playwright-module"])), "package.json"), "utf8")).version;
  const playwright = await import(values["playwright-module"] ? pathToFileURL(resolve(values["playwright-module"])).href : "playwright");
  browser = await playwright.chromium.launch({ executablePath: values.chromium, headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage(); observe(page, "primary"); await boot(page);
  prove("official browser booted with production carrier", await page.evaluate(() => typeof globalThis.__DSH_TRANSPORT__?.rpc?.call === "function" && globalThis.__DSH_MOCK_PROOF__ !== true));
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.getByRole("button", { name: "Increase font size", exact: true }).click();
  await page.getByText("Work details", { exact: true }).locator("..").locator("..").getByRole("button").click();
  await page.getByRole("menuitem", { name: "Verbose", exact: true }).click();
  await page.getByText("Performance & usage", { exact: true }).locator("..").locator("..").getByRole("button").click();
  await page.getByRole("menuitem", { name: "Compact", exact: true }).click();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page.getByRole("button", { name: "Add model provider", exact: true }).click();
  await page.getByRole("textbox", { name: "Provider ID", exact: true }).fill(route);
  await page.getByRole("textbox", { name: "Display name", exact: true }).fill("Actual browser alternate route");
  await page.getByRole("textbox", { name: "Base URL", exact: true }).fill(providerOrigin);
  await page.getByLabel("API key", { exact: true }).fill(fixtureCredential);
  await page.getByRole("button", { name: "Add model", exact: true }).click();
  await page.getByRole("textbox", { name: "Model ID 1", exact: true }).fill(alternate);
  await page.getByRole("button", { name: "Create provider", exact: true }).click();
  await page.getByRole("textbox", { name: "Provider ID", exact: true }).waitFor({ state: "hidden", timeout: 10_000 });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const configured = await rpc("settings/describe", {}), profiles = configured.namespaces.find(row => row.ns === "llm-pi-ai");
  prove("official Models form persisted a real adapter profile", profiles.value.providers[route]?.models?.[0]?.id === alternate);
  prove("official key form stored only a credential reference in profile", profiles.value.providers[route].apiKeyEnv && !JSON.stringify(profiles).includes(fixtureCredential));
  prove("official theme and font controls persisted to host settings", configured.namespaces.some(row => row.ns === "ui-theme" && row.value.preference === "dark" && row.value.fontSize === 15));
  prove("official Work details and Performance controls persisted to ui-chat", configured.namespaces.some(row => row.ns === "ui-chat" && row.value.transcriptView === "verbose" && row.value.performanceUsage === "compact"));
  const listed = await rpc("session/list", { _request: {} });
  const session = listed.items.filter(item => item.agentAvailable && item.blank).sort((a, b) => b.createdAt - a.createdAt)[0];
  assert.ok(session, "Actual official composer did not create a blank session");
  const id = session.sessionId, title = "Model selection acceptance draft";
  await chooseSession(page, id);
  stream = await follow(id);
  const firstSnapshot = stream.frames.find(frame => frame.type === "snapshot");
  const prefix = await rpc("session/page", { request: { address: { kind: "session", sessionId: id }, throughSeq: firstSnapshot.cursor } });
  const second = await context.newPage(); observe(second, "second-tab"); await boot(second); await chooseSession(second, id);
  await select(page, alternate);
  await page.getByRole("button", { name: `Select model, current ${alternate}`, exact: true }).waitFor({ timeout: 10_000 });
  await second.getByRole("button", { name: `Select model, current ${alternate}`, exact: true }).waitFor({ timeout: 10_000 });
  prove("official composer and second tab show committed selected model", true);
  const selection = await rpc("session/projections", { request: { sessionId: id } });
  prove("authoritative projection.next matches selected route/model", selection.values.modelSelection.next.provider === route && selection.values.modelSelection.next.model === alternate);
  await until(() => stream.frames.some(frame => frame.type === "event" && frame.event?.type === "model/selection"
    && frame.event.data?.provider === route && frame.event.data?.model === alternate && frame.event.seq > firstSnapshot.cursor),
    "Selection did not append its durable model/selection event to the existing follow stream");
  prove("existing follow stream received the durable newer model/selection event", true);
  const prefixAfter = await rpc("session/page", { request: { address: { kind: "session", sessionId: id }, throughSeq: firstSnapshot.cursor } });
  prove("model switch retained every previously committed history record", JSON.stringify(prefixAfter) === JSON.stringify(prefix));
  await page.locator('[contenteditable="true"]').fill("Verify the actual selected alternate model through a production turn.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await until(() => requests.some(request => request.model === alternate), "Selected alternate did not reach real provider HTTP");
  await page.getByRole("heading", { name: "Actual selected model", exact: true }).waitFor({ timeout: 15_000 });
  await until(async () => {
    const summary = (await rpc("session/list", { _request: {} })).items.find(item => item.sessionId === id);
    return summary?.running === false && summary.projections.values.modelSelection.lastUsed?.model === alternate
      && summary.projections.values.turnBoundary.openTurnStartSeq === null;
  }, "The actual durable Harness turn did not settle");
  prove("real production HTTP turn used selected alternate model", requests.length === 1 && requests[0].model === alternate);
  await capture(page, "selected-model-two-tabs");
  await rpc("session/rename", { request: { sessionId: id, title } });
  const ownersBefore = await readFile(resolve(dataDir, "deepseek", "owners-index.json"), "utf8");
  const startedProjection = await rpc("session/projections", { request: { sessionId: id } });
  await select(page, baseline);
  await page.getByText(/frozen|started|first prompt|blank session|create a fresh/i).last().waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: `Select model, current ${alternate}`, exact: true }).waitFor();
  const afterRefusal = await rpc("session/projections", { request: { sessionId: id } });
  prove("started-session selection visibly rejects and preserves native owner", (await readFile(resolve(dataDir, "deepseek", "owners-index.json"), "utf8")) === ownersBefore && JSON.stringify(afterRefusal) === JSON.stringify(startedProjection));
  await capture(page, "started-selection-refused");
  await stream.close(); stream = undefined; await stopHost(); await launch();
  await boot(page); await chooseSession(page, id);
  await page.getByRole("button", { name: `Select model, current ${alternate}`, exact: true }).waitFor({ timeout: 10_000 });
  const restored = await rpc("session/projections", { request: { sessionId: id } });
  prove("real process restart rehydrates stable session and model selection", restored.values.modelSelection.next.provider === route && restored.values.modelSelection.next.model === alternate);
  const restoredSettings = await rpc("settings/describe", {});
  prove("real process restart retains actual official chat preference writes", restoredSettings.namespaces.some(row => row.ns === "ui-chat" && row.value.transcriptView === "verbose" && row.value.performanceUsage === "compact"));
  prove("restart retained previously committed history prefix", JSON.stringify(await rpc("session/page", { request: { address: { kind: "session", sessionId: id }, throughSeq: firstSnapshot.cursor } })) === JSON.stringify(prefix));
  await capture(page, "restart-selection");
  prove("both process launches used identical captured production artifact fingerprints", JSON.stringify(launches[0].artifacts) === JSON.stringify(launches[1].artifacts));
  prove("browser has no uncaught errors", !trace.some(row => row.kind === "pageerror"), trace.filter(row => row.kind === "pageerror"));
  prove("paid model calls remained zero", true, { paidModelCalls: 0, loopbackRequests: requests.length });
} catch (error) {
  trace.push({ kind: "acceptance-error", message: String(error), stack: error.stack });
  assertions.push({ name: "production browser model selection acceptance", status: "FAIL", details: String(error) }); process.exitCode = 1;
  for (const context of browser?.contexts() ?? []) for (const [index, page] of context.pages().entries()) {
    await page.screenshot({ path: resolve(output, `failure-${index}.png`), fullPage: true }).catch(() => {});
    await writeFile(resolve(output, `failure-${index}-text.txt`), await page.locator("body").innerText().catch(() => "[page unavailable]"));
  }
} finally {
  await stream?.close().catch(error => trace.push({ kind: "follow-cleanup-error", message: String(error) }));
  await browser?.close(); await stopHost().catch(error => { child?.kill("SIGKILL"); trace.push({ kind: "host-cleanup-error", message: String(error) }); process.exitCode = 1; });
  provider.close(); for (const socket of sockets) socket.destroy();
  const sourceFiles = ["apps/web/src/deepseek/catalog.ts", "apps/web/src/deepseek/composition.ts", "apps/web/src/deepseek/owners.ts", "apps/web/src/deepseek/session.ts", "apps/web/src/deepseek/projections.ts", "apps/web/src/main.ts"];
  const fingerprints = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash("sha256").update(await readFile(resolve(source, file))).digest("hex")])));
  await writeFile(resolve(output, "trace.json"), JSON.stringify(safe(trace), null, 2) + "\n");
  const result = { status: process.exitCode ? "FAIL" : "PASS", scope: "unmodified official UI, real production Web main, local HTTP fixture; not paid model quality", origin, providerOrigin,
    runnerSha256, node: process.version, playwrightVersion, paidModelCalls: 0, loopbackRequests: requests.length, launches, fingerprints, screenshots, assertions };
  await writeFile(resolve(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ output, status: result.status, assertions: assertions.length, failures: assertions.filter(row => row.status === "FAIL") }, null, 2));
}
