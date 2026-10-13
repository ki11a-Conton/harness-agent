/** Carrier conformance against a real local HTTP server, independent of UI/backend evidence. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../../apps/web/public/deepseek/transport.js", import.meta.url), "utf8");
async function withCarrier(handler, exercise) {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ path: request.url, body });
      if (request.url.endsWith("/cancel")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, value: null }));
      } else await handler(request, response, body);
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: { code: "test/server", message: error.message, details: {} } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const globals = { crypto: webcrypto, AbortController, DOMException, Uint8Array, TextDecoder,
    fetch: (url, init) => fetch(new URL(url, origin), init) };
  runInNewContext(source, globals, { filename: "deepseek/transport.js" });
  try { await exercise(globals.__DSH_TRANSPORT__, requests); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const json = (response, result, status = 200) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(result));
};

test("unary carrier preserves args, binary data, errors, and server-owned results", async () => {
  await withCarrier(async (request, response, body) => {
    assert.equal(request.headers["content-type"], "application/json");
    if (body.endpoint === "failure") return json(response, { ok: false,
      error: { code: "gateway/forbidden", message: "Denied by the real endpoint", details: { owner: "other" } } }, 403);
    if (body.endpoint === "void") return json(response, { ok: true });
    assert.deepEqual(body.args, { text: "actual HTTP", bytes: { $dshBytes: [0, 128, 255] } });
    assert.equal(typeof body.requestId, "string");
    assert.match(body.requestId, /^[A-Za-z0-9_-]{16,128}$/);
    json(response, { ok: true, value: { bytes: { $dshBytes: [4, 7, 255] }, text: "echo" } });
  }, async transport => {
    assert.equal(transport.ownsHost, undefined);
    const result = await transport.rpc.call("/api", "echo", { args: { text: "actual HTTP", bytes: Uint8Array.of(0, 128, 255) } });
    assert.equal(result.ok, true);
    assert.ok(result.value.bytes instanceof Uint8Array);
    assert.deepEqual([...result.value.bytes], [4, 7, 255]);
    const rejected = await transport.rpc.call("/api", "failure", { args: {} });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "gateway/forbidden");
    assert.equal(rejected.error.details.owner, "other");
    assert.equal((await transport.rpc.call("/api", "void", { args: {} })).value, undefined);
  });
});

test("stream carrier decodes complete frames, split UTF8 and binary without changing Typert values", async () => {
  await withCarrier(async (_request, response, body) => {
    assert.equal(body.endpoint, "stream");
    assert.equal(typeof body.streamId, "string");
    response.writeHead(200, { "Content-Type": "application/x-ndjson" });
    const bytes = Buffer.from(JSON.stringify({ type: "ready", label: "中文", value: { $dshBytes: [0, 255] } }) + "\n");
    const split = bytes.indexOf(Buffer.from("中")) + 1;
    response.write(bytes.subarray(0, split));
    await new Promise(resolve => setImmediate(resolve));
    response.write(bytes.subarray(split));
    response.end('{"type":"event","seq":2}\n');
  }, async transport => {
    const frames = [];
    for await (const frame of transport.rpc.open("/api", "stream", { args: {} }, new AbortController().signal)) frames.push(frame);
    assert.equal(frames.length, 2);
    assert.equal(frames[0].label, "中文");
    assert.deepEqual([...frames[0].value], [0, 255]);
    assert.equal(frames[1].seq, 2);
  });
});

test("failed open and failures after headers remain visible", async () => {
  await withCarrier(async (_request, response, body) => {
    const error = { code: "gateway/not-found", message: "No such session", details: { sessionId: "missing" } };
    if (body.endpoint === "before") return json(response, { ok: false, error }, 404);
    response.writeHead(200, { "Content-Type": "application/x-ndjson" });
    response.end(JSON.stringify({ __deepseek_transport_error__: error }) + "\n");
  }, async transport => {
    for (const endpoint of ["before", "after"]) {
      await assert.rejects(async () => {
        for await (const _frame of transport.rpc.open("/api", endpoint, { args: {} }, new AbortController().signal)) {}
      }, error => error.code === "gateway/not-found" && error.details.sessionId === "missing");
    }
  });
});

test("truncated or malformed frames reject without manufacturing success", async () => {
  await withCarrier(async (_request, response, body) => {
    if (body.endpoint === "invalid-result") return json(response, { arbitrary: "invalid" });
    response.writeHead(200, { "Content-Type": "application/x-ndjson" });
    response.end(body.endpoint === "truncated" ? '{"type":"event"}' : '{bad json}\n');
  }, async transport => {
    await assert.rejects(transport.rpc.call("/api", "invalid-result", { args: {} }), /invalid RPC result/);
    for (const endpoint of ["truncated", "malformed"]) await assert.rejects(async () => {
      for await (const _frame of transport.rpc.open("/api", endpoint, { args: {} }, new AbortController().signal)) {}
    });
  });
});

test("a failed HTTP response cannot claim a successful unary result", async () => {
  await withCarrier(async (_request, response) => {
    json(response, { ok: true, value: "incorrect success" }, 503);
  }, async transport => {
    await assert.rejects(transport.rpc.call("/api", "failed-http", { args: {} }), /success on a failed HTTP response/);
  });
});

test("stream uplink sends ordered values and its completion through the admitted stream id", async () => {
  let streamResponse;
  const uplinkValues = [];
  let firstId;
  await withCarrier(async (request, response, body) => {
    if (request.url.endsWith("/open")) {
      firstId = body.streamId;
      streamResponse = response;
      response.writeHead(200, { "Content-Type": "application/x-ndjson" });
      response.flushHeaders();
      return;
    }
    assert.equal(request.url, "/api/deepseek/uplink");
    assert.equal(body.streamId, firstId);
    if (body.done) {
      json(response, { ok: true, value: null });
      streamResponse.end('{"type":"finished"}\n');
    } else {
      uplinkValues.push(body.item);
      json(response, { ok: true, value: null });
    }
  }, async transport => {
    async function* items() { yield { input: 1 }; yield { input: 2 }; }
    const frames = [];
    for await (const frame of transport.rpc.open("/api", "bidi", { args: {} }, new AbortController().signal, items())) frames.push(frame);
    assert.deepEqual(uplinkValues, [{ input: 1 }, { input: 2 }]);
    assert.equal(frames[0].type, "finished");
  });
});

test("unary and stream cancellation abort data fetches and notify the server", async () => {
  for (const kind of ["call", "open"]) {
    let startedResolve;
    const started = new Promise(resolve => { startedResolve = resolve; });
    let closedResolve;
    const closed = new Promise(resolve => { closedResolve = resolve; });
    await withCarrier(async (_request, response, body) => {
      response.on("close", closedResolve);
      if (kind === "open") {
        response.writeHead(200, { "Content-Type": "application/x-ndjson" });
        response.flushHeaders();
      }
      startedResolve(body);
    }, async (transport, requests) => {
      const controller = new AbortController();
      const action = kind === "call"
        ? transport.rpc.call("/api", "pending", { args: {} }, controller.signal)
        : (async () => { for await (const _frame of transport.rpc.open("/api", "pending", { args: {} }, controller.signal)) {} })();
      const request = await started;
      const rejection = assert.rejects(action, error => error.name === "AbortError");
      controller.abort();
      await rejection;
      await closed;
      for (let i = 0; i < 100 && !requests.some(item => item.path.endsWith("/cancel")); i++) {
        await new Promise(resolve => setImmediate(resolve));
      }
      const cancel = requests.find(item => item.path.endsWith("/cancel"));
      assert.ok(cancel, "explicit cancellation request reached the HTTP server");
      assert.equal(cancel.body[kind === "call" ? "requestId" : "streamId"], request[kind === "call" ? "requestId" : "streamId"]);
    });
  }
});

test("unrecognized channels, missing args and pre-aborted calls do not reach HTTP", async () => {
  await withCarrier(async () => assert.fail("invalid carrier invocation reached HTTP"), async (transport, requests) => {
    await assert.rejects(transport.rpc.call("/rpc", "unknown", { args: {} }), /does not carry channel/);
    await assert.rejects(transport.rpc.call("/api", "unknown", {}), /requires the DeepSeek/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(transport.rpc.call("/api", "unknown", { args: {} }, controller.signal), error => error.name === "AbortError");
    assert.equal(requests.length, 0);
  });
});
