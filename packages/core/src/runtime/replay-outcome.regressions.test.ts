import { describe, expect, it } from "vitest";
import {
  buildCheckpoint, DEFAULT_TOOL_SEMANTICS, newAgentId, newCheckpointId,
  newEventId, newSessionId, newTurnId, newWorkingState,
} from "@ar/contracts";
import type { AgentEvent, ToolExecutionRecord, ToolSemantics } from "@ar/contracts";
import { MemoryEventStore, MemorySessionStore } from "../test/fakes.js";
import { RecoveryController } from "./recovery-controller.js";
import { buildResumePrompt } from "./turn-helpers.js";

async function fixture(name = "write_file") {
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const sessionId = newSessionId();
  const turnId = newTurnId();
  const semantics: ToolSemantics = { ...DEFAULT_TOOL_SEMANTICS, sideEffectScope: "filesystem" };
  const controller = new RecoveryController({
    store, events, now: () => 999, semanticsOf: () => semantics,
    emit: (sid, type, payload, tid) => events.appendNew({ id: newEventId(), sessionId: sid, turnId: tid, type, payload, timestamp: 999 }),
  });
  const checkpoint = buildCheckpoint({
    checkpointId: newCheckpointId(), schemaVersion: 1, sessionId, turnId,
    agentId: newAgentId(), createdAt: 1, reason: "before-tool", phase: "thinking", iteration: 0,
    state: newWorkingState("fix source.ts"), toolLedger: [], childSessions: [],
    lastEventSequence: 0, effectiveAgentConfigRef: "effectiveAgent", contextRefs: [],
  });
  const append = (type: AgentEvent["type"], payload: Record<string, unknown>) => events.appendNew({
    id: newEventId(), sessionId, turnId, timestamp: 10 + events.events.length, type,
    payload: { toolCallId: "call-1", ...payload },
  });
  await append("tool.requested", { name, args: { path: "source.ts", mutations: [{ op: "mark_completed", step: "must not apply" }] } });
  return {
    append, events, checkpoint,
    message: (content: string) => store.appendMessage({ id: "result-1" as never, sessionId, turnId, role: "tool", toolCallId: "call-1" as never, content, createdAt: 99 }),
    replay: () => controller.reconstructResumeState(sessionId, turnId, checkpoint),
  };
}

describe("crash replay preserves authoritative tool outcomes", () => {
  it.each(["denied", "failed", "cancelled", "timeout"] as const)("does not turn %s into an applied write before a tool message exists", async (status) => {
    const f = await fixture();
    await f.append("tool.completed", { status });
    const result = await f.replay();
    expect(result.replayedToolLedger.map((r) => r.status)).toEqual([status]);
    expect(result.working.filesChanged).toEqual([]);
    expect(result.working.completed).toEqual([]);
    expect(result.committedSideEffects).toEqual([]);
    expect(result.unresolvedTools).toHaveLength(status === "denied" ? 0 : 1);
    expect(f.checkpoint.state.filesChanged).toEqual([]);
  });

  it("a persisted tool message cannot override a refusal", async () => {
    const f = await fixture();
    await f.append("tool.completed", { status: "denied" });
    await f.message("arbitrary successful-looking tool output");
    expect((await f.replay()).replayedToolLedger[0]!.status).toBe("denied");
  });

  it("a later successful retry wins over an earlier failure of the same call", async () => {
    const f = await fixture();
    await f.append("tool.failed", { error: { code: "TOOL_EXECUTION_FAILED" } });
    await f.append("tool.completed", { status: "success" });
    await f.append("tool.completed", {}); // legacy Core terminal after the orchestrator
    const result = await f.replay();
    expect(result.replayedToolLedger[0]!.status).toBe("success");
    expect(result.working.filesChanged).toEqual(["source.ts"]);
    expect(result.working.failures).toEqual([]);
    expect(result.committedSideEffects).toHaveLength(1);
    expect(result.unresolvedTools).toEqual([]);
  });

  it("a later failure wins over an earlier successful terminal", async () => {
    const f = await fixture();
    await f.append("tool.completed", { status: "success" });
    await f.append("tool.failed", { error: { code: "PROCESS_TIMEOUT" } });
    const result = await f.replay();
    expect(result.replayedToolLedger[0]!.status).toBe("timeout");
    expect(result.working.filesChanged).toEqual([]);
    expect(result.committedSideEffects).toEqual([]);
    expect(result.unresolvedTools).toHaveLength(1);
  });

  it("does not certify an invalid explicit terminal status as success", async () => {
    const f = await fixture();
    await f.append("tool.completed", { status: "not-a-status" });
    const result = await f.replay();
    expect(result.replayedToolLedger[0]!.status).toBe("interrupted");
    expect(result.working.filesChanged).toEqual([]);
    expect(result.unresolvedTools).toHaveLength(1);
  });

  it.each(["event", "message"] as const)("preserves legacy success with only a %s", async (kind) => {
    const f = await fixture();
    if (kind === "event") await f.append("tool.completed", {});
    else await f.message("[failed] is untrusted literal output, not a result status");
    expect((await f.replay()).replayedToolLedger[0]!.status).toBe("success");
  });

  it("does not apply denied plan mutations", async () => {
    const f = await fixture("update_plan");
    await f.append("tool.completed", { status: "denied" });
    const result = await f.replay();
    expect(result.working.completed).toEqual([]);
    expect(result.committedSideEffects).toEqual([]);
  });

  it.each(["denied", "failed", "cancelled", "timeout", "interrupted"] as const)("the resume prompt does not label a legacy %s record already applied", (status) => {
    const record: ToolExecutionRecord = { toolCallId: "call-1" as never, tool: "write_file", argsHash: "hash", started: 1, completed: 2, status, sideEffect: true };
    const prompt = buildResumePrompt(newWorkingState("fix source.ts"), [record], []);
    const applied = prompt.split("## Committed side effects")[1]!.split("## ")[0]!;
    expect(applied).not.toContain("write_file");
    expect(prompt).toContain(`[${status}]`);
    expect(prompt).toContain("reconcile");
  });
});
