import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertToolProtocol, type ModelRequest } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { expect, it } from "vitest";
import { createHarness } from "./create-harness.js";

const examples = [
  { path: "client.ts", query: "retryRequest", before: "const maxAttempts = 3;", after: "const delays = [50, 100, 200];" },
  { path: "reader.py", query: "read_page", before: "PAGE_LIMIT = 50", after: "    return rows[:PAGE_LIMIT]" },
  { path: "worker.go", query: "consumeJob", before: "const capacity = 8", after: "var queue = make(chan Job, capacity)" },
];

it.each(examples)("delivers the same local source evidence for $path in one search", async ({ path, query, before, after }) => {
  const cwd = await mkdtemp(join(tmpdir(), "ar-grep-context-pair-"));
  const source = ["// header", before, `${query}()`, after, "// footer", ""].join("\n");
  const task = `Locate ${query} in ${path} and identify the lines immediately before and after it.`;

  async function inspect(withContext: boolean) {
    const requests: ModelRequest[] = [];
    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("grep_search", { pattern: query, path, literal: true, ...(withContext ? { contextLines: 1 } : {}) }),
      ...(withContext ? [] : [ScriptedModelProvider.toolCall("read_file", { path, offset: 2, limit: 3 })]),
      ScriptedModelProvider.text("The search evidence is available."),
    ]);
    const createClient = provider.createClient.bind(provider);
    provider.createClient = (model, config) => {
      const client = createClient(model, config);
      return { async *generate(request, signal) { requests.push(request as ModelRequest); yield* client.generate(request, signal); } };
    };
    const harness = await createHarness({ cwd, profile: "test", modelProvider: provider,
      model: { providerId: provider.id, modelId: "scripted-model" } });
    try {
      const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd });
      const turn = await harness.runtime.startTurn(session.id, task);
      const outcome = await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
      expect(outcome.status).toBe("completed");
      for (const request of requests) assertToolProtocol(request.messages);
      expect(requests[0]?.tools?.find(tool => tool.name === "grep_search")?.inputSchema.properties).toHaveProperty("contextLines");
      const responses = requests.at(-1)!.messages.filter(message => message.role === "tool");
      const events = await harness.events.list(session.id);
      const tools = events.filter(event => event.type === "tool.requested").map(event => event.payload.name);
      return { requests: requests.length, responses, tools };
    } finally { await harness.close(); }
  }

  try {
    await writeFile(join(cwd, path), source);
    const baseline = await inspect(false);
    const candidate = await inspect(true);
    expect(baseline.tools).toEqual(["grep_search", "read_file"]);
    expect(candidate.tools).toEqual(["grep_search"]);
    expect([baseline.requests, candidate.requests]).toEqual([3, 2]);
    expect(JSON.parse(baseline.responses.at(-1)!.content).content).toBe([before, `${query}()`, after].join("\n"));
    expect(JSON.parse(candidate.responses.at(-1)!.content)).toMatchObject({
      hits: [{ file: path, line: 3, text: `${query}()` }],
      context: [{ file: path, line: 2, text: before }, { file: path, line: 4, text: after }],
    });
  } finally { await rm(cwd, { recursive: true, force: true, maxRetries: 8 }); }
});
