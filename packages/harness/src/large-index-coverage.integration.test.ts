import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ModelProvider, ModelRequest } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { createHarness } from "./create-harness.js";

it("delivers skipped-source coverage to the next real model request", async () => {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "harness-index-coverage-")));
  const cwd = join(base, "repo"); await fs.mkdir(cwd);
  await fs.writeFile(join(cwd, "visible.ts"), "export const SharedSymbol = 1;\n");
  const file = await fs.open(join(cwd, "oversized.ts"), "w");
  await file.truncate(24 * 1024 * 1024 + 1); await file.close();
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    id: "index-coverage-offline",
    listModels: async () => [{ id: "scripted", capabilities: { contextWindowTokens: 128000 } }],
    createClient: () => ({ async *generate(request) {
      requests.push(structuredClone(request));
      yield* requests.length === 1
        ? ScriptedModelProvider.toolCall("symbol_search", { symbol: "SharedSymbol" })
        : ScriptedModelProvider.text("A file was skipped; further inspection is needed.");
    } }),
  };
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness({ cwd, dataDir: join(base, "state"), profile: "test", modelProvider: provider,
      model: { providerId: provider.id, modelId: "scripted" },
      featureFlags: { skills: false, mcp: false, memory: false, delegation: false, learning: false } });
    const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd });
    const turn = await harness.runtime.startTurn(session.id, "Locate SharedSymbol and report incomplete coverage.");
    const result = await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(result.status).toBe("completed"); expect(requests).toHaveLength(2);
    const toolMessage = requests[1]!.messages.filter(message => message.role === "tool").map(message => message.content).join("\n");
    expect(toolMessage).toContain("visible.ts");
    expect(toolMessage).toContain('"complete":false');
    expect(toolMessage).toContain('"skippedOversizedFiles":1');
  } finally {
    await harness?.close(); await fs.rm(base, { recursive: true, force: true });
  }
});
