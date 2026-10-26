import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { newAgentId, newSessionId, newToolCallId, newTurnId, type ToolExecutionContext } from "@ar/contracts";
import { ToolRegistry } from "./registry.js";
import { ToolOrchestrator } from "./orchestrator.js";
import { searchFilesTool } from "./tools/search-files.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ar-search-separator-"));
  await mkdir(join(root, "src", "nested"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "src", "nested", "b.ts"), "export const b = 2;\n");
  await writeFile(join(root, "src", "ignore.py"), "pass\n");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it.each([
  [".", "src/*.ts", ["src/a.ts"]],
  [".", "src\\*.ts", ["src/a.ts"]],
  [".", "src/**/*.ts", ["src/a.ts", "src/nested/b.ts"]],
  [".", "src\\**\\*.ts", ["src/a.ts", "src/nested/b.ts"]],
  ["src", "nested/*.ts", ["src/nested/b.ts"]],
  ["src", "nested\\*.ts", ["src/nested/b.ts"]],
  [".", "*.ts", ["src/a.ts", "src/nested/b.ts"]],
] as const)("search_files path=%s pattern=%s has consistent separator and basename matching", async (path, pattern, expected) => {
  const registry = new ToolRegistry(); registry.register(searchFilesTool);
  const orchestrator = new ToolOrchestrator({ registry, workspaceRoot: root });
  const context: ToolExecutionContext = {
    cwd: root, sessionId: newSessionId(), turnId: newTurnId(), agentId: newAgentId(), signal: new AbortController().signal,
    permissions: { rules: [{ action: "read", resource: "file", effect: "allow" }] },
    sandboxPolicy: { filesystem: { mode: "workspace-write" }, network: { mode: "deny" }, process: { maxOutputBytes: 100000 } },
  };
  for (const includeSummary of [false, true]) {
    const id = newToolCallId();
    const result = await orchestrator.execute({ id, sessionId: context.sessionId, turnId: context.turnId, agentId: context.agentId,
      call: { id, name: "search_files", args: { path, pattern, includeSummary } } }, context);
    expect(result.status).toBe("success");
    expect(result.output).toEqual(includeSummary ? { summary: { complete: true, limitReached: false }, hits: expected } : expected);
  }
});
