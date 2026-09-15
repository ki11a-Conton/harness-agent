// P3-6 end-to-end: a real worker subagent writes into an ISOLATED child
// workspace and the parent harness physically merges the patch back into the
// parent root. Unlike delegation-tools.test (mock delegator/manager), this
// walks the full createHarness → runtime → real Delegator → real
// DefaultChildWorkspaceManager → ToolOrchestrator path.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  newSessionId,
  newToolCallId,
  newTurnId,
  type AgentDefinition,
  type ModelEvent,
  type ModelProvider,
  type ModelRef,
  type ProviderConfig,
} from "@ar/contracts";
import { createHarness } from "./create-harness.js";

let tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ar-worker-e2e-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

/** Scripted provider: yields the next ModelEvent script per generate() call. */
function scriptedProvider(script: (ModelEvent[] | ((requestSystem: string) => ModelEvent[]))[]) {
  let index = 0;
  const provider: ModelProvider = {
    id: "scripted-worker",
    async listModels() {
      return [{ id: "w", name: "worker", capabilities: { contextWindowTokens: 128_000 } }];
    },
    createClient(_m: ModelRef, _c: ProviderConfig) {
      return {
        async *generate(request: unknown): AsyncGenerator<ModelEvent, void, void> {
          const entry = script[Math.min(index, script.length - 1)];
          index += 1;
          const entryEvents = typeof entry === "function" ? entry((request as { system?: string }).system ?? "") : (entry ?? []);
          for (const event of entryEvents) yield event;
        },
      };
    },
  };
  const model: ModelRef = { providerId: "scripted-worker", modelId: "w" };
  return { provider, model, calls: () => index };
}

function text(text: string): ModelEvent[] {
  return [
    { type: "started", timestamp: 0 },
    { type: "text_delta", text, timestamp: 0 },
    { type: "completed", result: { finishReason: "stop", text }, timestamp: 0 },
  ];
}

function toolCall(name: string, args: Record<string, unknown>): ModelEvent[] {
  const id = newToolCallId();
  return [
    { type: "started", timestamp: 0 },
    { type: "tool_call_delta", toolCall: { id, name, args }, timestamp: 0 },
    {
      type: "completed",
      result: { finishReason: "tool_calls", toolCalls: [{ id, name, args }] },
      timestamp: 0,
    },
  ];
}

describe("P3-6 end-to-end: delegate_worker writes an isolated copy and merges", () => {
  it("child writes to an isolated root; parent physically receives the patch", async () => {
    const cwd = await tempDir();
    const dataDir = await tempDir();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "a.ts"), "export const a = 1;\n");

    const fixtureText = "export function helper() { return 42; }\n";
    const { provider, model } = scriptedProvider([
      // 0: parent calls delegate_worker
      toolCall("delegate_worker", { goal: "implement src/helper.ts" }),
      // 1: worker calls write_file inside its isolated root
      toolCall("write_file", { path: "src/helper.ts", content: fixtureText }),
      // 2: worker reports done
      text("wrote src/helper.ts"),
      // 3: parent finishes
      text("the worker implemented it"),
    ]);

    const harness = await createHarness({
      cwd,
      dataDir,
      profile: "interactive",
      modelProvider: provider,
      model,
      delegation: { enabled: true, maxDepth: 2, maxConcurrent: 2 },
    });
    try {
      const main = harness.agents.find((a) => a.name === "main")!;
      // delegate_worker must be registered for the model to call it.
      expect(harness.registry.names()).toContain("delegate_worker");
      const session = await harness.runtime.createSession({ agent: main, cwd });
      const turn = await harness.runtime.startTurn(session.id, "implement the helper");
      // Auto-approve any approval request the delegate_worker tool raises
      // (interactive profile → exec:tool asks for approval).
      //
      // R72: this loop must be bound to the TEST's lifecycle, not to a fixed
      // 200×10ms budget. A fixed budget is a wall-clock race: on a loaded
      // runner the approval request can be raised after the loop has already
      // exited, leaving it pending. The turn then blocks until the 60s
      // approval expiry, the delegation never runs, and the later
      // `readFile(src/helper.ts)` fails with ENOENT — a misleading failure
      // that points at the merge path when the real cause is the harness
      // never approving. The loop now runs until the turn settles.
      let turnSettled = false;
      const autoApprove = (async () => {
        while (!turnSettled) {
          for (const req of harness.approvalStore.listPending()) {
            harness.approvalStore.resolve(req.id, "allow", "test");
          }
          await new Promise((r) => setTimeout(r, 10));
        }
      })();
      const outcome = await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
      turnSettled = true;
      await autoApprove;

      expect(outcome.status).toBe("completed");

      // R72: surface the ACTUAL worker/tool/merge outcome before asserting on
      // file content, so a failure never degrades into a bare ENOENT that
      // hides whether the child ran, wrote, or merged. Events are read first
      // because they are the authoritative record of what happened.
      const events = await harness.events.list(session.id);
      const types = events.map((e) => e.type);
      const childSessionId = events.find((e) => e.type === "subagent.started")?.payload.childSessionId as
        | string
        | undefined;
      const mergeOutput = events.find(
        (e) => e.type === "tool.completed" && e.payload.tool === "delegate_worker",
      )?.payload.outputPreview as string | undefined;

      expect(types).toContain("subagent.started");
      expect(types).toContain("subagent.completed");
      // The merge must report the file as applied — not conflicted/skipped.
      expect(mergeOutput).toContain("[workspace merge]");
      expect(mergeOutput).toContain("applied:");

      // The worker's write landed in the PARENT workspace via physical merge.
      const merged = await readFile(join(cwd, "src", "helper.ts"), "utf8");
      expect(merged).toBe(fixtureText);

      // The child session existed and completed its turn; the isolated root is
      // disposed after the delegation (the patch was already extracted).
      expect(childSessionId).toBeTruthy();
      const childTurns = await harness.store.listTurns(childSessionId as never);
      expect(childTurns.at(-1)?.status).toBe("completed");
    } finally {
      await harness.close();
    }
  });
});