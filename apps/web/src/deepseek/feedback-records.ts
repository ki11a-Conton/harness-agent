import { z } from "zod";

// MIT vocabulary adapted from DeepSeek Harness 5badb15009ae1756c3afe0ae0cef1faafc290ccc,
// packages/feedback/{message-feedback,command-feedback}/src/types.ts.
// Copyright (c) 2026 DeepSeek. Full license retained at
// public/deepseek/licenses/upstream-source-reference/LICENSE.
export const feedbackCategories = ["task-result", "instruction-following", "product-interaction", "service-stability", "resource-cost", "security-privacy-permission", "other"] as const;
export const MAX_FEEDBACK_NOTE_BYTES = 16 * 1024;
const stamp = z.number().int().nonnegative().safe();
const note = z.string().refine(value => value.trim().length > 0 && Buffer.byteLength(value) <= MAX_FEEDBACK_NOTE_BYTES);
export const feedbackItemSchema = z.object({ messageId: z.string().min(1).max(300), rating: z.enum(["positive", "negative"]),
  note: note.optional(), category: z.enum(feedbackCategories).optional(), version: z.string().uuid(), createdAt: stamp, updatedAt: stamp,
}).strict().refine(value => value.updatedAt >= value.createdAt);
export type FeedbackItem = z.infer<typeof feedbackItemSchema>;
export const feedbackHistorySchema = z.array(z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message-put"), item: feedbackItemSchema }).strict(),
  z.object({ kind: z.literal("message-delete"), messageId: z.string().min(1).max(300), at: stamp }).strict(),
  z.object({ kind: z.literal("session"), at: stamp, text: note.optional(), category: z.enum(feedbackCategories).optional() }).strict(),
])).max(2048).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024);
export type FeedbackHistory = z.infer<typeof feedbackHistorySchema>;

export function feedbackItems(history: FeedbackHistory): FeedbackItem[] {
  const items = new Map<string, FeedbackItem>();
  for (const event of history) {
    if (event.kind === "message-put") items.set(event.item.messageId, event.item);
    else if (event.kind === "message-delete") items.delete(event.messageId);
  }
  return structuredClone([...items.values()]);
}
