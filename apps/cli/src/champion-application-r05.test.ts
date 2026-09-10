/**
 * E4-R05 — F12: a champion's mechanism must be INSTALLED and observable after a
 * real startup (not just flags), and F13: a CAS race must close the stale
 * harness and return the baseline, never the old champion instance.
 *
 * All offline: real createHarness, temp dirs only, a capturing fake provider.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createHarness } from "@ar/harness";
import type { ModelProvider, ModelRef, ProviderConfig, ModelEvent } from "@ar/contracts";
import {
  applyPromotion,
  createInitialChampionState,
  type ChampionState,
} from "@ar/evaluation";
import { championStateDigest, writeChampionStateFileCas } from "./champion-state-file.js";
import { createHarnessWithChampion } from "./champion-application.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

let dir: string;
let statePath: string;
let captured: string[];

function capturingProvider(): { provider: ModelProvider; model: ModelRef } {
  const model: ModelRef = { providerId: "cap", modelId: "cap-model" };
  const provider: ModelProvider = {
    id: "cap",
    async listModels() {
      return [{ id: model.modelId, name: "capture", capabilities: { contextWindowTokens: 128_000 } }];
    },
    createClient(_model: ModelRef, _config: ProviderConfig) {
      return {
        async *generate(request: unknown): AsyncGenerator<ModelEvent, void, void> {
          captured.push((request as { system?: string }).system ?? "");
          yield { type: "started", timestamp: 0 };
          yield { type: "text_delta", text: "ok", timestamp: 0 };
          yield { type: "completed", result: { finishReason: "stop", text: "ok" }, timestamp: 0 };
        },
      };
    },
  };
  return { provider, model };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "e4-r05-"));
  statePath = join(dir, "champion-state.json");
  captured = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function baseConfig(dataDir?: string) {
  const { provider, model } = capturingProvider();
  return {
    cwd: dir,
    ...(dataDir !== undefined ? { dataDir } : {}),
    profile: "interactive" as const,
    modelProvider: provider,
    model,
  };
}

async function writePendingState(candidateId: string, configPatch: Record<string, unknown>): Promise<ChampionState> {
  const c0 = createInitialChampionState();
  const next = applyPromotion(c0, candidateId, configPatch, "runs/evidence.json");
  await writeChampionStateFileCas(next, championStateDigest(c0), statePath);
  return next;
}

describe("E4-R05 mechanism installation + CAS race", () => {
  it("F12: budget-aware champion startup INSTALLS the guidance in the real main agent prompt", async () => {
    await writePendingState("budget_aware_completion_v1", {});
    const out = await createHarnessWithChampion({
      runtimeEntrypoint: "cli",
      baseConfig: baseConfig(join(dir, "data")),
      stateFilePath: statePath,
      sourceSha: sha("src"),
    });
    expect(out.status).toBe("applied");
    const main = out.harness.agents.find((a) => a.name === "main");
    expect(main).toBeDefined();
    expect(main!.systemPrompt).toContain("prioritize running the verification command");
    await out.harness.close();
  });

  it("F12: the baseline (C0) has NO budget guidance after startup", async () => {
    const c0 = createInitialChampionState();
    await writeChampionStateFileCas(c0, championStateDigest(c0), statePath);
    const out = await createHarnessWithChampion({
      runtimeEntrypoint: "cli",
      baseConfig: baseConfig(join(dir, "data")),
      stateFilePath: statePath,
    });
    expect(out.status).toBe("baseline");
    const main = out.harness.agents.find((a) => a.name === "main");
    expect(main!.systemPrompt).not.toContain("prioritize running the verification command");
    await out.harness.close();
  });

  it("F12: real turn REQUEST carries the installed guidance (mechanism observable, not a flag)", async () => {
    await writePendingState("budget_aware_completion_v1", {});
    const out = await createHarnessWithChampion({
      runtimeEntrypoint: "cli",
      baseConfig: baseConfig(join(dir, "data")),
      stateFilePath: statePath,
      sourceSha: sha("src"),
    });
    expect(out.status).toBe("applied");
    const main = out.harness.agents.find((a) => a.name === "main")!;
    const session = await out.harness.runtime.createSession({ agent: main, cwd: dir });
    const turn = await out.harness.runtime.startTurn(session.id, "please fix control.txt");
    await out.harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    // One real turn reached the provider; its SYSTEM prompt carries the guidance.
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.join("\n")).toContain("prioritize running the verification command");
    await out.harness.close();
  });

  it("F13: CAS race — stale champion harness is CLOSED and the baseline is returned", async () => {
    await writePendingState("budget_aware_completion_v1", {});
    let racerClosed = false;
    let raced = false;
    const out = await createHarnessWithChampion({
      runtimeEntrypoint: "cli",
      baseConfig: baseConfig(join(dir, "data")),
      stateFilePath: statePath,
      sourceSha: sha("src"),
      // While the champion harness is being created, another process advances
      // the state, so this startup's CAS write fails.
      createHarnessFn: async (config) => {
        if (!raced) {
          raced = true;
          const fresh = JSON.parse(await readFile(statePath, "utf8")) as ChampionState;
          const advanced = applyPromotion(fresh, "memory_retrieval", { memory: true }, "runs/other.json");
          await writeChampionStateFileCas(advanced, championStateDigest(fresh), statePath);
        }
        const h = await createHarness(config);
        const originalClose = h.close.bind(h);
        h.close = async () => {
          racerClosed = true;
          return originalClose();
        };
        return h;
      },
    });
    expect(raced).toBe(true);
    expect(out.status).toBe("applicationFailed");
    expect(out.reason).toContain("CAS");
    // The stale (champion-configured) harness was closed — it does not serve.
    expect(racerClosed).toBe(true);
    // The harness we RUN is the BASELINE, not the old champion: no budget guidance.
    const main = out.harness.agents.find((a) => a.name === "main");
    expect(main!.systemPrompt).not.toContain("prioritize running the verification command");
    await out.harness.close();
  });
});