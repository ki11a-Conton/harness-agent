import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { assertToolProtocol } from "@ar/contracts";
import { OpenAICompatibleProvider } from "@ar/model";
import { createHarness } from "./create-harness.js";

const frame = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;

async function fixture(mode: "reset-once" | "sse-error" | "always-reset" | "text" | "reasoning" | "tool" | "cancel") {
  const cwd = await mkdtemp(join(tmpdir(), "ar-stream-http-"));
  const requests: Record<string, unknown>[] = [];
  const controller = new AbortController();
  const server = createServer((req, res) => { void (async () => {
    if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"data":[{"id":"http-local"}]}'); return; }
    let raw = ""; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
    if (mode === "cancel") { res.write(": keepalive\n\n"); setTimeout(() => controller.abort(), 20); return; }
    if (requests.length === 1 || mode === "always-reset") {
      if (mode === "sse-error") { res.end(`data: ${JSON.stringify({ error: { message: "temporary overload", status: 503 } })}\n\n`); return; }
      if (mode === "text") res.write(frame({ content: "partial answer" }));
      else if (mode === "reasoning") res.write(frame({ reasoning_content: "private partial reasoning" }));
      else if (mode === "tool") res.write(frame({ tool_calls: [{ index: 0, id: "partial", function: { name: "write_file", arguments: '{"path":"unsafe.txt"' } }] }));
      else res.write(": keepalive\n\n");
      setTimeout(() => res.destroy(), 20); return;
    }
    if (requests.length === 2) res.end(frame({ tool_calls: [{ index: 0, id: "actual-write", type: "function", function: {
      name: "write_file", arguments: JSON.stringify({ path: "recovered.txt", content: "one committed write\n" }),
    } }] }, "tool_calls") + "data: [DONE]\n\n");
    else res.end(frame({ content: "verified local HTTP completion" }, "stop") + "data: [DONE]\n\n");
  })().catch(() => { if (!res.destroyed) res.destroy(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const provider = new OpenAICompatibleProvider({ apiKey: "offline-http-test", baseUrl: `http://127.0.0.1:${port}/v1`, modelId: "http-local",
    requestPolicy: { maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 5000 } });
  const harness = await createHarness({ cwd, profile: "test", modelProvider: provider, model: { providerId: "openai", modelId: "http-local" } });
  const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd });
  const run = async () => { const turn = await harness.runtime.startTurn(session.id, "Write recovered.txt once, then finish."); return harness.runtime.runTurn(session.id, turn.id, controller.signal); };
  const close = async () => { controller.abort(); await harness.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(cwd, { recursive: true, force: true }); };
  return { cwd, harness, session, requests, run, close };
}

it.each(["reset-once", "sse-error"] as const)("recovers %s through actual HTTP and writes the real file exactly once", async mode => {
  const f = await fixture(mode);
  try {
    expect((await f.run()).status).toBe("completed");
    expect(await readFile(join(f.cwd, "recovered.txt"), "utf8")).toBe("one committed write\n");
    expect(f.requests).toHaveLength(3); expect(f.requests[0]).toEqual(f.requests[1]);
    const events = await f.harness.events.list(f.session.id);
    expect(events.filter(event => event.type === "model.retry")).toHaveLength(1);
    expect(events.filter(event => event.type === "tool.requested" && event.payload.name === "write_file")).toHaveLength(1);
    assertToolProtocol(await f.harness.store.listMessages(f.session.id));
  } finally { await f.close(); }
});

it.each(["text", "reasoning", "tool", "cancel"] as const)("does not replay %s after a real streaming interruption or human cancellation", async mode => {
  const f = await fixture(mode);
  try {
    expect((await f.run()).status).toBe(mode === "cancel" ? "cancelled" : "failed");
    expect(f.requests).toHaveLength(1);
    await expect(readFile(join(f.cwd, "recovered.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(f.cwd, "unsafe.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const events = await f.harness.events.list(f.session.id);
    expect(events.filter(event => event.type === "model.retry" || event.type === "tool.requested")).toHaveLength(0);
  } finally { await f.close(); }
});

it("persistent no-output connection resets fail within the existing three-attempt budget", async () => {
  const f = await fixture("always-reset");
  try { expect((await f.run()).status).toBe("failed"); expect(f.requests).toHaveLength(3);
    expect((await f.harness.events.list(f.session.id)).filter(event => event.type === "model.retry")).toHaveLength(2);
  } finally { await f.close(); }
});
