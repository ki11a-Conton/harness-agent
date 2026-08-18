import { describe, expect, it } from "vitest";
import type { Skill } from "@ar/contracts";
import { newSkillId } from "@ar/contracts";
import {
  averageToolLatencyOf,
  recordSkillEffectiveness,
  successRateOf,
} from "./effectiveness.js";

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: newSkillId(),
    path: "skills/compile-check",
    manifest: { name: "compile-check", description: "run the compiler", version: "1.0.0" },
    status: "discovered",
    discoveredAt: 1000,
    ...overrides,
  };
}

describe("P2-5 skill effectiveness", () => {
  it("accumulates selection and loading without touching the body", () => {
    let skill = makeSkill();
    skill = recordSkillEffectiveness(skill, { kind: "selected" }, { at: 2000 });
    skill = recordSkillEffectiveness(skill, { kind: "loaded" }, { at: 2100 });

    expect(skill.effectiveness!.selectedCount).toBe(1);
    expect(skill.effectiveness!.loadedCount).toBe(1);
    expect(skill.effectiveness!.lastUsedAt).toBe(2100);
    expect(skill.body).toBeUndefined();
  });

  it("accumulates cost and outcome signals", () => {
    let skill = makeSkill();
    skill = recordSkillEffectiveness(skill, { kind: "toolCalled" });
    skill = recordSkillEffectiveness(skill, { kind: "tokensUsed", count: 1200 });
    skill = recordSkillEffectiveness(skill, { kind: "latency", ms: 4500 });
    skill = recordSkillEffectiveness(skill, { kind: "taskCompleted" });
    skill = recordSkillEffectiveness(skill, { kind: "verificationPassed" });

    expect(skill.effectiveness!.toolCallCount).toBe(1);
    expect(skill.effectiveness!.tokenCount).toBe(1200);
    expect(skill.effectiveness!.latencyMs).toBe(4500);
    expect(skill.effectiveness!.completedCount).toBe(1);
    expect(skill.effectiveness!.verificationPassedCount).toBe(1);
  });

  it("is immutable: repeated records on the same skill accumulate", () => {
    const skill = makeSkill();
    const once = recordSkillEffectiveness(skill, { kind: "taskFailed" });
    const twice = recordSkillEffectiveness(once, { kind: "taskCompleted" });

    expect(skill.effectiveness).toBeUndefined();
    expect(once.effectiveness!.failedCount).toBe(1);
    expect(twice.effectiveness!.failedCount).toBe(1);
    expect(twice.effectiveness!.completedCount).toBe(1);
  });

  it("successRateOf is undefined without concluded tasks, else completed/total", () => {
    expect(successRateOf(makeSkill())).toBeUndefined();

    let skill = makeSkill();
    skill = recordSkillEffectiveness(skill, { kind: "taskCompleted" });
    skill = recordSkillEffectiveness(skill, { kind: "taskCompleted" });
    skill = recordSkillEffectiveness(skill, { kind: "taskFailed" });
    expect(successRateOf(skill)).toBeCloseTo(2 / 3, 6);
  });

  it("averageToolLatencyOf is undefined without tool calls", () => {
    expect(averageToolLatencyOf(makeSkill())).toBeUndefined();

    let skill = makeSkill();
    skill = recordSkillEffectiveness(skill, { kind: "toolCalled" });
    skill = recordSkillEffectiveness(skill, { kind: "latency", ms: 1000 });
    skill = recordSkillEffectiveness(skill, { kind: "toolCalled" });
    skill = recordSkillEffectiveness(skill, { kind: "latency", ms: 3000 });
    expect(averageToolLatencyOf(skill)).toBe(2000);
  });
});