import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { newMemoryId, type MemoryEntry, type ModelProvider, type ModelRequest } from "@ar/contracts";
import { createHarness } from "./create-harness.js";
it("injects valid stored memory and completes a real runtime turn beside corrupt JSONL metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "production-invalid-memory-")), dataDir = join(dir, "data");
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = { id: "memory-integrity", listModels: async () => [{ id: "offline", name: "Offline", capabilities: { contextWindowTokens: 128000 } }],
    createClient: () => ({ generate: async function* (request) { requests.push(structuredClone(request)); yield { type: "started", timestamp: 0 }; yield { type: "completed", timestamp: 0, result: { finishReason: "stop", text: "checked" } }; } }) };
  const harness = await createHarness({ cwd: dir, dataDir, profile: "test", modelProvider: provider, model: { providerId: provider.id, modelId: "offline" }, memory: { enabled: true, scope: "workspace" }, featureFlags: { skills: false, mcp: false, delegation: false, learning: false } });
  try {
    const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd: dir });
    const good: MemoryEntry = { id: newMemoryId(), content: "needle valid-memory-sentinel: run project checks", type: "explicit", sourceSession: session.id, scope: "workspace", importance: 0.8, confidence: 0.9, novelty: 0.6, stability: 0.7, createdAt: Date.now(), updatedAt: Date.now(), deleted: false };
    await harness.memoryStore!.write(good);
    const owners = await readdir(join(dataDir, "memory-scopes")); expect(owners).toHaveLength(1);
    const path = join(dataDir, "memory-scopes", owners[0]!, "memories.jsonl"), raw = await readFile(path, "utf8");
    const bad = { ...good, id: newMemoryId(), content: "needle corrupt-memory-sentinel", structured: null };
    await writeFile(path, JSON.stringify(bad) + "\n" + raw);
    const turn = await harness.runtime.startTurn(session.id, "needle"), outcome = await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("completed"); expect(requests).toHaveLength(1);
    const prompt = JSON.stringify(requests[0]); expect(prompt).toContain("valid-memory-sentinel"); expect(prompt).not.toContain("corrupt-memory-sentinel");
    expect((await harness.memoryStore!.get(good.id))?.usefulness?.injectedCount).toBe(1);
    expect(await harness.memoryStore!.get(bad.id)).toMatchObject({ content: bad.content, structured: null });
  } finally { await harness.close(); await rm(dir, { recursive: true, force: true }); }
});
