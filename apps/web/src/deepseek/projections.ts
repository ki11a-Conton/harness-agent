import { modelUsageForBrowser as usageOf } from "./browser-usage.js";
import { EVENT_ABI_VERSION, toolNameOf } from "@ar/contracts";
import type { AgentEvent, Message, Session } from "@ar/contracts";
import { createActivityProjection } from "./activity-projections.js";

/** Browser DTOs follow dsh-api-session-controller@0.2.1-alpha.1/types,
 * dsh-session/types (format 4), and dsh-llm. These are wire values, not a
 * second Runtime journal. The original Harness records remain authoritative. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export interface SessionWireEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: JsonValue;
  readonly ignorable?: true;
  readonly surfaceOp?: "append";
}
export interface SessionHistoryRecord {
  readonly type: "event";
  readonly event: SessionWireEvent;
}
export interface SessionWireHeader {
  readonly version: 4;
  readonly id: string;
  readonly createdAt: number;
  readonly cwd: string;
  readonly isSeeded: boolean;
  readonly parentSession?: string;
}
export interface SessionAssistantStreamAttempt {
  readonly attemptId: string;
  readonly startedAfterSeq: number;
  readonly turn: number;
  readonly step: number;
  readonly nextIndex: number;
  readonly stream: readonly JsonValue[];
}
export interface SessionAssistantStreamBaseline {
  readonly revision: number;
  readonly activeAttempt?: SessionAssistantStreamAttempt;
}
export type SessionAssistantStreamFrame = {
  readonly type: "start";
  readonly attemptId: string;
  readonly revision: number;
  readonly startedAfterSeq: number;
  readonly turn: number;
  readonly step: number;
} | {
  readonly type: "chunk";
  readonly attemptId: string;
  readonly revision: number;
  readonly index: number;
  readonly time: number;
  readonly chunk: JsonValue;
} | {
  readonly type: "end";
  readonly attemptId: string;
  readonly revision: number;
  readonly index: number;
  readonly outcome: { readonly kind: "committed"; readonly eventType: "assistant/message" | "assistant/attempt"; readonly seq: number }
    | { readonly kind: "abandoned" };
};
export interface SessionProjectionBaseline {
  readonly asOfSeq: number;
  readonly values: Readonly<Record<string, JsonValue>>;
}
export type SessionFollowFrame = SessionHistoryRecord | { readonly type: "assistant-stream"; readonly frame: SessionAssistantStreamFrame } | {
  readonly type: "snapshot";
  readonly header: SessionWireHeader;
  readonly cursor: number;
  readonly records: readonly SessionHistoryRecord[];
  readonly hasMore: boolean;
  readonly projections: SessionProjectionBaseline;
  readonly assistantStream?: SessionAssistantStreamBaseline;
};
export interface SessionPageWindow {
  readonly throughSeq: number;
  readonly beforeSeq?: number;
  readonly maxMessages?: number;
  readonly turnWindow?: { readonly minMessages: number; readonly minTurns: number };
}
export interface SessionPage {
  readonly records: readonly SessionHistoryRecord[];
  readonly hasMore: boolean;
}
export interface PageProjection {
  readonly header: SessionWireHeader;
  readonly records: readonly SessionHistoryRecord[];
  readonly cursor: number;
  /** Last source event represented by this consistent prefix, or -1. */
  readonly sourceCursor: number;
  readonly assistantStream: SessionAssistantStreamBaseline;
  /** Ordered durable entries and transient frames produced by each source event. */
  readonly framesBySourceSequence: ReadonlyMap<number, readonly SessionFollowFrame[]>;
  /** Allows a fork cursor to resolve back to the owning Harness event. */
  readonly sourceSequenceBySeq: readonly number[];
  readonly projections: SessionProjectionBaseline;
}
export interface SessionProjectionInput {
  readonly session: Session;
  /** Stable role key resolved from the actual frozen native agent. */
  readonly agentPreset?: string;
  /** Read messages before events, so every visible message has its complete event prefix. */
  readonly messages: readonly Message[];
  readonly events: readonly AgentEvent[];
  /** Declared baseline of the source-event coordinate space, defaulting to 0.
   *
   * Complete journals, including concatenated retired-owner prefixes, start at
   * 0. Only a caller with an independently established bounded range may declare
   * another baseline; never infer one from the first event received. Interior
   * gaps remain invalid, and browser session services always use the default. */
  readonly sourceBaseline?: number;
  readonly title?: string;
  /** Accepted prompt correlation, keyed by durable message id or inbox prompt id. */
  readonly requestIds?: Readonly<Record<string, string>>;
  /** Local host presentation for user input; never changes journal anchoring or model content. */
  readonly displayTexts?: Readonly<Record<string, string>>;
  /** Actual persisted children whose parent identity has been checked. */
  readonly children?: readonly Session[];
}

interface Attempt {
  attemptId: string;
  startedAfterSeq: number;
  turn: number;
  step: number;
  stream: JsonValue[];
  nextIndex: number;
  textStarted: boolean;
}
interface AnchorPlan {
  readonly at: Map<number, number[]>;
  readonly barriers: Set<number>;
  readonly modelMessages: Set<string>;
}

/** Replay a checked Harness prefix into the actual official browser vocabulary.
 * Messages are anchored to records emitted after their append. A source tool
 * outcome can precede its tool message; that incomplete suffix is held back,
 * so a later append cannot renumber events a browser already followed. */
export function projectSessionHistory(input: SessionProjectionInput): PageProjection {
  validateSources(input);
  const { session, events, messages } = input;
  const initialModel = session.modelSelection?.initialModel ?? session.model;
  const plan = planMessageAnchors(input);
  const activity = createActivityProjection(session, messages, input.children, input.agentPreset);
  const records: SessionHistoryRecord[] = [];
  const sourceSequenceBySeq: number[] = [];
  const framesBySourceSequence = new Map<number, readonly SessionFollowFrame[]>();
  const publishedMessages = new Set<string>();
  const emittedCalls = new Set<string>();
  const turnNumbers = new Map<string, number>();
  const stepNumbers = new Map<string, number>();
  const toolOutcomes = new Map<string, AgentEvent>();
  for (const event of events) {
    if (isToolOutcome(event) && typeof event.payload.toolCallId === "string") toolOutcomes.set(event.payload.toolCallId, event);
  }
  let sourceCursor = -1;
  let revision = 0;
  let active: Attempt | undefined;
  let currentTurn = 0;
  let currentStep = 0;
  let currentStepKey: string | undefined;
  let stepOpen = false;
  let openTurnStartSeq: number | null = null;
  let lastStepStartSeq: number | null = null;
  let lastStepBoundary: JsonValue = null;
  let lastPromptAt: number | null = null;
  let modelStarted = false;
  let usedModel: { providerId: string; modelId: string } | undefined;
  let title: string | null = input.title ?? null;
  let frameBatch: SessionFollowFrame[] = [];
  let sourceSequence = -1;

  function append(type: string, time: number, data: JsonValue, surface = false, ignorable = false): SessionWireEvent {
    const event: SessionWireEvent = {
      type, seq: records.length, time, data,
      ...(surface ? { surfaceOp: "append" as const } : {}),
      ...(ignorable ? { ignorable: true as const } : {}),
    };
    const entry: SessionHistoryRecord = { type: "event", event };
    records.push(entry);
    sourceSequenceBySeq.push(sourceSequence);
    frameBatch.push(entry);
    return event;
  }
  function frame(value: SessionAssistantStreamFrame): void {
    frameBatch.push({ type: "assistant-stream", frame: value });
  }
  function chunk(time: number, value: JsonValue): void {
    if (active === undefined) return;
    active.stream.push({ type: "chunk", time, chunk: value });
    frame({ type: "chunk", attemptId: active.attemptId, revision: ++revision, index: active.nextIndex++, time, chunk: value });
  }
  function closeStep(time: number): void {
    if (!stepOpen) return;
    const end = append("step/end", time, { turn: currentTurn, step: currentStep });
    lastStepBoundary = { kind: "end", seq: end.seq };
    stepOpen = false;
  }
  function finishAttempt(time: number, reason: JsonValue): void {
    if (active === undefined) return;
    chunk(time, { type: "finish", reason });
    const attempt = active;
    const settled = append("assistant/attempt", time, { turn: attempt.turn, step: attempt.step, stream: attempt.stream });
    frame({ type: "end", attemptId: attempt.attemptId, revision: ++revision, index: attempt.nextIndex,
      outcome: { kind: "committed", eventType: "assistant/attempt", seq: settled.seq } });
    active = undefined;
  }
  function messageSource(message: Message): JsonValue {
    if (message.role === "assistant") return plan.modelMessages.has(message.id)
      ? { kind: "model", provider: message.model?.providerId ?? initialModel.providerId, model: message.model?.modelId ?? initialModel.modelId }
      : { kind: "harness-verification" };
    if (message.role === "tool") return { kind: "tool", callId: message.toolCallId! };
    if (message.role === "system") return { kind: "system-prompt" };
    const rpcId = input.requestIds?.[message.id] ?? (message.promptId === undefined ? undefined : input.requestIds?.[message.promptId]);
    return { kind: "user", ...(rpcId === undefined ? {} : { rpcId }) };
  }
  function contentOf(message: Message): JsonValue[] {
    const content: JsonValue[] = [];
    // Harness preserves private provider reasoning only for protocol-complete
    // model history. Its model contract forbids exposing that internal field
    // as user-facing output; official thinking renderers remain installed but
    // receive no invented or recovered hidden reasoning blocks.
    const text = message.role === "user" ? input.displayTexts?.[message.id] ?? message.content : message.content;
    if (text !== "") content.push({ type: "text", text });
    for (const call of message.toolCalls ?? []) content.push({ type: "tool-call", id: call.id, name: call.name, arguments: JSON.stringify(call.args) });
    return content;
  }
  function publishMessage(message: Message, event: AgentEvent, modelSettlement = false): void {
    if (publishedMessages.has(message.id)) return;
    const content = contentOf(message);
    const outcome = message.toolCallId === undefined ? undefined : toolOutcomes.get(message.toolCallId);
    const isError = outcome !== undefined && (outcome.type === "tool.failed"
      || (typeof outcome.payload.status === "string" && outcome.payload.status !== "success"));
    const wireMessage: JsonValue = {
      id: message.id, role: message.role, content, source: messageSource(message),
      ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
      ...(isError ? { isError: true } : {}),
    };
    if (message.role === "user") {
      append("user/message", message.createdAt, wireMessage, true);
      lastPromptAt = message.createdAt;
      if (title === null) title = (input.displayTexts?.[message.id] ?? message.content).replace(/\s+/g, " ").trim().slice(0, 80) || null;
    } else if (message.role === "assistant") {
      // The provenance recorded when the response was produced, never the
      // session row: a live model switch must not relabel published history.
      if (plan.modelMessages.has(message.id)) usedModel = { ...(message.model ?? initialModel) };
      if (modelSettlement && active !== undefined) {
        // Harness journals only visible text deltas. The final reasoning block
        // remains reasoning; it is never emitted as a text-delta.
        if (active.textStarted) chunk(event.timestamp, { type: "block-end", index: 0, block: { type: "text", text: message.content } });
        else if (message.content !== "") {
          chunk(event.timestamp, { type: "block-start", index: 0, blockType: "text" });
          chunk(event.timestamp, { type: "text-delta", index: 0, text: message.content });
          chunk(event.timestamp, { type: "block-end", index: 0, block: { type: "text", text: message.content } });
        }
        let index = message.content !== "" || active.textStarted ? 1 : 0;
        for (const block of content) {
          if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
          const record = block as Readonly<Record<string, JsonValue>>;
          if (record.type === "text") continue;
          chunk(event.timestamp, { type: "block-start", index, blockType: record.type! });
          chunk(event.timestamp, { type: "block-end", index: index++, block });
        }
        const usage = usageOf(event.payload.usage);
        if (usage !== undefined) chunk(event.timestamp, { type: "usage", usage });
        chunk(event.timestamp, { type: "finish", reason: finishReasonOf(event.payload.finishReason, event.payload.error) });
        const attempt = active;
        const settled = append("assistant/message", message.createdAt, {
          turn: attempt.turn, step: attempt.step, message: wireMessage, stream: attempt.stream,
          ...(usage === undefined ? {} : { usage }),
          ...(event.payload.finishReason === "cancelled" ? { interrupted: true } : {}),
        }, true);
        frame({ type: "end", attemptId: attempt.attemptId, revision: ++revision, index: attempt.nextIndex,
          outcome: { kind: "committed", eventType: "assistant/message", seq: settled.seq } });
        active = undefined;
      } else append("assistant/message", message.createdAt, { turn: currentTurn, step: currentStep, message: wireMessage, stream: [] }, true);
    } else if (message.role === "system") append("system/message", message.createdAt, { turn: currentTurn, step: currentStep, message: wireMessage }, true);
    else {
      if (message.toolCallId !== undefined && !emittedCalls.has(message.toolCallId)) {
        const owner = messages.find(candidate => candidate.toolCalls?.some(call => call.id === message.toolCallId));
        const call = owner?.toolCalls?.find(candidate => candidate.id === message.toolCallId);
        if (call !== undefined) {
          append("tool/call", owner!.createdAt, { turn: currentTurn, step: currentStep, callId: call.id, name: call.name, arguments: JSON.stringify(call.args) });
          emittedCalls.add(call.id);
        }
      }
      append("tool/result", message.createdAt, { turn: currentTurn, step: currentStep, message: wireMessage }, true);
    }
    publishedMessages.add(message.id);
  }

  for (const event of events) {
    if (plan.barriers.has(event.sequence)) break;
    sourceSequence = event.sequence;
    frameBatch = [];
    if (event.type === "human.message" && event.payload.hostOnly === true && event.payload.kind === "web_model_selection") {
      const value = event.payload.selection;
      if (!value || typeof value !== "object" || Array.isArray(value)
        || typeof (value as Record<string, unknown>).provider !== "string" || !(value as Record<string, unknown>).provider
        || typeof (value as Record<string, unknown>).model !== "string" || !(value as Record<string, unknown>).model
        || Object.keys(value).some(key => !["provider", "model"].includes(key))) throw new Error("Invalid durable Web model selection");
      append("model/selection", event.timestamp, value as JsonValue);
      framesBySourceSequence.set(event.sequence, frameBatch); sourceCursor = event.sequence; continue;
    }
    if (event.payload.hostOnly === true && !(event.type === "tool.completed" && toolNameOf(event.payload) === "web_workspace_changes"
      && event.payload.status === "success" && event.payload.derived === true)) {
      // Private file/terminal/settings tools belong to the host UI, never to
      // a model attempt. Do not expose their inputs or fabricate chat tools.
      framesBySourceSequence.set(event.sequence, frameBatch); sourceCursor = event.sequence; continue;
    }
    const turnKey = event.turnId ?? stringOf(event.payload.turnId);
    if (turnKey !== undefined && !turnNumbers.has(turnKey)) turnNumbers.set(turnKey, turnNumbers.size + 1);
    const turn = turnKey === undefined ? currentTurn : turnNumbers.get(turnKey)!;
    const anchored = (plan.at.get(event.sequence) ?? []).map(index => messages[index]!);
    switch (event.type) {
      case "turn.started": {
        if (active !== undefined) finishAttempt(event.timestamp, { kind: "aborted", failure: { code: "INTERRUPTED", message: "The preceding model attempt ended without a completion record." } });
        closeStep(event.timestamp);
        currentTurn = turn;
        currentStep = 0;
        currentStepKey = undefined;
        const started = append("turn/start", event.timestamp, { turn });
        openTurnStartSeq = started.seq;
        for (const message of anchored) publishMessage(message, event);
        break;
      }
      case "model.started": {
        modelStarted = true;
        const key = `${turnKey ?? turn}:${stringOf(event.payload.stepId) ?? event.id}`;
        if (active !== undefined) finishAttempt(event.timestamp, { kind: "error", failure: { code: "MODEL_ERROR", message: "The model attempt restarted without a completion record." } });
        if (currentStepKey !== key) {
          closeStep(event.timestamp);
          currentTurn = turn;
          currentStep = [...stepNumbers.keys()].filter(candidate => candidate.startsWith(`${turnKey ?? turn}:`)).length + 1;
          stepNumbers.set(key, currentStep);
          currentStepKey = key;
          const started = append("step/start", event.timestamp, { turn, step: currentStep });
          lastStepStartSeq = started.seq;
          lastStepBoundary = { kind: "start", seq: started.seq };
          stepOpen = true;
        }
        for (const message of anchored) publishMessage(message, event);
        active = { attemptId: stringOf(event.payload.callId) ?? event.id, startedAfterSeq: records.length - 1,
          turn, step: currentStep, stream: [], nextIndex: 0, textStarted: false };
        frame({ type: "start", attemptId: active.attemptId, revision: ++revision, startedAfterSeq: active.startedAfterSeq, turn, step: currentStep });
        break;
      }
      case "model.delta":
        appendHarnessEvent(append, event);
        if (active !== undefined && event.payload.kind === "text" && typeof event.payload.text === "string") {
          if (!active.textStarted) {
            chunk(event.timestamp, { type: "block-start", index: 0, blockType: "text" });
            active.textStarted = true;
          }
          chunk(event.timestamp, { type: "text-delta", index: 0, text: event.payload.text });
        }
        break;
      case "model.completed":
        for (const message of anchored) publishMessage(message, event, message.role === "assistant" && plan.modelMessages.has(message.id));
        appendHarnessEvent(append, event);
        break;
      case "model.retry":
      case "model.failed":
        for (const message of anchored) publishMessage(message, event);
        finishAttempt(event.timestamp, { kind: "error", failure: failureOf(event.payload.error) });
        appendHarnessEvent(append, event);
        break;
      case "tool.requested": {
        for (const message of anchored) publishMessage(message, event);
        const callId = stringOf(event.payload.toolCallId);
        const name = toolNameOf(event.payload);
        if (callId !== undefined && name !== undefined && !emittedCalls.has(callId)) {
          const args = event.payload.args ?? messages.flatMap(message => message.toolCalls ?? []).find(call => call.id === callId)?.args;
          if (args === undefined) throw new Error(`tool.requested ${event.id} lacks actual call arguments`);
          append("tool/call", event.timestamp, { turn, step: currentStep, callId, name, arguments: JSON.stringify(args) });
          emittedCalls.add(callId);
        } else appendHarnessEvent(append, event);
        break;
      }
      case "turn.completed":
      case "turn.failed":
      case "turn.cancelled":
        for (const message of anchored) publishMessage(message, event);
        finishAttempt(event.timestamp, event.type === "turn.cancelled"
          ? { kind: "aborted", failure: { code: "USER_CANCELLED", message: "The turn was cancelled." } }
          : { kind: "error", failure: failureOf(event.payload.error) });
        closeStep(event.timestamp);
        append("turn/end", event.timestamp, { turn, reason: event.type === "turn.cancelled"
          ? { kind: "aborted", reason: { kind: "user" } }
          : event.type === "turn.failed" ? { kind: "error", error: failureOf(event.payload.error) }
            : event.payload.terminationReason === "max_tokens" ? { kind: "max-tokens" } : { kind: "completed" } });
        openTurnStartSeq = null;
        break;
      default: {
        for (const message of anchored) publishMessage(message, event);
        appendHarnessEvent(append, event);
        // The workspace owner appends this only after its controlled change
        // snapshot has settled. Give that snapshot its own stable wire seq;
        // never insert it retrospectively at the earlier turn/end record.
        if (event.type === "tool.completed" && toolNameOf(event.payload) === "web_workspace_changes"
          && event.payload.status === "success" && event.payload.hostOnly === true && event.payload.derived === true) {
          append("workspace/changes", event.timestamp, { turn });
        }
        const metadata = sessionMetadataOf(event);
        if (metadata !== undefined && typeof metadata.title === "string" && metadata.title.trim() !== "") {
          title = metadata.title;
          append("session/title", event.timestamp, { title, messageSeqs: [], source: { kind: "user" } });
        }
        if (event.type === "ask.turn_waiting") closeStep(event.timestamp);
      }
    }
    for (const derived of activity.consume(event)) {
      assertJsonValue(derived.data, `activity projection from ${event.id}`);
      append(derived.type, event.timestamp, derived.data);
    }
    framesBySourceSequence.set(event.sequence, frameBatch);
    sourceCursor = event.sequence;
  }
  const cursor = records.length - 1;
  // Legacy journals carry no per-message provenance; they keep reporting the
  // session's own model, which is what the pre-switch UI showed.
  const lastUsedModel = usedModel ?? (modelStarted ? initialModel : undefined);
  return {
    header: { version: 4, id: session.id, createdAt: session.createdAt, cwd: session.cwd,
      isSeeded: session.parentId !== undefined, ...(session.parentId === undefined ? {} : { parentSession: session.parentId }) },
    records, cursor, sourceCursor, framesBySourceSequence, sourceSequenceBySeq,
    assistantStream: { revision, ...(active === undefined ? {} : { activeAttempt: {
      attemptId: active.attemptId, startedAfterSeq: active.startedAfterSeq, turn: active.turn, step: active.step,
      nextIndex: active.nextIndex, stream: active.stream,
    } }) },
    projections: { asOfSeq: cursor, values: {
      title,
      sessionListMetadata: { blank: turnNumbers.size === 0 && lastPromptAt === null, lastPromptAt },
      modelSelection: { lastUsed: lastUsedModel === undefined ? null : { provider: lastUsedModel.providerId, model: lastUsedModel.modelId },
        next: { provider: session.model.providerId, model: session.model.modelId } },
      turnBoundary: { openTurnStartSeq, lastStepStartSeq, lastStepBoundary, lastTurn: currentTurn },
      ...activity.values(),
    } },
  };
}

/** The official message-aligned backwards page algorithm, retaining every
 * intervening lifecycle/trace event. A fixed throughSeq excludes later work. */
export function pageSessionHistory(projection: PageProjection, request: SessionPageWindow): SessionPage {
  validatePageWindow(request);
  if (request.throughSeq > projection.cursor) throw new Error("throughSeq is beyond the current session cursor");
  const end = Math.min(request.throughSeq + 1, request.beforeSeq ?? request.throughSeq + 1);
  let count = 0;
  let turns = 0;
  let cut = 0;
  for (let index = end - 1; index >= 0; index--) {
    const event = projection.records[index]!.event;
    if (request.turnWindow !== undefined && event.type === "turn/start") {
      turns++;
      if (count >= request.turnWindow.minMessages && turns >= request.turnWindow.minTurns) { cut = index; break; }
    }
    if ((event.type !== "user/message" && event.type !== "assistant/message") || event.surfaceOp !== "append") continue;
    if (++count >= (request.maxMessages ?? 50)) { cut = index; break; }
  }
  return { records: projection.records.slice(cut, end), hasMore: cut > 0 };
}

function planMessageAnchors(input: SessionProjectionInput): AnchorPlan {
  const { events, messages } = input;
  const at = new Map<number, number[]>();
  const anchors = new Map<number, number>();
  const barriers = new Set<number>();
  const modelMessages = new Set<string>();
  function anchor(index: number | undefined, event: AgentEvent): void {
    if (index !== undefined && index >= 0 && !anchors.has(index)) anchors.set(index, event.sequence);
  }
  function find(predicate: (message: Message) => boolean): number | undefined {
    const index = messages.findIndex((message, index) => !anchors.has(index) && predicate(message));
    return index < 0 ? undefined : index;
  }
  const outcomeEvents = new Map<string, AgentEvent[]>();
  for (const event of events) {
    if (isToolOutcome(event) && typeof event.payload.toolCallId === "string") {
      const list = outcomeEvents.get(event.payload.toolCallId) ?? [];
      list.push(event); outcomeEvents.set(event.payload.toolCallId, list);
    }
    if (event.type === "turn.started") {
      const index = find(message => message.role === "user" && message.turnId === event.turnId && message.askId === undefined
        && (typeof event.payload.text !== "string" || message.content === event.payload.text));
      if (index === undefined) barriers.add(event.sequence);
      else anchor(index, event);
    }
    if (event.type === "model.completed") {
      const index = find(message => message.role === "assistant" && message.turnId === event.turnId
        && (typeof event.payload.text !== "string" || message.content === event.payload.text)
        && (typeof event.payload.toolCalls !== "number" || (message.toolCalls?.length ?? 0) === event.payload.toolCalls));
      if (index === undefined) barriers.add(event.sequence);
      else { anchor(index, event); modelMessages.add(messages[index]!.id); }
    }
    if (event.type === "ask.user_replied") {
      const index = find(message => message.role === "user" && message.askId === event.payload.askId && message.turnId === event.turnId);
      if (index === undefined) barriers.add(event.sequence);
      else anchor(index, event);
    }
  }
  for (const [callId, outcomes] of outcomeEvents) {
    const index = find(message => message.role === "tool" && message.toolCallId === callId);
    if (index !== undefined) anchor(index, outcomes.at(-1)!);
    else if (messages.some(message => message.toolCalls?.some(call => call.id === callId))) barriers.add(outcomes[0]!.sequence);
  }
  for (const event of events) {
    const callId = stringOf(event.payload.toolCallId);
    if (callId !== undefined && (event.type === "tool.requested" || event.type === "tool.started")) {
      anchor(find(message => message.role === "assistant" && message.toolCalls?.some(call => call.id === callId) === true), event);
    }
    if (event.type === "model.started" && Array.isArray(event.payload.contextMessageIds)) {
      for (const id of event.payload.contextMessageIds) anchor(find(message => message.id === id), event);
    }
    if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled" || event.type === "ask.turn_waiting" || event.type === "session.forked") {
      for (let index = 0; index < messages.length; index++) {
        const message = messages[index]!;
        if (!anchors.has(index) && message.createdAt <= event.timestamp
          && (message.turnId === event.turnId || event.type === "session.forked")) anchor(index, event);
      }
    }
  }
  // Move otherwise-unanchored injected messages to the next anchored message.
  // Appended but not yet event-committed suffixes are deliberately withheld.
  let nextAnchor: number | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (anchors.has(index)) nextAnchor = anchors.get(index);
    else if (nextAnchor !== undefined) anchors.set(index, nextAnchor);
  }
  for (const [index, sequence] of anchors) {
    const group = at.get(sequence) ?? [];
    group.push(index); at.set(sequence, group);
  }
  for (const group of at.values()) group.sort((a, b) => a - b);
  return { at, barriers, modelMessages };
}

function validateSources(input: SessionProjectionInput): void {
  const eventIds = new Set<string>();
  // A declared range is distinct from a full journal. Production session reads
  // do not derive this value from unvalidated input.
  const baseline = input.sourceBaseline ?? 0;
  if (!Number.isSafeInteger(baseline) || baseline < 0 || Object.is(baseline, -0)) {
    throw new Error(`source event baseline must be a non-negative safe integer, received ${baseline}`);
  }
  if (input.events.length > 0 && input.events[0]!.sequence !== baseline) {
    throw new Error(`source event sequence is not contiguous: expected ${baseline}, received ${input.events[0]!.sequence}`);
  }
  for (let index = 0; index < input.events.length; index++) {
    const event = input.events[index]!;
    if (!Number.isSafeInteger(event.sequence)) throw new Error(`source event sequence must be a safe integer, received ${event.sequence}`);
    if (event.sessionId !== input.session.id) throw new Error(`event ${event.id} belongs to another session`);
    if (event.sequence !== baseline + index || Object.is(event.sequence, -0)) throw new Error(`source event sequence is not contiguous: expected ${baseline + index}, received ${event.sequence}`);
    if (eventIds.has(event.id)) throw new Error(`duplicate source event id ${event.id}`);
    eventIds.add(event.id);
    if (!Number.isSafeInteger(event.timestamp)) throw new Error(`event ${event.id} has an invalid timestamp`);
    if (event.schemaVersion !== undefined && event.schemaVersion !== EVENT_ABI_VERSION) throw new Error(`event ${event.id} has unsupported ABI ${event.schemaVersion}`);
    assertJsonValue(event.payload, `event ${event.id} payload`);
  }
  const messageIds = new Set<string>();
  for (const message of input.messages) {
    if (message.sessionId !== input.session.id) throw new Error(`message ${message.id} belongs to another session`);
    if (messageIds.has(message.id)) throw new Error(`duplicate message id ${message.id}`);
    messageIds.add(message.id);
    if (!Number.isSafeInteger(message.createdAt) || typeof message.content !== "string") throw new Error(`message ${message.id} has an invalid body`);
    if (message.role === "tool" && !message.toolCallId) throw new Error(`tool message ${message.id} lacks a tool call id`);
    for (const call of message.toolCalls ?? []) assertJsonValue(call.args, `tool call ${call.id} arguments`);
  }
}
function validatePageWindow(request: SessionPageWindow): void {
  if (!Number.isSafeInteger(request.throughSeq) || request.throughSeq < -1 || Object.is(request.throughSeq, -0)) throw new Error("throughSeq must be a safe integer greater than or equal to -1");
  if (request.beforeSeq !== undefined && (!Number.isSafeInteger(request.beforeSeq) || request.beforeSeq < 0 || Object.is(request.beforeSeq, -0))) throw new Error("beforeSeq must be a non-negative safe integer");
  if (request.maxMessages !== undefined && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages <= 0)) throw new Error("maxMessages must be a positive safe integer");
  if (request.turnWindow !== undefined) {
    const { minMessages, minTurns } = request.turnWindow;
    if (!Number.isSafeInteger(minMessages) || minMessages <= 0 || minMessages > (request.maxMessages ?? 50)) throw new Error("turnWindow.minMessages must be positive and no greater than maxMessages");
    if (!Number.isSafeInteger(minTurns) || minTurns <= 0) throw new Error("turnWindow.minTurns must be a positive safe integer");
  }
}
function isToolOutcome(event: AgentEvent): boolean { return event.type === "tool.completed" || event.type === "tool.failed"; }
function stringOf(value: unknown): string | undefined { return typeof value === "string" && value !== "" ? value : undefined; }
function failureOf(value: unknown): JsonValue {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return { code: stringOf(record.code) ?? "MODEL_ERROR", message: stringOf(record.message) ?? "The model or turn failed." };
  }
  return { code: "MODEL_ERROR", message: typeof value === "string" ? value : "The model or turn failed." };
}
function finishReasonOf(value: unknown, error: unknown): JsonValue {
  switch (value) {
    case "tool_calls": return { kind: "tool-calls" };
    case "length": case "max_tokens": return { kind: "max-tokens" };
    case "error": return { kind: "error", failure: failureOf(error) };
    case "cancelled": return { kind: "aborted", failure: failureOf(error) };
    default: return { kind: "stop" };
  }
}
function sessionMetadataOf(event: AgentEvent): Readonly<Record<string, JsonValue>> | undefined {
  if (event.type !== "tool.completed" || toolNameOf(event.payload) !== "web_session_metadata"
    || (event.payload.status !== undefined && event.payload.status !== "success")) return undefined;
  const preview = event.payload.outputPreview;
  if (typeof preview !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(preview);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    assertJsonValue(parsed, "session metadata outcome");
    return parsed as Readonly<Record<string, JsonValue>>;
  } catch { return undefined; }
}
function appendHarnessEvent(
  append: (type: string, time: number, data: JsonValue, surface?: boolean, ignorable?: boolean) => SessionWireEvent,
  event: AgentEvent,
): void {
  append(`harness/${event.type}`, event.timestamp, { sourceId: event.id, sourceSequence: event.sequence, payload: event.payload as JsonValue }, false, true);
}
function assertJsonValue(value: unknown, subject: string, seen = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (typeof value !== "object" || seen.has(value)) throw new Error(`${subject} is not lossless JSON`);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new Error(`${subject} is not a JSON object`);
  seen.add(value);
  for (const member of Object.values(value)) assertJsonValue(member, subject, seen);
  seen.delete(value);
}
