import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { newSessionId, newToolCallId, newTurnId, type ToolDefinition } from "@ar/contracts";
import { createHarness } from "./create-harness.js";
import { ScriptedModelProvider } from "@ar/model";
const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it.each([false, true])("protects real production tool events, including split credentials and capped previews (durable=%s)", async durable => {
  const cwd = await mkdtemp(join(tmpdir(), "final-tool-event-")); paths.push(cwd);
  const dataDir = durable ? await mkdtemp(join(tmpdir(), "final-tool-event-data-")) : undefined; if (dataDir) paths.push(dataDir);
  const harness = await createHarness({ cwd, ...(dataDir ? { dataDir } : {}), profile: "interactive", modelProvider: new ScriptedModelProvider([]), model: { providerId: "scripted", modelId: "scripted-model" } });
  const secret = "sk-" + "a19b".repeat(12), fragments = ["OPENAI_API_", "KEY=sk-", "a19b".repeat(12), "\n"];
  const tool: ToolDefinition = { name: "emit_test_output", description: "Emit synthetic test output", inputSchema: z.object({}), risk: "readonly",
    metadata: { name: "emit_test_output", version: "1", sideEffect: false, filesystem: false, network: false, process: false, interactive: false, retry: "safe" },
    async execute(_input, context) {
      for (const text of fragments) context.onOutput?.({ stream: "stdout", text });
      context.onOutput?.({ stream: "progress", text: "API_KEY=" + secret });
      return { status: "success", output: { stdout: "x".repeat(480) + "API_KEY=" + secret }, evidence: [{ type: "file", description: "API_KEY=" + secret, source: cwd, timestamp: Date.now() }] };
    } };
  harness.registry.register(tool);
  const sessionId = newSessionId();
  try {
    const result = await harness.orchestrator.execute({ id: newToolCallId(), sessionId, agentId: harness.agents[0]!.id, turnId: newTurnId(), call: { id: newToolCallId(), name: tool.name, args: {} } }, {
      sessionId, cwd, signal: new AbortController().signal, sandboxPolicy: { filesystem: { mode: "workspace-write", allowedPaths: [cwd] }, network: { mode: "deny" }, process: {} },
      agentId: harness.agents[0]!.id,
      permissions: { defaultEffect: "allow", rules: [] },
    });
    expect(result.status).toBe("success");
    const events = await harness.events.list(sessionId);
    const serialized = JSON.stringify(events); expect(serialized).not.toContain(secret);
    const replayed = events.filter(event => event.type === "tool.output").map(event => event.payload.text ?? "").join("");
    expect(replayed).not.toContain(secret); expect(replayed).not.toContain("OPENAI_API_KEY=sk-");
    expect(events.some(event => event.type === "tool.completed")).toBe(true);
    expect(events.filter(event => event.type === "tool.output").every(event => event.payload.withheld === true)).toBe(true);
  } finally { await harness.close(); }
});
