import type { Skill, SkillEffectiveness } from "@ar/contracts";

/**
 * P2-5: skill effectiveness tracking. Pure functions only — persistence is
 * the store's job. A discovered skill is not an effective skill: the funnel
 * (selected → loaded → injected → outcome/cost) accumulates evidence that
 * downstream evolution gates (SKILL-EVO-001) and selection logic consume.
 */

export type SkillUseFeedback =
  | { kind: "selected" }
  | { kind: "loaded" }
  | { kind: "injected" }
  | { kind: "toolCalled" }
  | { kind: "tokensUsed"; count: number }
  | { kind: "latency"; ms: number }
  | { kind: "taskCompleted" }
  | { kind: "taskFailed" }
  | { kind: "verificationPassed" }
  | { kind: "verificationFailed" };

export interface SkillUseOptions {
  /** Feedback timestamp; defaults to Date.now(). */
  at?: number;
}

/** One feedback record applied to the skill's funnel. */
export type SkillEffectivenessDelta = Partial<SkillEffectiveness>;

/** Return a new skill with the feedback applied (immutable). */
export function recordSkillEffectiveness(
  skill: Skill,
  feedback: SkillUseFeedback,
  opts: SkillUseOptions = {},
): Skill {
  const base = skill.effectiveness ?? emptyEffectiveness();
  const count = (kind: SkillUseFeedback["kind"]): number =>
    feedback.kind === kind ? 1 : 0;
  return {
    ...skill,
    effectiveness: {
      ...base,
      selectedCount: base.selectedCount + count("selected"),
      loadedCount: base.loadedCount + count("loaded"),
      injectedCount: base.injectedCount + count("injected"),
      toolCallCount: base.toolCallCount + count("toolCalled"),
      tokenCount:
        base.tokenCount + (feedback.kind === "tokensUsed" ? feedback.count : 0),
      latencyMs: base.latencyMs + (feedback.kind === "latency" ? feedback.ms : 0),
      completedCount: base.completedCount + count("taskCompleted"),
      failedCount: base.failedCount + count("taskFailed"),
      verificationPassedCount:
        base.verificationPassedCount + count("verificationPassed"),
      verificationFailedCount:
        base.verificationFailedCount + count("verificationFailed"),
      lastUsedAt: opts.at ?? Date.now(),
    },
  };
}

/** Neutral starting profile (no feedback yet). */
function emptyEffectiveness(): SkillEffectiveness {
  return {
    selectedCount: 0,
    loadedCount: 0,
    injectedCount: 0,
    completedCount: 0,
    failedCount: 0,
    verificationPassedCount: 0,
    verificationFailedCount: 0,
    toolCallCount: 0,
    tokenCount: 0,
    latencyMs: 0,
  };
}

/** Success rate over concluded tasks; undefined when nothing concluded. */
export function successRateOf(skill: Skill): number | undefined {
  const total =
    (skill.effectiveness?.completedCount ?? 0) + (skill.effectiveness?.failedCount ?? 0);
  if (total === 0) return undefined;
  const completed = skill.effectiveness?.completedCount ?? 0;
  return completed / total;
}

/** Average latency per tool call (ms); undefined without tool calls. */
export function averageToolLatencyOf(skill: Skill): number | undefined {
  const calls = skill.effectiveness?.toolCallCount ?? 0;
  if (calls === 0) return undefined;
  return (skill.effectiveness?.latencyMs ?? 0) / calls;
}