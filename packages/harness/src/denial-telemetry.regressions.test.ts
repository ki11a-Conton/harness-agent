import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ScriptedModelProvider } from "@ar/model";
import { createHarness } from "./create-harness.js";

it.each(["permission", "sandbox", "write-safety"])("actual %s refusal is observable exactly once without a write", async kind => {
  const root = await mkdtemp(join(tmpdir(), "denial-telemetry-"));
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const target = kind === "sandbox" ? join(root, "outside.txt") : join(cwd, "existing.txt");
  const original = "original\n".repeat(kind === "write-safety" ? 2000 : 1);
  await writeFile(target, original);
  const provider = new ScriptedModelProvider([
    ScriptedModelProvider.toolCall("write_file", { path: target, content: "forbidden replacement\n" }),
    ScriptedModelProvider.text("The refused write was not performed."),
  ]);
  const harness = await createHarness({ cwd, profile: "interactive", modelProvider: provider,
    model: { providerId: provider.id, modelId: "scripted-model" }, limits: { maxToolCalls: 4 } });
  try {
    const agent = { ...harness.agents[0]!, permissions: { defaultEffect: kind === "permission" ? "deny" as const : "allow" as const, rules: [] } };
    const session = await harness.runtime.createSession({ agent, cwd });
    const turn = await harness.runtime.startTurn(session.id, "Attempt the write once, then report the actual refusal");
    await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    const events = await harness.events.list(session.id);
    const requested = events.find(event => event.type === "tool.requested" && (event.payload.tool ?? event.payload.name) === "write_file");
    expect(requested).toBeDefined();
    const denial = events.filter(event => event.turnId === turn.id && event.type.startsWith("security.")
      && event.type.endsWith("_denied") && event.payload.toolCallId === requested!.payload.toolCallId);
    expect(denial).toHaveLength(1);
    expect(denial[0]!.type).toBe(kind === "permission" ? "security.permission_denied" : "security.filesystem_denied");
    expect(await readFile(target, "utf8")).toBe(original);
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});
