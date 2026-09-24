import { z } from "zod";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { errorInfo, type WorkingStateMutation } from "@ar/contracts";

/**
 * P0-12: update_plan tool — controlled mutation of the agent's working state.
 * The model may update its plan, constraints, decisions, facts, open questions,
 * and mark steps as completed/pending. Protected fields (goal, filesChanged,
 * commandsRun, testsRun, failures, toolRefs, artifactRefs, memoryRefs,
 * childAgentRefs) are read-only from the model's perspective — the runtime
 * populates them automatically.
 */

const mutationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_constraints"), constraints: z.array(z.string()) }),
  z.object({ op: z.literal("set_plan"), steps: z.array(z.string()) }),
  z.object({ op: z.literal("mark_completed"), step: z.string() }),
  z.object({ op: z.literal("set_pending"), steps: z.array(z.string()) }),
  z.object({ op: z.literal("add_decision"), decision: z.string() }),
  z.object({ op: z.literal("add_fact"), fact: z.string() }),
  z.object({ op: z.literal("add_open_question"), question: z.string() }),
  z.object({ op: z.literal("resolve_open_question"), question: z.string() }),
]);

export interface UpdatePlanToolInput {
  mutations: WorkingStateMutation[];
}

const inputSchema = z.object({
  mutations: z.array(mutationSchema).min(1).max(20),
});

export const updatePlanTool: ToolDefinition<UpdatePlanToolInput, string> = {
  name: "update_plan",
  description:
    "Update the agent's working state — plan, constraints, decisions, facts, and progress tracking. " +
    "Use this to set a plan before starting work, mark steps complete, add decisions, " +
    "and record facts. The runtime protects fields like goal and filesChanged.",
  inputSchema,
  risk: "readonly",
  metadata: {
    name: "update_plan",
    version: "1.0.0",
    sideEffect: false,
    network: false,
    filesystem: false,
    process: false,
    interactive: false,
    retry: "safe",
    concurrencySafe: true,
  },
  async execute(input: UpdatePlanToolInput, _context: ToolExecutionContext): Promise<ToolResult<string>> {
    try {
      return {
        status: "success",
        output: `applied ${input.mutations.length} mutation(s)`,
        evidence: [
          {
            type: "file",
            description: `update_plan: ${input.mutations.length} mutation(s)`,
            source: "working-state",
            timestamp: Date.now(),
          },
        ],
      };
    } catch (err) {
      return {
        status: "failed",
        error: errorInfo("PROCESS_ERROR", err instanceof Error ? err.message : String(err)),
      };
    }
  },
};