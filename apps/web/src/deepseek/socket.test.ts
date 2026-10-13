import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, expect, it } from "vitest";
import { attachDeepseekSocket } from "./socket.js";
import { RemoteFailure, type DeepseekService } from "./transport.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of cleanups.splice(0).reverse()) await action(); });
async function fixture(services: DeepseekService[], options: Parameters<typeof attachDeepseekSocket>[2] = {}) {
  const server = createServer(); const sockets = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
  const bindings = new Set<ReturnType<typeof attachDeepseekSocket>>();
  server.on("upgrade", (request, socket, head) => sockets.handleUpgrade(request, socket, head, ws => {
    const binding = attachDeepseekSocket(ws, services, options); bindings.add(binding); ws.once("close", () => bindings.delete(binding));
  }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanups.push(async () => {
    await Promise.all([...bindings].map(binding => binding.close()));
    for (const ws of sockets.clients) ws.terminate();
    await new Promise<void>(done => sockets.close(() => done()));
    await new Promise<void>(done => server.close(() => done()));
  });
  return { origin, sockets, async client() { const ws = new WebSocket(origin.replace("http", "ws") + "/api/deepseek/socket"); await once(ws, "open"); return ws; } };
}
async function carrier(origin: string) {
  const source = await readFile(new URL("../../public/deepseek/transport.js", import.meta.url), "utf8");
  const globals = { WebSocket, URL, crypto: webcrypto, AbortController, DOMException, Uint8Array, TextDecoder, setTimeout, clearTimeout, location: { href: origin },
    fetch() { throw new Error("Production socket carrier unexpectedly used HTTP fallback"); } };
  runInNewContext(source, globals);
  return (globals as unknown as { __DSH_TRANSPORT__: { rpc: { call(...args: unknown[]): Promise<{ ok: boolean; value?: unknown; error?: { code: string } }>; open(...args: unknown[]): AsyncIterable<unknown> } } }).__DSH_TRANSPORT__.rpc;
}
async function within<T>(value: Promise<T>, delay = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([value, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Real socket operation timed out")), delay); })]); }
  finally { clearTimeout(timer!); }
}
const wait = (signal: AbortSignal) => new Promise<void>(done => { signal.addEventListener("abort", () => done(), { once: true }); if (signal.aborted) done(); });

it("one actual socket carries twelve permanent Remote streams and still admits unary, binary and cancel operations", async () => {
  let active = 0, cancelled = 0, closedServices = 0;
  const stack = await fixture([{ endpoints: ["permanent", "echo", "fail"], async call(endpoint, args) {
    if (endpoint === "fail") throw new RemoteFailure("gateway/forbidden", "Real permission refusal"); return args;
  }, async *stream(_endpoint, args, signal) {
    active++; try { yield args; await wait(signal); } finally { active--; cancelled++; }
  }, async close() { closedServices++; } }]);
  const rpc = await carrier(stack.origin);
  const controllers = Array.from({ length: 12 }, () => new AbortController());
  const streams = controllers.map((controller, index) => rpc.open("/api", "permanent", { args: { index } }, controller.signal)[Symbol.asyncIterator]());
  for (let i = 0; i < streams.length; i++) expect((await within(streams[i]!.next())).value).toEqual({ index: i });
  expect(active).toBe(12);
  const echo = await within(rpc.call("/api", "echo", { args: { bytes: Uint8Array.of(0, 128, 255), text: "中文" } }));
  expect(echo).toEqual({ ok: true, value: { bytes: Uint8Array.of(0, 128, 255), text: "中文" } });
  expect(await rpc.call("/api", "fail", { args: {} })).toMatchObject({ ok: false, error: { code: "gateway/forbidden" } });
  controllers[0]!.abort(); await streams[0]!.return?.();
  for (let i = 0; i < 50 && cancelled === 0; i++) await new Promise(done => setTimeout(done, 2));
  expect(active).toBe(11); expect(closedServices).toBe(0);
  controllers.forEach(controller => controller.abort()); await Promise.all(streams.map(stream => stream.return?.()));
});

it("socket uplink remains ordered and completion closes only the input direction", async () => {
  const observed: unknown[] = [];
  const stack = await fixture([{ endpoints: ["bidi"], async call() {}, async *stream(_endpoint, _args, _signal, uplink) {
    for await (const value of uplink) observed.push(value);
    yield { observed }; yield { inputClosed: true, outputStillLive: true };
  } }]);
  const rpc = await carrier(stack.origin);
  async function* input() { yield "first"; yield Uint8Array.of(3, 255); }
  const frames = []; for await (const frame of rpc.open("/api", "bidi", { args: {} }, new AbortController().signal, input())) frames.push(frame);
  expect(observed).toEqual(["first", Uint8Array.of(3, 255)]);
  expect(frames).toEqual([{ observed }, { inputClosed: true, outputStillLive: true }]);
});

it("another socket cannot use a request capability to cancel the first socket's actual stream", async () => {
  let cancelled = false;
  const stack = await fixture([{ endpoints: ["hold"], async call() {}, async *stream(_endpoint, _args, signal) {
    try { yield { ready: true }; await wait(signal); } finally { cancelled = true; }
  } }]);
  const first = await stack.client(), second = await stack.client();
  const id = "socket_first_network_0123456789", streamId = "socket_stream_0123456789";
  first.send(JSON.stringify({ type: "request", id, route: "open", body: { endpoint: "hold", args: {}, streamId } }));
  await once(first, "message");
  second.send(JSON.stringify({ type: "request", id: "socket_second_network_0123456789", route: "cancel", body: { streamId } }));
  const response = JSON.parse(String((await once(second, "message"))[0]));
  expect(response).toMatchObject({ type: "result", value: { ok: true, value: { cancelled: false } } });
  expect(cancelled).toBe(false);
  first.close(); second.close();
});

it("a socket disconnect aborts only that tab's work and never closes shared services", async () => {
  let aborted = 0, serviceClosed = 0;
  const stack = await fixture([{ endpoints: ["hold"], async call() {}, async *stream(_endpoint, _args, signal) {
    try { yield { ready: true }; await wait(signal); } finally { aborted++; }
  }, async close() { serviceClosed++; } }]);
  const ws = await stack.client();
  ws.send(JSON.stringify({ type: "request", id: "socket_disconnect_0123456789", route: "open", body: { endpoint: "hold", args: {}, streamId: "socket_stream_0123456789" } }));
  await once(ws, "message"); ws.close(); await once(ws, "close");
  for (let i = 0; i < 50 && aborted === 0; i++) await new Promise(done => setTimeout(done, 2));
  expect(aborted).toBe(1); expect(serviceClosed).toBe(0);
});

it("protocol and output limits close a real socket without accepting malformed or unbounded work", async () => {
  let dispatched = 0, aborted = 0;
  const service: DeepseekService = { endpoints: ["hold"], async call() { dispatched++; }, async *stream(_endpoint, _args, signal) {
    try { yield { ready: true }; await wait(signal); } finally { aborted++; }
  } };
  const invalid = await fixture([service]); const first = await invalid.client();
  const firstClosed = once(first, "close"); first.send('{"type":"request","id":"bad","route":"call","body":{}}');
  expect((await within(firstClosed))[0]).toBe(1008); expect(dispatched).toBe(0);
  const bounded = await fixture([service], { maxQueuedBytes: 60 }); const second = await bounded.client();
  const secondClosed = once(second, "close");
  second.send(JSON.stringify({ type: "request", id: "output_limit_0123456789", route: "open", body: { endpoint: "hold", args: {}, streamId: "stream_limit_0123456789" } }));
  expect((await within(secondClosed))[0]).toBe(1009);
  expect(aborted).toBe(1);
});

it("socket stream failures are visible and a fresh connection never replays a disconnected unary action", async () => {
  let calls = 0;
  const stack = await fixture([{ endpoints: ["fail-after", "action", "echo"], async call(endpoint, _args, signal) {
    if (endpoint === "echo") return "fresh request";
    calls++; await wait(signal); signal.throwIfAborted();
  }, async *stream() { yield { actual: "first" }; throw new RemoteFailure("session/not-found", "Actual owner vanished"); } }]);
  const rpc = await carrier(stack.origin), stream = rpc.open("/api", "fail-after", { args: {} }, new AbortController().signal)[Symbol.asyncIterator]();
  expect((await within(stream.next())).value).toEqual({ actual: "first" });
  await expect(within(stream.next())).rejects.toMatchObject({ code: "session/not-found" });
  const action = rpc.call("/api", "action", { args: {} });
  const rejected = expect(action).rejects.toThrow("not replayed");
  for (let i = 0; i < 100 && calls === 0; i++) await new Promise(done => setTimeout(done, 2));
  for (const socket of stack.sockets.clients) socket.terminate();
  await rejected;
  expect(await within(rpc.call("/api", "echo", { args: {} }))).toEqual({ ok: true, value: "fresh request" });
  expect(calls).toBe(1);
});

it("pre-aborted socket operations and wrong channels never reach an actual executor", async () => {
  let calls = 0; const stack = await fixture([{ endpoints: ["echo"], async call() { calls++; } }]);
  const rpc = await carrier(stack.origin), controller = new AbortController(); controller.abort();
  await expect(rpc.call("/api", "echo", { args: {} }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  await expect(rpc.call("/wrong", "echo", { args: {} })).rejects.toThrow("does not carry channel");
  expect(calls).toBe(0); expect(stack.sockets.clients.size).toBe(0);
});
