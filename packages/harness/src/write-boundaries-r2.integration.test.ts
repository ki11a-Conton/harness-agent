import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ModelProvider } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { createHarness } from "./create-harness.js";

it("a coding turn repairs invalid write content and verifies actual bytes without rereading", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "write-boundary-runtime-")));
  const before = "exports.value = 1;\n", after = "exports.value = 42; // 中文😀\n";
  let requests = 0, version = "";
  await writeFile(join(cwd, "value.cjs"), before);
  await writeFile(join(cwd, "check.cjs"), "require('node:assert/strict').equal(require('./value.cjs').value,42);console.log('WRITE_BOUNDARY_CHECK_PASSED');\n");
  const provider: ModelProvider = {
    id: "write-boundary-replay", listModels: async () => [{ id: "offline", capabilities: { contextWindowTokens: 128000 } }],
    createClient: () => ({ async *generate(request) {
      requests++;
      const last = request.messages.filter(m => m.role === "tool").at(-1)?.content ?? "";
      if (requests === 1) yield* ScriptedModelProvider.toolCall("read_file", { path: "value.cjs", versioned: true });
      else if (requests === 2) {
        version = /"sha256"\s*:\s*"([a-f0-9]{64})"/.exec(last)![1]!;
        yield* ScriptedModelProvider.toolCall("write_file", { path: "value.cjs", content: "exports.value = 42; // \ud800\n", expectedSha256: version });
      } else if (requests === 3) {
        expect(last).toContain("[failed]"); expect(last).toMatch(/Unicode|surrogate/i);
        expect(await readFile(join(cwd, "value.cjs"), "utf8")).toBe(before);
        yield* ScriptedModelProvider.toolCall("write_file", { path: "value.cjs", content: after, expectedSha256: version });
      } else if (requests === 4) {
        expect(last).not.toContain("[failed]"); expect(await readFile(join(cwd, "value.cjs"), "utf8")).toBe(after);
        yield* ScriptedModelProvider.toolCall("exec", { command: process.execPath, args: ["check.cjs"] });
      } else {
        expect(requests).toBe(5); expect(last).toContain("WRITE_BOUNDARY_CHECK_PASSED");
        yield* ScriptedModelProvider.text("Updated the actual code and verified it with the project check.");
      }
    } }),
  };
  const h = await createHarness({ cwd, dataDir: join(cwd, "state"), profile: "test", modelProvider: provider,
    model: { providerId: provider.id, modelId: "offline" }, limits: { maxDurationMs: 30000, maxToolCalls: 12 },
    featureFlags: { skills: false, mcp: false, memory: false, delegation: false, learning: false },
    sandboxPolicy: { filesystem: { mode: "workspace-write", allowedPaths: [cwd] }, network: { mode: "deny" }, process: { timeoutMs: 10000 } },
    task: { id: "write-boundaries", goal: "Repair and verify the value", completionPolicy: { requiresVerification: true },
      verification: [{ kind: "command", command: process.execPath, args: ["check.cjs"] }] },
  });
  try {
    const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd });
    const turn = await h.runtime.startTurn(session.id, "Fix the value and run the check.");
    const result = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(result.status, JSON.stringify({ result, requests })).toBe("completed"); expect(result.grade).toBe("verified_complete"); expect(requests).toBe(5);
    expect(await readFile(join(cwd, "value.cjs"), "utf8")).toBe(after);
    const events = await h.events.list(session.id);
    expect(events.filter(e => e.type === "tool.started" && e.payload.tool === "read_file")).toHaveLength(1);
    expect(events.some(e => e.type === "tool.completed" && e.payload.status === "failed")).toBe(true);
    expect(events.some(e => e.type === "verification.completed")).toBe(true);
  } finally {
    await h.close();
    await rm(cwd, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 8 : 0, retryDelay: 50 });
  }
}, 30000);
