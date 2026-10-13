import { once } from "node:events";
import { connect } from "node:net";
import { afterEach, expect, it } from "vitest";
import WebSocket from "ws";
import { createHarness } from "@ar/harness";
import { ScriptedModelProvider } from "@ar/model";
import { WebChannelAdapter } from "../adapter.js";
import { SessionBindings } from "../bindings.js";
import { WebServer } from "../server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of cleanups.splice(0).reverse()) await action(); });
async function fixture() {
  const provider = new ScriptedModelProvider([]);
  const base = await createHarness({ cwd: process.cwd(), profile: "interactive", modelProvider: provider,
    model: { providerId: provider.id, modelId: "upgrade-boundary-test" } });
  let dispatched = 0, aborted = 0, serviceClosed = 0;
  const server = new WebServer({ adapter: new WebChannelAdapter(), bindings: new SessionBindings(), events: base.events, store: base.store, approvalStore: base.approvalStore,
    deepseekServices: [{ endpoints: ["hold", "echo"], async call() { dispatched++; return "real socket result"; }, async *stream(_endpoint, _args, signal) {
      try { yield { actual: "ready" }; await new Promise<void>(done => { signal.addEventListener("abort", () => done(), { once: true }); if (signal.aborted) done(); }); }
      finally { aborted++; }
    }, async close() { serviceClosed++; } }], host: "127.0.0.1", port: 0 });
  const { port } = await server.start();
  cleanups.push(async () => { await server.stop(); await base.close(); });
  return { server, port, authority: `127.0.0.1:${port}`, counts: () => ({ dispatched, aborted, serviceClosed }) };
}
async function rejectedUpgrade(port: number, authority: string, { method = "GET", path = "/api/deepseek/socket", headers = {} }: { method?: string; path?: string; headers?: Record<string, string> }) {
  const socket = connect(port, "127.0.0.1"); await once(socket, "connect");
  const response = new Promise<string>((resolve, reject) => { socket.once("data", chunk => { resolve(chunk.toString()); socket.destroy(); }); socket.once("error", reject); });
  socket.write(`${method} ${path} HTTP/1.1\r\nHost: ${authority}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n`);
  return response;
}

it("real WebServer applies trusted Host, Origin, cross-site, path and method checks before socket admission", async () => {
  const stack = await fixture();
  const rejectedHeaders: Array<Record<string, string>> = [{ Origin: "https://attacker.invalid" }, { "Sec-Fetch-Site": "cross-site" }];
  for (const headers of rejectedHeaders) {
    expect(await rejectedUpgrade(stack.port, stack.authority, { headers })).toMatch(/^HTTP\/1\.1 403/);
  }
  expect(await rejectedUpgrade(stack.port, "attacker.invalid", {})).toMatch(/^HTTP\/1\.1 403/);
  expect(await rejectedUpgrade(stack.port, stack.authority, { path: "/other/socket" })).toMatch(/^HTTP\/1\.1 404/);
  expect(await rejectedUpgrade(stack.port, stack.authority, { method: "POST" })).toMatch(/^HTTP\/1\.1 404/);
  expect(stack.counts()).toEqual({ dispatched: 0, aborted: 0, serviceClosed: 0 });
  const ws = new WebSocket(`ws://${stack.authority}/api/deepseek/socket`, { origin: `http://${stack.authority}` }); await once(ws, "open");
  ws.send(JSON.stringify({ type: "request", id: "trusted_upgrade_0123456789", route: "call", body: { endpoint: "echo", args: {}, requestId: "trusted_call_0123456789" } }));
  const frame = JSON.parse(String((await once(ws, "message"))[0]));
  expect(frame).toMatchObject({ type: "result", status: 200, value: { ok: true, value: "real socket result" } });
  expect(stack.counts().dispatched).toBe(1); ws.close();
});

it("real WebServer stop aborts every independent socket and closes a shared service exactly once", async () => {
  const stack = await fixture(); const sockets: WebSocket[] = [];
  for (let i = 0; i < 2; i++) {
    const ws = new WebSocket(`ws://${stack.authority}/api/deepseek/socket`); await once(ws, "open"); sockets.push(ws);
    ws.send(JSON.stringify({ type: "request", id: `shutdown_socket_0123456789_${i}`, route: "open", body: { endpoint: "hold", args: {}, streamId: `shutdown_stream_0123456789_${i}` } }));
    await once(ws, "message");
  }
  const peerClosed = sockets.map(socket => socket.readyState === WebSocket.CLOSED ? Promise.resolve() : once(socket, "close"));
  await stack.server.stop(); await Promise.all(peerClosed);
  expect(stack.counts()).toEqual({ dispatched: 0, aborted: 2, serviceClosed: 1 });
  await stack.server.stop(); expect(stack.counts().serviceClosed).toBe(1);
  expect(sockets.every(socket => socket.readyState === WebSocket.CLOSED)).toBe(true);
});

it("a peer that never answers its close handshake cannot hold WebServer shutdown open", async () => {
  const stack = await fixture(), socket = connect(stack.port, "127.0.0.1"); await once(socket, "connect");
  const headers = once(socket, "data");
  socket.write(`GET /api/deepseek/socket HTTP/1.1\r\nHost: ${stack.authority}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  expect(String((await headers)[0])).toMatch(/^HTTP\/1\.1 101/);
  socket.pause();
  const started = Date.now();
  try { await stack.server.stop(); expect(Date.now() - started).toBeLessThan(1000); }
  finally { socket.destroy(); }
  expect(stack.counts().serviceClosed).toBe(1);
});
