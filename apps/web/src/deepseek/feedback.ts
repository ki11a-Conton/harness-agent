import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SessionId } from "@ar/contracts";
import type { Harness } from "@ar/harness";
import { RemoteFailure } from "./transport.js";
import { feedbackCategories, feedbackHistorySchema, feedbackItems, MAX_FEEDBACK_NOTE_BYTES, type FeedbackHistory, type FeedbackItem } from "./feedback-records.js";

// MIT adaptation of message-feedback's session-owned CAS/no-op/delete rules at
// DeepSeek Harness 5badb15009ae1756c3afe0ae0cef1faafc290ccc. Copyright (c) 2026
// DeepSeek; license retained in public/deepseek/licenses/upstream-source-reference/LICENSE.
// Harness keeps this local human audit in controlled presentation metadata;
// it never adds a prompt or uploads conversation logs to an external service.
export type FeedbackAction<T> = (history: FeedbackHistory) => { value: T; history?: FeedbackHistory };
export interface FeedbackHost {
  harness: Harness;
  transaction<T>(id: string, signal: AbortSignal, action: FeedbackAction<T>): Promise<T>;
}
const sessionId = z.string().regex(/^session_[A-Za-z0-9_-]+$/).max(200);
const messageId = z.string().min(1).max(300);
const version = z.string().min(1).max(200);
const schemas = {
  "messageFeedback/list": z.object({ sessionId }).strict(),
  "messageFeedback/put": z.object({ sessionId, messageId, rating: z.enum(["positive", "negative"]), note: z.string().optional(), category: z.enum(feedbackCategories).optional(), ifVersion: version.nullable() }).strict(),
  "messageFeedback/delete": z.object({ sessionId, messageId, ifVersion: version }).strict(),
  "sessionFeedback/record": z.object({ sessionId, text: z.string().optional(), category: z.enum(feedbackCategories).optional() }).strict(),
};
type Endpoint = keyof typeof schemas;
type Result = { ok: true; value: unknown } | { ok: false; error: Record<string, unknown> };
const success = (value: unknown): Result => ({ ok: true, value });
const refused = (code: string, details: Record<string, unknown> = {}): Result => ({ ok: false, error: { code, ...details } });

export function createFeedbackService(host: FeedbackHost) {
  return {
    endpoints: Object.keys(schemas),
    async call(endpoint: string, envelope: Record<string, unknown>, signal: AbortSignal): Promise<Result> {
      signal.throwIfAborted();
      if (!Object.hasOwn(schemas, endpoint)) throw new RemoteFailure("gateway/not-found", "Unknown feedback endpoint");
      const parsed = z.object({ request: schemas[endpoint as Endpoint] }).strict().safeParse(envelope);
      if (!parsed.success) throw new RemoteFailure("gateway/bad-request", "Invalid feedback request");
      const request = parsed.data.request;
      const args: Record<string, unknown> = request;
      const session = await host.harness.store.getSession(request.sessionId as SessionId);
      if (session === undefined || session.status === "failed") return refused("session-not-found", { sessionId: request.sessionId });
      if (endpoint === "messageFeedback/put") {
        const owned = await host.harness.store.listMessages(session.id);
        if (!owned.some(message => message.id === args.messageId && message.role === "assistant")) {
          return refused("target-not-found", { sessionId: session.id, messageId: args.messageId });
        }
      }
      const rawNote = endpoint === "messageFeedback/put" ? args.note : args.text;
      if (typeof rawNote === "string") {
        if (endpoint === "messageFeedback/put" && !rawNote.trim()) return refused("note-blank");
        const actualBytes = Buffer.byteLength(rawNote);
        if (actualBytes > MAX_FEEDBACK_NOTE_BYTES) return refused("note-too-large", { maxBytes: MAX_FEEDBACK_NOTE_BYTES, actualBytes });
      }
      return host.transaction<Result>(request.sessionId, signal, history => {
        signal.throwIfAborted();
        const items = feedbackItems(history);
        if (endpoint === "messageFeedback/list") return { value: success({ items }) };
        const existing = items.find(item => item.messageId === args.messageId);
        let next: FeedbackHistory[number], value: unknown;
        if (endpoint === "messageFeedback/put") {
          if (args.ifVersion !== (existing?.version ?? null)) return { value: refused("version-conflict", { current: existing ?? null }) };
          if (existing && existing.rating === args.rating && existing.note === args.note && existing.category === args.category) return { value: success(existing) };
          const now = Date.now();
          const item: FeedbackItem = { messageId: String(args.messageId), rating: args.rating as FeedbackItem["rating"],
            ...(args.note === undefined ? {} : { note: String(args.note) }), ...(args.category === undefined ? {} : { category: args.category as FeedbackItem["category"] }),
            version: randomUUID(), createdAt: existing?.createdAt ?? now, updatedAt: Math.max(now, existing?.updatedAt ?? now) };
          next = { kind: "message-put", item }; value = item;
        } else if (endpoint === "messageFeedback/delete") {
          if (existing === undefined) return { value: success({ absent: true }) };
          if (args.ifVersion !== existing.version) return { value: refused("version-conflict", { current: existing }) };
          next = { kind: "message-delete", messageId: existing.messageId, at: Date.now() }; value = { absent: true };
        } else {
          const text = typeof args.text === "string" ? args.text.trim() : "";
          next = { kind: "session", at: Date.now(), ...(text ? { text } : {}), ...(args.category === undefined ? {} : { category: args.category as FeedbackItem["category"] }) };
          value = { recorded: true };
        }
        const updated = [...history, next];
        if (!feedbackHistorySchema.safeParse(updated).success) throw new RemoteFailure("feedback/storage-limit", "Local feedback history exceeded its bounded storage policy");
        return { value: success(value), history: updated };
      });
    },
  };
}
