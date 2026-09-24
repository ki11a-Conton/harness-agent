/**
 * E4-R16 — N12 regressions:
 *
 *   1. the strategy INSTALLED at startup is the EXACT text EVALUATED by the
 *      benchmark (shared strategy-layer definition) — the old "similar
 *      meaning" startup-side rewrite is a drift defect;
 *   2. the mechanism implementation digest binds the actual guidance text, so
 *      a rewritten strategy changes the arm digest / execution identity /
 *      promotion target even when the candidateId is unchanged;
 *   3. a PENDING promotion claim with no promotion evidence (evidenceRef) is
 *      never applied/PROVEN — it stays quarantined.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createHarness } from "@ar/harness";
import type { ModelProvider, ModelRef, ProviderConfig, ModelEvent } from "@ar/contracts";
import {
  applyPromotion,
  createInitialChampionState,
  getArmFactory,
  budgetAwareCompletionGuidanceDigest,
  computeSnapshotDigest,
  BUDGET_AWARE_COMPLETION_GUIDANCE_V1,
  type ChampionState,
} from "@ar/evaluation";
import { championStateDigest, writeChampionStateFileCas } from "./champion-state-file.js";
import { createHarnessWithChampion, CHAMPION_BUDGET_AWARE_GUIDANCE } from "./champion-application.js";
import { BUDGET_AWARE_COMPLETION_GUIDANCE } from "./benchmark-command.js";

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

function baseConfig() {
  const { provider, model } = capturingProvider();
  return {
    cwd: dir,
    dataDir: join(dir, "data"),
    profile: "interactive" as const,
    modelProvider: provider,
    model,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "e4-r16-"));
  statePath = join(dir, "champion-state.json");
  captured = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("E4-R16: installed strategy == evaluated strategy (N12)", () => {
  it("the champion-installed guidance is byte-identical to the benchmark-evaluated guidance", () => {
    // N12's STRATEGY_DRIFT repro: the startup used a DIFFERENT "similar
    // meaning" text than the benchmark. Both sides must consume the SAME
    // shared strategy-layer definition.
    expect(CHAMPION_BUDGET_AWARE_GUIDANCE).toBe(BUDGET_AWARE_COMPLETION_GUIDANCE);
    expect(CHAMPION_BUDGET_AWARE_GUIDANCE).toBe(BUDGET_AWARE_COMPLETION_GUIDANCE_V1);
  });

  it("the mechanism implementation digest binds the ACTUAL guidance text", () => {
    const arm = getArmFactory().resolveCandidate("budget_aware_completion_v1");
    // The arm's promptAdditionsDigest is the real sha256 of the strategy text.
    expect(arm.promptAdditionsDigest).toBe(budgetAwareCompletionGuidanceDigest());
    expect(arm.promptAdditionsDigest).toMatch(/^[0-9a-f]{64}$/);
    // A REWRITTEN strategy text (same candidateId) changes the digest — an old
    // evaluation can never authorize the new implementation.
    const rewritten = createHash("sha256").update(BUDGET_AWARE_COMPLETION_GUIDANCE_V1 + "\n- NEW: always verify twice.").digest("hex");
    expect(rewritten).not.toBe(budgetAwareCompletionGuidanceDigest());
  });

  it("a REAL startup installs the shared evaluated text (observed in the main agent prompt)", async () => {
    const c0 = createInitialChampionState();
    const pending = applyPromotion(c0, "budget_aware_completion_v1", {}, "runs/evidence.json", {
      envelopeDigest: sha("env"),
      decisionEnvelopeDigest: sha("dec"),
    });
    await writeChampionStateFileCas(pending, championStateDigest(c0), statePath);
    const out = await createHarnessWithChampion({
      runtimeEntrypoint: "cli",
      baseConfig: baseConfig(),
      stateFilePath: statePath,
      sourceSha: sha("src"),
    });
    expect(out.status).toBe("applied");
    const main = out.harness.agents.find((a) => a.name === "main");
    expect(main).toBeDefined();
    expect(main!.systemPrompt).toContain(BUDGET_AWARE_COMPLETION_GUIDANCE_V1.split("\n")[2]!.trim());
    expect(main!.systemPrompt).toContain("Budget-aware completion guidance:");
    await out.harness.close();
  });

  it("a PENDING claim with NO promotion evidence is refused — never applied/PROVEN", async () => {
    // Hand-written quarantined state with NO evidenceRef (a forged/legacy
    // pending claim). The startup must refuse it and leave it unapplied.
    const forged: ChampionState = {
      schemaVersion: "1.0.0",
      level: "C1",
      candidateId: "budget_aware_completion_v1",
      configPatch: {},
      evidenceRef: null, // NO promotion evidence
      history: [],
      applied: false,
      validity: "QUARANTINED_PENDING_REEVALUATION",
    };
    await writeFile(statePath, JSON.stringify(forged), "utf8");
    const out = await createHarnessWithChampion({
      runtimeEntrypoint: "cli",
      baseConfig: baseConfig(),
      stateFilePath: statePath,
      sourceSha: sha("src"),
    });
    expect(out.status).toBe("profileRejected");
    expect(out.reason).toMatch(/evidence/i);
    expect(out.proof).toBeNull();
    // The state is NOT applied / PROVEN — the baseline runs instead.
    const main = out.harness.agents.find((a) => a.name === "main");
    expect(main!.systemPrompt).not.toContain("Budget-aware completion guidance:");
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as ChampionState;
    expect(persisted.applied).toBe(false);
    expect(persisted.validity).toBe("QUARANTINED_PENDING_REEVALUATION");
    await out.harness.close();
  });

  it("a PENDING claim WITH evidence proceeds to a real application (control)", async () => {
    const c0 = createInitialChampionState();
    const pending = applyPromotion(c0, "budget_aware_completion_v1", {}, "runs/evidence.json", {
      envelopeDigest: sha("env"),
      decisionEnvelopeDigest: sha("dec"),
    });
    await writeChampionStateFileCas(pending, championStateDigest(c0), statePath);
    const out = await createHarnessWithChampion({
      runtimeEntrypoint: "cli",
      baseConfig: baseConfig(),
      stateFilePath: statePath,
      sourceSha: sha("src"),
    });
    expect(out.status).toBe("applied");
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as ChampionState;
    expect(persisted.applied).toBe(true);
    expect(persisted.validity).toBe("PROVEN");
    await out.harness.close();
  });

  it("the shared digest flows into the promotion target (arm digest is text-bound)", () => {
    // The arm digest (computeSnapshotDigest) includes promptAdditionsDigest —
    // a guidance edit therefore changes the arm digest and with it the R15
    // promotion target's expectedConfigDigest, even with the same candidateId.
    const arm = getArmFactory().resolveCandidate("budget_aware_completion_v1");
    const armDigestWithText = arm.digest;
    // Recompute the arm digest with a hypothetical rewritten guidance.
    const rewrittenDigest = createHash("sha256").update(BUDGET_AWARE_COMPLETION_GUIDANCE_V1 + " rewritten").digest("hex");
    const snapshot = { ...arm, promptAdditionsDigest: rewrittenDigest, digest: undefined };
    expect(computeSnapshotDigest(snapshot as never)).not.toBe(armDigestWithText);
  });
});
