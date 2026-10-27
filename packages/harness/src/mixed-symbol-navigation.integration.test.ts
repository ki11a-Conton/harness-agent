import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ModelProvider, ModelRequest } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { createHarness } from "./create-harness.js";

it("delivers mixed-language definitions and bounded long-line evidence to the next model request", async () => {
  const cwd = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "harness-mixed-navigation-")));
  await fs.writeFile(join(cwd, "frontend.ts"), `export const SharedSymbol = 1;\n${"x".repeat(12000)} SharedSymbol ${"y".repeat(3000)}\n`);
  await fs.writeFile(join(cwd, "worker.py"), "def SharedSymbol():\n    return 2\n");
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    id: "mixed-navigation-offline",
    listModels: async () => [{ id: "scripted", capabilities: { contextWindowTokens: 128000 } }],
    createClient: () => ({ async *generate(request) {
      requests.push(structuredClone(request));
      yield* requests.length === 1
        ? ScriptedModelProvider.toolCall("symbol_search", { symbol: "SharedSymbol" })
        : ScriptedModelProvider.text("Located the definitions.");
    } }),
  };
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness({ cwd, dataDir: join(cwd, "state"), profile: "test", modelProvider: provider,
      model: { providerId: provider.id, modelId: "scripted" },
      featureFlags: { skills: false, mcp: false, memory: false, delegation: false, learning: false } });
    const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd });
    const turn = await harness.runtime.startTurn(session.id, "Locate SharedSymbol in both components.");
    const result = await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(result.status).toBe("completed");
    expect(requests).toHaveLength(2);
    const toolMessage = requests[1]!.messages.filter(message => message.role === "tool").map(message => message.content).join("\n");
    expect(toolMessage).toContain("frontend.ts");
    expect(toolMessage).toContain("worker.py");
    expect(toolMessage).toContain("SharedSymbol");
    expect(toolMessage).toContain('"truncated":true');
    expect(Buffer.byteLength(toolMessage, "utf8")).toBeLessThan(10000);
  } finally {
    await harness?.close();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
