/**
 * E4-R86 — offline replay of the R85-confirmed H2 failure fingerprint (plan
 * §R86.6: "use R85's NON-HOLDOUT traces to prove the new code changes the
 * TARGET mechanism"). No provider calls; no holdout per-case data is read.
 *
 * The committed R85 evidence (`docs/evidence/e4-r85-failure-taxonomy.json`)
 * records the H2 defect (id `H2-stall-gate-progress-blind`,
 * `status: CONFIRMED_HARNESS_DEFECT`) with its shared pattern:
 *   - termination_reason = tool_limit with tool_failures = 0,
 *   - retry_taxonomy.stallRecovery > 0 (recovery budget fully consumed),
 *   - an artifact verifier whose check was never reached.
 * and its minimal repro: "call the SAME tool with the SAME args six times
 * while every call returns a DIFFERENT result; the runtime ends with
 * run.limit_reached{limit:maxRepeatedToolCalls}".
 *
 * This test REPLAYS that recorded fingerprint against the FIXED runtime and
 * proves the target mechanism changed: the recorded
 * `maxRepeatedToolCalls` limit fingerprint no longer fires for the progress
 * shape (it converts to completion + `stall.progress_detected` evidence),
 * while NON-target traces (a genuine constant-result stall, an args-differing
 * sequence, and the alternating A->B pattern) keep their pre-R86 outcomes.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  AgentDefinition,
  ModelEvent,
  ModelProvider,
  ToolCallRequest,
  ToolExecutionContext,
  ToolResult,
} from "@ar/contracts";
import { DEFAULT_TOOL_SEMANTICS, newAgentId } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: "r86-replay-agent",
  description: "offline replay of the R85 H2 fingerprint",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "replay H2",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

const EVIDENCE_PATH = fileURLToPath(
  new URL("../../../../docs/evidence/e4-r85-failure-taxonomy.json", import.meta.url),
);

interface H2Record {
  id: string;
  status: string;
  fingerprint: string;
  affectedCases: number;
  samples: string[];
  sharedPattern: string;
  minimalRepro: string;
}

function loadH2Record(): H2Record {
  const doc = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8")) as {
    candidates: H2Record[];
    verdict: string;
  };
  const h2 = doc.candidates?.find((d) => d.id === "H2-stall-gate-progress-blind");
  expect(doc.verdict).toBe("CONFIRMED_HARNESS_DEFECT");
  expect(h2).toBeDefined();
  expect(h2!.status).toBe("CONFIRMED_HARNESS_DEFECT");
  expect(h2!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  return h2!;
}

interface ReplayOutcome {
  status: string;
  toolCalls: number;
  maxRepeatedToolCallsLimits: number;
  stallRecoveries: number;
  progressDetected: number;
}

async function replay(
  calls: ModelEvent[][],
  orchestrator: { execute(request: ToolCallRequest, context: ToolExecutionContext): Promise<ToolResult> },
  runtimeOpts: Record<string, unknown> = {},
): Promise<ReplayOutcome> {
  const provider = new ScriptedModelProvider([
    ...calls,
    ScriptedModelProvider.text("done"),
  ]);
  const events = new MemoryEventStore();
  const runtime = new AgentRuntime({
    store: new MemorySessionStore(),
    events,
    modelProvider: provider as unknown as ModelProvider,
    orchestrator: orchestrator as never,
    agents: [AGENT],
    maxRepeatedIdenticalToolCalls: 3,
    maxStallRecoveries: 1,
    toolRegistry: defaultTestToolCatalog(),
    permissiveToolResolution: true,
    toolSemanticsOf: () => ({ ...DEFAULT_TOOL_SEMANTICS, sideEffectScope: "none" as const, readOnly: true }),
    ...runtimeOpts,
  });
  const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\work" });
  const turn = await runtime.startTurn(session.id, "replay");
  const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);
  const stored = await events.list(session.id);
  return {
    status: outcome.status,
    toolCalls: calls.length,
    maxRepeatedToolCallsLimits: stored.filter(
      (e) => e.type === "run.limit_reached" && e.payload.limit === "maxRepeatedToolCalls",
    ).length,
    stallRecoveries: stored.filter((e) => e.type === "retry.stallRecovery").length,
    progressDetected: stored.filter((e) => e.type === "stall.progress_detected").length,
  };
}

const echo = (text: string): ModelEvent[] => ScriptedModelProvider.toolCall("echo", { text });

describe("E4-R86 — offline replay of the R85 H2 fingerprint", () => {
  it("replays the committed H2 record: the maxRepeatedToolCalls fingerprint no longer fires for the progress shape", async () => {
    const h2 = loadH2Record();
    // The recorded shared pattern: same tool+args, tool_failures=0, results
    // changing (the minimal repro) — six identical calls, every result new.
    const changing = new (class {
      private n = 0;
      async execute(): Promise<ToolResult> {
        this.n += 1;
        return { status: "success", output: { progress: `step-${this.n}` } };
      }
      async executeBound(): Promise<ToolResult> {
        return await this.execute();
      }
    })();
    const before = await replay(Array.from({ length: 6 }, () => echo("same")), changing);

    // Pre-R86 the fingerprint was run.limit_reached{limit:maxRepeatedToolCalls}
    // + failed (that is exactly what the recorded sharedPattern says). After
    // the fix the target mechanism changed: no limit fires, the turn completes,
    // and the fix path is visible as structured evidence.
    expect(before.status).toBe("completed");
    expect(before.maxRepeatedToolCallsLimits).toBe(0);
    expect(before.stallRecoveries).toBe(0);
    expect(before.progressDetected).toBeGreaterThan(0);

    // Sanity: the recorded evidence really is the fingerprint this replay
    // exercises (the repro in the committed record is the same six-call shape).
    expect(h2.minimalRepro).toContain("maxRepeatedToolCalls");
    expect(h2.samples.length).toBe(3);
  });

  it("NON-target trace: a genuine UNCHANGING repeat still stalls exactly as before", async () => {
    const constant = new (class {
      async execute(): Promise<ToolResult> {
        return { status: "success", output: { progress: "same" } };
      }
    })();
    const out = await replay(Array.from({ length: 6 }, () => echo("same")), constant);
    expect(out.status).toBe("failed");
    expect(out.maxRepeatedToolCallsLimits).toBe(1);
    expect(out.stallRecoveries).toBe(1);
    expect(out.progressDetected).toBe(0);
  });

  it("NON-target trace: different args are never a stall (unchanged behaviour)", async () => {
    const constant = new (class {
      async execute(): Promise<ToolResult> {
        return { status: "success", output: { progress: "same" } };
      }
    })();
    const out = await replay(
      [echo("a"), echo("b"), echo("c"), echo("d")],
      constant,
    );
    expect(out.status).toBe("completed");
    expect(out.maxRepeatedToolCallsLimits).toBe(0);
    expect(out.progressDetected).toBe(0);
  });

  it("NON-target trace: the alternating A->B pattern keeps its pattern-stall outcome", async () => {
    // R85's non-holdout triage treated the identical-call gate and the P2-41
    // pattern classifier as separate mechanisms; the R86 fix must not disturb
    // the pattern gate. Alternating args with constant results are a genuine
    // `alternating_loop` stall (same setup as the pre-existing P2-41 test,
    // which uses maxPatternStallRecoveries: 0 so the pattern terminates
    // immediately instead of recovering).
    const constant = new (class {
      async execute(): Promise<ToolResult> {
        return { status: "success", output: { progress: "same" } };
      }
    })();
    const out = await replay(
      [echo("a"), echo("b"), echo("a"), echo("b"), echo("a"), echo("b")],
      constant,
      { enabledStallPatterns: ["alternating_loop"], maxPatternStallRecoveries: 0 },
    );
    // The alternating pattern stall terminates via the pattern gate (a limit
    // fires) — the identical-call gate stays out of it either way.
    expect(out.status).toBe("failed");
    expect(out.maxRepeatedToolCallsLimits).toBe(0);
  });
});
