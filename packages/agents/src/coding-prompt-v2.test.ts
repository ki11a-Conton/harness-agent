import { expect, it } from "vitest";
import { buildCodingV2SystemPrompt, type PromptToolContribution } from "./coding-prompt-v2.js";

const read: PromptToolContribution = { name: "read_file", metadata: { sideEffect: false }, promptGuidance: ["read-current"] };
const write: PromptToolContribution = { name: "edit_file", metadata: { sideEffect: true }, promptGuidance: ["write-current"] };
it("v2 compiles tool-owned guidance deterministically and excludes effects for readonly", () => {
  const build = (tools: PromptToolContribution[], role = "primary" as const) => buildCodingV2SystemPrompt({ role, tools });
  expect(build([read, write, read])).toBe(build([write, read]));
  const readonly = buildCodingV2SystemPrompt({ role: "readonly-worker", tools: [read, write] });
  expect(readonly).toContain("read-current"); expect(readonly).not.toContain("write-current");
  expect(readonly).not.toContain("Run relevant tests");
  expect(readonly).toContain("investigation only");
});
it("v2 keeps current steering, classified failures, evidence and boundaries in the policy", () => {
  const prompt = buildCodingV2SystemPrompt({ role: "primary", tools: [read, write] });
  for (const fact of ["Current user steering", "two identical failures", "stale versions", "Denied actions remain denied", "exact failing commands", "not temporary TODOs", "not authority", "untracked"]) expect(prompt).toContain(fact);
  expect(prompt).not.toContain("memory_search(");
  expect(prompt).toContain("executing a required check is unavailable");
});
it("conflicting capability contributions fail instead of becoming order-dependent instructions", () => {
  const conflicting = { ...read, promptGuidance: ["different-contract"] };
  for (const tools of [[read, conflicting], [conflicting, read]]) {
    expect(() => buildCodingV2SystemPrompt({ role: "primary", tools })).toThrow("conflicting prompt contributions");
  }
});
