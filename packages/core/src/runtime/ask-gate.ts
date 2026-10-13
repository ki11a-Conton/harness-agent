import { ASK_REASONS, isAskReason, type ToolSpec } from "@ar/contracts";
import { ASK_GATE_TOOL } from "./turn-helpers.js";

/** A formal Runtime phase advertisement, never an executable ToolDefinition. */
export const ASK_GATE_SPEC: ToolSpec = {
  name: ASK_GATE_TOOL,
  description: "Ask the user for essential missing input or a decision. The current turn pauses until the user answers; no workspace tool executes.",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["question", "reason"],
    properties: {
      question: { type: "string", minLength: 1, maxLength: 8192, pattern: "\\S" },
      reason: { type: "string", enum: [...ASK_REASONS] },
      options: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 1024, pattern: "\\S" } },
    },
  },
};

/** Validate the same closed shape advertised to the model before parking. */
export function validAskGateArgs(args: Record<string, unknown>): boolean {
  const validText = (value: unknown, cap: number) => typeof value === "string" && value.trim().length > 0 && value.length <= cap;
  return Object.keys(args).every(key => ["question", "reason", "options"].includes(key))
    && validText(args.question, 8192) && isAskReason(args.reason)
    && (args.options === undefined || Array.isArray(args.options) && args.options.length >= 1 && args.options.length <= 20 && args.options.every(option => validText(option, 1024)));
}
