import { afterEach, describe, expect, it } from "vitest";
import { createServer, IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import { once } from "node:events";
import { DeepseekTransport, RemoteFailure, remoteError, wireDecode, wireEncode, type DeepseekService } from "./transport.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const requestId = "request_01234567890123456789";
const streamId = "stream_01234567890123456789";
async function result(response: Response) {
  return await response.json() as { ok: boolean; error: { code: string }; value: { cancelled: boolean } };
}

async function serve(service: DeepseekService) {
  const transport = new DeepseekTransport([service]);
  const server: Server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      await transport.handle(req.url!.slice(1), JSON.parse(Buffer.concat(chunks).toString()), req, res);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ harnessTestFailure: String(error) }));
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanups.push(async () => { await transport.stop(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Expected TCP address");
  const post = (route: string, body: unknown, signal?: AbortSignal) => fetch(`http://127.0.0.1:${address.port}/${route}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }),
  });
  return { post, transport };
}

describe("DeepSeek host transport admission and lifecycle", () => {
  it("preserves validated binary arguments and results across real HTTP", async () => {
    const { post } = await serve({ endpoints: ["binary"], async call(_endpoint, args) { expect(args).toEqual(Uint8Array.of(0, 128, 255)); return Uint8Array.of(1, 255); } });
    const response = await post("call", { endpoint: "binary", args: { $dshBytes: [0, 128, 255] }, requestId });
    expect(response.status).toBe(200); expect(wireDecode(await response.json())).toEqual({ ok: true, value: Uint8Array.of(1, 255) });
  });

  it("rejects unknown endpoints, invalid ids and extra admission fields before service invocation", async () => {
    let calls = 0;
    const { post } = await serve({ endpoints: ["echo"], async call() { calls++; return null; } });
    for (const body of [
      { endpoint: "not-registered", args: {}, requestId },
      { endpoint: "echo", args: {}, requestId: "short" },
      { endpoint: "echo", args: {}, requestId, arbitraryPrivilege: true },
      { endpoint: "echo", args: { $dshBytes: [256] }, requestId },
    ]) { const response = await post("call", body); expect(response.status).toBe(400); expect((await result(response)).ok).toBe(false); }
    expect(calls).toBe(0);
  });

  it("rejects a cancellation identifier from the other request kind", async () => {
    let aborted = false;
    const { post } = await serve({ endpoints: ["events"], async call() { return null; }, async *stream(_endpoint, _args, signal) {
      try { yield { ready: true }; await new Promise<void>(done => signal.addEventListener("abort", () => done(), { once: true })); }
      finally { aborted = signal.aborted; }
    } });
    const response = await post("open", { endpoint: "events", args: {}, streamId });
    const reader = response.body!.getReader(); await reader.read();
    const wrong = await post("cancel", { requestId: streamId });
    expect(wrong.status).toBe(400); expect((await result(wrong)).error.code).toBe("gateway/bad-request");
    expect(aborted).toBe(false);
    expect((await result(await post("cancel", { streamId }))).value.cancelled).toBe(true);
    await reader.cancel();
  });

  it("does not admit a request whose response disconnected before listeners attached", async () => {
    let calls = 0;
    const transport = new DeepseekTransport([{ endpoints: ["effect"], async call() { calls++; return null; } }]);
    const request = new IncomingMessage(new Socket()); request.aborted = true;
    // Reproduces a body parsed by the outer HTTP host before its close callback:
    // transport admission must not start a side effect on an already dead carrier.
    const response = { destroyed: true, writableEnded: false, headersSent: false, once() {}, off() {} } as unknown as ServerResponse;
    await transport.handle("call", { endpoint: "effect", args: {}, requestId }, request, response);
    expect(calls).toBe(0);
    await transport.stop(); request.destroy();
  });

  it("delivers a domain failure after NDJSON headers without inventing a data frame", async () => {
    const { post } = await serve({ endpoints: ["events"], async call() { return null; }, async *stream() {
      yield { ready: true }; throw new RemoteFailure("session/not-found", "Missing session", { id: "missing" });
    } });
    const response = await post("open", { endpoint: "events", args: {}, streamId });
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const frames = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
    expect(frames).toEqual([{ ready: true }, { __deepseek_transport_error__: { code: "session/not-found", message: "Missing session", details: { id: "missing" } } }]);
  });

  it("reports an unserializable service result instead of leaving the HTTP response pending", async () => {
    const { post } = await serve({ endpoints: ["unserializable"], async call() { return { invalid: 1n }; } });
    const response = await post("call", { endpoint: "unserializable", args: {}, requestId }, AbortSignal.timeout(1000));
    expect(response.status).toBe(400); expect((await result(response)).error.code).toBe("gateway/internal");
  });

  it("orders uplink items and rejects pushes after an admitted completion", async () => {
    const observed: unknown[] = [];
    const { post } = await serve({ endpoints: ["bidi"], async call() { return null; }, async *stream(_endpoint, _args, _signal, uplink) {
      yield { ready: true }; for await (const item of uplink) observed.push(item); yield { done: true };
    } });
    const response = await post("open", { endpoint: "bidi", args: {}, streamId });
    const reader = response.body!.getReader(); await reader.read();
    for (const item of ["one", "two"]) expect((await result(await post("uplink", { streamId, item }))).ok).toBe(true);
    expect((await result(await post("uplink", { streamId, done: true }))).ok).toBe(true);
    const late = await post("uplink", { streamId, item: "late" }); expect(late.status).toBe(400);
    expect(observed).toEqual(["one", "two"]); await reader.cancel();
  });

  it("stops pending calls and closes a multi-endpoint service exactly once", async () => {
    let closeCount = 0; let started!: () => void;
    const ready = new Promise<void>(done => { started = done; });
    const { post, transport } = await serve({ endpoints: ["pending", "other"], async call(_endpoint, _args, signal) {
      started(); await new Promise<void>(done => signal.addEventListener("abort", () => done(), { once: true })); signal.throwIfAborted();
    }, async close() { closeCount++; } });
    const pending = post("call", { endpoint: "pending", args: {}, requestId }); await ready;
    await transport.stop(); const response = await pending;
    expect((await result(response)).error.code).toBe("gateway/cancelled"); expect(closeCount).toBe(1);
    await transport.stop(); expect(closeCount).toBe(1);
  });
});

describe("DeepSeek host wire codec and error safety", () => {
  it("encodes Node Buffer as binary rather than its incompatible toJSON object", () => {
    expect(wireDecode(JSON.parse(wireEncode({ bytes: Buffer.from([0, 128, 255]) })))).toEqual({ bytes: Uint8Array.of(0, 128, 255) });
  });
  it("converts circular diagnostic details to a safe Remote failure", () => {
    const details: Record<string, unknown> = {}; details.self = details;
    expect(remoteError(new RemoteFailure("gateway/unavailable", "Host failed", details))).toEqual({ code: "gateway/unavailable", message: "Host failed", details: {} });
  });
  it("converts non-JSON diagnostic details to a safe Remote failure", () => {
    expect(remoteError(new RemoteFailure("gateway/unavailable", "Host failed", { unsafe: 1n }))).toEqual({ code: "gateway/unavailable", message: "Host failed", details: {} });
  });
  it("does not allow a diagnostic toJSON override to violate the Remote failure object shape", () => {
    expect(remoteError(new RemoteFailure("gateway/unavailable", "Host failed", { toJSON: () => "invalid details" }))).toEqual({ code: "gateway/unavailable", message: "Host failed", details: {} });
  });
});
