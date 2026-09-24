/**
 * P1 — production champion installs the SAME tool-call-efficiency strategy the
 * benchmark evaluates, and the application proof binds the installed bytes.
 *
 * Plan §P1 ("生产 champion 必须安装候选的同一策略，并验证安装事实"). The gap
 * (F1): a candidate that resolves `toolCallEfficiency=true` produced a
 * ChampionHarnessConfig with NO such field, so `championMechanismInstallPlan`
 * never demanded it, `createHarnessWithChampion` never installed the guidance,
 * and `projectChampionFieldChecks` never verified it — an `applied`/PROVEN
 * proof could be written on flags alone even though the model-visible prompt
 * was unchanged.
 *
 * These tests are BEHAVIORAL: they start the REAL createHarness with a temporary
 * state file and assert on the live agent prompt / resolved config / proof, not
 * on a pure mapper return. Offline, zero provider calls.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelProvider } from "@ar/model";
import {
  applyPromotion,
  createInitialChampionState,
  TOOL_CALL_EFFICIENCY_GUIDANCE_V1,
  type ChampionState,
} from "@ar/evaluation";
import { championStateDigest, readChampionStateFile, writeChampionStateFileCas } from "./champion-state-file.js";
import {
  championMechanismInstallPlan,
  projectChampionFieldChecks,
  createHarnessWithChampion,
  CHAMPION_TOOL_CALL_EFFICIENCY_GUIDANCE,
} from "./champion-application.js";

let dir: string;
let statePath: string;
let scriptedProvider: ScriptedModelProvider;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "e4-p1-"));
  statePath = join(dir, "champion-state.json");
  scriptedProvider = new ScriptedModelProvider([ScriptedModelProvider.text("hi")]);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function baseConfig(dataDir?: string) {
  return {
    cwd: dir,
    ...(dataDir !== undefined ? { dataDir } : {}),
    profile: "interactive" as const,
    modelProvider: scriptedProvider,
    model: { providerId: "scripted", modelId: "test-model" },
  };
}

async function writePendingState(candidateId: string): Promise<ChampionState> {
  const c0 = createInitialChampionState();
  const next = applyPromotion(c0, candidateId, {}, "runs/evidence.json");
  await writeChampionStateFileCas(next, championStateDigest(c0), statePath);
  return next;
}

describe("P1 — tool_call_efficiency_v1 is really installed at production startup", () => {
  it("RED→GREEN: startup INSTALLS the exact strategy text and the proof attests it", async () => {
    await writePendingState("tool_call_efficiency_v1");
    const outcome = await createHarnessWithChampion({
      runtimeEntrypoint: "cli",
      baseConfig: baseConfig(join(dir, "data")),
      stateFilePath: statePath,
      sourceSha: "e".repeat(40),
    });
    try {
      expect(outcome.status).toBe("applied");
      expect(outcome.proof).not.toBeNull();
      // The model-visible prompt carries the SAME bytes the benchmark sends.
      const main = outcome.harness.agents.find((a) => a.name === "main");
      expect(main!.systemPrompt.endsWith(TOOL_CALL_EFFICIENCY_GUIDANCE_V1)).toBe(true);
      // ...and the resolved config records that guidance.
      expect(outcome.harness.resolvedConfig.value.completionGuidance).toBe(TOOL_CALL_EFFICIENCY_GUIDANCE_V1);
    } finally {
      await outcome.harness.close();
    }
  });

  it("removing the install FAILS the application (never applied on flags alone)", async () => {
    await writePendingState("tool_call_efficiency_v1");
    const outcome = await createHarnessWithChampion({
      runtimeEntrypoint: "cli",
      baseConfig: baseConfig(join(dir, "no-mech")),
      stateFilePath: statePath,
      sourceSha: "f".repeat(40),
      createHarnessFn: async (config) => {
        const { createHarness } = await import("@ar/harness");
        return createHarness({ ...config, completionGuidance: undefined });
      },
    });
    try {
      expect(outcome.status).toBe("applicationFailed");
      expect(outcome.proof).toBeNull();
      expect(outcome.reason).toMatch(/completionGuidance|drift/i);
      const saved = (await readChampionStateFile(statePath)) as ChampionState;
      expect(saved.applied).toBe(false);
      expect(saved.appliedProof).toBeUndefined();
    } finally {
      await outcome.harness.close();
    }
  });

  it("the install plan recognizes the mechanism and refuses the mutually-exclusive pair", () => {
    // tool-call efficiency has a real production install point.
    expect(championMechanismInstallPlan({ toolCallEfficiency: true }).ok).toBe(true);
    // Both prompt-guidance mechanisms at once would inject two conflicting
    // system prompts — refuse rather than silently pick one.
    const both = championMechanismInstallPlan({ budgetAwareCompletion: true, toolCallEfficiency: true });
    expect(both.ok).toBe(false);
    expect(both.reason).toMatch(/mutually exclusive|conflicting/i);
  });

  it("the field checks bind the ACTUAL guidance bytes (target hash depends on the text)", () => {
    const resolved = { featureFlags: {} } as never;
    const origins = new Map<string, { source: string }>();
    const toolEff = projectChampionFieldChecks({}, undefined, false, true, resolved, origins);
    const budget = projectChampionFieldChecks({}, undefined, true, false, resolved, origins);
    const toolCheck = toolEff.find((c) => c.key === "completionGuidance");
    expect(toolCheck?.intended).toBe(TOOL_CALL_EFFICIENCY_GUIDANCE_V1);
    expect(toolCheck?.intended).toBe(CHAMPION_TOOL_CALL_EFFICIENCY_GUIDANCE);
    const budgetCheck = budget.find((c) => c.key === "completionGuidance");
    // Different mechanisms bind different guidance → different intended bytes.
    expect(toolCheck?.intended).not.toBe(budgetCheck?.intended);
  });
});