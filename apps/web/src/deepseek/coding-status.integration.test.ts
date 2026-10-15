import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createHarness } from "@ar/harness";
import { ScriptedModelProvider } from "@ar/model";
import { projectSessionHistory } from "./projections.js";
import { codingStatusOf } from "./coding-status.js";

it("C7 actual commands, edits and verification remain separate in the browser status", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "coding-status-"));
  const provider = new ScriptedModelProvider([
    ScriptedModelProvider.toolCall("exec", { command: process.execPath, args: ["-e", "process.exit(2)"] }),
    ScriptedModelProvider.toolCall("write_file", { path: "code #1.ts", content: "export const value = 2;\n" }),
    ScriptedModelProvider.text("The fixture has stopped."),
  ]);
  const harness = await createHarness({ cwd, dataDir: join(cwd, "state"), profile: "test", modelProvider: provider,
    model: { providerId: provider.id, modelId: "scripted-model" }, featureFlags: { skills: false, learning: false } });
  try {
    const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd });
    const turn = await harness.runtime.startTurn(session.id, "Inspect failure and make a focused edit");
    await harness.runtime.runTurn(session.id, turn.id, AbortSignal.timeout(10000));
    const projection = projectSessionHistory({ session: (await harness.store.getSession(session.id))!, events: await harness.events.list(session.id), messages: await harness.store.listMessages(session.id) });
    const status = codingStatusOf(projection);
    expect(status.status).toBe("completed"); expect(status.verification).toBe("unrun");
    expect(status.commands).toHaveLength(1); expect(status.commands[0]).toMatchObject({ exitCode: 2, failed: true });
    expect(status.files).toHaveLength(1); expect(status.files[0]!.editorUri).toContain("code%20%231.ts:1");
    expect(status.files[0]!.editorUri).toMatch(/^vscode:\/\/file\//);
    const replay = codingStatusOf({ ...projection, records: [...projection.records,
      { type: "event", event: { type: "harness/verification.completed", seq: projection.cursor + 1, time: 1000, data: { payload: { passed: true } } } },
      { type: "event", event: { type: "turn/start", seq: projection.cursor + 2, time: 1001, data: { turn: 2 } } },
    ] });
    expect(replay.verification).toBe("unrun"); expect(replay.status).toBe("running"); expect(replay.commands).toHaveLength(0);
  } finally { await harness.close(); await rm(cwd, { recursive: true, force: true }); }
});
