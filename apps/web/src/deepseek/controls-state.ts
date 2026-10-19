import { z } from "zod";

export const permissionPresets = ["read-only", "workspace-write", "danger-full-access"] as const;
export const goalSchema = z.object({
  id: z.string().uuid(), revision: z.number().int().positive().safe(), objective: z.string().trim().min(1).max(16000),
  phase: z.enum(["active", "paused", "blocked", "complete"]),
  maxGoalRounds: z.number().int().min(1).max(100), roundsStarted: z.number().int().min(0).max(100),
  createdAt: z.number().finite(), updatedAt: z.number().finite(),
  blockedReason: z.object({ code: z.string().max(100), message: z.string().max(1000) }).strict().optional(),
  pending: z.object({ requestId: z.string().max(200), text: z.string().max(64000) }).strict().optional(),
}).strict();
export const controlsSchema = z.object({
  permission: z.enum(permissionPresets),
  plan: z.object({ status: z.enum(["off", "draft", "review", "approved"]), revision: z.number().int().nonnegative().safe(),
    content: z.string().max(32000).optional(), requestId: z.string().max(200).optional(), admitted: z.boolean().optional() }).strict(),
  goal: goalSchema.optional(),
  reasoning: z.object({ provider: z.string().min(1).max(200), model: z.string().min(1).max(200), effort: z.string().min(1).max(100).optional() }).strict().optional(),
  compaction: z.object({ pending: z.boolean(), requestedAt: z.number().finite(), lastCompletedAt: z.number().finite().optional() }).strict().optional(),
}).strict();
export type SessionControls = z.infer<typeof controlsSchema>;
export type Goal = z.infer<typeof goalSchema>;
export const defaultControls = (): SessionControls => ({ permission: "workspace-write", plan: { status: "off", revision: 0 } });

/** Actual human-owned state, separate from frozen agent configuration. */
export function controlProjections(controls: SessionControls) {
  const { goal, plan } = controls;
  const { pending: _pending, ...view } = goal ?? {};
  return {
    permissions: { currentValue: controls.permission },
    plan: { active: plan.status === "draft" || plan.status === "review", pending: false },
    harnessPlan: plan,
    harnessCompaction: controls.compaction ?? null,
    goal: goal === undefined ? null : { goal: { id: goal.id, revision: goal.revision, objective: goal.objective, phase: goal.phase,
      maxGoalRounds: goal.maxGoalRounds, ...(goal.blockedReason === undefined ? {} : { blockedReason: goal.blockedReason }) },
      roundsStarted: goal.roundsStarted, createdAt: goal.createdAt, updatedAt: goal.updatedAt },
    harnessGoal: goal === undefined ? null : view,
  };
}
