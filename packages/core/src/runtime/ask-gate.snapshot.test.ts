import { expect, it } from "vitest";
import { newAgentId, newSessionId, newTurnId, type AgentDefinition, type ToolSpec } from "@ar/contracts";
import { ASK_GATE_SPEC, validAskGateArgs } from "./ask-gate.js";
import { buildStepExecutionSnapshot } from "./step-snapshot-factory.js";

const agent: AgentDefinition = { id: newAgentId(), name: "formal-snapshot", description: "test", mode: "primary", model: { providerId: "scripted", modelId: "scripted-model" }, systemPrompt: "Ask only for missing input", tools: { allow: [] }, permissions: { rules: [] }, skills: {}, limits: {} };
function build(formalActionSpecs: readonly ToolSpec[] = []) {
  return buildStepExecutionSnapshot({ sessionId: newSessionId(), turnId: newTurnId(), agent, cwd: "/workspace", stepIndex: 0, priorBlocks: [], system: agent.systemPrompt, compacted: false, history: [], registry: { specs: () => [], list: () => [], get: () => undefined }, semanticsOf: () => { throw new Error("No executable binding exists for a formal phase"); }, formalActionSpecs, goal: "Missing target", toolSelector: { select: () => ({ selected: [], dropped: [] }) } as never, now: () => 1 });
}

it("formal ask schemas are frozen separately, fingerprinted, immune to ordinary tool selection, and never resolve to an executable binding", () => {
  const spec = structuredClone(ASK_GATE_SPEC), snapshot = build([spec]);
  expect(snapshot.tools.modelVisibleSpecs).toEqual([]); expect(snapshot.tools.formalActionSpecs).toEqual([ASK_GATE_SPEC]);
  expect(snapshot.tools.has("ask_user")).toBe(false); expect(snapshot.tools.resolve("ask_user")).toBeUndefined();
  expect(snapshot.advertised).toEqual({ available: 1, dropped: [] });
  const fingerprint = snapshot.record.toolRouterFingerprint;
  spec.inputSchema.required = []; spec.description = "Changed after sampling";
  expect(snapshot.tools.formalActionSpecs).toEqual([ASK_GATE_SPEC]); expect(snapshot.record.toolRouterFingerprint).toBe(fingerprint);
  expect(Object.isFrozen(snapshot.tools.formalActionSpecs)).toBe(true); expect(Object.isFrozen(snapshot.tools.formalActionSpecs![0]!.inputSchema)).toBe(true);
  expect(build([ASK_GATE_SPEC]).record.toolRouterFingerprint).toBe(fingerprint); expect(build().record.toolRouterFingerprint).not.toBe(fingerprint);
});

it("duplicate formal names fail freeze and the advertised schema rejects unknown fields and coerced reason or choices", () => {
  expect(() => build([ASK_GATE_SPEC, ASK_GATE_SPEC])).toThrow(/collides/);
  expect(validAskGateArgs({ question: "Which target?", reason: "choice_required", options: ["a", "b"] })).toBe(true);
  for (const args of [{ question: "   ", reason: "choice_required" }, { question: "q", reason: "unknown" }, { question: "q", reason: "choice_required", options: [1] }, { question: "q", reason: "choice_required", options: [] }, { question: "q", reason: "choice_required", sessionId: "foreign" }, { question: "q" }]) expect(validAskGateArgs(args)).toBe(false);
});
