#!/usr/bin/env node
/** Real browser boot observation; never installs mocks or intercepts HTTP responses. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { observeProductionRpc, canonicalPluginResource } from "./deepseek-browser-observe.mjs";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(`${name} requires a value`);
  return argv[index + 1];
};
const url = option("--url");
if (!url) throw new Error("Use --url <production Harness HTTP origin> --output <evidence directory>");
const origin = new URL(url).origin;
const workspace = option("--workspace");
const output = path.resolve(option("--output", "/tmp/deepseek-production-browser-smoke"));
const playwrightModule = option("--playwright-module");
const playwright = await import(playwrightModule ? pathToFileURL(path.resolve(playwrightModule)).href : "playwright");
const browser = await playwright.chromium.launch({ headless: true,
  executablePath: option("--chromium", "/usr/bin/chromium"), args: ["--no-sandbox"] });
await mkdir(output, { recursive: true });
const results = [];
try {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
    { name: "narrow-tall", width: 320, height: 1100 },
  ]) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
    const page = await context.newPage();
    const errors = [];
    const consoles = [];
    const rpc = observeProductionRpc(page, origin);
    const externalRequests = rpc.externalRequests;
    const assets = [];
    const calls = rpc.calls;
    const failedResponses = [];
    page.on("pageerror", error => errors.push(String(error)));
    page.on("console", message => { if (["error", "warning"].includes(message.type())) consoles.push({ type: message.type(), text: message.text() }); });
    page.on("response", response => {
      const requestUrl = new URL(response.url());
      if (requestUrl.pathname.startsWith("/deepseek/")) assets.push({ path: requestUrl.pathname + requestUrl.search, status: response.status() });
      if (response.status() >= 400) {
        let payload;
        try { payload = response.request().postDataJSON(); } catch {}
        failedResponses.push({ method: response.request().method(), path: requestUrl.pathname,
          status: response.status(), endpoint: payload?.endpoint });
      }
    });
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      const preview = page.getByRole("button", { name: "Continue", exact: true });
      await preview.waitFor({ state: "visible", timeout: 2000 }).catch(() => {});
      if (await preview.isVisible()) await preview.click();
      if (workspace !== undefined) {
        const choose = page.getByRole("button", { name: "Choose workspace", exact: true });
        if (await choose.isVisible()) {
          await choose.click();
          await page.getByRole("button", { name: workspace, exact: true }).first().click({ timeout: 4000 });
        }
      }
      await page.waitForFunction(() => document.querySelector("textarea,[contenteditable=true]") !== null ||
        /failed|failure/i.test(document.querySelector("#root")?.textContent ?? ""), undefined, { timeout: 8000 });
      await page.evaluate(() => document.fonts.ready);
    } catch (error) {
      errors.push("Boot observation failed: " + String(error));
    }
    const observation = await page.evaluate(() => ({
      title: document.title,
      text: document.body.innerText,
      mock: globalThis.__DSH_MOCK_PROOF__ === true,
      hasCarrier: typeof globalThis.__DSH_TRANSPORT__?.rpc?.call === "function" &&
        typeof globalThis.__DSH_TRANSPORT__?.rpc?.open === "function",
      ownsHost: globalThis.__DSH_TRANSPORT__?.ownsHost === true,
      loaderMode: globalThis.__ModuleLoader__?.mode,
      defaultEntries: globalThis.__DSH_BOOT__?.entries?.map(item => ({ id: item.id, url: item.url })),
      styles: [...new Set([...document.querySelectorAll("style[data-plugin]")].map(item => item.dataset.plugin))],
      controls: [...document.querySelectorAll("button,input,textarea,[contenteditable=true]")].map(item => ({
        tag: item.tagName.toLowerCase(), text: item.textContent?.trim(), label: item.getAttribute("aria-label"),
        title: item.getAttribute("title"), placeholder: item.getAttribute("placeholder"),
        disabled: item.disabled === true, visible: item.getClientRects().length > 0,
      })),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      fontStatus: document.fonts.status,
    }));
    const loaded = new Set(assets.filter(item => item.status === 200).map(item => canonicalPluginResource(item.path, origin)));
    const missingDefaultBundles = observation.defaultEntries?.filter(item => !loaded.has(canonicalPluginResource(item.url, origin))).map(item => item.id) ?? [];
    const failures = [];
    if (observation.mock) failures.push("mock carrier present");
    if (observation.ownsHost) failures.push("served frontend asserted ownsHost");
    if (!observation.hasCarrier) failures.push("production carrier missing");
    if (observation.defaultEntries?.length !== 66) failures.push("default roster differs from 66 reviewed entries");
    if (missingDefaultBundles.length) failures.push("default bundles did not load: " + missingDefaultBundles.join(", "));
    if (errors.length) failures.push("uncaught browser errors");
    if (consoles.some(item => item.type === "error")) failures.push("browser console errors");
    if (externalRequests.length) failures.push("external asset requests");
    if (assets.some(item => item.status >= 400)) failures.push("local asset requests failed");
    if (failedResponses.length) failures.push("production HTTP requests failed");
    if (observation.horizontalOverflow) failures.push("official layout overflows the viewport horizontally");
    if (!observation.controls.some(item => item.visible && ["textarea", "div"].includes(item.tag))) failures.push("official composer did not mount");
    if (!calls.some(item => item.route === "open" && item.endpoint === "$events")) failures.push("official connection event stream did not open");
    await rpc.settled();
    if (rpc.results.some(item => item.ok === false)) failures.push("production RPC returned a failure");
    await page.screenshot({ path: path.join(output, viewport.name + ".png"), fullPage: true });
    results.push({ viewport, status: failures.length ? "FAIL" : "PASS", scope: "real production boot observation only; full control parity requires separate endpoint evidence",
      failures, observation, missingDefaultBundles, errors, consoles, externalRequests, assets, calls, rpcResults: rpc.results, sockets: rpc.sockets, failedResponses });
    await context.close();
  }
} finally { await browser.close(); }
await writeFile(path.join(output, "result.json"), JSON.stringify({ origin, results }, null, 2) + "\n");
console.log(JSON.stringify({ output, results: results.map(item => ({ viewport: item.viewport.name, status: item.status,
  failures: item.failures, defaultBundles: item.observation.defaultEntries?.length, endpointCalls: item.calls.length,
  consoleWarningsOrErrors: item.consoles.length })) }, null, 2));
if (results.some(item => item.status !== "PASS")) process.exitCode = 1;
