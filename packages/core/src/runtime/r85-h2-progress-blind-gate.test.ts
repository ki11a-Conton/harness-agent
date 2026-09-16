/**
 * E4-R85 — minimal synthetic reproducer for the H2 defect, and the pin that
 * R86 must flip.
 *
 * ## The defect
 *
 * Two independent mechanisms in this codebase already know that a repeated call
 * whose RESULT CHANGED is progress, not a stall:
 *
 *   1. `AgentState.recordToolCall` documents it: "The result fingerprint is
 *      supplied by the runtime so an identical call with a DIFFERENT result is
 *      progress, not a stall (avoids false positives)."
 *   2. `AgentState.priorResultChanged` implements exactly that test, and
 *      `ToolCallController.recordStallTrace` calls it for read-only tools.
 *
 * But the gate that actually TERMINATES the turn — the identical-call streak at
 * `AgentState.noteToolCall`, consumed in `runtime.ts` as
 * `run.limit_reached{limit:"maxRepeatedToolCalls"}` — keys the streak on
 * `name:args` ONLY. It never consults the result fingerprint, and
 * `recordProgress`/`clearStallWindow` clear `recentTraces` WITHOUT resetting
 * `identicalToolStreak`. So observable progress cannot cancel the streak.
 *
 * Consequence: a turn that repeatedly calls the same tool with the same
 * arguments while every call returns a DIFFERENT (advancing) result is
 * terminated as a stall.
 *
 * ## Why this file asserts the DEFECTIVE behaviour
 *
 * The plan requires `pnpm test` to be GREEN at the end of R85, while R86 must
 * begin by "turning R85's minimal synthetic reproducer into a FAILING test and
 * recording the RED evidence". So R85 commits the reproducer as an executable
 * CHARACTERIZATION test: it pins today's behaviour precisely and documents the
 * assertion R86 must flip. This is deliberately not `it.fails` — a suppressed
 * failure would hide the moment the behaviour changes.
 *
 * R86 will:
 *   1. change `expect(outcome.status).toBe("failed")` to `.toBe("completed")`,
 *      observe it fail (RED), record that output, then
 *   2. fix the narrow layer (cancel the identical-call streak when the same
 *      call+args produced a different result) until it passes.
 *
 * Fully offline: a scripted provider and a synthetic orchestrator, so this
 * reproducer costs 0 provider calls and needs no API key.
 */
import { describe, expect, it } from "vitest";
import type {
  AgentDefinition,
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
  name: "r85-h2-agent",
  description: "minimal H2 reproducer",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "reproduce the identical-call gate defect",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

/**
 * Every call returns a DIFFERENT result. From the model's point of view the
 * world is advancing on each call, so this is a polling/progress loop, not a
 * stall — exactly the case `priorResultChanged` exists to protect.
 */
class ChangingResultOrchestrator {
  calls: ToolCallRequest[] = [];
  private n = 0;
  async execute(request: ToolCallRequest, _context: ToolExecutionContext): Promise<ToolResult> {
    this.calls.push(request);
    this.n += 1;
    return { status: "success", output: { progress: `step-${this.n}` } };
  }
  async executeBound(request: ToolCallRequest, context: ToolExecutionContext): Promise<ToolResult> {
    return await this.execute(request, context);
  }
}

interface ProbeOutcome {
  status: string;
  toolCallsExecuted: number;
  stallRecoveries: number;
  limits: Array<{ limit?: unknown; used?: unknown; allowed?: unknown }>;
}

/** Run the reproducer: N identical calls with changing results, then finish. */
async function runProbe(repeat: number): Promise<ProbeOutcome> {
  const call = ScriptedModelProvider.toolCall("echo", { text: "same" });
  const provider = new ScriptedModelProvider([
    ...Array.from({ length: repeat }, () => call),
    ScriptedModelProvider.text("done"),
  ]);
  const orchestrator = new ChangingResultOrchestrator();
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
  });
  const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\work" });
  const turn = await runtime.startTurn(session.id, "h2 reproducer");
  const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);
  const stored = await events.list(session.id);
  return {
    status: outcome.status,
    toolCallsExecuted: orchestrator.calls.length,
    stallRecoveries: stored.filter((e) => e.type === "retry.stallRecovery").length,
    limits: stored
      .filter((e) => e.type === "run.limit_reached")
      .map((e) => e.payload as { limit?: unknown; used?: unknown; allowed?: unknown }),
  };
}

describe("E4-R85 H2 — progress-blind identical-call gate (reproducer)", () => {
  it("terminates the turn even though every repeated call returned a DIFFERENT result", async () => {
    const probe = await runProbe(6);

    // Every call returned new output, so the model was making observable
    // progress — yet the turn is killed as a stall.
    expect(probe.toolCallsExecuted).toBe(6);
    expect(probe.status).toBe("failed");
    expect(probe.limits).toEqual([{ limit: "maxRepeatedToolCalls", used: 3, allowed: 3 }]);

    // The stall-recovery budget was offered once and still could not save the
    // turn, because the streak is reset but the underlying blindness remains.
    expect(probe.stallRecoveries).toBe(1);

    // THE ASSERTION R86 MUST FLIP: with changing results this turn must
    // complete, because the gate is supposed to cancel on changed results.
    // expect(probe.status).toBe("completed");
  });

  it("a SHORT run survives only because stall recovery masks it (4 calls)", async () => {
    // This is why the defect hid for so long: with few calls the single stall
    // recovery resets the streak and the turn squeaks through. The defect only
    // becomes terminal once the model needs more than one recovery window.
    const probe = await runProbe(4);
    expect(probe.status).toBe("completed");
    expect(probe.toolCallsExecuted).toBe(4);
    expect(probe.stallRecoveries).toBe(1);
  });

  it("a genuinely UNCHANGING repeated call is still treated as a stall (counterexample)", async () => {
    // The gate must keep working for real stalls: here every call returns the
    // SAME result, so terminating is correct behaviour and must NOT be broken
    // by the R86 fix.
    const call = ScriptedModelProvider.toolCall("echo", { text: "same" });
    const provider = new ScriptedModelProvider([
      ...Array.from({ length: 6 }, () => call),
      ScriptedModelProvider.text("done"),
    ]);
    const events = new MemoryEventStore();
    const runtime = new AgentRuntime({
      store: new MemorySessionStore(),
      events,
      modelProvider: provider as unknown as ModelProvider,
      // Constant result: no progress signal can fire, so the default echo tool
      // output is identical on every call.
      orchestrator: new (class {
        async execute(): Promise<ToolResult> {
          return { status: "success", output: { progress: "constant" } };
        }
        async executeBound(): Promise<ToolResult> {
          return { status: "success", output: { progress: "constant" } };
        }
      })() as never,
      agents: [AGENT],
      maxRepeatedIdenticalToolCalls: 3,
      maxStallRecoveries: 1,
      toolRegistry: defaultTestToolCatalog(),
      permissiveToolResolution: true,
      toolSemanticsOf: () => ({ ...DEFAULT_TOOL_SEMANTICS, sideEffectScope: "none" as const, readOnly: true }),
    });
    const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\work" });
    const turn = await runtime.startTurn(session.id, "real stall");
    const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);

    expect(outcome.status).toBe("failed");
    const limits = (await events.list(session.id)).filter((e) => e.type === "run.limit_reached");
    expect(limits.length).toBeGreaterThan(0);
  });
});
