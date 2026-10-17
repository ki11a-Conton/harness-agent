import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAskReason, type AgentEvent, type ApprovalId, type AskId, type AskUserRequest, type SessionId, type TurnId } from "@ar/contracts";
import type { Harness } from "@ar/harness";

export interface RemoteEventHost {
  harness: Harness;
  pollDelayMs?: number;
  home?: string;
  /** Must inject the original ask reply and continue its actual turn through the actor owner. */
  answerAsk(request: AskUserRequest, text: string): Promise<void>;
  summary?(sessionId: SessionId, signal?: AbortSignal): Promise<unknown>;
}
type Pending = { kind: "approval" | "ask"; id: string; sessionId: SessionId; turnId?: TurnId; question?: AskUserRequest };
type Delivery = { pending: Pending; completed?: string; inflight?: Promise<void> };
type Notification = { type: "emit"; event: string; args: readonly unknown[] };
type Generation = { deliveries: Map<string, Delivery>; notices: Notification[]; active: boolean; failure?: Error };

// Exact emit face of MIT dsh-api-remotes@0.2.1-alpha.1/remote-events.ts.
// Waterfalls stay with their actual owner/correlation boundary above.
const EMIT_TOPICS = new Set(["agent-preset/selected", "api-session/activity", "api-session/added", "api-session/error", "api-session/removed", "api-session/status",
  "commands/change", "deepseek-account/session-expired", "deepseek-account/model-sign-in-required", "credentials/record-updated", "credentials/reference-updated",
  "goal/activation-changed", "cordis/request-run", "cordis/request-run-resolved", "cordis/dynamic-package", "cordis/dynamic-retract", "cordis/inspect-query",
  "cordis/inspect-query-resolved", "llm/adapters-updated", "permission-presets/catalog-changed", "plugin-manager/changed", "plugin-manager/install-log",
  "plugin-manager/install-state", "settings/document-updated", "schedule/changed"]);

/** Gateway event generations own their correlations; browser agentId is never an ownership proof. */
export function createEventsService(host: RemoteEventHost) {
  const generations = new Map<string, Generation>();

  async function ownedQuestion(sessionId: SessionId, id: string, events?: readonly AgentEvent[]): Promise<AskUserRequest | undefined> {
    const session = await host.harness.store.getSession(sessionId);
    if (session === undefined || session.status === "failed") return;
    let request = await host.harness.askUserStore?.get(id as AskId);
    if (host.harness.askUserStore === undefined) {
      const journal = events ?? await host.harness.events.list(sessionId);
      const asked = journal.find(event => event.type === "ask.user_asked" && event.payload.askId === id
        && event.payload.turnId === event.turnId && event.turnId !== undefined);
      if (asked !== undefined && typeof asked.payload.question === "string" && isAskReason(asked.payload.reason)
        && journal.some(event => event.type === "ask.turn_waiting" && event.turnId === asked.turnId && event.payload.askId === id)) {
        const reply = journal.find(event => event.type === "ask.user_replied" && event.turnId === asked.turnId && event.payload.askId === id);
        request = { id: id as AskId, sessionId, turnId: asked.turnId, question: asked.payload.question, reason: asked.payload.reason,
          createdAt: asked.timestamp, status: reply === undefined ? "pending" : "answered",
          ...(reply === undefined ? {} : { answerText: String(reply.payload.text), answeredAt: reply.timestamp }),
          ...(Array.isArray(asked.payload.options) && asked.payload.options.every(value => typeof value === "string") ? { options: asked.payload.options as string[] } : {}) };
      }
    }
    if (request === undefined || request.sessionId !== sessionId || request.turnId === undefined
      || request.status === "withdrawn" || (await host.harness.store.getTurn(request.turnId))?.sessionId !== sessionId) return;
    return request;
  }

  // P41 audit WEB-020: the `$events` waterfall polls every ~25 ms, so a full
  // journal replay plus one ownership read per ask id must not run for sessions
  // that produced no new event. The cache is validated by one bounded tail read
  // (`afterSequence` + `limit: 1`) and by the cheap mutable sources the projection
  // actually depends on: the approval store, the ask store, and the session status.
  type AskCache = { lastSequence: number; approvals: string; asks: string; status: string; items: Pending[] };
  const askCache = new Map<SessionId, AskCache>();

  async function pending(): Promise<Pending[]> {
    const sessions = (await host.harness.store.listSessions()).filter(session => session.status !== "failed");
    const visible = new Set(sessions.map(session => session.id));
    const now = Date.now();
    const approvals = new Map<SessionId, Pending[]>();
    const approvalSignature = new Map<SessionId, string>();
    for (const request of host.harness.approvalStore.listPending()) {
      if (!visible.has(request.sessionId)) continue;
      const live = request.expiresAt > now;
      approvalSignature.set(request.sessionId, `${approvalSignature.get(request.sessionId) ?? ""}${request.id}/${live ? 1 : 0};`);
      if (!live) continue;
      const list = approvals.get(request.sessionId) ?? [];
      list.push({ kind: "approval", id: request.id, sessionId: request.sessionId, turnId: request.turnId });
      approvals.set(request.sessionId, list);
    }
    const result: Pending[] = [];
    for (const session of sessions) {
      const sessionApprovals = approvals.get(session.id) ?? [];
      const sessionApprovalSignature = approvalSignature.get(session.id) ?? "";
      const questions = host.harness.askUserStore === undefined ? [] : await host.harness.askUserStore.listPending(session.id);
      const askSignature = questions.map(question => `${question.id}/${question.status}`).join(";");
      const cached = askCache.get(session.id);
      if (cached !== undefined) {
        const tail = await host.harness.events.list(session.id, { afterSequence: cached.lastSequence, limit: 1 });
        if (tail.length === 0 && cached.approvals === sessionApprovalSignature && cached.asks === askSignature
          && cached.status === session.status && await stillWaiting(cached.items)) {
          result.push(...cached.items);
          continue;
        }
      }
      const journal = await host.harness.events.list(session.id);
      const items: Pending[] = [...sessionApprovals];
      const ids = new Set(journal.flatMap(event => event.type === "ask.user_asked" && typeof event.payload.askId === "string" ? [event.payload.askId] : []));
      for (const question of questions) ids.add(question.id);
      for (const id of ids) {
        const question = await ownedQuestion(session.id, id, journal);
        if (question?.turnId === undefined) continue;
        const turn = await host.harness.store.getTurn(question.turnId);
        if (turn?.status !== "waiting_for_user") continue;
        const waiting = journal.findLast(event => event.type === "ask.turn_waiting" && event.turnId === question.turnId && event.payload.askId === id);
        if (waiting === undefined || journal.some(event => event.type === "model.started" && event.turnId === question.turnId && event.sequence > waiting.sequence)) continue;
        // An answer can commit before the continuation owner starts (including
        // an IO-failure window). Keep that original ask retryable until a real
        // continuation model.started, rather than leaving an invisible pause.
        items.push({ kind: "ask", id, sessionId: session.id, turnId: question.turnId, question });
      }
      askCache.set(session.id, { lastSequence: journal.at(-1)?.sequence ?? cached?.lastSequence ?? 0,
        approvals: sessionApprovalSignature, asks: askSignature, status: session.status, items });
      result.push(...items);
    }
    for (const id of [...askCache.keys()]) if (!visible.has(id)) askCache.delete(id);
    return result;
  }

  /** A cached ask is valid only while its turn is still parked on the same owner. */
  async function stillWaiting(items: readonly Pending[]): Promise<boolean> {
    for (const item of items) {
      if (item.kind !== "ask" || item.turnId === undefined) continue;
      if ((await host.harness.store.getTurn(item.turnId))?.status !== "waiting_for_user") return false;
    }
    return true;
  }

  async function apply(delivery: Delivery, outcome: Record<string, unknown>): Promise<void> {
    if (outcome.kind === "next") { keys(outcome, ["kind"]); return; }
    if (outcome.kind === "rejected") {
      keys(outcome, ["kind", "error"]);
      const error = object(outcome.error);
      keys(error, ["name", "message"], ["code", "details"]);
      string(error.name, "name"); string(error.message, "message", true);
      // Listener failures never resolve the actual pending owner as an approval or answer.
      return;
    }
    keys(outcome, ["kind"], ["value"]);
    if (outcome.kind !== "result") fail("gateway/bad-request", "Invalid event result kind");
    const owner = delivery.pending;
    const actual = (await pending()).find(item => item.kind === owner.kind && item.id === owner.id
      && item.sessionId === owner.sessionId && item.turnId === owner.turnId);
    if (actual === undefined) fail("gateway/conflict", "Remote event is no longer pending");
    if (owner.kind === "approval") {
      if (!["allowed-once", "rejected", "cancelled", "unavailable"].includes(String(outcome.value))) {
        fail("gateway/bad-request", "Invalid approval outcome");
      }
      host.harness.approvalStore.resolve(owner.id as ApprovalId,
        outcome.value === "allowed-once" ? "allow" : outcome.value === "cancelled" ? "cancelled" : "deny", "web");
    } else {
      await host.answerAsk(actual!.question!, answerText(actual!.question!, outcome.value));
    }
  }

  return {
    endpoints: ["$events", "$events/result", "userQuestions/answer", "userQuestions/attachWait"],
    /** Volatile domain notifications reach current generations only. New
     * connections read authoritative baselines rather than replaying notices. */
    publish(topic: string, args: readonly unknown[]): void {
      if (!EMIT_TOPICS.has(topic) || !Array.isArray(args)) fail("gateway/bad-request", "Unknown forwarded notification");
      if ((["llm/adapters-updated", "schedule/changed"].includes(topic) && args.length !== 0)
        || (topic === "credentials/reference-updated" && (args.length !== 1 || typeof args[0] !== "string"))
        || (topic === "settings/document-updated" && (args.length !== 2 || typeof args[0] !== "string" || !Number.isSafeInteger(args[1]) || Number(args[1]) < 0))) {
        fail("gateway/bad-request", "Invalid forwarded notification arguments");
      }
      assertJson(args);
      const owned = JSON.parse(JSON.stringify(args)) as unknown[];
      for (const generation of generations.values()) if (generation.active && generation.failure === undefined) {
        if (generation.notices.length >= 256) {
          generation.failure = Object.assign(new Error("Forwarded notification queue overflow; reconnect for current state"), { code: "gateway/unavailable" });
          generation.notices.length = 0;
        } else generation.notices.push({ type: "emit", event: topic, args: structuredClone(owned) });
      }
    },
    async call(endpoint: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
      signal.throwIfAborted();
      if (endpoint === "$events/result") {
        keys(args, ["clientId", "eventId", "outcome"]);
        const clientId = string(args.clientId, "clientId");
        const eventId = string(args.eventId, "eventId");
        const generation = generations.get(clientId);
        if (generation === undefined || !generation.active) fail("gateway/conflict", "Unknown or closed event generation");
        const delivery = generation!.deliveries.get(eventId);
        if (delivery === undefined) fail("gateway/conflict", "Event does not belong to this generation");
        const outcome = object(args.outcome);
        const fingerprint = JSON.stringify(outcome);
        if (delivery!.completed !== undefined) {
          if (delivery!.completed !== fingerprint) fail("gateway/conflict", "Event already answered differently");
          await delivery!.inflight;
          return;
        }
        // Claim synchronously before the first await: two concurrent HTTP result requests cannot both continue a turn.
        delivery!.completed = fingerprint;
        delivery!.inflight = apply(delivery!, outcome);
        try { await delivery!.inflight; } catch (error) { delete delivery!.completed; throw error; }
        finally { delete delivery!.inflight; }
        return;
      }
      if (endpoint === "userQuestions/answer") {
        keys(args, ["agentId", "callId", "answer"]);
        const sessionId = string(args.agentId, "agentId") as SessionId;
        const callId = string(args.callId, "callId");
        // The durable question also permits a same-answer HTTP retry after
        // injection or settlement. Its exact session/turn binding remains
        // authoritative; pending-list membership alone loses that proof.
        const question = await ownedQuestion(sessionId, callId);
        if (question === undefined) fail("user-questions/not-found", "No owned pending question");
        await host.answerAsk(question!, answerText(question!, args.answer));
        return true;
      }
      fail("gateway/not-found", `Unknown unary endpoint: ${endpoint}`);
    },
    async *stream(endpoint: string, args: Record<string, unknown>, signal: AbortSignal): AsyncIterable<unknown> {
      if (endpoint === "userQuestions/attachWait") {
        keys(args, ["agentId", "callId"]);
        if (await ownedQuestion(string(args.agentId, "agentId") as SessionId, string(args.callId, "callId")) === undefined) fail("user-questions/not-found", "No owned question");
        // Native Harness parks an indefinite question; it has no foreground
        // timeout claim. The official endpoint closes without duration frames
        // when that separate timed-wait owner is absent.
        return;
      }
      if (endpoint !== "$events") fail("gateway/unavailable", `Unsupported event stream: ${endpoint}`);
      keys(args, []);
      signal.throwIfAborted();
      const clientId = randomUUID();
      const generation: Generation = { deliveries: new Map(), notices: [], active: true };
      generations.set(clientId, generation);
      const seen = new Map<string, string>();
      const summaries = new Map<string, string>();
      const summaryController = new AbortController();
      const summarySignal = AbortSignal.any([signal, summaryController.signal]);
      let summaryScan: Promise<void> | undefined;
      function enqueueSummary(event: string, args: readonly unknown[]) {
        if (generation.notices.length >= 256) throw new Error("Session summary notification queue overflow; reconnect for current state");
        generation.notices.push({ type: "emit", event, args });
      }
      try {
        yield { type: "ready", clientId, host: { home: host.home ?? homedir() } };
        while (!signal.aborted) {
          if (generation.failure !== undefined) throw generation.failure;
          while (generation.notices.length > 0) yield generation.notices.shift()!;
          const actual = await pending();
          const available = new Set(actual.map(item => `${item.kind}/${item.id}`));
          for (const [key, eventId] of seen) {
            if (!available.has(key)) { yield { type: "cancel", eventId }; seen.delete(key); }
          }
          for (const item of actual) {
            const key = `${item.kind}/${item.id}`;
            if (seen.has(key)) continue;
            const eventId = randomUUID();
            seen.set(key, eventId);
            generation.deliveries.set(eventId, { pending: item });
            if (item.kind === "ask") {
              const request = item.question!;
              yield { type: "waterfall", event: "user-questions/request", eventId, agentId: item.sessionId,
                request: { questions: [{ id: request.id, question: request.question,
                  ...(request.options === undefined ? {} : { options: request.options.map(label => ({ label })) }) }], wait: { callId: request.id } } };
            } else {
              const request = host.harness.approvalStore.listPending(item.sessionId).find(value => value.id === item.id)!;
              const events = await host.harness.events.list(item.sessionId);
              const source = events.find(event => event.type === "approval.created" && event.payload.approvalId === item.id);
              yield { type: "waterfall", event: "approval/request", eventId, agentId: item.sessionId,
                request: { toolName: typeof source?.payload.tool === "string" ? source.payload.tool : request.action,
                  ...(typeof source?.payload.toolCallId === "string" ? { callId: source.payload.toolCallId } : {}),
                  reason: `${request.reason}\n${request.target}` } };
            }
          }
          // A summary can wait for the ownership lock held by a private tool
          // awaiting human approval. Never let that read block the waterfall
          // which is the only route to answering the approval.
          if (host.summary !== undefined && summaryScan === undefined) {
            summaryScan = (async () => {
              for (const session of (await host.harness.store.listSessions()).filter(session => session.status !== "failed")) {
                if (!generation.active || signal.aborted) return;
                let summary: unknown;
                try { summary = await host.summary!(session.id, summarySignal); }
                catch (error) {
                  if (!generation.active || signal.aborted) return;
                  const current = await host.harness.store.getSession(session.id);
                  if ((error as { code?: unknown }).code !== "session/not-found" || (current !== undefined && current.status !== "failed")) throw error;
                  if (summaries.delete(session.id)) enqueueSummary("api-session/removed", [session.id]);
                  continue;
                }
                if (!generation.active || signal.aborted) return;
                const encoded = JSON.stringify(summary);
                if (summaries.get(session.id) !== encoded) {
                  summaries.set(session.id, encoded);
                  enqueueSummary("api-session/added", [summary]);
                  // The client applies added summaries to its list/projections,
                  // but resident Session.running is owned by the status topic.
                  // A list loaded during generation otherwise stays busy after
                  // the durable turn and conversation have already completed.
                  if (typeof summary === "object" && summary !== null && "running" in summary && typeof summary.running === "boolean") {
                    enqueueSummary("api-session/status", [session.id, summary.running]);
                  }
                }
              }
            })().then(() => { summaryScan = undefined; }, error => {
              if (generation.active && !signal.aborted) generation.failure = error instanceof Error ? error : new Error("Session summary scan failed");
              summaryScan = undefined;
            });
          }
          await pause(host.pollDelayMs ?? 25, signal);
        }
      } finally {
        generation.active = false;
        summaryController.abort();
        // Drain owned reads/writes before releasing the stream. In particular,
        // Windows must not remove a state directory while metadata IO is live.
        await summaryScan;
        generation.deliveries.clear();
        generation.notices.length = 0;
        generations.delete(clientId);
      }
    },
  };
}

export function answerText(request: AskUserRequest, value: unknown): string {
  const answer = object(value); keys(answer, ["answers"]);
  if (!Array.isArray(answer.answers) || answer.answers.length !== 1) fail("gateway/bad-request", "Exactly one owned question answer is required");
  const item = object(answer.answers[0]); keys(item, ["id", "selected"], ["custom"]);
  if (item.id !== request.id || !Array.isArray(item.selected) || item.selected.length > 1
    || item.selected.some(option => typeof option !== "string" || !request.options?.includes(option))) {
    fail("gateway/bad-request", "Question answer identity or option does not match the pending ask");
  }
  if (item.custom !== undefined && (typeof item.custom !== "string" || item.custom.trim().length === 0)) fail("gateway/bad-request", "Invalid custom answer");
  const text = [...item.selected, ...(typeof item.custom === "string" ? [item.custom] : [])].join("\n").trim();
  if (text.length === 0 || text.length > 64_000) fail("gateway/bad-request", "A bounded, non-empty answer is required");
  return text;
}

export function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code, details: {} }); }
function assertJson(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (typeof value !== "object" || seen.has(value)) fail("gateway/bad-request", "Notification must contain lossless JSON");
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) fail("gateway/bad-request", "Notification must contain plain JSON objects");
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) fail("gateway/bad-request", "Notification must contain plain JSON data");
    assertJson(descriptor.value, seen);
  }
  if (Array.isArray(value) && Object.keys(value).length !== value.length) fail("gateway/bad-request", "Notification arrays cannot contain holes");
  seen.delete(value);
}
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("gateway/bad-request", "Expected an object");
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Reflect.ownKeys(value).some(key => typeof key !== "string" || ![...required, ...optional].includes(key))) {
    fail("gateway/bad-request", "Unexpected or missing request fields");
  }
}
export function string(value: unknown, name: string, empty = false): string {
  if (typeof value !== "string" || (!empty && value.length === 0) || value.length > 64_000) fail("gateway/bad-request", `${name} must be a bounded string`);
  return value as string;
}
export function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
  });
}
