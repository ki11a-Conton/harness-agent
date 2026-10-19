import { z } from "zod";

/** Adapted declaration pattern from the retained MIT llm-pi-ai model catalog:
 * levels belong to a model and map to exact provider wire values. Unknown
 * gateways never acquire capabilities from a model-name guess. */
export const effortIds = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEfforts = false | Partial<Record<typeof effortIds[number], string>>;
export const reasoningEffortsSchema = z.union([z.literal(false), z.record(z.enum(effortIds), z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u))
  .refine(value => Object.keys(value).some(key => key !== "off"), "Declare at least one reasoning level")]);
export function reasoningCatalog(efforts: ReasoningEfforts | undefined) {
  if (!efforts) return undefined;
  return { efforts: effortIds.filter(id => efforts[id] !== undefined).map(id => ({ id, name: id })) };
}
