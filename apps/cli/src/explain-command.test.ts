import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, EventStore } from "@ar/contracts";
import { EVENT_ABI_VERSION, newEventId, newSessionId, newTurnId } from "@ar/contracts";
import { JSONLEventStore } from "@ar/events";
import { deriveRunMetrics } from "@ar/session";
import { explainCmd } from "./explain-command.js";

let tempDir: string | undefined;
afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function freshEventStore(): Promise<{ store: EventStore; sessionId: string }> {
  tempDir = await mkdtemp(join(tmpdir(), "harness-explain-"));
  return { store: new JSONLEventStore({ dataDir: tempDir }), sessionId: newSessionId() };
}

function ev(
  sessionId: string,
  type: AgentEvent["type"],
  payload: Record<string, unknown>,
  extra: Partial<AgentEvent> = {},
): AgentEvent {
  return {
    id: newEventId(),
    sessionId: sessionId as never,
    sequence: 0,
    timestamp: Date.now(),
    type,
    payload,
    schemaVersion: EVENT_ABI_VERSION,
    ...extra,
  };
}

describe("P9-3: agent explain (observable evidence only)", () => {
  it("reports goal, plan, context sources, tool semantics, permission + verification", async () => {
    const { store, sessionId } = await freshEventStore();
    const turnId = newTurnId();
    await store.append(ev(sessionId, "turn.started", { goal: "fix parser" }, { turnId }));
    await store.append(
      ev(sessionId, "instruction.discovered", { path: "AGENTS.md" }, { turnId }),
    );
    await store.append(
      ev(sessionId, "tool.output", { tool: "update_plan", output: "step1: parse; step2: fix" }, { turnId }),
    );
    await store.append(
      ev(sessionId, "tool.completed", { toolCallId: "call-1", tool: "edit_file", durationMs: 12 }, { turnId }),
    );
    await store.append(
      ev(sessionId, "tool.failed", { toolCallId: "call-2", tool: "exec", error: { info: { message: "ENOENT" } } }, { turnId }),
    );
    await store.append(
      ev(sessionId, "security.permission_denied", { tool: "curl", error: "denied by policy" }, { turnId }),
    );
    await store.append(
      ev(sessionId, "verification.step_completed", { ref: "verification.step:command:node t.js", passed: true }, { turnId }),
    );
    await store.append(
      ev(sessionId, "turn.completed", { status: "completed", terminationReason: "verified_complete" }, { turnId }),
    );

    const result = await explainCmd({ sessionId: sessionId as never }, store);
    expect(result.exitCode).toBe(0);
    const out = result.lines.join("\n");
    expect(out).toContain("goal: fix parser");
    expect(out).toContain("active plan:");
    expect(out).toContain("context sources: AGENTS.md");
    expect(out).toContain("tool semantics: exec"); // the LAST executed tool
    expect(out).toContain("ENOENT");
    expect(out).toContain("permission result: DENIED curl");
    expect(out).toContain("verification: PASS verification.step:command:node t.js");
    expect(out).toContain("verified_complete");
  });

  it("filters to a specific tool call with --tool-call", async () => {
    const { store, sessionId } = await freshEventStore();
    await store.append(ev(sessionId, "tool.completed", { toolCallId: "call-1", tool: "read_file" }));
    await store.append(ev(sessionId, "tool.completed", { toolCallId: "call-2", tool: "edit_file" }));
    const result = await explainCmd({ sessionId: sessionId as never, toolCallId: "call-2" }, store);
    expect(result.lines.join("\n")).toContain("edit_file");
  });
});

describe("P9-4: offline trace replay metrics", () => {
  it("derives tokens, calls, retries, verification and completion grade from events", async () => {
    const sessionId = newSessionId();
    const events = [
      ev(sessionId, "turn.started", {}),
      ev(sessionId, "model.started", { callId: "mc-1" }),
      ev(sessionId, "model.completed", { callId: "mc-1", usage: { inputTokens: 100, outputTokens: 20 }, durationMs: 50 }),
      ev(sessionId, "model.retry", {}),
      ev(sessionId, "tool.requested", { toolCallId: "t1" }),
      ev(sessionId, "tool.completed", { toolCallId: "t1" }),
      ev(sessionId, "tool.failed", { toolCallId: "t2" }),
      ev(sessionId, "context.compacted", {}),
      ev(sessionId, "verification.step_started", { ref: "v1" }),
      ev(sessionId, "verification.step_completed", { ref: "v1", passed: true }),
      ev(sessionId, "turn.completed", { terminationReason: "model_stopped" }),
    ];
    const metrics = await deriveRunMetrics(events);
    expect(metrics.turns).toBe(1);
    expect(metrics.modelCalls).toBe(1);
    expect(metrics.tokens).toBe(120);
    expect(metrics.inputTokens).toBe(100);
    expect(metrics.outputTokens).toBe(20);
    expect(metrics.modelTimeMs).toBe(50);
    expect(metrics.retries).toBe(1);
    expect(metrics.toolCalls).toBe(1); // tool.requested only
    expect(metrics.toolFailures).toBe(1);
    expect(metrics.compactions).toBe(1);
    expect(metrics.verificationSteps).toBe(1);
    expect(metrics.verificationPassed).toBe(1);
    // Gate evidence 1/1 on a bare stop → verified_complete (P8-3).
    expect(metrics.completionGrade).toBe("verified_complete");
  });

  it("bare model_stopped with no gate grades unverified_complete", async () => {
    const sessionId = newSessionId();
    const metrics = await deriveRunMetrics([
      ev(sessionId, "turn.started", {}),
      ev(sessionId, "turn.completed", { terminationReason: "model_stopped" }),
    ]);
    expect(metrics.completionGrade).toBe("unverified_complete");
  });
});
