import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { newMemoryId, newMessageId, type MemoryEntry } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { createHarness } from "./create-harness.js";
import { createCodingPromptPolicy } from "./coding-prompt-policy.js";

it("C4 scoped on-demand tools run through actual Runtime and cannot search another session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "on-demand-memory-"));
  const provider = new ScriptedModelProvider([
    ScriptedModelProvider.toolCall("memory_search", { query: "portlint", k: 1, maxTokens: 128 }),
    ScriptedModelProvider.toolCall("session_search", { query: "marker", k: 8, maxTokens: 128, sessionId: "invented-other-session" }),
    ScriptedModelProvider.text("offline fixture finished"),
  ]);
  const harness = await createHarness({ cwd: dir, dataDir: join(dir, "state"), profile: "test", modelProvider: provider,
    model: { providerId: provider.id, modelId: "scripted-model" }, memory: { enabled: true, scope: "workspace", onDemand: true },
    agentPromptPolicy: createCodingPromptPolicy("coding-v2"), featureFlags: { skills: false, learning: false } });
  try {
    const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd: dir });
    const other = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd: dir });
    await harness.store.appendMessage({ id: newMessageId(), sessionId: other.id, role: "user", content: "marker foreign-private-record", createdAt: Date.now() });
    const memory: MemoryEntry = { id: newMemoryId(), type: "procedural", sourceSession: session.id, scope: "workspace",
      content: "portlint convention: inspect declared port configuration; " + "context ".repeat(500),
      importance: .9, confidence: .9, novelty: .9, stability: .9, createdAt: Date.now(), updatedAt: Date.now(), deleted: false };
    await harness.memoryStore!.write(memory);
    const turn = await harness.runtime.startTurn(session.id, "Inspect marker current-session");
    const result = await harness.runtime.runTurn(session.id, turn.id, AbortSignal.timeout(15000));
    expect(result.status).toBe("completed");
    const messages = await harness.store.listMessages(session.id);
    const outputs = messages.filter(message => message.role === "tool").map(message => message.content);
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toContain("portlint convention"); expect(outputs[0]).toContain('"truncated":true');
    expect(outputs[1]).toContain("current-session"); expect(outputs[1]).not.toContain("foreign-private-record");
    for (const output of outputs) { expect(Buffer.byteLength(output)).toBeLessThanOrEqual(512); expect(JSON.parse(output).trust).toBe("semi-trusted"); }
    expect(harness.agents[0]!.tools.allow).toContain("memory_search");
    expect((await harness.events.list(session.id)).some(event => event.type === "tool.completed")).toBe(true);
    // Deletion is honored by the shared bridge, not a separate stale cache.
    await harness.memoryStore!.remove(memory.id);
    const retrieved = await harness.memoryBridge!.retrieve({ sessionId: session.id, goal: "portlint", cwd: dir, recordFeedback: false });
    expect(retrieved.items).toHaveLength(0);
  } finally { await harness.close(); await rm(dir, { recursive: true, force: true }); }
});
