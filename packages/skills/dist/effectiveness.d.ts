import type { Skill, SkillEffectiveness } from "@ar/contracts";
/**
 * P2-5: skill effectiveness tracking. Pure functions only — persistence is
 * the store's job. A discovered skill is not an effective skill: the funnel
 * (selected → loaded → injected → outcome/cost) accumulates evidence that
 * downstream evolution gates (SKILL-EVO-001) and selection logic consume.
 */
export type SkillUseFeedback = {
    kind: "selected";
} | {
    kind: "loaded";
} | {
    kind: "injected";
} | {
    kind: "toolCalled";
} | {
    kind: "tokensUsed";
    count: number;
} | {
    kind: "latency";
    ms: number;
} | {
    kind: "taskCompleted";
} | {
    kind: "taskFailed";
} | {
    kind: "verificationPassed";
} | {
    kind: "verificationFailed";
};
export interface SkillUseOptions {
    /** Feedback timestamp; defaults to Date.now(). */
    at?: number;
}
/** One feedback record applied to the skill's funnel. */
export type SkillEffectivenessDelta = Partial<SkillEffectiveness>;
/** Return a new skill with the feedback applied (immutable). */
export declare function recordSkillEffectiveness(skill: Skill, feedback: SkillUseFeedback, opts?: SkillUseOptions): Skill;
/** Success rate over concluded tasks; undefined when nothing concluded. */
export declare function successRateOf(skill: Skill): number | undefined;
/** Average latency per tool call (ms); undefined without tool calls. */
export declare function averageToolLatencyOf(skill: Skill): number | undefined;
//# sourceMappingURL=effectiveness.d.ts.map