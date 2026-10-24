import { z } from "zod";
import type { ModelRequest } from "@ar/contracts";

/** Adapted declaration pattern from the retained MIT llm-pi-ai model catalog:
 * levels belong to a model and map to exact provider wire values. Unknown
 * gateways never acquire capabilities from a model-name guess. Off/null follows
 * 22ddee37; source and MIT notice: third_party/deepseek-model-reasoning. */
export const effortIds = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const wireValue = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u);
const effortFields = {
  off: wireValue.nullable().optional(), minimal: wireValue.optional(), low: wireValue.optional(),
  medium: wireValue.optional(), high: wireValue.optional(), xhigh: wireValue.optional(), max: wireValue.optional(),
} satisfies Record<typeof effortIds[number], z.ZodTypeAny>;
export const reasoningEffortsSchema = z.union([z.literal(false), z.object(effortFields).strict()
  .refine(value => Object.keys(value).some(key => key !== "off"), "Declare at least one reasoning level")]);
export type ReasoningEfforts = z.infer<typeof reasoningEffortsSchema>;
export function reasoningCatalog(efforts: ReasoningEfforts | undefined) {
  if (!efforts) return undefined;
  return { efforts: effortIds.filter(id => efforts[id] !== undefined).map(id => ({ id, name: id })) };
}

/** A null Off explicitly removes the wire override; old strings retain their exact meaning. */
export function applyModelReasoning(request: ModelRequest, efforts: ReasoningEfforts | undefined, selected: string): ModelRequest {
  const wire = efforts && efforts[selected as keyof typeof efforts];
  if (selected === "off" && wire === null) {
    const next = { ...request };
    delete next.reasoningEffort;
    return next;
  }
  return typeof wire === "string" ? { ...request, reasoningEffort: wire } : request;
}
