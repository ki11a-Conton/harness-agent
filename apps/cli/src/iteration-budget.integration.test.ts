import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Session, TurnId } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { createDefaultDeps } from "./main.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each([
  { environment: undefined, explicit: undefined, ceiling: 20 },
  { environment: "23", explicit: undefined, ceiling: 23 },
  { environment: "Infinity", explicit: 2, ceiling: 2 },
])("CLI budget reaches the real RPC loop: $environment / $explicit gives $ceiling", async ({ environment, explicit, ceiling }) => {
  const cwd = await mkdtemp(join(tmpdir(), "ar-cli-iterations-")); roots.push(cwd);
  for (let i = 0; i < 22; i++) await writeFile(join(cwd, `file-${i}.txt`), `evidence ${i}`);
  const provider = new ScriptedModelProvider([...Array.from({ length: 22 }, (_, i) => ScriptedModelProvider.toolCall("read_file", { path: `file-${i}.txt` })), ScriptedModelProvider.text("Read all twenty-two files.")]);
  vi.stubEnv("HARNESS_MAX_ITERATIONS_PER_TURN", environment);
  const deps = await createDefaultDeps({ cwd, provider, ...(explicit === undefined ? {} : { maxIterationsPerTurn: explicit }) });
  try {
    const agents = await deps.rpc.request("agent.list") as Array<{ id: string }>;
    const session = await deps.rpc.request("session.create", { agentId: agents[0]!.id, cwd }) as Session;
    const turn = await deps.rpc.request("session.send", { sessionId: session.id, text: "Read all files" }) as { turnId: TurnId };
    const outcome = await deps.rpc.request("session.run", { sessionId: session.id, turnId: turn.turnId }) as { status: string; error?: { message: string } };
    expect(deps.resolvedConfig?.value.maxIterationsPerTurn).toBe(explicit ?? (environment === undefined ? undefined : 23));
    expect(outcome.status).toBe(ceiling === 23 ? "completed" : "failed");
    expect((await deps.events.list(session.id)).filter(event => event.type === "model.started")).toHaveLength(ceiling);
    if (ceiling < 23) expect(outcome.error?.message).toContain(`maxIterationsPerTurn (${ceiling})`);
  } finally { await (deps as typeof deps & { close?: () => Promise<void> }).close?.(); }
});

it("CLI rejects an invalid environment budget before provider discovery", async () => {
  vi.stubEnv("HARNESS_MAX_ITERATIONS_PER_TURN", "Infinity");
  const provider = new ScriptedModelProvider([]), list = vi.spyOn(provider, "listModels");
  await expect(createDefaultDeps({ provider })).rejects.toThrow(/positive safe integer/);
  expect(list).not.toHaveBeenCalled();
});
