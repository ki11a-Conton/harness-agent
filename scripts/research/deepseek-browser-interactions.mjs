#!/usr/bin/env node
/**
 * Bounded acceptance through the unmodified official UI and production HTTP.
 * No RPC mock, response interception, injected model output, or CDN is used.
 * Model scenarios require evidence from deepseek-live-host.mjs so they cannot
 * silently exercise a paid endpoint. A PASS covers the named assertion only;
 * BLOCKED and SKIPPED are retained and never counted as full UI parity.
 */
import assert from "node:assert/strict";
import { observeProductionRpc } from "./deepseek-browser-observe.mjs";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
const { values } = parseArgs({ options: {
  url: { type: "string" }, output: { type: "string" },
  "playwright-module": { type: "string" }, chromium: { type: "string", default: "/usr/bin/chromium" },
  "fixture-evidence": { type: "string" }, models: { type: "boolean", default: false },
  cases: { type: "string" }, viewports: { type: "string", default: "desktop" },
} });
if (!values.url || !values.output) throw new Error("Use --url <production HTTP origin> --output <new evidence directory>");
const origin = new URL(values.url).origin, output = path.resolve(values.output);
const viewportCatalog = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 },
  "narrow-tall": { width: 320, height: 1100 } };
const viewportNames = values.viewports.split(",");
for (const name of viewportNames) assert(viewportCatalog[name], "Unknown viewport: " + name);
let fixture;
if (values.models) {
  assert(values["fixture-evidence"], "Model scenarios require --fixture-evidence from deepseek-live-host.mjs");
  fixture = JSON.parse(await readFile(path.join(path.resolve(values["fixture-evidence"]), "launch.json"), "utf8"));
  assert.equal(fixture.paidModelCalls, 0); assert.equal(fixture.model, "web-loopback-fixture");
  assert.equal(new URL(fixture.providerOrigin).hostname, "127.0.0.1");
  assert.equal(new URL(origin).hostname, "127.0.0.1");
}
const playwright = await import(values["playwright-module"] ? pathToFileURL(path.resolve(values["playwright-module"])).href : "playwright");
const browser = await playwright.chromium.launch({ headless: true, executablePath: values.chromium, args: ["--no-sandbox"] });
let playwrightVersion;
if (values["playwright-module"]) {
  playwrightVersion = JSON.parse(await readFile(path.join(path.dirname(path.resolve(values["playwright-module"])), "package.json"), "utf8")).version;
}
const engine = { node: process.version, chromium: browser.version(), executable: values.chromium, playwright: playwrightVersion,
  viewportScope: "responsive desktop/mobile/narrow-tall viewport sizes; not a physical mobile device or Windows execution claim" };
await mkdir(output, { recursive: true });
const results = [];
const chosen = values.cases ? new Set(values.cases.split(",")) : undefined;
class Blocked extends Error {}
async function modelRequests() {
  try { return (await readFile(path.join(path.resolve(values["fixture-evidence"]), "requests.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
async function fixtureJournal(sessionId) {
  assert(/^session_[\w-]+$/.test(sessionId), "Unexpected native session identity");
  const data = path.resolve(fixture.cwd, "../data");
  const index = JSON.parse(await readFile(path.join(data, "deepseek/owners-index.json"), "utf8"));
  const nativeId = index.aliases?.find(alias => alias.externalId === sessionId)?.nativeId ?? sessionId;
  assert(/^session_[\w-]+$/.test(nativeId), "Unexpected physical session identity");
  const roots = [data, ...index.owners.map(owner => {
    assert(/^[a-f0-9]{64}$/.test(owner.id), "Unexpected durable owner identity");
    return path.join(data, "deepseek/owners", owner.id);
  })];
  for (const root of roots) {
    try { return (await readFile(path.join(root, nativeId + ".jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line).event); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  throw new Error("Actual native session journal was not found");
}
function requestEndpoint(request) { try { return request.postDataJSON()?.endpoint; } catch { return undefined; } }
async function boot(page) {
  await page.goto(values.url, { waitUntil: "domcontentloaded" });
  await page.locator("[data-composer-input=true]").waitFor({ state: "visible", timeout: 7000 });
  assert.equal(await page.getByRole('heading', { name: /^(Preview Notice|预览版说明)$/ }).count(), 0, 'startup needs no preview acknowledgement');
  if (await page.locator("[data-composer-input=true]").getAttribute("contenteditable") !== "true") {
    await page.getByRole("button", { name: "Choose workspace", exact: true }).click();
    await page.getByRole("menuitem", { name: "project", exact: true }).click();
  }
  await page.locator('[data-composer-input=true][contenteditable=true]').waitFor({ state: "visible", timeout: 7000 });
}
async function check(checks, label, operation) { await operation(); checks.push({ label, status: "PASS" }); }
async function clickVisible(page, label) {
  const button = page.getByRole("button", { name: label, exact: true }).filter({ visible: true });
  await button.first().click();
}
async function surface(page) {
  return page.evaluate(() => ({ text: document.body.innerText,
    controls: [...document.querySelectorAll("button,input,textarea,[contenteditable=true]")].filter(item => item.getClientRects().length > 0)
      .map(item => ({ tag: item.tagName, text: item.textContent?.trim(), label: item.getAttribute("aria-label"),
        placeholder: item.getAttribute("placeholder"), disabled: item.disabled === true })),
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth }));
}
const rpcByPage = new WeakMap();
async function prompt(page, text, checks) {
  const input = page.locator("[data-composer-input=true]").filter({ visible: true });
  await input.fill(text);
  const responsePromise = rpcByPage.get(page).waitForResult("session/prompt");
  await clickVisible(page, "Send message");
  const waited = await responsePromise; if (waited.error) throw waited.error;
  assert.equal(waited.result.status, 200); assert.equal(waited.result.ok, true, JSON.stringify(waited.result.error));
  checks.push({ label: "UI prompt reached production admission and returned success", status: "PASS" });
}
async function answerFinished(page) {
  await page.getByRole("heading", { name: "Actual Harness browser answer", exact: true }).last().waitFor({ state: "visible", timeout: 15000 });
  // The heading is the first streamed chunk, so it cannot prove completion.
  // This fixture's code block arrives in the final content chunk.
  await page.locator("pre code").filter({ hasText: "export const value = 1;" }).last().waitFor({ state: "visible", timeout: 15000 });
  await page.getByRole("button", { name: "Stop generating", exact: true }).waitFor({ state: "hidden", timeout: 15000 });
}
const cases = {
  "settings-general": async (page, checks) => {
    await clickVisible(page, "Settings"); await clickVisible(page, "General");
    await check(checks, "official General settings are usable", async () => {
      assert(await page.getByRole("button", { name: "Edit shortcuts", exact: true }).isVisible());
      const darkSave = rpcByPage.get(page).waitForResult("settings/mutate");
      await clickVisible(page, "Dark");
      const darkResult = await darkSave; if (darkResult.error) throw darkResult.error;
      assert.equal(darkResult.result.ok, true);
      assert.equal(await page.evaluate(() => document.documentElement.style.colorScheme), "dark");
      const lightSave = rpcByPage.get(page).waitForResult("settings/mutate");
      await clickVisible(page, "Light");
      const lightResult = await lightSave; if (lightResult.error) throw lightResult.error;
      assert.equal(lightResult.result.ok, true);
      assert.equal(await page.evaluate(() => document.documentElement.style.colorScheme), "light");
    });
    await clickVisible(page, "Close"); await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("[data-composer-input=true]").waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => document.documentElement.style.colorScheme), "light");
    checks.push({ label: "appearance persisted across actual page reload", status: "PASS" });
  },
  "models-editor": async (page, checks) => {
    await clickVisible(page, "Settings"); await clickVisible(page, "Models");
    await page.getByRole("button", { name: "Edit OpenAI compatible (openai)", exact: true }).click();
    await page.locator("summary").filter({ hasText: "Customized settings" }).click();
    await page.getByRole("textbox", { name: "Base URL", exact: true }).waitFor({ state: "visible" });
    await check(checks, "model editor renders actual launch route without exposing launch credential", async () => {
      assert(await page.getByRole("textbox", { name: "API key", exact: true }).isDisabled());
      assert.equal(await page.getByRole("textbox", { name: "API key", exact: true }).inputValue(), "");
      assert(await page.getByRole("textbox", { name: "Base URL", exact: true }).isVisible());
      assert.equal(await page.getByRole("textbox", { name: "Model ID 1", exact: true }).inputValue(), "web-loopback-fixture");
      assert(await page.getByRole("button", { name: "Fetch available models", exact: true }).isVisible());
    });
    await clickVisible(page, "Cancel");
  },
  "plugin-management": async (page, checks) => {
    await clickVisible(page, "Plugins");
    const add = page.getByRole("button", { name: "Add plugin", exact: true }); await add.waitFor({ state: "visible" });
    if (await add.isDisabled()) throw new Blocked("Actual plugin inventory is readable, but this host exposes no manageable Cordis/plugin profile; install/enable/configure parity is unfinished.");
    checks.push({ label: "plugin manager admits installation controls", status: "PASS" });
  },
  "automation-list": async (page, checks) => {
    await clickVisible(page, "Automation tasks");
    await page.locator('input[aria-label="Search tasks"]').waitFor({ state: "visible" });
    await clickVisible(page, "Enabled"); await clickVisible(page, "Inactive"); await clickVisible(page, "All");
    checks.push({ label: "actual schedule catalog and filters rendered", status: "PASS" });
  },
  "workspace-directory-picker": async (page, checks) => {
    await clickVisible(page, "Add workspace");
    await page.getByRole("button", { name: "Edit path", exact: true }).waitFor({ state: "visible" });
    assert(await page.getByRole("button", { name: "Show hidden files", exact: true }).isVisible());
    await clickVisible(page, "Cancel"); checks.push({ label: "real directory chooser opened and cancelled", status: "PASS" });
  },
  "workspace-files": async (page, checks) => {
    await clickVisible(page, "Open right sidebar");
    await page.getByRole("button", { name: /Workspace files/ }).click();
    await page.getByText("demo.js", { exact: true }).waitFor({ state: "visible", timeout: 8000 });
    checks.push({ label: "actual session workspace tree returned demo.js", status: "PASS" });
    await page.getByText("demo.js", { exact: true }).click();
    await page.getByText("export const value = 1;", { exact: false }).waitFor({ state: "visible", timeout: 8000 });
    checks.push({ label: "actual UTF-8 file preview rendered original project contents", status: "PASS" });
  },
  "terminal-rejection": async (page, checks) => {
    await clickVisible(page, "Open right sidebar");
    const outcome = rpcByPage.get(page).waitForResult("terminal/shells", 8000);
    await clickVisible(page, "New terminal Run commands in the Session workspace");
    const allow = page.getByRole("button", { name: "Allow once", exact: true });
    await allow.waitFor({ state: "visible", timeout: 6000 });
    await clickVisible(page, "Reject");
    const rejected = await outcome; if (rejected.error) throw rejected.error;
    assert.equal(rejected.result.ok, false); assert.equal(rejected.result.error?.code, "gateway/forbidden");
    rejected.result.expected = true;
    checks.push({ label: "actual shell discovery traversed approval UI; rejection issued", status: "PASS" });
  },
  "terminal": async (page, checks) => {
    await clickVisible(page, "Open right sidebar");
    const outcome = rpcByPage.get(page).waitForResult("terminal/create", 12000);
    let settled; outcome.then(value => { settled = value; });
    await clickVisible(page, "New terminal Run commands in the Session workspace");
    const deadline = Date.now() + 12000;
    while (!settled && Date.now() < deadline) {
      const allow = page.getByRole("button", { name: "Allow once", exact: true });
      if (await allow.isVisible()) { await allow.click(); checks.push({ label: "real terminal process step received human approval", status: "PASS" }); }
      await page.waitForTimeout(200);
    }
    const created = settled ?? await outcome; if (created.error) throw created.error;
    if (!created.result.ok && created.result.error?.code === "terminal/unavailable") {
      created.result.expected = true;
      throw new Blocked("Actual terminal owner refused PTY execution: " + created.result.error.message);
    }
    assert.equal(created.result.ok, true, JSON.stringify(created.result.error));
    checks.push({ label: "actual confined PTY owner created a terminal", status: "PASS" });
    throw new Blocked("PTY created; input/resize/exit still need an independently bounded continuation scenario.");
  },
  "session-lifecycle": async (page, checks) => {
    await prompt(page, "Render the fixture before testing actual session lifecycle.", checks); await answerFinished(page);
    const reopen = page.getByRole("button", { name: "Open sidebar", exact: true });
    if (await reopen.isVisible()) await reopen.click();
    const selected = page.locator('[data-row-key^="session:"][aria-selected="true"]');
    const oldKey = await selected.getAttribute("data-row-key"); assert(oldKey);
    await selected.hover(); await selected.getByRole("button", { name: /^Session actions for / }).click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    const title = "Browser lifecycle " + Date.now();
    await page.getByRole("textbox", { name: "Session name", exact: true }).fill(title);
    const rename = rpcByPage.get(page).waitForResult("session/rename", 8000);
    await clickVisible(page, "Rename"); const renamedResponse = await rename; if (renamedResponse.error) throw renamedResponse.error; assert.equal(renamedResponse.result.ok, true);
    await selected.getByText(title, { exact: true }).waitFor({ state: "visible" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("[data-composer-input=true]").waitFor({ state: "attached", timeout: 8000 });
    const reopenAfterReload = page.getByRole("button", { name: "Open sidebar", exact: true });
    if (await reopenAfterReload.isVisible()) await reopenAfterReload.click();
    await page.getByRole("treeitem").filter({ hasText: title }).waitFor({ state: "visible", timeout: 8000 });
    checks.push({ label: "real session rename persisted across page reload", status: "PASS" });
    const renamed = page.locator('[data-row-key="' + oldKey + '"]');
    await renamed.hover(); await renamed.getByRole("button", { name: /^Session actions for / }).click();
    const fork = rpcByPage.get(page).waitForResult("session/fork", 8000);
    await page.getByRole("menuitem", { name: "Fork session", exact: true }).click();
    const forkResponse = await fork; if (forkResponse.error) throw forkResponse.error;
    assert.equal(forkResponse.result.ok, true);
    // Upstream sidebar fork adds the child, but deliberately keeps the parent
    // open. Open the real new row instead of asserting invented navigation.
    const child = page.getByRole("treeitem").filter({ hasText: title + " (1)" });
    await child.waitFor({ state: "visible", timeout: 8000 }); await child.click();
    await page.waitForFunction(key => document.querySelector('[data-row-key^="session:"][aria-selected="true"]')?.getAttribute("data-row-key") !== key, oldKey, { timeout: 8000 });
    const forked = page.locator('[data-row-key^="session:"][aria-selected="true"]');
    const forkKey = await forked.getAttribute("data-row-key"); assert(forkKey && forkKey !== oldKey);
    if (page.viewportSize().width < 700) {
      const collapse = page.getByRole("button", { name: "Collapse sidebar", exact: true });
      if (await collapse.isVisible()) await collapse.click();
    }
    await page.getByRole("heading", { name: "Actual Harness browser answer", exact: true }).waitFor({ state: "visible", timeout: 8000 });
    checks.push({ label: "actual fork owns a distinct session and retained conversation", status: "PASS" });
    const reopenAfterChild = page.getByRole("button", { name: "Open sidebar", exact: true });
    if (await reopenAfterChild.isVisible()) await reopenAfterChild.click();
    await forked.hover(); await forked.getByRole("button", { name: /^Session actions for / }).click();
    await page.getByRole("menuitem", { name: "Archive session", exact: true }).click();
    await page.locator('[data-row-key="' + forkKey + '"]').waitFor({ state: "hidden", timeout: 8000 });
    await clickVisible(page, "undo");
    await page.locator('[data-row-key="' + forkKey + '"]').waitFor({ state: "visible", timeout: 8000 });
    checks.push({ label: "actual fork archive and undo restored the same session", status: "PASS" });
  },
  "markdown-stream-reload": async (page, checks) => {
    const before = (await modelRequests()).length;
    await page.evaluate(() => {
      globalThis.__HARNESS_BROWSER_OBSERVATION__ = [];
      let prior = "";
      const observer = new MutationObserver(() => {
        const heading = [...document.querySelectorAll("h1")].find(node => node.textContent.startsWith("Actual Harness browser"));
        if (!heading) return;
        // Observe the actual Markdown block, excluding status pills, clocks,
        // sidebars and composer text whose updates could mimic streaming.
        const answer = heading.parentElement.innerText;
        if (answer === prior) return; prior = answer;
        globalThis.__HARNESS_BROWSER_OBSERVATION__.push({ time: performance.now(), length: answer.length, text: answer,
          streaming: heading.closest('[data-streaming="true"]') !== null });
      });
      observer.observe(document.querySelector("#root"), { childList: true, subtree: true, characterData: true });
      globalThis.__HARNESS_BROWSER_OBSERVER__ = observer;
    });
    await prompt(page, "Render the real Markdown fixture for browser acceptance.", checks); await answerFinished(page);
    await check(checks, "official Markdown rendered heading, strong, list, table, link and code", async () => {
      assert(await page.locator("strong").filter({ hasText: "Bold result" }).last().isVisible());
      assert(await page.locator("table").filter({ hasText: "demo.js" }).last().isVisible());
      assert(await page.locator("pre code").filter({ hasText: "export const value = 1;" }).last().isVisible());
      assert(await page.locator('a[href="https://example.invalid/docs"]').last().isVisible());
      assert(await page.locator("li").filter({ hasText: "First item" }).last().isVisible());
    });
    const stream = await page.evaluate(() => { globalThis.__HARNESS_BROWSER_OBSERVER__.disconnect(); return globalThis.__HARNESS_BROWSER_OBSERVATION__; });
    assert(new Set(stream.map(item => item.length)).size >= 2, "Actual assistant text must visibly grow across provider chunks");
    assert(stream.some(item => item.streaming && item.length < stream.at(-1).length), "No actual partial assistant block was observed while streaming");
    checks.push({ label: "real streamed assistant text visibly changed before completion", status: "PASS", samples: stream });
    assert((await modelRequests()).length > before, "No actual loopback model HTTP request was recorded");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Actual Harness browser answer", exact: true }).waitFor({ state: "visible", timeout: 8000 });
    checks.push({ label: "durable conversation survived actual reload", status: "PASS" });
  },
  "read-tool": async (page, checks) => {
    const before = (await modelRequests()).length;
    await prompt(page, "[fixture:read] Read the actual demo.js in this workspace.", checks); await answerFinished(page);
    assert(await page.getByText("The actual tool result was received.", { exact: false }).isVisible());
    const calls = (await modelRequests()).slice(before);
    assert(calls.some(call => call.messages.some(message => message.role === "tool" && String(message.content).includes("export const value = 1;"))), "Model did not receive actual read_file output");
    checks.push({ label: "real read_file executed and actual file contents reached the model", status: "PASS" });
    await page.getByRole("button", { name: /^Completed in / }).last().click();
    const calledTools = page.getByRole("button", { name: "Called tools", exact: true }).last();
    if (await calledTools.isVisible()) await calledTools.click();
    const buttons = await page.getByRole("button").all();
    let toggled = false;
    for (const button of buttons) {
      const name = (await button.getAttribute("aria-label")) ?? (await button.innerText());
      if (/Read file|read_file|demo\.js/i.test(name) && await button.isVisible()) { await button.click(); toggled = true; break; }
    }
    assert(toggled, "Official tool detail toggle was not found; a text-only tool result is insufficient");
    checks.push({ label: "official tool details control was clicked", status: "PASS" });
  },
  "write-approval": async (page, checks) => {
    const file = path.join(fixture.cwd, "browser-created.txt");
    const before = await readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    const beforeStat = await stat(file, { bigint: true }).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    await prompt(page, "[fixture:write] Write the actual browser-created.txt, waiting for my approval.", checks);
    await page.getByRole("button", { name: "Allow once", exact: true }).waitFor({ state: "visible", timeout: 8000 });
    assert.equal(await readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return undefined; throw error; }), before, "Write happened before browser approval");
    const pendingStat = await stat(file, { bigint: true }).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    assert.equal(pendingStat?.mtimeNs, beforeStat?.mtimeNs, "Write changed the file before approval");
    checks.push({ label: "actual write stayed blocked before human approval", status: "PASS" });
    await clickVisible(page, "Allow once"); await answerFinished(page);
    assert.equal(await readFile(file, "utf8"), "Actual approved browser coding output\n");
    assert((await stat(file, { bigint: true })).mtimeNs !== beforeStat?.mtimeNs, "Approved tool did not actually write the file");
    checks.push({ label: "actual approval resumed tool and persisted the requested coding file", status: "PASS" });
  },
  "write-rejection": async (page, checks) => {
    const file = path.join(fixture.cwd, "browser-rejected.txt");
    const before = await readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    assert.equal(before, undefined, "Rejection scenario requires a fresh absent target file");
    const beforeCalls = (await modelRequests()).length;
    await prompt(page, "[fixture:write-deny] Attempt browser-rejected.txt and wait for my approval.", checks);
    await page.getByRole("button", { name: "Allow once", exact: true }).waitFor({ state: "visible", timeout: 8000 });
    assert.equal(await readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return undefined; throw error; }), undefined);
    await clickVisible(page, "Reject"); await answerFinished(page);
    assert.equal(await readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return undefined; throw error; }), undefined,
      "Rejected write left a filesystem side effect");
    const requests = (await modelRequests()).slice(beforeCalls);
    assert(requests.some(request => request.messages.some(message => message.role === "tool" && /denied|reject|permission/i.test(String(message.content)))),
      "Actual rejected tool outcome did not reach the model");
    checks.push({ label: "actual browser rejection returned a denied tool outcome with no target file", status: "PASS" });
  },
  "ask-reload-answer": async (page, checks) => {
    await prompt(page, "[fixture:ask] Ask me which browser target, and wait for my answer.", checks);
    await page.getByRole("radio", { name: "target-blue", exact: true }).waitFor({ state: "visible", timeout: 8000 });
    // Narrow layouts unmount the collapsed navigation rows. The actual create
    // result owns this conversation identity regardless of sidebar visibility.
    const created = rpcByPage.get(page).results.filter(result => result.endpoint === "session/create" && result.ok === true).at(-1);
    const sessionId = created?.value?.sessionId;
    assert.equal(typeof sessionId, "string", "The actual create result has no conversation identity");
    const pendingJournal = await fixtureJournal(sessionId);
    const question = pendingJournal.find(event => event.type === "ask.user_asked");
    assert(question?.turnId && question.payload.askId, "No actual identity-bearing pending question exists");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("radio", { name: "target-blue", exact: true }).waitFor({ state: "visible", timeout: 8000 });
    checks.push({ label: "actual pending question survived reload", status: "PASS" });
    await page.getByRole("radio", { name: "target-blue", exact: true }).click();
    await clickVisible(page, "Submit"); await answerFinished(page);
    assert(await page.getByText("The browser answer was received.", { exact: false }).isVisible());
    // Streamed answer text can become visible before the final durable turn
    // event. Wait for the original task's real terminal boundary, so a slow
    // journal flush is not mistaken for a different or missing completion.
    let completedJournal;
    const terminalDeadline = Date.now() + 8000;
    do {
      completedJournal = await fixtureJournal(sessionId);
      if (completedJournal.some(event => event.turnId === question.turnId
        && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type))) break;
      await page.waitForTimeout(40);
    } while (Date.now() < terminalDeadline);
    const replies = completedJournal.filter(event => event.type === "ask.user_replied");
    assert.equal(replies.length, 1); assert.equal(replies[0].turnId, question.turnId);
    assert.equal(replies[0].payload.askId, question.payload.askId);
    assert.equal(completedJournal.filter(event => event.type === "turn.started").length, 1, "Answer started a different extra turn");
    const completion = completedJournal.find(event => event.type === "turn.completed");
    assert.equal(completion?.turnId, question.turnId);
    checks.push({ label: "official question answer durably resumed and completed the original actual turn exactly once", status: "PASS",
      sessionId, turnId: question.turnId, askId: question.payload.askId });
  },
};
try {
  for (const viewportName of viewportNames) {
    for (const [name, operation] of Object.entries(cases)) {
      if (chosen && !chosen.has(name)) continue;
      if (["session-lifecycle", "markdown-stream-reload", "read-tool", "write-approval", "write-rejection", "ask-reload-answer"].includes(name) && !values.models) {
        results.push({ name, viewport: viewportName, status: "SKIPPED", reason: "Model scenarios require explicit loopback fixture evidence." }); continue;
      }
      const context = await browser.newContext({ viewport: viewportCatalog[viewportName] });
      const page = await context.newPage(); page.setDefaultTimeout(4000);
      const rpc = observeProductionRpc(page, origin); rpcByPage.set(page, rpc);
      const calls = rpc.results, errors = [], externalRequests = rpc.externalRequests, checks = [], assets = [], failedHttp = [];
      page.on("response", response => {
        const url = new URL(response.url());
        if (url.origin !== origin) return;
        if (url.pathname.startsWith("/deepseek/")) assets.push({ path: url.pathname + url.search, status: response.status() });
        if (response.status() >= 400 && url.pathname !== "/api/deepseek/call")
          failedHttp.push({ path: url.pathname + url.search, status: response.status(), method: response.request().method() });
      });
      page.on("pageerror", error => errors.push({ type: "pageerror", message: String(error) }));
      page.on("console", message => { if (message.type() === "error") errors.push({ type: "console", message: message.text() }); });
      let status = "PASS", failure;
      try {
        await boot(page);
        if (["settings-general", "models-editor", "plugin-management", "automation-list", "workspace-directory-picker"].includes(name)) {
          const reopen = page.getByRole("button", { name: "Open sidebar", exact: true });
          if (await reopen.isVisible()) await reopen.click();
        }
        await operation(page, checks);
      }
      catch (error) { status = error instanceof Blocked ? "BLOCKED" : "FAIL"; failure = String(error); }
      await rpc.settled();
      if (errors.length || externalRequests.length || failedHttp.length || calls.some(call => call.ok === false && call.expected !== true)) { status = "FAIL"; failure ??= "Actual browser errors, RPC failures or external requests occurred."; }
      const observation = await surface(page);
      await page.screenshot({ path: path.join(output, `${viewportName}-${name}.png`), fullPage: true });
      const result = { name, viewport: viewportName, status, ...(failure ? { failure } : {}), checks, calls, rpcRequests: rpc.calls, sockets: rpc.sockets, errors, externalRequests, assets, failedHttp, observation };
      results.push(result); await writeFile(path.join(output, `${viewportName}-${name}.json`), JSON.stringify(result, null, 2) + "\n");
      await context.close();
    }
  }
} finally { await browser.close(); }
const report = { origin, scope: "named real production UI interactions; not an assertion that all 140 default controls are complete", models: values.models,
  engine, fixture: fixture ? { launchId: fixture.launchId, compiledDigest: fixture.compiledDigest, providerOrigin: fixture.providerOrigin } : undefined,
  paidModelCalls: fixture?.paidModelCalls, results, complete: results.every(result => result.status === "PASS") };
await writeFile(path.join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output, complete: report.complete, results: results.map(({ name, viewport, status, failure, checks }) => ({ name, viewport, status, failure, assertions: checks?.length ?? 0 })) }, null, 2));
if (results.some(result => ["FAIL", "BLOCKED"].includes(result.status))) process.exitCode = 1;
