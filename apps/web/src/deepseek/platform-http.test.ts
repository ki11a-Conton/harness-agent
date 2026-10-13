import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { request as requestHttp } from "node:http";
import { createHarness } from "@ar/harness";
import { ScriptedModelProvider } from "@ar/model";
import { WebChannelAdapter } from "../adapter.js";
import { SessionBindings } from "../bindings.js";
import { WebServer } from "../server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function stack() {
  const provider = new ScriptedModelProvider([]);
  const harness = await createHarness({ cwd: process.cwd(), profile: "interactive", modelProvider: provider,
    model: { providerId: provider.id, modelId: "platform-http-fixture" } });
  const server = new WebServer({ adapter: new WebChannelAdapter(), bindings: new SessionBindings(),
    events: harness.events, store: harness.store, approvalStore: harness.approvalStore, deepseekServices: [], host: "127.0.0.1", port: 0 });
  const { port } = await server.start();
  cleanups.push(async () => { await server.stop(); await harness.close(); });
  return { server, base: `http://127.0.0.1:${port}` };
}

async function within<T>(promise: Promise<T>, milliseconds = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_done, reject) => {
      timer = setTimeout(() => reject(new Error("HTTP lifecycle did not settle within its deadline")), milliseconds);
    })]);
  } finally { clearTimeout(timer!); }
}

async function graph(base: string, signal: AbortSignal) {
  const response = await fetch(base + "/plugins/events", { signal });
  expect(response.status).toBe(200); expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder(); let buffered = "";
  while (!buffered.includes("\n\n")) {
    const chunk = await within(reader.read()); if (chunk.done) throw new Error("Plugin graph SSE closed before its baseline");
    buffered += decoder.decode(chunk.value, { stream: true });
  }
  const line = buffered.split("\n").find(item => item.startsWith("data: "));
  if (line === undefined) throw new Error("Plugin graph SSE has no data frame");
  return { response, reader, frame: JSON.parse(line.slice(6)) as { type: string; graph: { entries: Array<{ id: string; url: string; rev: string }> } } };
}

function rawHeaders(url: string, headers: Record<string, string>) {
  // Node fetch normalizes Host to its URL authority. Use the actual HTTP
  // request boundary to ensure the adversarial Host reaches the server.
  return new Promise<{ status: number | undefined; contentType: string | undefined }>((resolve, reject) => {
    const request = requestHttp(url, { headers }, response => {
      response.resume(); resolve({ status: response.statusCode, contentType: response.headers["content-type"] });
    });
    request.once("error", reject); request.end();
  });
}

describe("Official Web platform HTTP routes", () => {
  it("sends the complete actual local boot-manifest graph over a real EventSource SSE carrier", async () => {
    const { base } = await stack(); const controller = new AbortController();
    try {
      const actual = await graph(base, controller.signal);
      const expected: unknown = JSON.parse(await readFile(new URL("../../public/deepseek/boot-manifest.json", import.meta.url), "utf8"));
      expect(actual.frame.type).toBe("graph"); expect(actual.frame.graph).toEqual(expected);
      expect(actual.frame.graph.entries).toHaveLength(66);
      for (const entry of actual.frame.graph.entries) {
        expect(entry.url.startsWith("/deepseek/")).toBe(true);
        expect((await fetch(base + entry.url)).status).toBe(200);
      }
    } finally { controller.abort(); }
  });

  it("returns a real headless native-application capability catalog", async () => {
    const { base } = await stack(); const response = await fetch(base + "/open-in-app/apps", { headers: { Origin: base } });
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ apps: [] });
  });

  it("enforces the same Host, Origin and cross-site boundaries on both additional routes", async () => {
    const { base } = await stack();
    const adversarialHeaders: Array<Record<string, string>> = [
      { Host: "attacker.invalid" },
      { Origin: "https://attacker.invalid" },
      { "Sec-Fetch-Site": "cross-site" },
    ];
    for (const route of ["/plugins/events", "/open-in-app/apps"]) {
      for (const headers of adversarialHeaders) {
        const response = await rawHeaders(base + route, headers); expect(response.status).toBe(403);
        expect(response.contentType).toContain("application/json");
      }
    }
  });

  it("keeps independent plugin SSE subscribers alive and closes every one during host stop", async () => {
    const { base, server } = await stack(); const controllers = [new AbortController(), new AbortController()];
    try {
      const first = await graph(base, controllers[0]!.signal); const second = await graph(base, controllers[1]!.signal);
      expect(first.frame.graph).toEqual(second.frame.graph);
      await within(server.stop());
      expect((await within(first.reader.read())).done).toBe(true);
      expect((await within(second.reader.read())).done).toBe(true);
    } finally { for (const controller of controllers) controller.abort(); }
  });
});
