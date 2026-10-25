import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import {
  newAgentId,
  newSessionId,
  newToolCallId,
  newTurnId,
  type ToolExecutionContext,
} from "@ar/contracts";
import {
  ManagedCommands,
  ManagedCommandOrchestrator,
} from "./managed-commands.js";
import { ToolRegistry } from "./registry.js";
it("reserves all 16 pending spawns globally, refuses the 17th and drains before close acknowledgment", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "managed-capacity-")),
  );
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const deadlineAt = Date.now() + 10000;
  const controllers = Array.from({ length: 17 }, () => new AbortController());
  const manager = new ManagedCommands({
    resolveAuthority: async (context) => ({
      signal: context.signal,
      deadlineAt,
    }),
    save: async () => gate,
  });
  const registry = new ToolRegistry();
  for (const tool of manager.tools()) registry.register(tool);
  const dispatcher = new ManagedCommandOrchestrator(
    { registry, workspaceRoot: root },
    manager,
  );
  try {
    for (let i = 0; i < 17; i++) {
      const cwd = join(root, String(i));
      await mkdir(cwd);
      const context: ToolExecutionContext = {
        cwd,
        sessionId: newSessionId(),
        turnId: newTurnId(),
        agentId: newAgentId(),
        signal: controllers[i]!.signal,
        permissions: { rules: [], defaultEffect: "allow" },
        sandboxPolicy: {
          filesystem: { mode: "workspace-write", allowedPaths: [root] },
          network: { mode: "deny" },
          process: { timeoutMs: 5000 },
        },
      };
      const id = newToolCallId();
      const result = await dispatcher.execute(
        {
          id,
          sessionId: context.sessionId,
          turnId: context.turnId,
          agentId: context.agentId,
          call: {
            id,
            name: "exec_start",
            args: {
              command: process.execPath,
              args: ["-e", "require('node:fs').writeFileSync('late','bad')"],
              yieldMs: 0,
            },
          },
        },
        context,
      );
      expect(result.status).toBe(i === 16 ? "denied" : "success");
    }
    let acknowledged = false;
    const close = manager.close().then(() => {
      acknowledged = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(acknowledged).toBe(false);
    for (const controller of controllers) controller.abort();
    release();
    await close;
    for (let i = 0; i < 17; i++)
      expect(await readdir(join(root, String(i)))).toEqual([]);
  } finally {
    for (const controller of controllers) controller.abort();
    release();
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});
