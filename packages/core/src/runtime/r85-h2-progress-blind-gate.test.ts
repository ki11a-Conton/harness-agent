/**
 * E4-R85 → E4-R86 — the H2 defect reproducer, now a permanent regression test.
 *
 * ## The defect (as confirmed by R85)
 *
 * Two independent mechanisms in this codebase already knew that a repeated call
 * whose RESULT CHANGED is progress, not a stall:
 *
 *   1. `AgentState.recordToolCall` documented it: "The result fingerprint is
 *      supplied by the runtime so an identical call with a DIFFERENT result is
 *      progress, not a stall (avoids false positives)."
 *   2. `AgentState.priorResultChanged` implemented exactly that test, and
 *      `ToolCallController.recordStallTrace` called it for read-only tools.
 *
 * But the gate that actually TERMINATED the turn — the identical-call streak at
 * `AgentState.noteToolCall`, consumed in `runtime.ts` as
 * `run.limit_reached{limit:"maxRepeatedToolCalls"}` — keyed the streak on
 * `name:args` ONLY. It never consulted the result fingerprint, and
 * `recordProgress`/`clearStallWindow` cleared `recentTraces` WITHOUT resetting
 * `identicalToolStreak`. So observable progress could not cancel the streak.
 *
 * Consequence: a turn that repeatedly called the same tool with the same
 * arguments while every call returned a DIFFERENT (advancing) result was
 * terminated as a stall.
 *
 * ## History
 *
 * R85 committed this file as an executable CHARACTERIZATION test: it pinned the
 * defective behaviour precisely and documented the assertion R86 must flip, so
 * that `pnpm test` could be GREEN at the end of R85 without suppressing the
 * defect. R86 flipped those assertions (recorded RED evidence:
 * `.ci/r86-red-evidence.txt`) and fixed the narrow layer — `noteToolCall` now
 * keys the streak on the result fingerprint too, so a changed result cancels
 * the streak exactly as the documented contract always said it should.
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
  progressCancellations: number;
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
    // R86 §4: the fix path itself must be observable, not merely inferred from
    // the final status. This event fires when a repeated call+args was about to
    // be counted as a stall and a CHANGED result cancelled it.
    progressCancellations: stored.filter((e) => e.type === "stall.progress_detected").length,
    limits: stored
      .filter((e) => e.type === "run.limit_reached")
      .map((e) => e.payload as { limit?: unknown; used?: unknown; allowed?: unknown }),
  };
}

describe("E4-R85/R86 H2 — progress-blind identical-call gate (regression)", () => {
  it("completes the turn because every repeated call returned a DIFFERENT result", async () => {
    const probe = await runProbe(6);

    // Every call returned new output, so the model was making observable
    // progress. R86: the streak is cancelled by the changed result, so the turn
    // runs to completion and NO limit is reached.
    expect(probe.toolCallsExecuted).toBe(6);
    expect(probe.status).toBe("completed");
    expect(probe.limits).toEqual([]);

    // No stall recovery was needed at all: progress was never mistaken for a
    // stall, so the recovery budget stayed untouched.
    expect(probe.stallRecoveries).toBe(0);

    // ...and the cancellation is visible as structured evidence.
    expect(probe.progressCancellations).toBeGreaterThan(0);
  });

  it("a short run completes without consuming the stall-recovery budget (4 calls)", async () => {
    // Pre-R86 this case only passed because the single stall recovery reset the
    // streak — the defect was masked for short runs and only became terminal
    // once the model needed more than one recovery window. After the fix no
    // masking is involved: the run simply completes and the budget is intact.
    const probe = await runProbe(4);
    expect(probe.status).toBe("completed");
    expect(probe.toolCallsExecuted).toBe(4);
    expect(probe.stallRecoveries).toBe(0);
    expect(probe.limits).toEqual([]);
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
    const stored = await events.list(session.id);
    const limits = stored.filter((e) => e.type === "run.limit_reached");
    expect(limits.length).toBeGreaterThan(0);
    // A real stall must NOT be reported as progress-cancelled.
    expect(stored.filter((e) => e.type === "stall.progress_detected")).toHaveLength(0);
  });

  it("SECURITY regression: the fix path never leaks raw args or output into events", async () => {
    // The result fingerprint must be redacted: even though every call output
    // carries a SECRET sentinel (which legitimately changes between calls), the
    // new stall.progress_detected event must expose ONLY tool name + counts —
    // never the args, the output, or the sentinel. This is the plan §R86.2
    // "redacted args / no sensitive info in events" boundary.
    const SECRET = "S3CR3T-canary-9f8e7d6c";
    const call = ScriptedModelProvider.toolCall("echo", { text: "same" });
    const provider = new ScriptedModelProvider([
      ...Array.from({ length: 4 }, () => call),
      ScriptedModelProvider.text("done"),
    ]);
    const events = new MemoryEventStore();
    const runtime = new AgentRuntime({
      store: new MemorySessionStore(),
      events,
      modelProvider: provider as unknown as ModelProvider,
      orchestrator: new (class {
        private n = 0;
        async execute(): Promise<ToolResult> {
          this.n += 1;
          return { status: "success", output: { progress: `${SECRET}-${this.n}` } };
        }
        async executeBound(): Promise<ToolResult> {
          return await this.execute();
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
    const turn = await runtime.startTurn(session.id, "secret probe");
    const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("completed");

    const stored = await events.list(session.id);
    const progressEvents = stored.filter((e) => e.type === "stall.progress_detected");
    expect(progressEvents.length).toBeGreaterThan(0);
    // 1. No event of ANY type may carry the secret (fingerprints are hashes).
    for (const e of stored) {
      expect(JSON.stringify(e.payload), `${e.type} leaked the secret`).not.toContain(SECRET);
    }
    // 2. The new event's payload shape is minimal and secret-free.
    for (const e of progressEvents) {
      const keys = Object.keys(e.payload).sort();
      expect(keys).toEqual(["allowed", "tool", "wouldBeStreak"]);
      expect(e.payload.tool).toBe("echo");
      expect(typeof e.payload.wouldBeStreak).toBe("number");
      expect(typeof e.payload.allowed).toBe("number");
    }
  });
});
