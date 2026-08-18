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
});