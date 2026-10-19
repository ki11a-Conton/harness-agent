import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { newEventId, type AdmittedPrompt, type AskUserRequest, type Session, type SessionId, type ToolDefinition, type ToolResult } from "@ar/contracts";
import type { Harness } from "@ar/harness";
import type { RpcMethodRegistry } from "@ar/gateway";
import { createEventsService, fail, keys, object, pause, string } from "./events.js";
import { createSessionMetadataStore, type SessionMetadata, type SessionMetadataStore } from "./metadata.js";
import { pageSessionHistory, projectSessionHistory } from "./projections.js";
import { codingStatusOf } from "./coding-status.js";
import { createFeedbackService, type FeedbackAction } from "./feedback.js";
import { createSessionReferences } from "./session-references.js";
import { controlProjections, defaultControls } from "./controls-state.js";

export interface SessionHost {
  harness: Harness;
  rpc: RpcMethodRegistry;
  cwd: string;
  dataDir?: string;
  pollDelayMs?: number;
  createSession?(workspaceId: string | undefined, signal: AbortSignal): Promise<Session | { sessionId: string }>;
  resolveWorkspace?(workspaceId: string, signal: AbortSignal): Promise<{ id: string; path: string }>;
  /** Share the owner factory's alias/model-transition lock. Reads and actor
   * methods under this action must not independently acquire this same lock. */
  withSessionLock?<T>(sessionId: string, action: () => Promise<T>): Promise<T>;
  bindSession?(sessionId: string): Promise<void> | void;
  beforePrompt?(sessionId: string, requestId: string): Promise<void>;
  executeHostTool?(sessionId: string | undefined, definition: ToolDefinition, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
  /** The file owner validates the receipt's session, immutable bytes and UTF-8
   * encoding through its private admission tool. This is text context, never
   * a fabricated model-native file or image capability. */
  resolveUpload?(sessionId: string, receiptId: string, signal: AbortSignal): Promise<{
    receiptId: string;
    file: { attachmentId: string; name: string; bytes: number };
    text: string;
  }>;
}

/** Full official session wire boundary over the actual single-owner Harness actor. */
export function createSessionService(host: SessionHost) {
  const metadata = createSessionMetadataStore(host.dataDir);
  const locks = new Map<string, Promise<void>>();
  const continuations = new Map<string, Promise<void>>();
  const continuationActors = new Map<string, { interrupt(): Promise<unknown> }>();
  const pendingCalls = new Set<Promise<void>>();
  let stopped = false, closing: Promise<void> | undefined;

  async function serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (host.withSessionLock !== undefined) return host.withSessionLock(id, action);
    const previous = locks.get(id);
    let release!: () => void;
    const chain = new Promise<void>(done => { release = done; });
    locks.set(id, chain);
    await previous;
    try { return await action(); } finally { release(); if (locks.get(id) === chain) locks.delete(id); }
  }
  async function session(id: unknown): Promise<Session> {
    const value = await host.harness.store.getSession(string(id, "sessionId") as SessionId);
    if (value === undefined || value.status === "failed") fail("session/not-found", "Session is unavailable");
    return value!;
  }
  async function meta(id: string, signal: AbortSignal, mutation?: (current: SessionMetadata) => void, commitTitle = false): Promise<SessionMetadata> {
    if (host.executeHostTool === undefined) fail("gateway/unavailable", "Controlled session metadata owner is not configured");
    const tool = sessionMetadataTool(metadata, mutation, host.harness, commitTitle);
    const result = await host.executeHostTool!(id, tool, { path: metadata.path ?? resolve(host.cwd, ".deepseek-memory-metadata"), sessionId: id }, signal);
    if (result.status !== "success") fail(result.error?.code ?? "gateway/internal", result.error?.message ?? "Session metadata operation failed");
    // Metadata is written through a host tool, so a title or receipt commit
    // appends no journal event: the control frame must be invalidated explicitly.
    if (mutation !== undefined || commitTitle) invalidateControl(id as SessionId);
    return result.output as SessionMetadata;
  }
  async function projectUnlocked(id: SessionId, signal: AbortSignal) {
    signal.throwIfAborted();
    const current = await session(id);
    const details = await meta(id, signal);
    // Read source events after messages. Replay holds a commit barrier when the matching message has not appeared yet.
    const messages = await host.harness.store.listMessages(id);
    const displayTexts: Record<string, string> = {};
    for (const message of messages) if (message.role === "user") {
      const text = details.displayTexts?.[createHash("sha256").update(message.content).digest("hex")];
      if (text !== undefined) displayTexts[message.id] = text;
    }
    const events = await host.harness.events.list(id);
    const children = await host.harness.store.listSessions({ parentId: id });
    signal.throwIfAborted();
    const requestIds: Record<string, string> = {};
    const inbox = await host.harness.inbox.listAll(id);
    let admissionBarrier: number | undefined;
    for (const [requestId, receipt] of Object.entries(details.requests)) {
      let prompt: AdmittedPrompt | undefined;
      if (receipt.promptId !== undefined) prompt = inbox.find(item => item.id === receipt.promptId);
      else {
        const candidates = inbox.filter(item => !receipt.beforePromptIds.includes(item.id) && item.text === receipt.text
          && item.kind === (receipt.mode === "queue" ? "followup" : "steer") && item.admittedAt >= receipt.startedAt);
        if (candidates.length === 1) prompt = candidates[0];
      }
      if (prompt === undefined) continue;
      requestIds[prompt.id] = requestId;
      if (prompt.kind === "followup") {
        if (prompt.promotedTurnId !== undefined) {
          // Runtime.startTurn predates inbox correlation and does not stamp
          // promptId. Its durable promotion binding, rather than equal text,
          // identifies the one original user message of this queued turn.
          const message = messages.find(value => value.role === "user" && value.turnId === prompt!.promotedTurnId
            && value.askId === undefined && value.promptId === undefined && value.content === prompt!.text);
          if (message !== undefined) requestIds[message.id] = requestId;
        } else {
          // The actor appends turn.started before bindPromotion. Hold that
          // unbound suffix so a follow subscriber never sees a user message
          // whose rpcId changes after its durable owner binding lands.
          const started = events.find(event => event.type === "turn.started" && event.payload.text === prompt!.text
            && event.timestamp >= prompt!.admittedAt && messages.some(message => message.role === "user"
              && message.turnId === event.turnId && message.askId === undefined && message.content === prompt!.text));
          if (started !== undefined) admissionBarrier = Math.min(admissionBarrier ?? Infinity, started.sequence);
        }
      }
    }
    const agentPreset = (await host.harness.runtime.getSessionAgent(id)).name;
    const visible = admissionBarrier === undefined ? events : events.filter(event => event.sequence < admissionBarrier);
    // This is a complete owner journal, including every retired prefix. Its
    // first observed event cannot prove a baseline: accepting it would conceal
    // lost history. Only explicitly bounded projection callers may declare one.
    const projected = projectSessionHistory({ session: current, messages, agentPreset,
      events: visible, title: details.title, requestIds, displayTexts, children });
    Object.assign(projected.projections.values, controlProjections(details.controls ?? defaultControls()));
    const reasoning = details.controls?.reasoning;
    if (reasoning?.provider === current.model.providerId && reasoning.model === current.model.modelId && reasoning.effort !== undefined) {
      const selection = projected.projections.values.modelSelection as { next: Record<string, unknown> };
      Object.assign(selection.next, { reasoningEffort: reasoning.effort });
    }
    return projected;
  }
  async function projectSnapshot(id: SessionId, signal: AbortSignal) {
    return serial(id, () => projectUnlocked(id, signal));
  }
  async function summaryUnlocked(id: SessionId, signal: AbortSignal) {
    const current = await session(id);
    // Actor loading is an execution cache, not an availability predicate.
    // Blank drafts and reopened sessions legitimately have no loaded actor.
    // Resolve the same durable effective agent used by runTurn without
    // starting an actor, admitting a prompt, or issuing a model request.
    const agent = await host.harness.runtime.getSessionAgent(id);
    const projection = await projectUnlocked(id, signal);
    const turns = await host.harness.store.listTurns(id);
    const journal = await host.harness.events.list(id);
    return { agentAvailable: agent.id === current.agentId, sessionId: id,
      updatedAt: Math.max(current.updatedAt, ...turns.map(turn => turn.startedAt)),
      running: turns.some(turn => {
        if (turn.status === "running" || turn.status === "waiting_for_approval") return true;
        if (turn.status !== "waiting_for_user") return false;
        // runTurn continues the same paused turn; its persisted status is
        // still waiting_for_user until settlement. Follow its real lifecycle,
        // so the resumed model request has an actual Stop control in the UI.
        const phase = journal.findLast(event => event.turnId === turn.id
          && ["model.started", "ask.turn_waiting", "turn.completed", "turn.failed", "turn.cancelled"].includes(event.type));
        return phase?.type === "model.started";
      }),
      blank: !projection.records.some(record => record.event.type === "user/message"), cwd: current.cwd,
      ...(current.parentId === undefined ? {} : { parentSessionId: current.parentId }),
      projections: { kind: "sequenced", asOfSeq: projection.cursor, values: projection.projections.values } };
  }
  async function summary(id: SessionId, signal: AbortSignal = new AbortController().signal) {
    return serial(id, () => summaryUnlocked(id, signal));
  }

  async function answerAsk(request: AskUserRequest, text: string): Promise<void> {
    if (request.turnId === undefined) fail("user-questions/not-found", "Question has no original turn");
    // A question can be published while its original actor is still saving
    // the pause. Wait outside the session lock, so the owner can finish that
    // operation before an answer claims and resumes the same turn.
    const waitingOwner = await session(request.sessionId);
    const waitingActor = await host.harness.sessions.load(waitingOwner.id);
    const parkDeadline = Date.now() + 10_000, waitSignal = new AbortController().signal;
    while (waitingActor.status().activeTurn?.turnId === request.turnId && !continuations.has(request.id)) {
      if (stopped) fail("gateway/cancelled", "Session service is closed");
      if (Date.now() >= parkDeadline) fail("user-questions/retry-later", "The original task has not finished pausing; retry the answer");
      await pause(host.pollDelayMs ?? 25, waitSignal);
    }
    if (stopped) fail("gateway/cancelled", "Session service is closed");
    await serial(request.sessionId, async () => {
      const owner = await session(request.sessionId);
      const signal = new AbortController().signal;
      const answered = await host.harness.askUserStore?.get(request.id);
      if (answered?.status === "answered" && answered.answerText !== text) fail("user-questions/conflict", "Question already has a different durable answer");
      if (host.harness.askUserStore === undefined) {
        const prior = (await host.harness.events.list(owner.id)).find(event => event.type === "ask.user_replied"
          && event.turnId === request.turnId && event.payload.askId === request.id);
        if (prior !== undefined && prior.payload.text !== text) fail("user-questions/conflict", "Question already has a different durable answer");
      }
      const reply = await host.harness.runtime.submitUserAnswer(owner.id, request.turnId!, request.id, text);
      if (!reply.resumed) fail("user-questions/conflict", reply.message);
      if (continuations.has(request.id)) return;
      const turn = await host.harness.store.getTurn(request.turnId!);
      const current = await meta(owner.id, signal);
      const prior = current.answers[request.id];
      if (prior !== undefined && prior.turnId !== request.turnId) fail("user-questions/conflict", "Question continuation has conflicting ownership");
      if (prior?.status === "settled" || turn?.status === "completed" || turn?.status === "failed" || turn?.status === "cancelled") return;
      const events = await host.harness.events.list(owner.id);
      if (prior !== undefined && events.some(event => event.sequence > prior.afterSequence && event.turnId === request.turnId && event.type === "model.started")) {
        // A restarted turn may have committed side effects. Its runtime recovery owner must reconcile it; never replay it as an answer retry.
        fail("user-questions/recovery-required", "Question continuation already started; use runtime recovery");
      }
      await meta(owner.id, signal, data => { data.answers[request.id] = { turnId: request.turnId!, status: "claimed", afterSequence: events.at(-1)?.sequence ?? -1 }; });
      const actor = await host.harness.sessions.load(owner.id);
      // runTurn reserves its actor slot synchronously. The promise is owned by the host, not the result HTTP request lifetime.
      const running = actor.runTurn(request.turnId!).then(async () => {
        await meta(owner.id, signal, data => { data.answers[request.id]!.status = "settled"; });
      }).catch(async error => {
        console.error("Web question continuation failed", request.sessionId, request.id, error instanceof Error ? error.message : String(error));
        await host.harness.events.appendNew({ id: newEventId(), sessionId: owner.id, turnId: request.turnId, timestamp: Date.now(),
          type: "runtime.degraded", payload: { component: "web-question-continuation", reason: "continuation_failed", message: error instanceof Error ? error.message : String(error) } })
          .catch(journalError => { console.error("Web question error journal failed", journalError instanceof Error ? journalError.message : String(journalError)); });
      }).finally(() => { continuations.delete(request.id); continuationActors.delete(request.id); });
      continuations.set(request.id, running); continuationActors.set(request.id, actor);
    });
  }

  const events = createEventsService({ harness: host.harness, pollDelayMs: host.pollDelayMs, answerAsk, summary: (id, signal) => summary(id, signal) });
  const references = createSessionReferences(host.harness, async (id, signal) => {
    const first = (await host.harness.store.listMessages(id as SessionId)).find(message => message.role === "user");
    // Read presentation metadata after messages: admission persists its display
    // mapping before the immutable expanded message can become visible.
    const details = await meta(id, signal);
    if (details.title) return details.title;
    if (!first) return undefined;
    const text = details.displayTexts?.[createHash("sha256").update(first.content).digest("hex")] ?? first.content;
    return text.trim().replace(/\s+/gu, " ").slice(0, 80);
  });

  async function prompt(request: Record<string, unknown>, signal: AbortSignal): Promise<{ accepted: true }> {
    keys(request, ["requestId", "sessionId", "mode", "content"], ["clientTimeZone"]);
    const id = string(request.sessionId, "sessionId") as SessionId;
    const requestId = string(request.requestId, "requestId");
    if (requestId.length > 200) fail("gateway/bad-request", "Prompt requestId is too long");
    if (request.mode !== "queue" && request.mode !== "steer") fail("gateway/bad-request", "Invalid prompt mode");
    if (request.clientTimeZone !== undefined) {
      try { new Intl.DateTimeFormat("en", { timeZone: string(request.clientTimeZone, "clientTimeZone") }); }
      catch { fail("session/invalid-time-zone", "Invalid client time zone"); }
    }
    if (!Array.isArray(request.content) || request.content.length === 0 || request.content.length > 100) fail("gateway/bad-request", "Invalid prompt content");
    const parts = request.content.map(part => {
      const value = object(part);
      if (value.type === "text") { keys(value, ["type", "text"]); return { type: "text" as const, text: string(value.text, "text", true) }; }
      if (value.type === "file") { keys(value, ["type", "receiptId"]); return { type: "file" as const, receiptId: string(value.receiptId, "receiptId") }; }
      fail("session/attachment-invalid", "This model route accepts text and controlled UTF-8 file receipts; native image intake is unavailable");
    });
    const fingerprint = createHash("sha256").update(JSON.stringify({ content: parts, mode: request.mode, clientTimeZone: request.clientTimeZone })).digest("hex");
    return serial(id, async () => {
      await session(id); signal.throwIfAborted();
      let current = await meta(id, signal);
      let receipt = Object.hasOwn(current.requests, requestId) ? current.requests[requestId] : undefined;
      if (receipt !== undefined && receipt.fingerprint !== fingerprint) fail("session/request-conflict", "Prompt requestId already names different content");
      if (receipt?.status === "accepted") {
        const ownerReceipt = receipt.promptId === undefined ? undefined : (await host.harness.inbox.listAll(id)).find(item => item.id === receipt!.promptId);
        if (ownerReceipt === undefined || ownerReceipt.sessionId !== id || ownerReceipt.text !== receipt.text
          || ownerReceipt.kind !== (receipt.mode === "queue" ? "followup" : "steer")) fail("session/admission-uncertain", "Accepted presentation receipt has no matching durable inbox owner");
        return { accepted: true };
      }
      if (receipt !== undefined) {
        // An interrupted admission can only be recovered from exactly one matching durable owner record.
        const candidates = (await host.harness.inbox.listAll(id)).filter(item => !receipt!.beforePromptIds.includes(item.id)
          && item.text === receipt!.text && item.kind === (receipt!.mode === "queue" ? "followup" : "steer") && item.admittedAt >= receipt!.startedAt);
        if (candidates.length !== 1) fail("session/admission-uncertain", "Prior prompt admission has no unique durable receipt; refusing duplicate execution");
        await meta(id, signal, data => { data.requests[requestId]!.status = "accepted"; data.requests[requestId]!.promptId = candidates[0]!.id; });
        return { accepted: true };
      }
      await host.beforePrompt?.(id, requestId);
      const content: Array<{ text: string; references: boolean }> = [];
      for (const part of parts) {
        if (part.type === "text") content.push({ text: part.text, references: true });
        else {
          if (host.resolveUpload === undefined) fail("session/attachment-invalid", "Controlled file admission is unavailable");
          const upload = await host.resolveUpload!(id, part.receiptId, signal);
          if (upload.receiptId !== part.receiptId || typeof upload.text !== "string" || typeof upload.file.name !== "string") fail("session/attachment-invalid", "File receipt owner returned an invalid attachment");
          content.push({ text: `[Attached UTF-8 file: ${JSON.stringify(upload.file.name)}]\n${upload.text}\n[End attached file]`, references: false });
        }
      }
      const { text, displayText } = await references.prepare(id, content, signal);
      if (text.trim().length === 0 || text.length > 64_000) fail("session/attachment-invalid", "Prompt text and extracted file context must contain at most 64000 characters");
      const actor = await host.harness.sessions.load(id);
      const beforePromptIds = (await host.harness.inbox.listAll(id)).map(item => item.id);
      current = await meta(id, signal, data => {
        if (displayText !== text) (data.displayTexts ??= {})[createHash("sha256").update(text).digest("hex")] = displayText;
        Object.defineProperty(data.requests, requestId, { enumerable: true, writable: true, configurable: true,
          value: { fingerprint, text, mode: request.mode as "queue" | "steer", startedAt: Date.now(), beforePromptIds, status: "admitting" } });
      });
      receipt = current.requests[requestId]!;
      // Cancellation before durable admission is honored. Once admitted, browser disconnect does not cancel another tab's work.
      signal.throwIfAborted();
      if (request.mode === "queue") await actor.enqueueFollowup({ sessionId: id, text });
      else await actor.steer({ sessionId: id, text });
      const candidates = (await host.harness.inbox.listAll(id)).filter(item => !beforePromptIds.includes(item.id)
        && item.text === text && item.kind === (request.mode === "queue" ? "followup" : "steer") && item.admittedAt >= receipt!.startedAt);
      if (candidates.length !== 1) fail("session/admission-uncertain", "Prompt was admitted but its durable receipt is ambiguous");
      await meta(id, new AbortController().signal, data => { data.requests[requestId]!.status = "accepted"; data.requests[requestId]!.promptId = candidates[0]!.id; });
      return { accepted: true };
    });
  }

  const feedback = createFeedbackService({ harness: host.harness,
    async transaction<T>(id: string, signal: AbortSignal, action: FeedbackAction<T>): Promise<T> {
      return serial(id, async () => {
        await session(id); const before = await meta(id, signal);
        const result = action(before.feedback ?? []);
        if (result.history !== undefined) await meta(id, signal, row => {
          if (row.revision !== before.revision) fail("session/metadata-conflict", "Feedback metadata revision changed");
          row.feedback = structuredClone(result.history!);
        });
        return result.value;
      });
    },
  });
  const endpoints = ["session/list", "session/search", "session/create", "session/rename", "session/fork", "session/prompt", "session/updateQueue", "session/cancel", "session/interrupt", "session/page", "session/follow", "session/projections", "session/control", "session/codingStatus",
    "session/canOpenWorkspacePath", "session/workspacePathApplications", "session/openWorkspacePath", "sessionReferenceResolver/candidates", ...events.endpoints, ...feedback.endpoints];
  const service = {
    endpoints, metadata, summary, publish: events.publish,
    close(): Promise<void> {
      return closing ??= (async () => {
        stopped = true;
        await Promise.all([...pendingCalls]);
        const interrupted = await Promise.allSettled([...new Set(continuationActors.values())].map(actor => actor.interrupt()));
        await Promise.all([...continuations.values()]);
        await metadata.drain();
        for (const result of interrupted) if (result.status === "rejected") throw result.reason;
      })();
    },
    /** Resolve the official browser seq to the owning Harness journal seq.
     * Changes/diff HTTP handlers must never treat the two seq spaces alike. */
    async sourceSequence(id: string, wireSeq: number, signal: AbortSignal): Promise<number> {
      if (!Number.isSafeInteger(wireSeq) || wireSeq < 0) fail("gateway/bad-request", "History seq must be a non-negative safe integer");
      const projection = await projectSnapshot(id as SessionId, signal);
      const sequence = projection.sourceSequenceBySeq[wireSeq];
      if (sequence === undefined) fail("session/not-found", "History seq is outside this session");
      return sequence!;
    },
    async call(endpoint: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
      signal.throwIfAborted();
      if (feedback.endpoints.includes(endpoint)) return feedback.call(endpoint, args, signal);
      if (endpoint === "sessionReferenceResolver/candidates") return references.candidates(args, signal);
      if (events.endpoints.includes(endpoint)) return events.call(endpoint, args, signal);
      if (endpoint === "session/canOpenWorkspacePath") { keys(args, []); return false; }
      if (endpoint === "session/workspacePathApplications") {
        keys(args, ["request"]); const request = object(args.request); keys(request, ["path"]); string(request.path, "path");
        // No native desktop opener is registered by this local/headless host.
        // This capability is independent of the actual in-browser file preview.
        return [];
      }
      if (endpoint === "session/openWorkspacePath") {
        keys(args, ["request"]); const request = object(args.request); keys(request, ["path"], ["action", "application"]);
        string(request.path, "path");
        if (request.action !== undefined && request.action !== "reveal") fail("gateway/bad-request", "Invalid desktop path action");
        if (request.application !== undefined) string(request.application, "application");
        fail("gateway/unavailable", "This host has no native desktop application launcher");
      }
      if (endpoint === "session/list") {
        keys(args, ["_request"]); const request = object(args._request); keys(request, [], ["cursor"]);
        if (request.cursor !== undefined) string(request.cursor, "cursor");
        const rows = [];
        for (const item of await host.harness.store.listSessions()) { signal.throwIfAborted(); if (item.status !== "failed") rows.push(await summary(item.id, signal)); }
        rows.sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId));
        return { items: rows };
      }
      keys(args, ["request"]); const request = object(args.request);
      if (endpoint === "session/search") {
        keys(request, ["query"]); const query = string(request.query, "query", true).trim().toLocaleLowerCase();
        if (query.length === 0) return { items: [], hasMore: false };
        const items = [];
        for (const row of await host.harness.store.listSessions()) {
          signal.throwIfAborted(); if (row.status === "failed") continue;
          const messages = await host.harness.store.listMessages(row.id);
          const match = messages.find(message => message.role !== "system" && message.content.toLocaleLowerCase().includes(query));
          if (match !== undefined) {
            const points = Array.from(match.content); const prefix = Array.from(match.content.slice(0, match.content.toLocaleLowerCase().indexOf(query))).length;
            items.push({ sessionId: row.id, snippet: points.slice(Math.max(0, prefix - 80), Math.max(0, prefix - 80) + 240).join("") });
            if (items.length > 20) return { items: items.slice(0, 20), hasMore: true };
          }
        }
        signal.throwIfAborted(); return { items, hasMore: false };
      }
      if (endpoint === "session/create") {
        keys(request, [], ["workspaceId", "cwd", "sessionId", "agentPreset"]);
        if (request.workspaceId !== undefined && request.cwd !== undefined) fail("gateway/bad-request", "workspaceId and cwd are mutually exclusive");
        if (request.agentPreset !== undefined && request.agentPreset !== host.harness.agents[0]?.name && request.agentPreset !== host.harness.agents[0]?.id) fail("agent-preset/not-found", "Unknown agent preset");
        if (request.sessionId !== undefined) {
          return serial(string(request.sessionId, "sessionId"), async () => {
            const adopted = await session(request.sessionId);
            if (request.cwd !== undefined && await realpath(string(request.cwd, "cwd")) !== await realpath(adopted.cwd)) fail("session/conflict", "Adoption cannot change frozen cwd");
            if (request.workspaceId !== undefined) {
              if (host.resolveWorkspace === undefined) fail("session/workspace-attach-failed", "Workspace binding owner is unavailable");
              const workspace = await host.resolveWorkspace!(string(request.workspaceId, "workspaceId"), signal);
              if (await realpath(workspace.path) !== await realpath(adopted.cwd)) fail("session/conflict", "Adoption cannot move a session to a different frozen workspace");
            }
            const actor = await host.harness.sessions.load(adopted.id);
            if (actor.executionState !== "idle" || actor.status().queuedFollowups > 0) fail("session/agent-busy", "Cannot adopt a busy session");
            await host.bindSession?.(adopted.id); return { sessionId: adopted.id };
          });
        }
        if (request.cwd !== undefined && await realpath(string(request.cwd, "cwd")) !== await realpath(host.cwd)) fail("session/conflict", "Use a registered workspace to create a session outside the primary cwd");
        const created = host.createSession !== undefined
          ? await host.createSession(request.workspaceId === undefined ? undefined : string(request.workspaceId, "workspaceId"), signal)
          : request.workspaceId === undefined ? await host.rpc.invoke("session.create", { agentId: host.harness.agents[0]!.id, cwd: host.cwd }, { signal }) as Session
            : fail("session/workspace-attach-failed", "Workspace session factory is unavailable");
        const id = "id" in created ? created.id : created.sessionId;
        await host.bindSession?.(id); return { sessionId: id };
      }
      if (endpoint === "session/prompt") return prompt(request, signal);
      if (endpoint === "session/updateQueue") {
        keys(request, ["sessionId", "itemId", "action"]);
        const owner = await session(request.sessionId);
        const itemId = string(request.itemId, "itemId");
        const action = object(request.action);
        if (action.kind === "edit") {
          keys(action, ["kind", "content"]);
          if (!Array.isArray(action.content) || action.content.length === 0) fail("gateway/bad-request", "Queue edits need non-empty text content");
          const content = action.content.map(part => { const value = object(part); keys(value, ["type", "text"]); if (value.type !== "text") fail("gateway/bad-request", "Queue edits accept text only"); return string(value.text, "text", true); }).join("\n");
          if (content.trim().length === 0 || content.length > 64_000) fail("gateway/bad-request", "Queue edit text is empty or too large");
        } else { keys(action, ["kind"]); if (action.kind !== "remove" && action.kind !== "steer") fail("gateway/bad-request", "Unknown queue action"); }
        if (!(await host.harness.inbox.listPending(owner.id)).some(item => item.id === itemId)) fail("session/queue-item-not-found", "Pending queue item no longer exists");
        // InboxStore can mark durable records, but the actor also owns a live
        // followup queue. Mutating only the store would leave that queued
        // action executing. No frozen owner currently exposes an atomic edit,
        // remove or queue-to-steer transition: fail visibly without side effects.
        fail("gateway/unavailable", "The current Runtime has no atomic pending-queue edit, remove or steer owner; the queued turn remains unchanged");
      }
      if (endpoint === "session/rename") {
        keys(request, ["sessionId", "title"]); const owner = await session(request.sessionId);
        const title = string(request.title, "title").trim().replace(/\s+/gu, " ");
        if (title.length === 0 || Array.from(title).length > 200) fail("session/title-invalid", "Title must contain 1–200 characters");
        return serial(owner.id, async () => {
          await meta(owner.id, signal, data => { data.title = title; }, true);
          const projection = await projectUnlocked(owner.id, signal);
          return { title, seq: projection.cursor };
        });
      }
      if (endpoint === "session/fork") {
        keys(request, ["sessionId"], ["atSeq"]); const owner = await session(request.sessionId);
        return serial(owner.id, async () => {
          if (request.atSeq !== undefined) {
            const projection = await projectUnlocked(owner.id, signal);
            if (request.atSeq !== projection.cursor) fail("session/fork-unavailable", "This runtime currently forks only the latest settled history; exact earlier cuts require the prefix-fork owner");
          }
          const branch = await host.rpc.invoke("session.fork", { sessionId: owner.id }, { signal }) as Session;
          const displayTexts = (await meta(owner.id, signal)).displayTexts;
          if (displayTexts !== undefined) await meta(branch.id, signal, row => { row.displayTexts = structuredClone(displayTexts); });
          await host.bindSession?.(branch.id); return { sessionId: branch.id };
        });
      }
      if (endpoint === "session/cancel" || endpoint === "session/interrupt") {
        keys(request, ["sessionId"]); const owner = await session(request.sessionId);
        return serial(owner.id, async () => {
          await host.rpc.invoke("session.interrupt", { sessionId: owner.id }, { signal });
          // An in-flight ask can commit its pause while interrupt is joining
          // the original run. Read its durable state AFTER that join.
          const waiting = (await host.harness.store.listTurns(owner.id)).filter(turn => turn.status === "waiting_for_user");
          // A returned waiting turn has no active actor run. Cancellation goes through the runtime's original turn owner.
          for (const turn of waiting) {
            if ((await host.harness.store.getTurn(turn.id))?.status !== "waiting_for_user") continue;
            const actor = await host.harness.sessions.load(owner.id);
            await actor.cancelTurn(turn.id);
          }
          return { accepted: true };
        });
      }
      if (endpoint === "session/projections") {
        keys(request, ["sessionId"]); const id = string(request.sessionId, "sessionId") as SessionId;
        return serial(id, async () => {
          const existing = await host.harness.store.getSession(id);
          if (existing === undefined || existing.status === "failed") return null;
          return (await projectUnlocked(id, signal)).projections;
        });
      }
      if (endpoint === "session/page") {
        keys(request, ["address", "throughSeq"], ["beforeSeq", "maxMessages", "turnWindow"]);
        const id = await address(request.address);
        return pageSessionHistory(await projectSnapshot(id, signal), request as never);
      }
      if (endpoint === "session/codingStatus") {
        keys(request, ["address"]);
        return codingStatusOf(await projectSnapshot(await address(request.address), signal));
      }
      fail("gateway/not-found", `Unknown session endpoint: ${endpoint}`);
    },
    async *stream(endpoint: string, args: Record<string, unknown>, signal: AbortSignal, _uplink?: AsyncIterable<unknown>): AsyncIterable<unknown> {
      signal.throwIfAborted();
      if (events.endpoints.includes(endpoint)) { yield* events.stream(endpoint, args, signal); return; }
      if (endpoint === "session/control") {
        keys(args, []);
        const previous = new Map<string, string>();
        const baselines: Record<string, unknown> = {};
        for (const row of await host.harness.store.listSessions()) if (row.status !== "failed") {
          const baseline = await controlProjection(row, signal);
          baselines[row.id] = { kind: "sequenced", asOfSeq: baseline.asOfSeq, values: baseline.values };
          previous.set(row.id, baseline.encoded);
        }
        yield { type: "baseline", value: { projections: baselines } };
        while (!signal.aborted) {
          for (const row of await host.harness.store.listSessions()) if (row.status !== "failed") {
            const baseline = await controlProjection(row, signal);
            if (previous.get(row.id) === baseline.encoded) continue;
            previous.set(row.id, baseline.encoded);
            // Only the opening baseline/list hints support the empty cursor
            // -1. A live control frame needs a committed non-negative seq;
            // RemoteSnapshotStream also forbids a second opening baseline.
            // New drafts get their empty hints from create/list/$events.
            if (baseline.asOfSeq === -1) continue;
            for (const [key, value] of Object.entries(baseline.values)) yield { type: "projection", sessionId: row.id, key, value, seq: baseline.asOfSeq };
          }
          await pause(host.pollDelayMs ?? 25, signal);
        }
        return;
      }
      if (endpoint !== "session/follow") fail("gateway/not-found", `Unknown session stream: ${endpoint}`);
      keys(args, ["request"]); const request = object(args.request);
      keys(request, ["address"], ["maxMessages", "turnWindow", "assistantStream"]);
      if (request.assistantStream !== undefined && request.assistantStream !== true) fail("gateway/bad-request", "assistantStream must be true when present");
      const id = await address(request.address);
      let projection = await projectSnapshot(id, signal);
      const page = pageSessionHistory(projection, { ...request, throughSeq: projection.cursor } as never);
      yield { type: "snapshot", header: projection.header,
        cursor: projection.cursor, ...page, projections: projection.projections,
        ...(request.assistantStream === true ? { assistantStream: projection.assistantStream } : {}) };
      let sourceCursor = projection.sourceCursor;
      const committed = new Map(projection.records.map(record => [record.event.seq, JSON.stringify(record)]));
      while (!signal.aborted) {
        await pause(host.pollDelayMs ?? 25, signal); if (signal.aborted) break;
        projection = await projectSnapshot(id, signal);
        for (const record of projection.records) if (committed.has(record.event.seq) && committed.get(record.event.seq) !== JSON.stringify(record)) {
          fail("session/history-conflict", "Durable projection prefix changed during follow");
        }
        for (const [sourceSequence, frames] of projection.framesBySourceSequence) if (sourceSequence > sourceCursor) {
          for (const frame of frames) {
            if (frame.type === "assistant-stream" && request.assistantStream !== true) continue;
            if (frame.type === "event") committed.set(frame.event.seq, JSON.stringify(frame));
            yield frame;
          }
        }
        sourceCursor = projection.sourceCursor;
      }
    },
  };
  // P41 audit WEB-021: `session/control` polls every ~25 ms, and one projection
  // reads the session row, the metadata host tool, every message, the full
  // journal, the child list and the inbox. A session that appended no event and
  // mutated no metadata since its last frame must not repeat that work, so the
  // frame is reused while the journal watermark, the session status and the
  // metadata revision are unchanged.
  const controlCache = new Map<SessionId, { sequence: number; status: string; revision: number; encoded: string;
    asOfSeq: number; values: Record<string, unknown> }>();
  const controlRevision = new Map<SessionId, number>();
  function invalidateControl(id: SessionId): void {
    controlRevision.set(id, (controlRevision.get(id) ?? 0) + 1);
  }
  async function controlProjection(row: { id: SessionId; status: string }, signal: AbortSignal) {
    // `nextSequence` is a single indexed `MAX(sequence)` read, not a journal replay.
    const sequence = (await host.harness.events.nextSequence(row.id)) - 1;
    const revision = controlRevision.get(row.id) ?? 0;
    const cached = controlCache.get(row.id);
    if (cached !== undefined && cached.sequence === sequence && cached.status === row.status && cached.revision === revision) return cached;
    const projection = (await projectSnapshot(row.id, signal)).projections;
    const entry = { sequence, status: row.status, revision, encoded: JSON.stringify(projection.values),
      asOfSeq: projection.asOfSeq, values: projection.values };
    controlCache.set(row.id, entry);
    return entry;
  }
  const dispatch = service.call.bind(service);
  service.call = async (endpoint, args, signal) => {
    if (stopped) fail("gateway/cancelled", "Session service is closed");
    let done!: () => void;
    const settled = new Promise<void>(resolve => { done = resolve; }); pendingCalls.add(settled);
    try { return await dispatch(endpoint, args, signal); }
    finally { done(); pendingCalls.delete(settled); }
  };
  return service;

  async function address(value: unknown): Promise<SessionId> {
    const input = object(value);
    if (input.kind === "session") {
      keys(input, ["kind", "sessionId"]);
      // Ownership/status are checked inside the read snapshot lock, so an
      // activation's private failed placeholder is never observed here.
      return string(input.sessionId, "sessionId") as SessionId;
    }
    if (input.kind === "subagent") {
      keys(input, ["kind", "parentSessionId", "childSessionId", "mode"]);
      const parent = await session(input.parentSessionId); const child = await session(input.childSessionId);
      if (child.parentId !== parent.id || !["one-shot", "continuable", "unknown"].includes(String(input.mode))) fail("subagent/not-found", "Child is not owned by this parent");
      return child.id;
    }
    fail("gateway/bad-request", "Invalid session address");
  }
}

/** Private host tool: never registered in the model's tool catalog or frozen router. */
export function sessionMetadataTool(store: SessionMetadataStore, mutation?: (current: SessionMetadata) => void, harness?: Harness, commitTitle = false): ToolDefinition {
  return { name: "web_session_metadata", description: "Read or mutate private session presentation and admission metadata", risk: mutation === undefined ? "readonly" : "side_effect",
    inputSchema: z.object({ path: z.string(), sessionId: z.string().min(1) }).strict(),
    metadata: { name: "web_session_metadata", version: "1", sideEffect: mutation !== undefined, filesystem: true, process: false, network: false, interactive: false, retry: "none", concurrencySafe: false },
    async execute(input) {
      const { sessionId } = input as { sessionId: string };
      const before = await store.read(sessionId);
      const output = mutation === undefined ? before : await store.update(sessionId, mutation);
      let publishTitle = output.title !== before.title;
      if (mutation !== undefined && !publishTitle && commitTitle && harness !== undefined) {
        const previous = (await harness.events.list(sessionId as SessionId)).findLast(event => event.type === "tool.completed" && event.payload.tool === "web_session_metadata" && typeof event.payload.outputPreview === "string");
        // A committed metadata write can precede its journal append failing.
        // Retrying the same title must reconcile that durable fact rather
        // than treating it as an event-free no-op forever.
        publishTitle = previous === undefined || previous.payload.outputPreview !== JSON.stringify({ title: output.title });
      }
      if (mutation !== undefined && publishTitle && output.title !== undefined && harness !== undefined) {
        await harness.events.appendNew({ id: newEventId(), sessionId: sessionId as SessionId, timestamp: Date.now(), type: "tool.completed",
          payload: { tool: "web_session_metadata", outputPreview: JSON.stringify({ title: output.title }) } });
      }
      return { status: "success", output };
    } };
}
