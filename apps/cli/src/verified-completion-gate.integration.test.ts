/**
 * P 轮 — the verified-completion gate's INSTALL claim on the REAL harness loop.
 *
 * The plan's P1/P2 acceptance is not "a flag exists": a real ModelRequest must
 * carry the EXACT gate bytes (and no other candidate's text), the default must
 * stay untouched, the arm identity must be its own, and a champion that declares
 * the gate together with any other guidance mechanism must be refused.
 *
 * Offline and deterministic: a scripted provider, zero paid calls.
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
  VERIFIED_COMPLETION_GATE_CANDIDATE_ID,
  VERIFIED_COMPLETION_GATE_GUIDANCE_V1,
  computeRuntimeConfigHash,
  getArmFactory,
  verifiedCompletionGateGuidanceDigest,
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

/** Sentences that exist ONLY in one candidate's text. */
const GATE_ONLY = "Report success only from output you actually observed";
const V1_ONLY = "do not re-read a\n  file you have already read";
const V2_ONLY = "make the freshness check an explicit step";

async function fixture(): Promise<{ cwd: string; dataDir: string }> {
  const root = await fs.mkdtemp(join(tmpdir(), "ar-p-completion-gate-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  const dataDir = join(root, "data");
  await fs.mkdir(join(cwd, "spec"), { recursive: true });
  await fs.mkdir(dataDir);
  await fs.writeFile(
    join(cwd, "check.js"),
    [
      '"use strict";',
      'const { value } = require("./src/value.js");',
      'if (value !== 12) { console.error("expected 12, got " + value); process.exit(1); }',
      'console.log("ok");',
      "",
    ].join("\n"),
  );
  await fs.mkdir(join(cwd, "src"), { recursive: true });
  await fs.writeFile(join(cwd, "src", "value.js"), '"use strict";\nmodule.exports = { value: 4 };\n');
  return { cwd, dataDir };
}

function provider(requests: ModelRequest[]): ModelProvider {
  return {
    id: "p-completion-gate",
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
                toolCalls: [{ id: newToolCallId(), name: "read_file", args: { path: "check.js", versioned: true } }],
              },
              timestamp: 0,
            };
            return;
          }
          yield {
            type: "completed",
            result: { finishReason: "stop", text: "check.js expects 12; I will change src/value.js and rerun it." },
            timestamp: 0,
          };
        },
      };
    },
  };
}

async function runOnce(guidance: string | undefined): Promise<{ harness: Harness; requests: ModelRequest[] }> {
  const fx = await fixture();
  const requests: ModelRequest[] = [];
  const harness = await createHarness({
    cwd: fx.cwd,
    dataDir: fx.dataDir,
    profile: "test",
    model: { providerId: "p-completion-gate", modelId: "scripted" },
    modelProvider: provider(requests),
    contextBudget: { maxTokens: 32_000, reserved: { system: 256, task: 128, output: 256 }, dynamic: 0 },
    ...(guidance === undefined ? {} : { completionGuidance: guidance }),
  });
  const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd: fx.cwd });
  const turn = await harness.runtime.startTurn(session.id, "Make `node check.js` pass, then report.");
  await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
  return { harness, requests };
}

describe("P — the gate guidance reaches the real model request", () => {
  it("1. the installed gate bytes are in the request and no other candidate's text is", async () => {
    const { harness, requests } = await runOnce(VERIFIED_COMPLETION_GATE_GUIDANCE_V1);
    try {
      expect(requests.length).toBeGreaterThanOrEqual(2);
      for (const request of requests) {
        const system = request.system ?? "";
        expect(system).toContain(VERIFIED_COMPLETION_GATE_GUIDANCE_V1);
        expect(system).toContain(GATE_ONLY);
        expect(system).not.toContain(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1);
        expect(system).not.toContain(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2);
        expect(system).not.toContain(V1_ONLY);
        expect(system).not.toContain(V2_ONLY);
      }
      // The digest of the observed block is the gate digest — not a label.
      const observed = requests[0]!.system ?? "";
      const block = observed.slice(observed.indexOf("\nVerified completion guidance:"));
      const crypto = await import("node:crypto");
      expect(verifiedCompletionGateGuidanceDigest()).toBe(
        crypto
          .createHash("sha256")
          .update(block.slice(0, VERIFIED_COMPLETION_GATE_GUIDANCE_V1.length), "utf8")
          .digest("hex"),
      );
    } finally {
      await harness.close();
    }
  });

  it("2. another candidate installed leaves the gate out, and the default installs neither", async () => {
    const v2Arm = await runOnce(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2);
    try {
      for (const request of v2Arm.requests) {
        const system = request.system ?? "";
        expect(system).toContain(V2_ONLY);
        expect(system).not.toContain(GATE_ONLY);
      }
    } finally {
      await v2Arm.harness.close();
    }

    const atDefault = await runOnce(undefined);
    try {
      expect(atDefault.requests.length).toBeGreaterThan(0);
      for (const request of atDefault.requests) {
        const system = request.system ?? "";
        expect(system).not.toContain(GATE_ONLY);
        expect(system).not.toContain(V1_ONLY);
        expect(system).not.toContain(V2_ONLY);
      }
    } finally {
      await atDefault.harness.close();
    }
  });
});

describe("P — arm identity and the champion install plan", () => {
  const mk = (candidate?: string): BenchmarkCommandOptions =>
    ({ suite: "regression", candidate } as unknown as BenchmarkCommandOptions);

  it("3. the gate arm's prompt and hashed runtime config are its own", () => {
    const baseline = runtimeConfigForHash(mk(), 32000);
    const v1 = runtimeConfigForHash(mk("context_safe_tool_call_efficiency_v1"), 32000);
    const v2 = runtimeConfigForHash(mk("context_safe_tool_call_efficiency_v2"), 32000);
    const gate = runtimeConfigForHash(mk(VERIFIED_COMPLETION_GATE_CANDIDATE_ID), 32000);

    expect(baseline.systemPrompt).toBe(BENCHMARK_SYSTEM_PROMPT);
    expect(gate.systemPrompt).toBe(BENCHMARK_SYSTEM_PROMPT + VERIFIED_COMPLETION_GATE_GUIDANCE_V1);

    const mechanismsOf = (c: unknown): Record<string, unknown> =>
      (c as { mechanisms: Record<string, unknown> }).mechanisms;
    expect("verifiedCompletionGate" in mechanismsOf(baseline)).toBe(false);
    expect("verifiedCompletionGate" in mechanismsOf(v1)).toBe(false);
    expect("verifiedCompletionGate" in mechanismsOf(v2)).toBe(false);
    expect(mechanismsOf(gate).verifiedCompletionGate).toBe(true);

    for (const other of [baseline, v1, v2]) {
      expect(computeRuntimeConfigHash(gate)).not.toBe(computeRuntimeConfigHash(other));
    }

    const factory = getArmFactory();
    expect(
      benchmarkModelVisibleSystemPrompt(factory.resolveRuntimeMechanisms(VERIFIED_COMPLETION_GATE_CANDIDATE_ID)),
    ).toBe(BENCHMARK_SYSTEM_PROMPT + VERIFIED_COMPLETION_GATE_GUIDANCE_V1);
    expect(benchmarkModelVisibleSystemPrompt(factory.resolveRuntimeMechanisms(null))).toBe(BENCHMARK_SYSTEM_PROMPT);
    expect(factory.resolveRuntimeMechanisms(VERIFIED_COMPLETION_GATE_CANDIDATE_ID).promptAdditionsDigest).toBe(
      verifiedCompletionGateGuidanceDigest(),
    );
  });

  it("4. the install plan accepts the gate alone and refuses it with any other guidance mechanism", () => {
    const alone = championMechanismInstallPlan({ verifiedCompletionGate: true });
    expect(alone.ok).toBe(true);
    expect(alone.supported.verifiedCompletionGate).toBe(true);

    // Every guidance mechanism shares one `completionGuidance` slot.
    expect(championMechanismInstallPlan({ verifiedCompletionGate: true, budgetAwareCompletion: true }).ok).toBe(false);
    expect(championMechanismInstallPlan({ verifiedCompletionGate: true, toolCallEfficiency: true }).ok).toBe(false);
    expect(championMechanismInstallPlan({ verifiedCompletionGate: true, contextSafeToolCallEfficiency: true }).ok).toBe(false);
    expect(championMechanismInstallPlan({ verifiedCompletionGate: true, contextSafeToolCallEfficiencyV2: true }).ok).toBe(false);
    // A single guidance mechanism still installs.
    expect(championMechanismInstallPlan({ contextSafeToolCallEfficiencyV2: true }).ok).toBe(true);
  });
});
