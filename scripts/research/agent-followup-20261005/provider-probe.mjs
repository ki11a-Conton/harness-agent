#!/usr/bin/env node
// Production provider protocol/ownership probes. All HTTP traffic is loopback.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const [repoArgument, outputArgument] = process.argv.slice(2);
if (!repoArgument || !outputArgument || process.argv.length !== 4) {
  throw new Error("usage: node provider-probe.mjs <repo> <fresh-output-directory>");
}
const repo = path.resolve(repoArgument);
const output = path.resolve(outputArgument);
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output); // Never overwrite a prior PASS, FAIL, or partial result.
const git = (...argv) => execFileSync("git", argv, { cwd: repo, encoding: "utf8" }).trim();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = ["packages/model/src/openai.ts", "packages/model/dist/openai.js",
  "packages/model/src/openai-stream-footer.regressions.test.ts", "packages/model/src/openai.test.ts",
  "scripts/research/agent-followup-20261005/provider-probe.mjs"];
async function fingerprints() {
  return Object.fromEntries(await Promise.all(files.map(async (name) => [name, hash(await readFile(path.join(repo, name)))])));
}
const receipt = {
  schemaVersion: "agent-followup-provider-probe-v1", status: "RUNNING",
  sourceSha: git("rev-parse", "HEAD"),
  sourceTrackedDirtyAtStart: git("status", "--porcelain", "--untracked-files=no") !== "",
  sourceStatusAtStart: git("status", "--porcelain"),
  sourceFingerprintsBefore: await fingerprints(),
  probeSha256: hash(await readFile(fileURLToPath(import.meta.url))),
  runtime: process.version, startedAt: new Date().toISOString(),
  paidProviderCalls: 0, realModelQuality: "NOT_RUN", cases: [], requests: [],
};
const save = () => writeFile(path.join(output, "result.json"), JSON.stringify(receipt, null, 2) + "\n");
await save();
const { OpenAICompatibleProvider } = await import(pathToFileURL(path.join(repo, "packages/model/dist/openai.js")));
const realFetch = globalThis.fetch;
const encode = (value) => new TextEncoder().encode(value);
const sse = (value) => `data: ${JSON.stringify(value)}\n\n`;
const usage = { prompt_tokens: 137, completion_tokens: 23, total_tokens: 160 };
const text = sse({ choices: [{ delta: { content: "你好 complete", reasoning_content: "kept reasoning" }, finish_reason: null }] });
const tool = sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_one",
  function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] } }] });
const terminal = (reason, extra = {}) => sse({ choices: [{ delta: {}, finish_reason: reason }], ...extra });
const footer = sse({ choices: [], usage });
const done = "data: [DONE]\n\n";
const expectedUsage = { inputTokens: 137, outputTokens: 23 };
const expectedTool = [{ id: "call_one", name: "read_file", args: { path: "a.txt" } }];
const routes = new Map();
const responses = new Map();
const server = http.createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const name = body.messages.at(-1)?.content;
    const route = routes.get(name);
    assert.ok(route, "unrecognized fixture route");
    const observed = { name, path: request.url, body, closed: false };
    receipt.requests.push(observed);
    const closed = once(response, "close").then(() => { observed.closed = true; });
    responses.set(name, { response, closed });
    response.writeHead(200, { "content-type": "text/event-stream" });
    await route(response);
  } catch (error) {
    receipt.serverError = { name: error.name, message: error.message };
    response.destroy(error);
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const client = (timeout = 0, retries = 2) => new OpenAICompatibleProvider().createClient(
  { providerId: "openai", modelId: "offline-provider-probe" },
  { apiKey: "offline-fixture-only", baseUrl, requestTimeoutMs: timeout, maxProviderRetries: retries, retryDelayMs: 0 },
);
const completed = (events) => {
  const matches = events.filter((event) => event.type === "completed");
  assert.equal(matches.length, 1, "expected exactly one completed event");
  return matches[0].result;
};
const noRetry = (events) => assert.equal(events.filter((event) => event.type === "retry").length, 0);
const success = (events, reason, withUsage = true) => {
  noRetry(events);
  const result = completed(events);
  assert.equal(result.finishReason, reason);
  assert.equal(events.filter((event) => event.type === "error").length, 0);
  assert.deepEqual(result.usage, withUsage ? expectedUsage : undefined);
  if (reason === "tool_calls") assert.deepEqual(result.toolCalls, expectedTool);
  return result;
};
const cancelled = (events) => {
  noRetry(events);
  assert.equal(completed(events).finishReason, "cancelled");
  assert.equal(events.filter((event) => event.type === "error").length, 0);
};
const failedRead = (events, kind) => {
  noRetry(events);
  assert.deepEqual(events.filter((event) => event.type === "completed" || event.type === "tool_call_delta"), []);
  const errors = events.filter((event) => event.type === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error.code, "MODEL_ERROR");
  assert.equal(errors[0].error.retryable, false);
  assert.equal(errors[0].error.safeToRetry, false);
  assert.equal(errors[0].error.provider.kind, kind);
};
async function collect(name, { abortAt, abortAfterTextMs, earlyReturn, timeoutMs = 0 } = {}) {
  const controller = new AbortController();
  const events = [];
  let capturedResponse;
  let fetchCalls = 0;
  let timer;
  globalThis.fetch = async (...args) => {
    fetchCalls += 1;
    capturedResponse = await realFetch(...args);
    return capturedResponse;
  };
  try {
    for await (const event of client(timeoutMs).generate({ messages: [{ role: "user", content: name }] }, controller.signal)) {
      events.push(event);
      if (abortAt?.(event)) controller.abort();
      if (event.type === "text_delta" && abortAfterTextMs !== undefined) timer = setTimeout(() => controller.abort(), abortAfterTextMs);
      if (earlyReturn && event.type === "text_delta") break;
    }
    assert.equal(fetchCalls, 1, "stream phase must not retry HTTP");
    assert.equal(capturedResponse?.body?.locked, false, "native response reader must be released");
    const observed = receipt.requests.filter((request) => request.name === name);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].path, "/v1/chat/completions");
    assert.deepEqual(observed[0].body.stream_options, { include_usage: true });
    return { events, fetchCalls, responseLocked: capturedResponse.body.locked };
  } finally {
    clearTimeout(timer);
    globalThis.fetch = realFetch;
  }
}
async function waitClosed(name) {
  let timer;
  try {
    await Promise.race([responses.get(name).closed,
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("reader cancellation did not close native response")), 1500); })]);
  } finally { clearTimeout(timer); }
}
async function check(name, action) {
  const row = { name, status: "RUNNING", startedAt: new Date().toISOString() };
  receipt.cases.push(row);
  try { Object.assign(row, await action()); row.status = "PASS"; }
  catch (error) { row.status = "FAIL"; row.error = { name: error.name, message: error.message, stack: error.stack }; throw error; }
  finally { row.finishedAt = new Date().toISOString(); await save(); }
}
async function httpCase(name, frames, verify, options = {}, hanging = false) {
  routes.set(name, async (response) => {
    response.write(frames);
    if (!hanging) response.end();
  });
  await check(name, async () => {
    const observed = await collect(name, options);
    verify(observed.events);
    if (hanging) await waitClosed(name);
    return { transport: "native-loopback-http", ...observed, nativeResponseClosed: responses.get(name).response.destroyed };
  });
}
async function ownedStreamCase(name, frames, verify, { abortAt, earlyReturn = false, cancelError, readError = false } = {}) {
  await check(name, async () => {
    let cancelCount = 0;
    let streamController;
    let timer;
    const stream = new ReadableStream({
      start(controller) { streamController = controller; controller.enqueue(encode(frames)); },
      cancel() { cancelCount += 1; if (cancelError) throw new Error("fixture cancel failure"); },
    });
    let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls += 1; return new Response(stream); };
    const controller = new AbortController();
    const events = [];
    try {
      for await (const event of client().generate({ messages: [] }, controller.signal)) {
        events.push(event);
        if (abortAt?.(event)) controller.abort();
        if (readError && event.type === "text_delta") timer = setTimeout(() => streamController.error(new Error("fixture reader failure")), 20);
        if (earlyReturn && event.type === "text_delta") break;
      }
      verify(events);
      assert.equal(fetchCalls, 1);
      assert.equal(stream.locked, false);
      assert.equal(cancelCount, readError ? 0 : 1);
      return { transport: "native-readable-stream", events, fetchCalls, readerLocked: stream.locked, cancelCount, injectedCancelError: !!cancelError };
    } finally { clearTimeout(timer); globalThis.fetch = realFetch; }
  });
}
try {
  for (const reason of ["stop", "tool_calls"]) {
    await httpCase(`${reason}-separate-footer`, (reason === "stop" ? text : tool) + terminal(reason) + footer + done,
      (events) => { success(events, reason); assert.equal(events.filter((event) => event.type === "usage").length, 1); });
  }
  routes.set("split-crlf-utf8-footer", async (response) => {
    const bytes = encode((text + terminal("stop") + footer + done).replace(/\n/g, "\r\n"));
    for (let offset = 0; offset < bytes.length; offset += 7) {
      response.write(bytes.slice(offset, offset + 7));
      await new Promise((resolve) => setImmediate(resolve));
    }
    response.end();
  });
  await check("split-crlf-utf8-footer", async () => {
    const observed = await collect("split-crlf-utf8-footer");
    assert.equal(success(observed.events, "stop").text, "你好 complete");
    return { transport: "native-loopback-http", fragmentWriteBytes: 7, ...observed };
  });
  await httpCase("partial-snapshot-final-footer", sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }) + text + terminal("stop") + footer,
    (events) => { success(events, "stop"); assert.deepEqual(events.filter((event) => event.type === "usage").map((event) => event.usage), [{ inputTokens: 5, outputTokens: 2 }, expectedUsage]); });
  await httpCase("same-frame-usage-open-transport", text + terminal("stop", { usage }), (events) => success(events, "stop"), {}, true);
  await httpCase("separate-footer-open-transport", tool + terminal("tool_calls") + footer, (events) => success(events, "tool_calls"), {}, true);
  for (const reason of ["stop", "tool_calls"]) {
    for (const [boundary, close] of [["done", done], ["eof", ""]]) {
      await httpCase(`${reason}-no-usage-${boundary}`, (reason === "stop" ? text : tool) + terminal(reason) + close, (events) => success(events, reason, false));
    }
  }
  for (const [boundary, close] of [["done", done], ["eof", ""]]) {
    await httpCase(`missing-normal-${boundary}`, tool + close, (events) => {
      noRetry(events);
      assert.equal(completed(events).finishReason, "error");
      assert.equal(completed(events).error.provider.kind, "protocol");
    });
  }
  const injectedText = sse({ choices: [{ delta: { content: "INJECTED", reasoning_content: "INJECTED", tool_calls: [{ index: 0, id: "bad", function: { name: "write_file", arguments: "BAD" } }] }, finish_reason: "tool_calls" }], usage });
  await httpCase("footer-cannot-mutate-output", text + terminal("stop") + injectedText, (events) => {
    assert.deepEqual(success(events, "stop"), { finishReason: "stop", text: "你好 complete", reasoningContent: "kept reasoning", usage: expectedUsage });
    assert.equal(events.filter((event) => event.type === "tool_call_delta").length, 0);
  });
  await httpCase("footer-cannot-mutate-tool", tool + terminal("tool_calls") + injectedText, (events) => {
    const result = success(events, "tool_calls"); assert.equal(result.text, ""); assert.equal(result.reasoningContent, undefined);
    assert.equal(events.filter((event) => event.type === "tool_call_delta").length, 1);
  });
  await httpCase("abnormal-reason-open-transport", tool + terminal("length"), (events) => {
    noRetry(events); assert.equal(completed(events).finishReason, "error");
    assert.equal(completed(events).error.provider.kind, "protocol");
  }, {}, true);
  await httpCase("native-caller-abort", text, cancelled, { abortAt: (event) => event.type === "text_delta" }, true);
  await httpCase("native-footer-caller-abort", text + tool + terminal("tool_calls"), (events) => {
    cancelled(events); assert.equal(events.filter((event) => event.type === "tool_call_delta").length, 0);
  }, { abortAfterTextMs: 25 }, true);
  await httpCase("native-footer-deadline", text + tool + terminal("tool_calls"), (events) => failedRead(events, "timeout"), { timeoutMs: 150 }, true);
  routes.set("native-footer-reader-error", async (response) => {
    response.write(text + tool + terminal("tool_calls"));
    const timer = setTimeout(() => response.destroy(new Error("fixture transport failure")), 30);
    response.once("close", () => clearTimeout(timer));
  });
  await check("native-footer-reader-error", async () => {
    const observed = await collect("native-footer-reader-error"); failedRead(observed.events, "network");
    return { transport: "native-loopback-http", ...observed };
  });
  await httpCase("native-consumer-early-return", text, (events) => {
    assert.equal(events.filter((event) => event.type === "completed").length, 0);
  }, { earlyReturn: true }, true);
  for (const [boundary, close] of [["eof", ""], ["done", done], ["usage", footer]]) {
    await httpCase(`abort-between-tool-and-completed-${boundary}`, tool + terminal("tool_calls") + close, cancelled,
      { abortAt: (event) => event.type === "tool_call_delta" });
    await httpCase(`abort-after-delivered-completed-${boundary}`, text + terminal("stop") + close,
      (events) => success(events, "stop", boundary === "usage"), { abortAt: (event) => event.type === "completed" });
  }
  await ownedStreamCase("buffered-caller-abort", text + terminal("stop") + footer, cancelled, { abortAt: (event) => event.type === "text_delta" });
  await ownedStreamCase("consumer-return-cancel-release", text, (events) => assert.equal(events.filter((event) => event.type === "completed").length, 0), { earlyReturn: true });
  await ownedStreamCase("cleanup-rejection-preserves-success", text + terminal("stop", { usage }), (events) => success(events, "stop"), { cancelError: true });
  await ownedStreamCase("cleanup-rejection-preserves-cancel", text, cancelled, { cancelError: true, abortAt: (event) => event.type === "text_delta" });
  await ownedStreamCase("reader-rejection-releases-lock", text + tool + terminal("tool_calls"), (events) => failedRead(events, "network"), { readError: true });
  assert.equal(receipt.serverError, undefined);
  receipt.status = "PASS";
} catch (error) {
  receipt.status = "FAIL";
  receipt.error = { name: error.name, message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  const closed = once(server, "close");
  server.close(); server.closeAllConnections(); await closed;
  receipt.sourceShaAtEnd = git("rev-parse", "HEAD");
  receipt.sourceTrackedDirtyAtEnd = git("status", "--porcelain", "--untracked-files=no") !== "";
  receipt.sourceStatusAtEnd = git("status", "--porcelain");
  receipt.sourceFingerprintsAfter = await fingerprints();
  if (receipt.sourceShaAtEnd !== receipt.sourceSha || JSON.stringify(receipt.sourceFingerprintsBefore) !== JSON.stringify(receipt.sourceFingerprintsAfter)) {
    receipt.status = "FAIL"; receipt.provenanceError = "source HEAD or fingerprinted bytes changed during probe"; process.exitCode = 1;
  }
  receipt.caseCount = receipt.cases.length;
  receipt.passed = receipt.cases.filter((row) => row.status === "PASS").length;
  receipt.failed = receipt.cases.filter((row) => row.status === "FAIL").length;
  receipt.httpRequestCount = receipt.requests.length;
  receipt.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ status: receipt.status, caseCount: receipt.caseCount, passed: receipt.passed, failed: receipt.failed,
    httpRequestCount: receipt.httpRequestCount, sourceSha: receipt.sourceSha, sourceTrackedDirty: receipt.sourceTrackedDirtyAtStart,
    result: path.join(output, "result.json") }));
}
