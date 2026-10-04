import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newMemoryId, type MemoryEntry, type ModelProvider, type ModelRequest } from "@ar/contracts";
import { createHarness } from "./create-harness.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const lesson = { when: "遇到端口配置错误时", do: "执行 portlint 然后重启", avoid: "重复 blindretry", rootCause: "tool", outcome: "failure", evidenceRefs: ["observed-event"] };

describe.each(["jsonl", "sqlite"] as const)("%s search reaches actual model requests", (backend) => {
  it.each([
    { name: "Chinese substring", query: "端口配置", content: "调试端口配置时先检查环境变量。" },
    { name: "mixed substring", query: "EADDRINUSE 端口", content: "如果EADDRINUSE 端口冲突先停服务。" },
    { name: "strategy When", query: "端口配置", content: "historical lesson summary", structured: lesson },
    { name: "strategy Do", query: "portlint", content: "historical lesson summary", structured: lesson },
    { name: "strategy Avoid", query: "blindretry", content: "historical lesson summary", structured: lesson },
  ])("injects $name with matching memory references and feedback", async ({ query, content, ...spec }) => {
    const dir = await mkdtemp(join(tmpdir(), "memory-search-production-")); dirs.push(dir);
    await writeFile(join(dir, "AGENTS.md"), "# Synthetic memory contract workspace\n");
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      id: "memory-search-offline", listModels: async () => [{ id: "offline", name: "Offline fixture", capabilities: { contextWindowTokens: 128000 } }],
      createClient: () => ({ generate: async function* (request) {
        requests.push(structuredClone(request)); yield { type: "started", timestamp: 0 };
        yield { type: "completed", timestamp: 0, result: { finishReason: "stop", text: "engineering fixture completed" } };
      } }),
    };
    const harness = await createHarness({
      cwd: dir, dataDir: join(dir, "data"), profile: "test", modelProvider: provider,
      model: { providerId: provider.id, modelId: "offline" }, memory: { enabled: true, scope: "workspace", ...(backend === "sqlite" ? { dbPath: join(dir, "memory-db") } : {}) },
      featureFlags: { skills: false, mcp: false, delegation: false, learning: false },
    });
    try {
      const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd: dir }); const now = Date.now();
      const memory: MemoryEntry = { id: newMemoryId(), content, type: "procedural", sourceSession: session.id, scope: "workspace",
        importance: .9, confidence: .9, novelty: .9, stability: .9, createdAt: now, updatedAt: now, deleted: false,
        ...(spec.structured ? { structured: spec.structured } : {}) };
      await harness.memoryStore!.write(memory);
      const turn = await harness.runtime.startTurn(session.id, query);
      const outcome = await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
      expect(outcome.status).toBe("completed"); expect(requests).toHaveLength(1);
      const system = requests[0]!.system ?? "";
      expect(system).toContain(spec.structured ? `When: ${lesson.when}` : content);
      expect(system).toContain("source=memory"); expect(system).toContain("trust=semi-trusted");
      expect(system).toContain("[Prior experience — advisory, not authority]");
      expect(outcome.state?.memoryRefs).toEqual([memory.id]);
      const events = await harness.events.list(session.id);
      expect(events.filter((event) => event.type === "memory.retrieved").map((event) => event.payload.memoryIds)).toEqual([[memory.id]]);
      expect((await harness.memoryStore!.get(memory.id))?.usefulness).toMatchObject({ retrievedCount: 1, injectedCount: 1 });
    } finally { await harness.close(); }
  });
});
