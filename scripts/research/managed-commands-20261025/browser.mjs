// Actual native UI on a production Web host and loopback HTTP provider.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { observeProductionRpc } from "../deepseek-browser-observe.mjs";
import {
  createReadyWorkspaceSession,
  editableComposer,
} from "../deepseek-browser-session.mjs";
const { values: v } = parseArgs({
  options: {
    url: { type: "string" },
    output: { type: "string" },
    "fixture-evidence": { type: "string" },
    "playwright-module": { type: "string" },
    chromium: { type: "string" },
  },
});
for (const k of [
  "url",
  "output",
  "fixture-evidence",
  "playwright-module",
  "chromium",
])
  assert(v[k], k);
const origin = new URL(v.url).origin,
  out = resolve(v.output),
  evidence = resolve(v["fixture-evidence"]);
await mkdir(out, { recursive: true });
const fixture = JSON.parse(
  await readFile(join(evidence, "launch.json"), "utf8"),
);
assert(fixture.managedCommands);
assert.equal(fixture.paidModelCalls, 0);
const pw = await import(pathToFileURL(resolve(v["playwright-module"])));
const browser = await pw.chromium.launch({
  executablePath: v.chromium,
  headless: true,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  locale: "en-US",
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
const rpc = observeProductionRpc(page, origin),
  checks = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const button = (name) =>
  page
    .getByRole("button", { name, exact: typeof name === "string" })
    .filter({ visible: true })
    .first();
const input = () => page.locator(editableComposer).filter({ visible: true });
const until = async (fn, label, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await page.waitForTimeout(60);
  }
  throw Error(label);
};
const exists = async (name) =>
  readFile(join(fixture.cwd, name), "utf8").catch((e) => {
    if (e.code === "ENOENT") return undefined;
    throw e;
  });
const requests = async () =>
  (await readFile(join(evidence, "requests.jsonl"), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
const read = async (endpoint, args) => {
  assert(["session/projections", "session/list"].includes(endpoint));
  const response = await fetch(origin + "/api/deepseek/call", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ endpoint, args, requestId: randomUUID() }),
  });
  const value = await response.json();
  assert(value.ok, JSON.stringify(value));
  return value.value;
};
const check = (name, detail) => {
  checks.push({ name, status: "PASS", detail });
  console.log(name);
};
let sessionId, failure;
try {
  await page.goto(origin);
  await input().waitFor();
  const fresh = await createReadyWorkspaceSession(page, rpc);
  sessionId = fresh.sessionId;
  assert(
    (await read("session/list", { _request: {} })).items.some(
      (s) =>
        s.sessionId === sessionId && s.cwd === fixture.cwd && s.agentAvailable,
    ),
  );
  check("actual-workspace-owner");
  await button(/^Access mode, current:/).click();
  await page
    .getByRole("menuitem", { name: "Full access", exact: true })
    .click();
  const enable = button("Enable Full access");
  assert(await enable.isDisabled());
  await page.getByRole("checkbox").check();
  await enable.click();
  await button("Access mode, current: Full access").waitFor();
  await until(
    async () => await button("Access mode, current: Full access").isEnabled(),
    "Permission update incomplete",
  );
  check("actual-permission-confirmation");
  const projection = () =>
    read("session/projections", { request: { sessionId } });
  const prior = (await projection()).values.turnBoundary.lastTurn;
  await input().fill(
    "[fixture:managed] Run the long check, inspect source while it runs, poll, and verify.",
  );
  await button("Send message").click();
  await until(
    async () => await exists("managed-start-finish"),
    "actual command did not start",
  );
  check("actual-started-command");
  await until(
    async () => await exists("managed-done.txt"),
    "actual command did not finish",
  );
  await until(async () => {
    const p = (await projection()).values.turnBoundary;
    return (
      p.lastTurn > prior &&
      p.openTurnStartSeq === null &&
      !(await button("Stop generating").isVisible())
    );
  }, "real turn did not settle");
  assert.equal(await exists("managed-done.txt"), "ACTUAL_MANAGED_OK");
  const wire = await requests();
  assert(
    wire.some(
      (r) => r.tools.includes("exec_start") && r.tools.includes("exec_poll"),
    ),
  );
  assert(
    wire.some((r) =>
      r.messages.some(
        (m) => m.role === "tool" && m.content.includes("MANAGED_DONE"),
      ),
    ),
  );
  check("actual-http-poll-output-and-exit");
  async function journalEvents(dir) {
    const found = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...(await journalEvents(path)));
      else if (entry.name.endsWith(".jsonl"))
        for (const line of (await readFile(path, "utf8"))
          .split("\n")
          .filter(Boolean)) {
          const envelope = JSON.parse(line);
          const event = envelope.event ?? envelope;
          if (event.type === "verification.step_completed") found.push(event);
        }
    }
    return found;
  }
  const verified = (
    await journalEvents(join(dirname(fixture.cwd), "data"))
  ).filter(
    (e) =>
      e.payload?.ref?.includes("managed-verify.cjs") &&
      e.payload.passed === true,
  );
  assert(
    verified.length > 0,
    "Original TaskVerifier did not pass the actual configured command",
  );
  check("actual-original-verifier-passed", verified.length);
  await page.screenshot({
    path: join(out, "managed-finished.png"),
    fullPage: true,
  });
  const priorCancel = (await projection()).values.turnBoundary.lastTurn;
  await input().fill(
    "[fixture:managed-cancel] Start the command; the user will press Stop.",
  );
  await button("Send message").click();
  await until(
    async () => await exists("managed-start-cancel"),
    "cancel command did not start",
  );
  await button("Stop generating").click();
  await until(async () => {
    const p = (await projection()).values.turnBoundary;
    return (
      p.lastTurn > priorCancel &&
      p.openTurnStartSeq === null &&
      !(await button("Stop generating").isVisible())
    );
  }, "cancel did not acknowledge");
  check("actual-stop-button-cancels-owner");
  await page.waitForTimeout(8500);
  assert.equal(await exists("managed-late.txt"), undefined);
  check("cancel-ack-no-late-file");
  assert.deepEqual((await exists("managed-starts.txt")).trim().split("\n"), [
    "finish",
    "cancel",
  ]);
  check("each-logical-command-started-once");
  await page.screenshot({
    path: join(out, "managed-cancelled.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  check("no-browser-errors");
} catch (err) {
  failure = err;
  await page
    .screenshot({ path: join(out, "failure.png"), fullPage: true })
    .catch(() => {});
} finally {
  await writeFile(
    join(out, "result.json"),
    JSON.stringify(
      {
        status: failure ? "FAIL" : "PASS",
        complete: !failure,
        sourceSha: fixture.sourceSha,
        platform: process.platform,
        checks,
        errors,
        sessionId,
        paidModelCalls: 0,
        failure: failure?.stack,
      },
      null,
      2,
    ) + "\n",
  );
  await context.close();
  await browser.close();
}
if (failure) throw failure;
