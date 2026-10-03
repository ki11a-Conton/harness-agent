import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProvider, ProviderConfig } from "@ar/contracts";
import { OpenAICompatibleProvider } from "@ar/model";
import { runBenchmarkCommand } from "./benchmark-command.js";

let root: string;
let http: Server | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "benchmark-request-policy-"));
  await mkdir(join(root, "cases", "single"), { recursive: true });
  await writeFile(join(root, "cases", "single", "request.md"), "Reply once with OK.");
  await writeFile(join(root, "cases", "single", "expected.md"), "No artifact required.");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENAI_MODEL", "");
  vi.stubEnv("OPENAI_MAX_RETRIES", "0");
  vi.stubEnv("OPENAI_RETRY_DELAY_MS", "0");
  vi.stubEnv("OPENAI_REQUEST_TIMEOUT_MS", "2000");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (http) {
    http.closeAllConnections();
    await new Promise<void>((done, reject) => http!.close(error => error ? reject(error) : done()));
    http = undefined;
  }
  await rm(root, { recursive: true, force: true });
});
const argv = () => ["--cases", join(root, "cases"), "--out", join(root, "out"), "--provider", "openai", "--model", "offline-fixture", "--max-logical-runs", "1", "--max-model-calls", "10"];
async function dry(extra: string[] = [], provider?: ModelProvider) {
  const result = await runBenchmarkCommand([...argv(), ...extra, "--dry-run"], provider);
  expect(result.exitCode, result.lines.join("\n")).toBe(0);
  return JSON.parse(result.lines.join("\n")) as { planDigest: string; providerCalls: number; effectiveModelParams: Record<string, unknown> };
}

describe("benchmark request policy confirmation", () => {
  it.each([
    ["OPENAI_MAX_RETRIES", "9"],
    ["OPENAI_RETRY_DELAY_MS", "900"],
    ["OPENAI_REQUEST_TIMEOUT_MS", "120000"],
  ])("changes the keyless plan digest when %s changes", async (name, value) => {
    const first = await dry();
    vi.stubEnv(name, value);
    const second = await dry();
    expect(second.planDigest).not.toBe(first.planDigest);
    expect(first.providerCalls).toBe(0);
    expect(second.providerCalls).toBe(0);
    expect(first.effectiveModelParams.providerRequestPolicy).toEqual({ maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 2000 });
  });

  it("refuses an old digest after a policy change before a physical request", async () => {
    let requests = 0;
    http = createServer((request, response) => { requests++; request.resume(); response.end(); });
    await new Promise<void>(done => http!.listen(0, "127.0.0.1", done));
    const endpoint = `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`;
    const first = await dry(["--endpoint", endpoint]);
    vi.stubEnv("OPENAI_MAX_RETRIES", "9");
    vi.stubEnv("OPENAI_API_KEY", "offline-not-a-credential");
    vi.stubEnv("RUN_PAID_BENCHMARKS", "1");
    const result = await runBenchmarkCommand([...argv(), "--endpoint", endpoint, "--plan-digest", first.planDigest]);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("plan digest mismatch");
    expect(requests).toBe(0);
  });

  it("passes the frozen identity policy into a real client after environment mutation", async () => {
    let requests = 0;
    http = createServer((request, response) => {
      requests++;
      request.resume();
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"offline"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>(done => http!.listen(0, "127.0.0.1", done));
    const real = new OpenAICompatibleProvider({ apiKey: "offline-not-a-credential", baseUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1` });
    const seen: ProviderConfig[] = [];
    const provider: ModelProvider = { id: "openai", listModels: () => real.listModels(), createClient(ref, config) {
      seen.push(config);
      vi.stubEnv("OPENAI_MAX_RETRIES", "9");
      vi.stubEnv("OPENAI_RETRY_DELAY_MS", "900");
      vi.stubEnv("OPENAI_REQUEST_TIMEOUT_MS", "0");
      return real.createClient(ref, config);
    } };
    const confirmed = await dry([], provider);
    const result = await runBenchmarkCommand([...argv(), "--plan-digest", confirmed.planDigest], provider);
    expect(requests, result.lines.join("\n")).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 2000 });
    expect(confirmed.effectiveModelParams.providerRequestPolicy).toEqual({ maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 2000 });
  });

  it("does not add OpenAI policy identity to an unrelated injected provider", async () => {
    const provider: ModelProvider = { id: "another-offline-provider", listModels: async () => [], createClient: () => { throw new Error("dry-run must not construct a client"); } };
    const first = await dry([], provider);
    vi.stubEnv("OPENAI_MAX_RETRIES", "9");
    const second = await dry([], provider);
    expect(second.planDigest).toBe(first.planDigest);
    expect(first.effectiveModelParams.providerRequestPolicy).toBeUndefined();
  });
});
