import { beforeEach, describe, expect, it } from "vitest";
import type {
  AgentEvent,
  EventId,
  EventType,
  SessionId,
  TurnId,
} from "@ar/contracts";
import { Reflector } from "./reflection.js";

const SESSION = "session_reflect" as SessionId;
const TURN_1 = "turn_1" as TurnId;
const TURN_2 = "turn_2" as TurnId;
const TURN_3 = "turn_3" as TurnId;

const reflector = new Reflector();

let seq = 0;
beforeEach(() => {
  seq = 0;
});
function ev(
  type: EventType,
  opts: { turnId?: TurnId; payload?: Record<string, unknown> } = {},
): AgentEvent {
  seq += 1;
  const event: AgentEvent = {
    id: `event_${seq}` as EventId,
    sessionId: SESSION,
    sequence: seq,
    timestamp: 1_700_000_000_000 + seq,
    type,
    payload: opts.payload ?? {},
  };
  if (opts.turnId !== undefined) event.turnId = opts.turnId;
  return event;
}

function info(code: string, message: string): Record<string, unknown> {
  return { code, message };
}

describe("Reflector (§68 rule-based reflection)", () => {
  it("attributes a turn+tool failure to the tool and produces a candidate", () => {
    const events = [
      ev("turn.started", { turnId: TURN_1 }),
      ev("tool.requested", {
        turnId: TURN_1,
        payload: { toolCallId: "call_1", name: "read_file" },
      }),
      ev("tool.failed", {
        turnId: TURN_1,
        payload: { toolCallId: "call_1", error: info("PROCESS_ERROR", "exit 1") },
      }),
      ev("turn.failed", {
        turnId: TURN_1,
        payload: { turnId: TURN_1, status: "failed", error: info("PROCESS_ERROR", "exit 1") },
      }),
    ];
    const outputs = reflector.reflect({ events });

    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.rootCause).toBe("tool");
    expect(outputs[0]!.outcome).toBe("failure");
    expect(outputs[0]!.generalizable).toBe(true);
    expect(outputs[0]!.lesson).toContain("read_file");
    expect(outputs[0]!.candidate).toBeDefined();
    expect(outputs[0]!.candidate!.content).toBe(outputs[0]!.lesson);
  });

  it("attributes verification.failed to verification", () => {
    const events = [
      ev("turn.started", { turnId: TURN_1 }),
      ev("verification.failed", {
        turnId: TURN_1,
        payload: { error: "tests failed: 3 errors" },
      }),
      ev("turn.failed", {
        turnId: TURN_1,
        payload: {
          turnId: TURN_1,
          status: "failed",
          error: info("VERIFICATION_FAILED", "tests failed: 3 errors"),
        },
      }),
    ];
    const outputs = reflector.reflect({ events });

    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.rootCause).toBe("verification");
    expect(outputs[0]!.outcome).toBe("failure");
    expect(outputs[0]!.generalizable).toBe(true);
    expect(outputs[0]!.lesson).toContain("re-verify");
  });

  it("dedupes two consecutive failures of the same tool into one lesson", () => {
    const events = [
      ev("tool.requested", { payload: { toolCallId: "call_1", name: "read_file" } }),
      ev("tool.failed", {
        payload: { toolCallId: "call_1", error: info("PROCESS_ERROR", "exit 1") },
      }),
      ev("tool.requested", { payload: { toolCallId: "call_1", name: "read_file" } }),
      ev("tool.failed", {
        payload: { toolCallId: "call_1", error: info("PROCESS_ERROR", "exit 1") },
      }),
    ];
    const outputs = reflector.reflect({ events });

    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.rootCause).toBe("tool");
    expect(outputs[0]!.lesson).toContain("read_file");
    expect(outputs[0]!.evidence).toContain("event_2@");
    expect(outputs[0]!.evidence).toContain("event_4@");
    expect(outputs[0]!.candidate!.importance).toBe(0.6);
  });

  it("returns an empty array when there are no failure events", () => {
    const events = [
      ev("turn.started", { turnId: TURN_1 }),
      ev("turn.completed", { turnId: TURN_1, payload: { turnId: TURN_1, status: "completed" } }),
      ev("tool.completed", { payload: { toolCallId: "call_1", status: "success" } }),
    ];
    expect(reflector.reflect({ events })).toEqual([]);
  });

  it("attributes model.failed to the model", () => {
    const events = [
      ev("turn.started", { turnId: TURN_1 }),
      ev("model.failed", {
        turnId: TURN_1,
        payload: { error: info("MODEL_ERROR", "provider timeout") },
      }),
    ];
    const outputs = reflector.reflect({ events });

    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.rootCause).toBe("model");
    expect(outputs[0]!.outcome).toBe("failure");
    expect(outputs[0]!.generalizable).toBe(true);
    expect(outputs[0]!.candidate!.importance).toBe(0.6);
  });

  it("attributes each root cause correctly in a mixed failure stream", () => {
    const events = [
      ev("turn.started", { turnId: TURN_1 }),
      ev("model.failed", {
        turnId: TURN_1,
        payload: { error: info("MODEL_ERROR", "provider timeout") },
      }),
      ev("turn.failed", {
        turnId: TURN_1,
        payload: {
          turnId: TURN_1,
          status: "failed",
          error: info("MODEL_ERROR", "provider timeout"),
        },
      }),
      ev("turn.started", { turnId: TURN_2 }),
      ev("tool.requested", {
        turnId: TURN_2,
        payload: { toolCallId: "call_a", name: "read_file" },
      }),
      ev("tool.failed", {
        turnId: TURN_2,
        payload: { toolCallId: "call_a", error: info("PROCESS_ERROR", "exit 1") },
      }),
      ev("tool.requested", {
        turnId: TURN_2,
        payload: { toolCallId: "call_a", name: "read_file" },
      }),
      ev("tool.completed", {
        turnId: TURN_2,
        payload: { toolCallId: "call_a", status: "success" },
      }),
      ev("turn.completed", { turnId: TURN_2, payload: { turnId: TURN_2, status: "completed" } }),
      ev("turn.started", { turnId: TURN_3 }),
      ev("verification.failed", {
        turnId: TURN_3,
        payload: { error: "tests failed" },
      }),
    ];
    const outputs = reflector.reflect({ events });

    expect(outputs.map((o) => o.rootCause)).toEqual(["model", "tool", "verification"]);
    expect(outputs.map((o) => o.outcome)).toEqual(["failure", "partial", "failure"]);
    expect(outputs.every((o) => o.candidate !== undefined)).toBe(true);
  });

  it("produces candidates with procedural type, session source, and severity importance", () => {
    const events = [
      ev("verification.failed", { payload: { error: "tests failed" } }),
    ];
    const outputs = reflector.reflect({ events });

    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.candidate).toEqual({
      content: outputs[0]!.lesson,
      type: "procedural",
      sourceSession: SESSION,
      importance: 0.8,
      confidence: 0.6,
      novelty: 0.5,
      stability: 0.5,
      structured: {
        when: "verification failed (tests failed)",
        do: "inspect the verification evidence, fix the reported issue, and re-verify",
        avoid: "declaring completion without a passing gate",
        rootCause: "verification",
        outcome: "failure",
        evidenceRefs: ["event_1"],
      },
    });
  });

  it("marks permission-denied failures as non-generalizable (§45)", () => {
    const events = [
      ev("tool.requested", { payload: { toolCallId: "call_1", name: "rm" } }),
      ev("tool.failed", {
        payload: {
          toolCallId: "call_1",
          error: info("PERMISSION_DENIED", "tool rm blocked by hook"),
        },
      }),
    ];
    const outputs = reflector.reflect({ events });

    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.rootCause).toBe("permission");
    expect(outputs[0]!.generalizable).toBe(false);
    expect(outputs[0]!.lesson).toContain("do not retry automatically");
    expect(outputs[0]!.candidate!.importance).toBe(0.5);
  });

  it("marks sandbox-denied failures as non-generalizable", () => {
    const events = [
      ev("tool.failed", {
        payload: { toolCallId: "call_1", error: info("SANDBOX_DENIED", "blocked by policy") },
      }),
    ];
    const outputs = reflector.reflect({ events });

    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.rootCause).toBe("sandbox");
    expect(outputs[0]!.generalizable).toBe(false);
  });

  it("marks a recovered tool failure as partial", () => {
    const events = [
      ev("turn.started", { turnId: TURN_1 }),
      ev("tool.requested", {
        turnId: TURN_1,
        payload: { toolCallId: "call_1", name: "read_file" },
      }),
      ev("tool.failed", {
        turnId: TURN_1,
        payload: { toolCallId: "call_1", error: info("PROCESS_ERROR", "exit 1") },
      }),
      ev("tool.requested", {
        turnId: TURN_1,
        payload: { toolCallId: "call_1", name: "read_file" },
      }),
      ev("tool.completed", {
        turnId: TURN_1,
        payload: { toolCallId: "call_1", status: "success" },
      }),
      ev("turn.completed", { turnId: TURN_1, payload: { turnId: TURN_1, status: "completed" } }),
    ];
    const outputs = reflector.reflect({ events });

    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.rootCause).toBe("tool");
    expect(outputs[0]!.outcome).toBe("partial");
    expect(outputs[0]!.candidate!.importance).toBe(0.6);
  });

  it("attributes context overflow to context with a compaction lesson", () => {
    const events = [
      ev("model.failed", {
        payload: { error: info("CONTEXT_OVERFLOW", "budget exceeded") },
      }),
    ];
    const outputs = reflector.reflect({ events });

    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.rootCause).toBe("context");
    expect(outputs[0]!.lesson).toContain("compact");
    expect(outputs[0]!.candidate!.importance).toBe(0.7);
  });

  it("evidence references related event ids, timestamps, and the task goal", () => {
    const events = [
      ev("tool.requested", { payload: { toolCallId: "call_1", name: "read_file" } }),
      ev("tool.failed", {
        payload: { toolCallId: "call_1", error: info("PROCESS_ERROR", "exit 1") },
      }),
    ];
    const outputs = reflector.reflect({ events, taskGoal: "fix the build" });

    expect(outputs[0]!.evidence).toContain("tool.requested event_1@1700000000001");
    expect(outputs[0]!.evidence).toContain("tool.failed event_2@1700000000002");
    expect(outputs[0]!.evidence).toContain("task: fix the build");
  });

  it("keeps failures of distinct tools as separate outputs", () => {
    const events = [
      ev("tool.requested", { payload: { toolCallId: "call_1", name: "read_file" } }),
      ev("tool.failed", {
        payload: { toolCallId: "call_1", error: info("PROCESS_ERROR", "exit 1") },
      }),
      ev("tool.requested", { payload: { toolCallId: "call_2", name: "write_file" } }),
      ev("tool.failed", {
        payload: { toolCallId: "call_2", error: info("PROCESS_ERROR", "exit 2") },
      }),
    ];
    const outputs = reflector.reflect({ events });

    expect(outputs).toHaveLength(2);
    expect(outputs[0]!.lesson).not.toBe(outputs[1]!.lesson);
  });

  it("skips user-cancelled failures (nothing to learn)", () => {
    const events = [
      ev("turn.failed", {
        payload: { error: info("USER_CANCELLED", "cancelled by user") },
      }),
    ];
    expect(reflector.reflect({ events })).toEqual([]);
  });

  it("gives a failed turn the highest severity (0.9)", () => {
    const events = [
      ev("turn.failed", {
        payload: { error: info("MODEL_ERROR", "provider timeout") },
      }),
    ];
    const outputs = reflector.reflect({ events });

    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.rootCause).toBe("model");
    expect(outputs[0]!.outcome).toBe("failure");
    expect(outputs[0]!.candidate!.importance).toBe(0.9);
  });

  it("P2-1: produces a structured When/Do/Avoid lesson on tool failures", () => {
    const events = [
      ev("tool.requested", { payload: { toolCallId: "call_1", name: "read_file" } }),
      ev("tool.failed", {
        payload: { toolCallId: "call_1", error: info("PROCESS_ERROR", "ENOENT src/missing.ts") },
      }),
    ];
    const outputs = reflector.reflect({ events });

    const structured = outputs[0]!.candidate!.structured;
    expect(structured).toBeDefined();
    expect(structured!.when).toContain("read_file");
    expect(structured!.when).toContain("ENOENT");
    expect(structured!.do).toContain("search");
    expect(structured!.do).toContain("guessed paths");
    expect(structured!.avoid).toContain("repeating the same guessed path");
    expect(structured!.rootCause).toBe("tool");
    expect(structured!.outcome).toBe("failure");
  });

  it("P2-1: verification failures carry an inspect-fix-reverify strategy", () => {
    const events = [
      ev("verification.failed", {
        payload: { error: info("VERIFICATION_FAILED", "gate: compile") },
      }),
    ];
    const outputs = reflector.reflect({ events });

    const structured = outputs[0]!.candidate!.structured;
    expect(structured!.when).toContain("verification failed");
    expect(structured!.do).toContain("re-verify");
    expect(structured!.avoid).toContain("declaring completion");
  });

  it("P2-1: evidenceRefs reference the actual failure event ids", () => {
    const events = [
      ev("tool.failed", {
        payload: { toolCallId: "call_1", error: info("PROCESS_ERROR", "exit 1") },
      }),
    ];
    const outputs = reflector.reflect({ events });

    expect(outputs[0]!.candidate!.structured!.evidenceRefs).toEqual(["event_1"]);
  });

  it("P2-1: deduped groups accumulate evidence refs in order", () => {
    const events = [
      ev("tool.failed", {
        payload: { toolCallId: "call_1", error: info("PROCESS_ERROR", "exit 1") },
      }),
      ev("tool.failed", {
        payload: { toolCallId: "call_1", error: info("PROCESS_ERROR", "exit 2") },
      }),
    ];
    const outputs = reflector.reflect({ events });

    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.candidate!.structured!.evidenceRefs).toEqual([
      "event_1",
      "event_2",
    ]);
  });
});
