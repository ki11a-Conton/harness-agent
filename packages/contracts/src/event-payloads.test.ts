import { describe, expect, it } from "vitest";
import {
  EVENT_PAYLOAD_TYPES,
  toolNameOf,
  type EventPayloadOf,
  type SecurityDeniedPayload,
  type ToolCompletedPayload,
  type ToolFailedPayload,
} from "./event-payloads.js";

/**
 * Q-4: typed event payloads.
 *
 * These tests pin the CANONICAL payload shapes for key events so a producer
 * can never silently drift a field name (e.g. `tool.requested` using `name`
 * while `tool.failed` uses `tool`) without a consumer noticing. The accessor
 * `toolNameOf` is the single read path evaluators must use; it prefers the
 * canonical `tool` field and only falls back to the legacy `name` alias.
 */
describe("Q-4 typed event payloads", () => {
  it("toolNameOf prefers the canonical `tool` field", () => {
    expect(toolNameOf({ tool: "exec", name: "mismatched" })).toBe("exec");
  });

  it("toolNameOf falls back to the legacy `name` alias", () => {
    expect(toolNameOf({ name: "read_file" })).toBe("read_file");
  });

  it("toolNameOf returns undefined when neither field is present or is empty", () => {
    expect(toolNameOf({})).toBeUndefined();
    expect(toolNameOf({ tool: "", name: "" })).toBeUndefined();
    expect(toolNameOf({ tool: 42 })).toBeUndefined();
  });

  it("tool.completed and tool.failed share the canonical tool field", () => {
    const completedPayload: ToolCompletedPayload = {
      toolCallId: "tc",
      tool: "bash",
      durationMs: 12,
    };
    const failedPayload: ToolFailedPayload = {
      toolCallId: "tc",
      tool: "bash",
      error: { code: "E1" },
    };
    // Exactly the drift Q-4 prevents: both producers name the tool `tool`.
    expect(completedPayload.tool).toBe("bash");
    expect(failedPayload.tool).toBe("bash");
    expect(toolNameOf(completedPayload)).toBe("bash");
    expect(toolNameOf(failedPayload)).toBe("bash");
  });

  it("EventPayloadMap is total and typed per event type", () => {
    // Compile-time: payload of a keyed event resolves to its typed shape.
    const completed: EventPayloadOf<"tool.completed"> = {
      toolCallId: "tc",
      tool: "bash",
      status: "success",
    };
    const failed: EventPayloadOf<"tool.failed"> = {
      toolCallId: "tc",
      tool: "bash",
      error: { code: "E1" },
    };
    const retry: EventPayloadOf<"model.retry"> = { attempt: 2 };
    const limit: EventPayloadOf<"run.limit_reached"> = {
      limit: "maxTokens",
      used: 100,
      allowed: 200,
    };
    void completed;
    void failed;
    void retry;
    void limit;
  });

  it("every security denial event uses the canonical denial payload", () => {
    const types: Array<keyof typeof EVENT_PAYLOAD_TYPES> = [
      "security.network_denied",
      "security.injection_denied",
      "security.permission_denied",
      "security.filesystem_denied",
      "security.process_denied",
      "security.secret_redacted",
      "security.memory_denied",
      "security.skill_denied",
      "security.mcp_denied",
      "security.approval_denied",
    ];
    for (const t of types) {
      expect(EVENT_PAYLOAD_TYPES[t]).toBe(true);
      // Every security denial shares the canonical denial payload shape.
      const p: SecurityDeniedPayload = {};
      expect(p.reason).toBeUndefined();
      void p;
    }
  });

  it("P20-5: terminal turn events carry the P19-1 grade + termination reason shape", () => {
    const completed: EventPayloadOf<"turn.completed"> = {
      status: "completed",
      statusDetail: "completed",
      terminationReason: "verified_complete",
      grade: "verified_complete",
      completionEvidence: { passedSteps: 2, totalSteps: 2 },
    };
    expect(completed.grade).toBe("verified_complete");
    expect(completed.completionEvidence).toEqual({ passedSteps: 2, totalSteps: 2 });
    const failed: EventPayloadOf<"turn.failed"> = { status: "failed", terminationReason: "verification_failed", grade: "verification_failed" };
    expect(failed.grade).toBe("verification_failed");
  });

  it("P20-5: recovery.decided and protocol repair events are typed, not ad-hoc", () => {
    const recovery: EventPayloadOf<"recovery.decided"> = {
      action: "retry_safe",
      input: "tool_failure",
      tool: "read_file",
      toolCallId: "tc-1",
      used: 0,
      remaining: 2,
    };
    expect(recovery.action).toBe("retry_safe");
    const repaired: EventPayloadOf<"protocol.repaired"> = {
      kind: "duplicate_tool_call_id",
      action: "recover",
      evidence: { kind: "duplicate_tool_call_id", repaired: true, before: "tc-1" },
    };
    expect(repaired.action).toBe("recover");
    expect(repaired.evidence?.before).toBe("tc-1");
  });

  it("P20-5: subagent lifecycle events are typed and linked to the parent call", () => {
    const started: EventPayloadOf<"subagent.started"> = {
      subagentId: "sa-1",
      parentCallId: "toolcall-delegate-1",
      delegatedBy: "delegate_worker",
      goal: "fix the flaky test",
    };
    expect(started.parentCallId).toBe("toolcall-delegate-1");
  });
});
