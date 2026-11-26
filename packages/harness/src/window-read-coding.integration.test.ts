import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { OpenAICompatibleProvider } from "@ar/model";
import { createCodingPromptPolicy } from "./coding-prompt-policy.js";
import { createHarness } from "./create-harness.js";

interface WireRequest {
  messages: { role: string; content?: string }[];
  tools: { function: { name: string; description: string; parameters: { properties: Record<string, unknown> } } }[];
}

it.each(["default", "window"] as const)("real HTTP coding turn uses %s orientation before the same verified edit", async mode => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ar-window-coding-")));
  const target = join(cwd, "values.cjs");
  const before = "exports.count = 1; // 数量😀\r\n" + "// existing source\n".repeat(10000);
  const after = before.replace("count = 1", "count = 42");
  const version = createHash("sha256").update(before).digest("hex");
  let requests = 0;
  let wireError: unknown;
  const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
  const server = createServer(async (request, response) => {
    try {
      expect(request.url).toBe("/v1/chat/completions");
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw) as WireRequest;
      const last = body.messages.filter(message => message.role === "tool").at(-1)?.content;
      let call: { name: string; args: object } | undefined;
      switch (++requests) {
        case 1: {
          const read = body.tools.find(tool => tool.function.name === "read_file")?.function;
          expect(read?.description).toContain("scan=window");
          expect(read?.parameters.properties.scan).toBeDefined();
          call = { name: "read_file", args: { path: "values.cjs", limit: 1, ...(mode === "window" ? { scan: "window" } : {}) } };
          break;
        }
        case 2: {
          const page = JSON.parse(last!);
          expect(page).toMatchObject({ content: "exports.count = 1; // 数量😀", nextOffset: 2, truncated: true });
          expect(page).not.toHaveProperty("sha256");
          if (mode === "window") {
            expect(page).toMatchObject({ scanComplete: false, scannedBytes: 65536 });
            expect(page).not.toHaveProperty("totalLines");
          } else expect(page).toMatchObject({ totalLines: 10001, bytes: Buffer.byteLength(before) });
          call = { name: "read_file", args: { path: "values.cjs", limit: 1, versioned: true } };
          break;
        }
        case 3: {
          const page = JSON.parse(last!);
          expect(page).toMatchObject({ totalLines: 10001, sha256: version });
          call = { name: "edit_file", args: { path: "values.cjs", expectedSha256: page.sha256,
            oldText: page.content, newText: page.content.replace("count = 1", "count = 42") } };
          break;
        }
        case 4:
          expect(JSON.parse(last!)).toHaveProperty("sha256", createHash("sha256").update(after).digest("hex"));
          call = { name: "exec", args: { command: process.execPath, args: ["check.cjs"] } };
          break;
        case 5:
          expect(last).toContain("WINDOW_READ_CODING_PASSED");
          break;
        default:
          throw new Error("unexpected model request");
      }
      const delta = call === undefined ? { content: "The count is updated and the actual project check passed." }
        : { tool_calls: [{ index: 0, id: `window-read-${requests}`, type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) } }] };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(frame({ choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] }) + "data: [DONE]\n\n");
    } catch (error) {
      wireError = error;
      response.writeHead(500);
      response.end("Loopback fixture assertion failed.");
    }
  });
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    await writeFile(target, before);
    await writeFile(join(cwd, "check.cjs"), "require('node:assert/strict').equal(require('./values.cjs').count,42);console.log('WINDOW_READ_CODING_PASSED');\n");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("loopback server did not bind");
    const provider = new OpenAICompatibleProvider({ apiKey: "window-test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`,
      modelId: "fixture", requestPolicy: { maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 10000 } });
    harness = await createHarness({ cwd, profile: "test", dataDir: join(cwd, "state"), modelProvider: provider,
      model: { providerId: provider.id, modelId: "fixture" }, agentPromptPolicy: createCodingPromptPolicy("coding-v2"),
      featureFlags: { skills: false, memory: false, mcp: false, learning: false, delegation: false },
      sandboxPolicy: { filesystem: { mode: "workspace-write", allowedPaths: [cwd] }, network: { mode: "deny" }, process: { timeoutMs: 10000 } },
      maxIterationsPerTurn: 8, limits: { maxToolCalls: 10, maxDurationMs: 30000 },
      task: { id: "window-read-coding", goal: "Update and verify exported count", completionPolicy: { requiresChangedFile: true, requiresVerification: true },
        verification: [{ kind: "artifact", path: "values.cjs", mustChange: true }, { kind: "command", command: process.execPath, args: ["check.cjs"] }] },
    });
    const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd });
    const turn = await harness.runtime.startTurn(session.id, "Find the current count, update it to 42, and run the project check.");
    const outcome = await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    if (wireError !== undefined) throw wireError;
    expect(outcome).toMatchObject({ status: "completed", grade: "verified_complete" });
    expect(requests).toBe(5);
    expect(await readFile(target, "utf8")).toBe(after);
    const events = await harness.events.list(session.id);
    expect(events.filter(event => event.type === "tool.requested").map(event => event.payload.name))
      .toEqual(["read_file", "read_file", "edit_file", "exec"]);
    expect(events.some(event => event.type === "verification.step_completed" && event.payload.passed === true)).toBe(true);
  } finally {
    try { await harness?.close(); }
    finally {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
      await rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    }
  }
}, 30000);
