import { describe, expect, it } from "vitest";
import { newAgentId, newSessionId, newTurnId } from "@ar/contracts";
import { AgentState, IllegalTransitionError } from "./agent-state.js";

const SID = newSessionId();
const AID = newAgentId();

describe("AgentState machine", () => {
  it("follows the documented happy path", () => {
    const s = new AgentState(SID, AID);
    expect(s.getPhase()).toBe("idle");
    s.beginTurn(newTurnId());
    expect(s.getPhase()).toBe("thinking");
    s.transition("tool_pending");
    s.transition("waiting_permission");
    s.transition("executing");
    s.transition("observing");
    s.transition("thinking");
    s.transition("compacting");
    s.transition("thinking");
    expect(s.getPhase()).toBe("thinking");
    s.terminate("completed");
    expect(s.isTerminal()).toBe(true);
  });

  it("rejects illegal transitions", () => {
    const s = new AgentState(SID, AID);
    s.beginTurn(newTurnId());
    expect(() => s.transition("executing")).toThrow(IllegalTransitionError);
    expect(() => s.transition("completed")).not.toThrow();
    expect(() => s.transition("thinking")).toThrow(IllegalTransitionError);
  });

  it("rejects transitions from terminal states", () => {
    const s = new AgentState(SID, AID);
    s.beginTurn(newTurnId());
    s.terminate("cancelled");
    expect(() => s.transition("thinking")).toThrow(IllegalTransitionError);
    expect(() => s.terminate("failed")).toThrow(IllegalTransitionError);
  });

  it("counts iterations and tool calls", () => {
    const s = new AgentState(SID, AID);
    s.beginTurn(newTurnId());
    s.nextIteration();
    s.nextIteration();
    s.countToolCall();
    s.countToolCall();
    expect(s.getIteration()).toBe(2);
    expect(s.getToolCallsExecuted()).toBe(2);
    const snap = s.snapshot();
    expect(snap.iteration).toBe(2);
    expect(snap.phase).toBe("thinking");
  });

  it("E4-R86 (H2): a repeated call+args with a DIFFERENT result cancels the identical streak", () => {
    const s = new AgentState(SID, AID);
    s.beginTurn(newTurnId());
    // Same call+args, three DIFFERENT results — each is observable progress.
    expect(s.noteToolCall("read_file", { path: "a" }, "fp-1")).toBe(1);
    expect(s.lastCallCancelledStreak).toBe(false);
    expect(s.noteToolCall("read_file", { path: "a" }, "fp-2")).toBe(1);
    expect(s.lastCallCancelledStreak).toBe(true);
    expect(s.lastCallWouldBeStreak).toBe(2);
    expect(s.noteToolCall("read_file", { path: "a" }, "fp-3")).toBe(1);
    expect(s.lastCallCancelledStreak).toBe(true);
  });

  it("E4-R86 (H2): an UNCHANGED result still advances the identical streak (real stall)", () => {
    const s = new AgentState(SID, AID);
    s.beginTurn(newTurnId());
    expect(s.noteToolCall("read_file", { path: "a" }, "fp-x")).toBe(1);
    expect(s.noteToolCall("read_file", { path: "a" }, "fp-x")).toBe(2);
    expect(s.lastCallCancelledStreak).toBe(false);
    expect(s.noteToolCall("read_file", { path: "a" }, "fp-x")).toBe(3);
    expect(s.lastCallCancelledStreak).toBe(false);
  });

  it("E4-R86 (H2): a different call or different args resets the streak WITHOUT progress", () => {
    const s = new AgentState(SID, AID);
    s.beginTurn(newTurnId());
    expect(s.noteToolCall("read_file", { path: "a" }, "fp-x")).toBe(1);
    expect(s.noteToolCall("read_file", { path: "b" }, "fp-y")).toBe(1);
    expect(s.lastCallCancelledStreak).toBe(false);
    expect(s.noteToolCall("write_file", { path: "a" }, "fp-z")).toBe(1);
    expect(s.lastCallCancelledStreak).toBe(false);
  });

  it("E4-R86 (H2): a caller that supplies NO result fingerprint keeps the pre-R86 name+args streak", () => {
    const s = new AgentState(SID, AID);
    s.beginTurn(newTurnId());
    // The result fingerprint is optional. A caller that omits it cannot report
    // observable progress, so it must fall back to the ORIGINAL contract
    // (same name+args → advance the streak). Returning 1 forever would silently
    // disable stall termination for that caller — a safety-relevant degradation.
    expect(s.noteToolCall("read_file", { path: "a" })).toBe(1);
    expect(s.noteToolCall("read_file", { path: "a" })).toBe(2);
    expect(s.noteToolCall("read_file", { path: "a" })).toBe(3);
    expect(s.lastCallCancelledStreak).toBe(false);
    expect(s.noteToolCall("read_file", { path: "b" })).toBe(1);
  });

  it("E4-R86 (H2): resetToolStreak clears the result-aware state (post-recovery)", () => {
    const s = new AgentState(SID, AID);
    s.beginTurn(newTurnId());
    s.noteToolCall("read_file", { path: "a" }, "fp-x");
    s.noteToolCall("read_file", { path: "a" }, "fp-x");
    s.resetToolStreak();
    expect(s.noteToolCall("read_file", { path: "a" }, "fp-x")).toBe(1);
    expect(s.lastCallCancelledStreak).toBe(false);
  });
});