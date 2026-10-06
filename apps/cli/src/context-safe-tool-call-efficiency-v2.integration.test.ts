/**
 * N7 / N7-1 — the v2 challenger's INSTALL claim, exercised on the REAL harness
 * loop and through the production install slot.
 *
 * N7-1's acceptance criterion is not "a flag exists": the plan requires that a
 * real ModelRequest carries the EXACT v2 strategy bytes and that the v1 bytes are
 * neither present nor substituted. These tests establish, offline and with zero
 * paid calls:
 *
 *   1. the v2 block reaches the real model request when installed through the
 *      SAME `completionGuidance` slot production uses, and the v1-only rule text
 *      does NOT reach it (so v1 and v2 can never be confused at the request
 *      boundary);
 *   2. at the default (nothing installed) the request carries neither block —
 *      default behaviour is unchanged;
 *   3. the arm identity for the v2 candidate differs from the baseline and from
 *      the v1 candidate in BOTH the model-visible prompt and the hashed runtime
 *      config, so a manifest can never conflate them;
 *   4. the champion install plan accepts v2 alone and REFUSES v2 together with
 *      any other guidance mechanism (they share one slot).
 */

import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newToolCallId, type ModelEvent, type ModelProvider, type ModelRequest } from "@ar/contracts";
import { createHarness, type Harness } from "@ar/harness";
import {
  CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1,
  CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2,
  CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_CANDIDATE_ID,
  computeRuntimeConfigHash,
  contextSafeToolCallEfficiencyV2GuidanceDigest,
  getArmFactory,
} from "@ar/evaluation";
import {
  BENCHMARK_SYSTEM_PROMPT,
  benchmarkModelVisibleSystemPrompt,
  runtimeConfigForHash,
  type BenchmarkCommandOptions,
} from "./benchmark-command.js";
import { championMechanismInstallPlan } from "./champion-application.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** A sentence that exists ONLY in the v1 text and one that exists ONLY in v2. */
const V1_ONLY = "do not re-read a\n  file you have already read";
const V2_ONLY = "make the freshness check an explicit step";

async function fixture(): Promise<{ cwd: string; dataDir: string }> {
  const root = await fs.mkdtemp(join(tmpdir(), "ar-n7-context-safe-v2-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  const dataDir = join(root, "data");
  await fs.mkdir(join(cwd, "spec"), { recursive: true });
  await fs.mkdir(dataDir);
  await fs.writeFile(
    join(cwd, "spec", "build-policy.txt"),
    ["# CI policy", "", "The build fleet fixes one job count per pipeline.", "", "build_jobs = 12", ""].join("\n"),
  );
  return { cwd, dataDir };
}

function provider(requests: ModelRequest[]): ModelProvider {
  return {
    id: "n7-context-safe-v2",
    async listModels() {
      return [{ id: "scripted", name: "scripted", capabilities: { contextWindowTokens: 32_000 } }];
    },
    createClient() {
      return {
        async *generate(request: ModelRequest): AsyncGenerator<ModelEvent> {
          requests.push(structuredClone(request));
          const call = requests.length;
          yield { type: "started", timestamp: 0 };
          if (call === 1) {
            yield {
              type: "completed",
              result: {
                finishReason: "tool_calls",
                toolCalls: [{ id: newToolCallId(), name: "read_file", args: { path: "spec/build-policy.txt", versioned: true } }],
              },
              timestamp: 0,
            };
            return;
          }
          yield { type: "completed", result: { finishReason: "stop", text: "read complete" }, timestamp: 0 };
        },
      };
    },
  };
}

async function runOnce(
  guidance: string | undefined,
): Promise<{ harness: Harness; requests: ModelRequest[] }> {
  const fx = await fixture();
  const requests: ModelRequest[] = [];
  const harness = await createHarness({
    cwd: fx.cwd,
    dataDir: fx.dataDir,
    profile: "test",
    model: { providerId: "n7-context-safe-v2", modelId: "scripted" },
    modelProvider: provider(requests),
    contextBudget: { maxTokens: 32_000, reserved: { system: 256, task: 128, output: 256 }, dynamic: 0 },
    ...(guidance === undefined ? {} : { completionGuidance: guidance }),
  });
  const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd: fx.cwd });
  const turn = await harness.runtime.startTurn(session.id, "Read spec/build-policy.txt, then stop.");
  await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
  return { harness, requests };
}

describe("N7/N7-1 — the v2 guidance reaches the real model request", () => {
  it("1. installed v2 bytes are in the request, and the v1-only rule is not", async () => {
    const { harness, requests } = await runOnce(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2);
    try {
      expect(requests.length).toBeGreaterThanOrEqual(2);
      for (const request of requests) {
        const system = request.system ?? "";
        expect(system).toContain(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2);
        expect(system).toContain(V2_ONLY);
        expect(system).not.toContain(V1_ONLY);
        expect(system).not.toContain(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1);
      }
      // The digest of the injected block is the v2 digest — not a label.
      const observed = requests[0]!.system ?? "";
      const block = observed.slice(observed.indexOf("\nTool-call efficiency guidance:"));
      expect(contextSafeToolCallEfficiencyV2GuidanceDigest()).toBe(
        (await import("node:crypto")).createHash("sha256").update(block.slice(0, CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2.length), "utf8").digest("hex"),
      );
    } finally {
      await harness.close();
    }
  });

  it("2. with the v1 block installed the v2-only rule is absent (the two are distinguishable at the boundary)", async () => {
    const { harness, requests } = await runOnce(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1);
    try {
      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        const system = request.system ?? "";
        expect(system).toContain(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1);
        expect(system).not.toContain(V2_ONLY);
        expect(system).not.toContain(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2);
      }
    } finally {
      await harness.close();
    }
  });

  it("3. at the default neither block is installed (default behaviour unchanged)", async () => {
    const { harness, requests } = await runOnce(undefined);
    try {
      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        const system = request.system ?? "";
        expect(system).not.toContain(V2_ONLY);
        expect(system).not.toContain(V1_ONLY);
      }
    } finally {
      await harness.close();
    }
  });
});

describe("N7/N7-1 — arm identity and the champion install plan", () => {
  const mk = (candidate?: string): BenchmarkCommandOptions =>
    ({ suite: "regression", candidate } as unknown as BenchmarkCommandOptions);

  it("4. the v2 arm's prompt and hashed runtime config are its own", () => {
    const baseline = runtimeConfigForHash(mk(), 32000);
    const v1 = runtimeConfigForHash(mk("context_safe_tool_call_efficiency_v1"), 32000);
    const v2 = runtimeConfigForHash(mk(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_CANDIDATE_ID), 32000);

    expect(baseline.systemPrompt).toBe(BENCHMARK_SYSTEM_PROMPT);
    expect(v1.systemPrompt).toBe(BENCHMARK_SYSTEM_PROMPT + CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1);
    expect(v2.systemPrompt).toBe(BENCHMARK_SYSTEM_PROMPT + CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2);

    const mechanismsOf = (c: unknown): Record<string, unknown> =>
      (c as { mechanisms: Record<string, unknown> }).mechanisms;
    expect("contextSafeToolCallEfficiency" in mechanismsOf(baseline)).toBe(false);
    expect("contextSafeToolCallEfficiencyV2" in mechanismsOf(baseline)).toBe(false);
    expect(mechanismsOf(v1).contextSafeToolCallEfficiencyV2).toBeUndefined();
    expect(mechanismsOf(v2).contextSafeToolCallEfficiencyV2).toBe(true);
    expect(mechanismsOf(v2).contextSafeToolCallEfficiency).toBeUndefined();

    expect(computeRuntimeConfigHash(v2)).not.toBe(computeRuntimeConfigHash(v1));
    expect(computeRuntimeConfigHash(v2)).not.toBe(computeRuntimeConfigHash(baseline));

    // The single model-visible builder agrees with the hashed config.
    const factory = getArmFactory();
    expect(
      benchmarkModelVisibleSystemPrompt(factory.resolveRuntimeMechanisms(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_CANDIDATE_ID)),
    ).toBe(BENCHMARK_SYSTEM_PROMPT + CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2);
    expect(benchmarkModelVisibleSystemPrompt(factory.resolveRuntimeMechanisms(null))).toBe(BENCHMARK_SYSTEM_PROMPT);
  });

  it("5. the install plan accepts v2 alone and refuses it with any other guidance mechanism", () => {
    const alone = championMechanismInstallPlan({ contextSafeToolCallEfficiencyV2: true });
    expect(alone.ok).toBe(true);
    expect(alone.supported.contextSafeToolCallEfficiencyV2).toBe(true);
    expect(alone.supported.contextSafeToolCallEfficiency).toBe(false);

    // v1 and v2 are two versions of the SAME slot.
    expect(championMechanismInstallPlan({ contextSafeToolCallEfficiency: true, contextSafeToolCallEfficiencyV2: true }).ok).toBe(false);
    expect(championMechanismInstallPlan({ budgetAwareCompletion: true, contextSafeToolCallEfficiencyV2: true }).ok).toBe(false);
    expect(championMechanismInstallPlan({ toolCallEfficiency: true, contextSafeToolCallEfficiencyV2: true }).ok).toBe(false);
    // A single guidance mechanism still installs.
    expect(championMechanismInstallPlan({ contextSafeToolCallEfficiency: true }).ok).toBe(true);
  });
});
