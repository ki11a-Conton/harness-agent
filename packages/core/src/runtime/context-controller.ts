/**
 * Q-1: context pipeline + steering injection + tool-output rendering extracted
 * from runtime.ts. Owns buildContext (skill/instruction discovery, system
 * prompt assembly, auto-compact, message-history trim, overflow check),
 * injectSteeringPrompts (exactly-once steer admission), and
 * renderToolResultForContext (budget/artifact/redaction/injection scan).
 *
 * Method bodies are byte-for-byte the ones that lived on AgentRuntime — the
 * only change is `this.<field>` → `this.deps.<field>`, plus `checkpoint` /
 * `finishTurn` arriving as injected functions bound to the runtime (so this
 * controller never imports runtime.ts / recovery controllers directly).
 * `compactCounter` is shared BY REFERENCE: it is the runtime-owned mutable
 * compaction count the model-call controller also increments.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorInfo, newArtifactId, newMessageId, stableFingerprint } from "@ar/contracts";
import type {
  AgentDefinition,
  AgentEvent,
  Artifact,
  ArtifactStore,
  CheckpointBudgetUsage,
  ContextBlock,
  ContextBudget,
  InboxStore,
  Message,
  SessionId,
  SessionStore,
  Skill,
  SkillIndexEntry,
  TerminationReason,
  ToolCall,
  ToolExecutionRecord,
  ToolResult,
  ToolSemantics,
  Turn,
  TurnId,
  WorkingState,
} from "@ar/contracts";
import type { ContextPipeline, InstructionDiscoveryOptions } from "@ar/context";
import { protectedFieldsMissing, checkpointView, historySummaryRequest, renderHistoryCheckpoint } from "@ar/context";
import { AgentState } from "../state/agent-state.js";
import { protectToolOutputText } from "./tool-output-security.js";
import { historyCarryover } from "./history-carryover.js";
import type { RecoveryPolicy } from "../recovery/recovery.js";
import {
  activeUserMessages,
  buildStateDigest,
  renderToolResult,
  TRUST_BOUNDARY_PROMPT,
  trimMessageHistory,
  retainMessageHistoryTail,
  workingStateToCompactionSummary,
} from "./turn-helpers.js";
import type {
  FaultPoint,
  FaultPointContext,
  SkillDiscovery,
  TurnContext,
  TurnOutcome,
  TurnOutcomeStatus,
} from "./turn-helpers.js";

const INCOMPLETE_HISTORY_NOTE = "\n\n[Historical DATA: incomplete assistant response after a model stream failure. This partial text does not establish completion or verification; no tool calls from this response were executed.]";
function incompleteHistoryView(history: Message[]): Message[] {
  return history.map(message => message.role === "assistant" && message.incomplete?.reason === "model_error"
    && !message.content.endsWith(INCOMPLETE_HISTORY_NOTE)
    ? { ...message, content: message.content + INCOMPLETE_HISTORY_NOTE } : message);
}

/** Q-1: result of buildContext — either proceed with updated context state
 *  or finish the turn on overflow. */
export type ContextUpdate =
  | { action: "proceed"; history: Message[]; system: string; lastReportTokens: number | undefined; digestAppended: boolean; overflowAttempt: number; selectedSkills?: import("@ar/contracts").SkillSnapshot["selected"]; instructionSources?: readonly import("@ar/contracts").InstructionSource[] }
  | { action: "finish"; outcome: TurnOutcome };

/** Q-1: everything ContextController needs from the runtime. All fields are
 *  read-only bindings captured at construction; `compactCounter` is the single
 *  shared mutable compaction count (also incremented by the model-call
 *  controller's reactive compaction). */
export interface ContextControllerDeps {
  store: SessionStore;
  emit: (
    sessionId: SessionId,
    type: AgentEvent["type"],
    payload: Record<string, unknown>,
    turnId?: TurnId,
    spans?: { spanId?: string; parentSpanId?: string },
  ) => Promise<AgentEvent>;
  now: () => number;
  failAt: (point: FaultPoint, ctx: FaultPointContext) => Promise<void>;
  context?: { pipeline: ContextPipeline; budget: ContextBudget; instructionOpts?: InstructionDiscoveryOptions };
  skills?: () => Skill[] | SkillDiscovery | Promise<Skill[] | SkillDiscovery>;
  skillSelector?: (entries: SkillIndexEntry[], context: import("@ar/contracts").SkillSelectionContext) => SkillIndexEntry[];
  /** P2-8: loads the body of the skills selected by `skillSelector` as
   *  semi-trusted context blocks (progressive disclosure: index → selection
   *  → body load → context). Receives the turn identity and selected names;
   *  the returned blocks are admitted into the pipeline ahead of tool output.
   *  Absent by default (index-only skills). */
  skillBodyBlocks?: (input: {
    sessionId: SessionId;
    turnId: TurnId;
    names: string[];
    skills?: readonly Skill[];
  }) => Promise<ContextBlock[]>;
  onSkillBodiesAdmitted?: (input: {
    sessionId: SessionId;
    turnId: TurnId;
    blocks: readonly ContextBlock[];
  }) => Promise<void>;
  recovery?: RecoveryPolicy;
  compactCounter: { value: number };
  checkpoint: (
    ctx: TurnContext,
    working: WorkingState,
    state: AgentState,
    toolLedger: ToolExecutionRecord[],
    reason: string,
    budgetUsage?: CheckpointBudgetUsage,
  ) => Promise<void>;
  finishTurn: (
    ctx: TurnContext,
    status: TurnOutcomeStatus,
    state: AgentState,
    working: WorkingState,
    error?: ReturnType<typeof errorInfo>,
    terminationReason?: TerminationReason,
    ledger?: ToolExecutionRecord[],
    completionEvidence?: import("@ar/contracts").CompletionEvidence,
  ) => Promise<TurnOutcome>;
  toolOutputBudget?: { maxInlineBytes: number; artifactDir?: string };
  outputRedactor?: (content: string) => { content: string; redacted: number };
  artifactStore?: ArtifactStore;
  semanticsOf: (name: string) => ToolSemantics;
  injectionDetector?: (content: string) => { hasInjection: boolean; reasons: string[] };
  inbox?: InboxStore;
}

export class ContextController {
  /** Append/consume spans two stores. Serialize this boundary per session
   * in one runtime, including recovery before runTurn acquires its guard. */
  private readonly steeringInFlight = new Map<SessionId, Promise<void>>();

  constructor(private readonly deps: ContextControllerDeps) {}

  /**
   * Q-1: context pipeline + compaction + overflow check extracted from
   * runTurn. Handles: context build (skill/instruction discovery, security
   * events), system prompt assembly, auto-compact, message-history trim,
   * context overflow check. Returns ContextUpdate — proceed with updated
   * state or finish on overflow.
   */
  async buildContext(
    ctx: TurnContext,
    agent: AgentDefinition,
    turn: Turn,
    working: WorkingState,
    priorBlocks: ContextBlock[],
    state: AgentState,
    toolLedger: ToolExecutionRecord[],
    history: Message[],
    _system: string,
    lastReportTokens: number | undefined,
    digestAppended: boolean,
    overflowAttempt: number,
    reactiveCompactionRequested: boolean,
    summarizeHistory?: (request: import("@ar/contracts").ModelRequest, maxTokens: number) => Promise<{
      text?: string; reason?: string; limit?: import("@ar/contracts").LimitBreach;
    }>,
  ): Promise<ContextUpdate> {
    const { sessionId, turnId, session } = ctx;
    // This is model-view DATA, not a new system instruction or a change to
    // the visible transcript. Render before context admission/compaction so
    // its tokens and the actual sampled bytes enter the normal step witness.
    history = incompleteHistoryView(history);
    let activeUsers = activeUserMessages(history, turnId);
    let compaction: { manual: boolean; reactive?: boolean; beforeTokens: number; afterTokens: number; strategy?: string; summarySource?: string; fallbackReason?: string } | undefined;
    let historyTrimmed = false;
    let system = agent.systemPrompt;
    // P32-1/P32-3: step-witness values — the selected skill manifest-of
    // record and the instruction sources (system + AGENTS.md) assembled from
    // this build. Populated inside the context branch; undefined when the
    // host runs without a context pipeline.
    let skillSnapshotEntries: import("@ar/contracts").SkillSnapshot["selected"] | undefined;
    let instructionSources: readonly import("@ar/contracts").InstructionSource[] | undefined;
    let admittedSkillBodies: readonly ContextBlock[] = [];

    if (this.deps.context?.pipeline.historyCompaction) history = checkpointView(history, activeUsers);

        if (this.deps.context !== undefined) {
          // Task 3: skill index — awaited once per build; provider errors
          // propagate like discovery errors (never swallowed). P0-7: the
          // provider may additionally report rejected skills.
          const disco = this.deps.skills !== undefined ? await this.deps.skills() : undefined;
          const skills = disco !== undefined && !Array.isArray(disco) ? disco.skills : disco;
          // P32-1/P32-4: keep a manifest-of record for the STEP snapshot —
          // which skills were selected, their body hash (mtime-free identity),
          // required tools and required MCP servers. The runtime freezes this
          // into StepExecutionSnapshot.skills; MCP requirements feed the
          // step's dependency resolver (never global startup).
          const skillsById = new Map(skills?.map((skill) => [skill.manifest.name, skill]) ?? []);
          const selectedSkills =
            this.deps.skillSelector !== undefined && skills !== undefined
              ? this.deps.skillSelector(
                  skills.map((skill) => ({
                    name: skill.manifest.name,
                    description: skill.manifest.description ?? "",
                  })),
                  {
                    goal: activeUsers.length > 0 ? activeUsers.map((message) => message.content).join("\n") : working.goal,
                    sessionId,
                    turnId,
                  },
                )
              : skills?.map((skill) => ({
                  name: skill.manifest.name,
                  description: skill.manifest.description ?? "",
                })) ?? [];
          const entries: import("@ar/contracts").SkillSnapshot["selected"] = selectedSkills.map(
            (entry) => {
              const skill = skillsById.get(entry.name);
              return {
                name: entry.name,
                source: skill?.provenance?.source ?? "unknown",
                ...(skill?.body !== undefined && skill.body !== ""
                  ? { bodyHash: stableFingerprint([skill.body]) }
                  : {}),
                requiredTools: [...(skill?.manifest.requiredTools ?? [])],
                requiredMcpServers: [...(skill?.manifest.requiredMcpServers ?? [])],
              };
            },
          );
          if (entries.length > 0) skillSnapshotEntries = entries;
          // P2-8: progressive disclosure — load the bodies of the selected
          // skills and admit them as semi-trusted skill data ahead of tool
          // output. A body-load failure degrades to index-only (never breaks
          // the turn); the index itself is unaffected.
          let skillBodyBlocks: ContextBlock[] = [];
          if (this.deps.skillBodyBlocks !== undefined && selectedSkills.length > 0) {
            try {
              skillBodyBlocks = await this.deps.skillBodyBlocks({
                sessionId,
                turnId,
                names: selectedSkills.map((entry) => entry.name),
                skills,
              });
            } catch (cause) {
              process.stderr.write(
                `[context] skillBodyBlocks failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
              );
            }
          }
          const built = await this.deps.context.pipeline.build({
            cwd: session.cwd,
            systemPrompt: agent.systemPrompt,
            priorBlocks: [...skillBodyBlocks, ...priorBlocks],
            // Current user messages are sent on their original channel. Give
            // them headroom before admitting ordinary system-side data.
            budget: {
              ...this.deps.context.budget,
              reserved: {
                ...this.deps.context.budget.reserved,
                task: this.deps.context.budget.reserved.task + this.deps.context.pipeline.estimateMessageTokens(activeUsers),
              },
            },
            instructionOpts: this.deps.context.instructionOpts,
            messages: history,
            // P6-3: attach the session so context.* selection telemetry events
            // land in the right stream.
            telemetrySessionId: session.id,
            // P1-2: what must survive compaction comes from the runtime's
            // working state (summaryOverride); the pipeline never synthesizes
            // summary content.
            summaryOverride: workingStateToCompactionSummary(working, activeUsers),
            ...(selectedSkills.length > 0 ? { skills: selectedSkills } : {}),
          });
          if (this.deps.skillBodyBlocks !== undefined) {
            const loadedIds = new Set(skillBodyBlocks.map((block) => block.id));
            admittedSkillBodies = built.blocks.filter((block) => block.source === "skill" && loadedIds.has(block.id));
            // The step witnesses the body actually admitted to model context,
            // including any bounded rendering, rather than a discovery-time
            // body that may have changed or been denied before load.
            for (const entry of entries) {
              const body = built.blocks.find((block) => block.source === "skill" && block.id === `skill-body:${entry.name}`);
              if (body !== undefined) entry.bodyHash = stableFingerprint([body.content]);
              else delete entry.bodyHash;
            }
          }
          lastReportTokens = built.report.used;
          // P32-3: the exact instruction world THIS step was built from —
          // system prompt hash + every project instruction document that
          // reached the model. The runtime pins these into the snapshot so a
          // mid-step AGENTS.md change can only affect the NEXT step.
          instructionSources = [
            { kind: "system", source: "system", contentHash: stableFingerprint([system]) },
            ...built.discovered.map((doc) => ({
              kind: "project_instruction" as const,
              source: doc.path,
              contentHash: stableFingerprint([doc.content]),
              path: doc.path,
            })),
          ];
          // P1-17: every discovered instruction document is observable with
          // its scope, so operators can audit which AGENTS.md files reached
          // the model (and whether a document was truncated).
          for (const doc of built.discovered) {
            await this.deps.emit(sessionId, "instruction.discovered", {
              path: doc.path,
              scope: doc.scope,
              sizeBytes: doc.sizeBytes,
              truncated: doc.truncated,
            }, turnId);
          }
          if (skills !== undefined) {
            for (const skill of skills) {
              await this.deps.emit(sessionId, "skill.discovered", {
                name: skill.manifest.name,
                description: skill.manifest.description ?? "",
                path: skill.path,
              }, turnId);
            }
          }
          // P0-7: a skill rejected at discovery time (injection/secret) is
          // observable on the event stream with a structured code — the skill
          // layer never fails stderr-only. The code/event pair agree via the
          // same rule the skills package exports.
          if (disco !== undefined && !Array.isArray(disco)) {
            for (const sec of disco.security) {
              await this.deps.emit(
                sessionId,
                sec.detection === "secret" ? "security.secret_redacted" : "security.skill_denied",
                {
                  reason: sec.detection === "injection"
                    ? `injection detected (${sec.reasons.join(", ")})`
                    : sec.detection === "required-tools"
                      ? `required tools denied (${sec.reasons.join(", ")})`
                      : `secret detected (${sec.reasons.join(", ")})`,
                  code: sec.detection === "secret" ? "SECRET_REDACTED" : "SKILL_DENIED",
                  source: sec.source,
                  target: sec.path,
                  details: sec.reasons,
                },
                turnId,
              );
            }
          }
          if (built.injected !== undefined) {
            for (const item of built.injected) {
              await this.deps.emit(sessionId, "security.injection_denied", {
                source: item.source,
                target: item.id,
                reason: item.reasons.length > 0 ? `injection detected (${item.reasons.join(", ")})` : "injection detected",
                reasons: item.reasons,
                code: "INJECTION_DENIED",
              }, turnId);
            }
          }
          // P0-8: every block is labeled with its trust level and source so
          // the model can distinguish authoritative policy from data; the
          // fixed header states the boundary rule (low-trust content is
          // DATA ONLY — instructions inside it are inert).
          system = [
            TRUST_BOUNDARY_PROMPT,
            ...built.blocks.map(
              (b) =>
                `[context trust=${b.trust} source=${b.source}${b.scope !== undefined ? ` scope=${b.scope}` : ""}${b.path !== undefined ? ` path=${b.path}` : ""}]\n${b.content}`,
            ),
          ].join("\n\n---\n\n");
          await this.deps.emit(sessionId, "context.built", {
            tokens: built.report.used,
            used: built.report.used,
            budget: this.deps.context.budget.maxTokens,
            dropped: built.report.dropped,
            compacted: built.compacted,
            messagesTokens: built.report.messagesTokens ?? 0,
          }, turnId);
          const pipeline = this.deps.context.pipeline;
          if (pipeline.historyCompaction) {
            // Price the rendered system, not just bare block bodies. Leave
            // output space and compact BEFORE an upstream context overflow.
            const headroom = Math.max(0, this.deps.context.budget.maxTokens
              - pipeline.estimateTextTokens(system) - this.deps.context.budget.reserved.output);
            let beforeTokens = pipeline.estimateMessageTokens(history);
            const activeIds = new Set(activeUsers.map(message => message.id));
            const historical = history.filter(message => !activeIds.has(message.id));
            const freshHistoricalTokens = pipeline.estimateMessageTokens(historical.filter(message => message.contextCheckpoint === undefined));
            // Hysteresis: a large protected user task alone must not cause
            // another model summary before every small tool round.
            const usefulAutomatic = beforeTokens > Math.floor(headroom * 0.85)
              && (beforeTokens > headroom || freshHistoricalTokens >= Math.max(256, Math.floor(headroom * 0.1)));
            if (historical.length > 0 && (built.manualCompaction || usefulAutomatic || reactiveCompactionRequested)) {
              // Upstream has disproved the local estimate. Bound both the
              // auxiliary request and the replacement view relative to the
              // rejected history, rather than increasing a known-bad payload.
              const activeTokens = pipeline.estimateMessageTokens(activeUsers);
              // A reduction ratio must not reject a large human task that
              // can fit once old investigation is removed. Reserve a bounded
              // handoff above the exact user anchors, still below the failed
              // view and never above the configured headroom.
              const protectedTarget = activeTokens + Math.min(512, Math.floor((beforeTokens - activeTokens) * 0.5));
              const targetHeadroom = reactiveCompactionRequested
                ? Math.min(headroom, Math.max(Math.floor(beforeTokens * 0.6), protectedTarget)) : headroom;
              const maxSummaryTokens = Math.max(0, Math.min(2048, Math.floor(targetHeadroom * 0.35),
                reactiveCompactionRequested ? targetHeadroom - activeTokens - 32 : Infinity));
              const protect = (text: string) => {
                const safe = protectToolOutputText(text, { redact: this.deps.outputRedactor, detect: this.deps.injectionDetector });
                return safe.injection.hasInjection ? undefined : safe.content;
              };
              const requestBudget = Math.floor(reactiveCompactionRequested
                ? Math.min(this.deps.context.budget.maxTokens * 0.7, beforeTokens * 0.5)
                : this.deps.context.budget.maxTokens * 0.7);
              const request = historySummaryRequest(history, requestBudget,
                text => pipeline.estimateTextTokens(text), protect);
              const coveredInputIds = new Set(history.map(message => message.id));
              await this.deps.emit(sessionId, "context.compacted", { phase: "started", strategy: "codex-v1",
                manual: built.manualCompaction === true, ...(reactiveCompactionRequested ? { reactive: true } : {}), beforeTokens }, turnId);
              const summary = request && maxSummaryTokens >= 128 && summarizeHistory
                ? await summarizeHistory(request, maxSummaryTokens) : { reason: "summary-input-budget" };
              if (summary.limit) return { action: "finish", outcome: await this.deps.finishTurn(ctx, "failed", state, working,
                errorInfo("RESOURCE_LIMIT", `${summary.limit.limit} reached during context compaction`), "agent_limit", toolLedger) };
              if (ctx.signal.aborted) return { action: "finish", outcome: await this.deps.finishTurn(ctx, "cancelled", state, working, undefined, "cancelled", toolLedger) };
              // A summary can take time. Admit corrections that arrived during
              // it before the coding request, through the existing exactly-once
              // inbox boundary. The handoff did NOT summarize these new inputs.
              history = incompleteHistoryView(await this.injectSteeringPrompts(ctx, history));
              activeUsers = activeUserMessages(history, turnId);
              activeIds.clear(); for (const message of activeUsers) activeIds.add(message.id);
              beforeTokens = pipeline.estimateMessageTokens(history);
              const safeSummary = summary.text ? protect(summary.text) : undefined;
              const modelText = safeSummary?.trim() && pipeline.estimateTextTokens(renderHistoryCheckpoint(safeSummary)) <= maxSummaryTokens ? safeSummary : undefined;
              const carryover = modelText === undefined ? historyCarryover(history,
                Math.min(512, Math.max(0, maxSummaryTokens - (reactiveCompactionRequested ? 128 : 0))),
                messages => pipeline.estimateMessageTokens(messages), protect) : undefined;
              const text = modelText ?? carryover?.content ?? "Previous context exceeded the available budget. Consult the original transcript for full details. No model-generated handoff is available; continue the current user task without assuming earlier checks passed.";
              const durable = incompleteHistoryView(await this.deps.store.listMessages(sessionId));
              // Keep the recent protocol-valid tail as raw evidence. A model
              // must still see the latest completed tool batch, rather than
              // accidentally reissuing it immediately after compaction.
              const rawBudget = Math.max(0, Math.min(Math.floor(targetHeadroom * 0.4),
                Math.floor(beforeTokens * (built.manualCompaction ? 0.25 : 0.4)),
                targetHeadroom - pipeline.estimateMessageTokens(activeUsers) - maxSummaryTokens - 32));
              let tailStart = history.length, rawTokens = 0;
              while (tailStart > 0) {
                const message = history[tailStart - 1]!;
                const cost = activeIds.has(message.id) || message.contextCheckpoint ? 0 : pipeline.estimateMessageTokens([message]);
                if (rawTokens + cost > rawBudget) break;
                rawTokens += cost; tailStart--;
              }
              const recentIds = new Set(retainMessageHistoryTail(history, tailStart, activeUsers)
                .filter(message => !activeIds.has(message.id) && message.contextCheckpoint === undefined).map(message => message.id));
              const firstRecent = durable.findIndex(message => recentIds.has(message.id));
              // A view can end in an old protected user anchor after a newer
              // checkpoint. Use the latest durable input position, not the
              // last element's position, so coverage never moves backwards.
              const coveredInputEnd = durable.reduce((end, message, index) => coveredInputIds.has(message.id) ? index + 1 : end, 0);
              const through = durable.slice(0, Math.min(firstRecent < 0 ? durable.length : firstRecent, coveredInputEnd))
                .filter(message => message.contextCheckpoint === undefined).at(-1);
              if (through) {
                const checkpoint: Message = { id: newMessageId(), sessionId, turnId, role: "assistant",
                  content: renderHistoryCheckpoint(text), contextCheckpoint: { version: 1, throughMessageId: through.id,
                    source: modelText ? "model" : "extractive" }, createdAt: this.deps.now() };
                const view = checkpointView([...durable, checkpoint], activeUsers);
                if (pipeline.estimateMessageTokens(view) < beforeTokens && pipeline.estimateMessageTokens(view) <= targetHeadroom) {
                  // Persist BEFORE publishing success or advancing the model.
                  await this.deps.store.appendMessage(checkpoint);
                  this.deps.compactCounter.value++;
                  history = view; historyTrimmed = true;
                  compaction = { manual: built.manualCompaction === true, beforeTokens,
                    afterTokens: pipeline.estimateMessageTokens(history), strategy: "codex-v1",
                    ...(reactiveCompactionRequested ? { reactive: true } : {}),
                    summarySource: checkpoint.contextCheckpoint!.source,
                    ...(modelText ? {} : { fallbackReason: summary.reason ?? "invalid-summary" }) };
                  await this.deps.failAt("context.compacted", { sessionId, turnId });
                  await this.deps.checkpoint(ctx, working, state, toolLedger, "context:history-checkpoint");
                } else if (beforeTokens > headroom) {
                  // Even the fallback cannot fit protected human input.
                  await this.deps.emit(sessionId, "run.limit_reached", { limit: "maxTokens", used: beforeTokens, allowed: headroom }, turnId);
                  return { action: "finish", outcome: await this.deps.finishTurn(ctx, "failed", state, working,
                    errorInfo("RESOURCE_LIMIT", "Context cannot fit after bounded compaction; shorten the active user input."), "context_limit", toolLedger) };
                }
              }
            }
            if (reactiveCompactionRequested && !historyTrimmed) {
              // Protected input cannot be removed merely to retry. Do not
              // replay the upstream-rejected view when no smaller safe view
              // could be durably installed by this one compaction attempt.
              await this.deps.emit(sessionId, "run.limit_reached", { limit: "maxTokens", used: beforeTokens, reason: "upstream-context-overflow" }, turnId);
              return { action: "finish", outcome: await this.deps.finishTurn(ctx, "failed", state, working,
                errorInfo("RESOURCE_LIMIT", "Upstream context overflow cannot be reduced while preserving active user input; shorten the task or use a larger model context."), "context_limit", toolLedger) };
            }
          }
          if (built.compacted) {
            this.deps.compactCounter.value += 1;
            await this.deps.emit(sessionId, "context.compacted", {
              compressed: 1,
              reason: built.manualCompaction ? "manual compaction requested by user" : "auto-compact (context budget)",
              phase: "blocks",
              reactive: false,
              totalCount: this.deps.compactCounter.value,
            }, turnId);
            if (!digestAppended) {
              // Structured compaction summary (plan.md Phase 4/5): the model
              // keeps goal/completed-work/commands/errors after compaction;
              // full history stays in the store (transcript fallback).
              digestAppended = true;
              const digestText = buildStateDigest(working, "context compacted — older tool outputs were folded into this summary", activeUsers);
              // P17-6: programmatic preservation check — a non-empty digest
              // is NOT success; every protected field must be present (or
              // carried by the durable working state). A violation is
              // surfaced on the event stream, never silent.
              const missing = protectedFieldsMissing(
                protectedFactsFrom(working, activeUsers),
                digestText,
                {
                  unresolvedTools: working.toolRefs,
                  memoryRefs: working.memoryRefs,
                  skillRefs: working.toolRefs,
                  childAgentRefs: working.childAgentRefs,
                },
              );
              if (missing.length > 0) {
                await this.deps.emit(sessionId, "context.protected_facts_violation", {
                  turnId,
                  missing,
                  digestLength: digestText.length,
                }, turnId);
              }
              // The checkpoint strategy already retains the durable working
              // state and the structured block digest. A second synthetic
              // system message is neither sampled in this view nor needed;
              // publishing it later would move an already-followed prefix.
              if (!pipeline.historyCompaction) await this.deps.store.appendMessage({
                id: newMessageId(), sessionId, turnId, role: "system",
                content: digestText, createdAt: this.deps.now(),
              });
            }
            // P1-3: after compaction is a checkpoint safety boundary. (P1-5: a kill
            // here simulates dying during compaction — the summary below is
            // already durable in the transcript.)
            await this.deps.failAt("context.compacted", { sessionId, turnId });
            await this.deps.checkpoint(
              ctx, working, state, toolLedger, "context:compacted",
              lastReportTokens !== undefined ? { maxTokens: this.deps.context?.budget.maxTokens ?? 0, usedTokens: lastReportTokens } : undefined,
            );
          }
          // Phase 8 message-history trim: when the message history alone
          // exceeds the headroom left by the system side, drop the OLDEST
          // messages (keeping the recent tail) and inject the state digest so
          // the goal/context survives the trim. The full transcript stays in
          // the store (transcript fallback). The trim runs BEFORE the
          // system-side overflow check below: the system side has priority.
          if (!pipeline.historyCompaction && built.report.used < this.deps.context.budget.maxTokens) {
            const available = this.deps.context.budget.maxTokens - built.report.used;
            const messagesTokens = built.report.messagesTokens ?? 0;
            const headroom = built.manualCompaction ? Math.min(available, Math.max(this.deps.context.pipeline.estimateMessageTokens(activeUsers), Math.floor(messagesTokens * 0.6))) : available;
            if (messagesTokens > headroom || built.manualCompaction) {
              historyTrimmed = true;
              await this.deps.emit(sessionId, "context.compacted", {
                compressed: 1,
                reason: "message-history trim (context budget)",
                reactive: false,
                totalCount: ++this.deps.compactCounter.value,
              }, turnId);
              await this.deps.store.appendMessage({
                id: newMessageId(),
                sessionId,
                turnId,
                role: "system",
                content: buildStateDigest(working, "message history trimmed — older messages folded into this summary; continue concisely", activeUsers),
                createdAt: this.deps.now(),
              });
              history = incompleteHistoryView(await this.deps.store.listMessages(sessionId));
              const pipeline = this.deps.context.pipeline;
              const carryover = historyCarryover(history, Math.min(512, Math.floor(headroom / 3)),
                messages => pipeline.estimateMessageTokens(messages), text => {
                  const safe = protectToolOutputText(text, { redact: this.deps.outputRedactor, detect: this.deps.injectionDetector });
                  return safe.injection.hasInjection ? undefined : safe.content;
                });
              const reservedNotes = carryover === undefined ? 0 : pipeline.estimateMessageTokens([carryover]);
              history = trimMessageHistory(history, Math.max(0, headroom - reservedNotes), (message) => pipeline.estimateMessageTokens([message]), activeUsers);
              if (carryover !== undefined) history = [carryover, ...history];
            }
          }
          // The budget may retain a short recent tail above its estimate, but
          // active user authority itself must never be evicted to fit. Detect
          // that irreducible overflow before any provider/tool call.
          const protectedTokens = pipeline.historyCompaction
            ? pipeline.estimateTextTokens(system) + this.deps.context.budget.reserved.output + pipeline.estimateMessageTokens(history)
            : built.report.used + pipeline.estimateMessageTokens(activeUsers);
          if (protectedTokens > this.deps.context.budget.maxTokens) {
            overflowAttempt += 1;
            const decision =
              this.deps.recovery?.decide("context_overflow", overflowAttempt) ?? {
                action: "fail_safe" as const,
                reason: `context overflow: protected context used ${protectedTokens} > maxTokens ${this.deps.context.budget.maxTokens}`,
              };
            if (decision.action === "ask" || decision.action === "fail_safe" || activeUsers.length > 0) {
              await this.deps.emit(sessionId, "run.limit_reached", { limit: "maxTokens", used: protectedTokens }, turnId);
              return { action: "finish", outcome: await this.deps.finishTurn(
                ctx, "failed", state, working,
                errorInfo("RESOURCE_LIMIT", decision.action === "retry"
                  ? `protected user context cannot fit: used ${protectedTokens} > maxTokens ${this.deps.context.budget.maxTokens}`
                  : decision.reason),
                "context_limit",
                toolLedger,
              ) };
            }
          }
          if (compaction === undefined && (built.compacted || historyTrimmed)) {
            compaction = { manual: built.manualCompaction === true, beforeTokens: built.report.messagesTokens ?? 0,
              afterTokens: this.deps.context.pipeline.estimateMessageTokens(history) };
          }
        }

    // Feedback is based on final blocks, after protected-context overflow
    // checks. An abort observed before this hook admits nothing for the
    // cancelled step. Once feedback begins, host writes are awaited rather
    // than raced or detached; this metric is admission, not a provider call.
    if (ctx.signal.aborted) {
      return { action: "finish", outcome: await this.deps.finishTurn(
        ctx, "cancelled", state, working, undefined, "cancelled", toolLedger,
      ) };
    }
    if (this.deps.onSkillBodiesAdmitted !== undefined && admittedSkillBodies.length > 0) {
      await this.deps.onSkillBodiesAdmitted({ sessionId, turnId, blocks: admittedSkillBodies });
    }
    if (compaction !== undefined) await this.deps.emit(sessionId, "context.compacted", {
      phase: "completed", reason: compaction.manual ? "manual context preparation completed" : "automatic context preparation completed",
      ...compaction, compressed: compaction.afterTokens < compaction.beforeTokens ? 1 : 0,
      totalCount: this.deps.compactCounter.value,
    }, turnId);

    return {
      action: "proceed",
      history,
      system,
      lastReportTokens,
      digestAppended,
      overflowAttempt,
      selectedSkills: skillSnapshotEntries,
      // P32-3: system + project instruction sources of THIS context build.
      instructionSources,
    };
  }

  /**
   * Q-1: steering prompt injection extracted from runTurn. User steering
   * admitted while the turn is running lands here — the safe boundary
   * before the model call — as a user message. Exactly-once: checks history
   * for already-appended promptId and reconciles to consumed if found.
   * Returns the (possibly refreshed) message history.
   */
  async injectSteeringPrompts(
    ctx: Pick<TurnContext, "sessionId" | "turnId">,
    history: Message[],
    options: { recoverBoundOnly?: boolean } = {},
  ): Promise<Message[]> {
    if (this.deps.inbox === undefined) return history;
    const previous = this.steeringInFlight.get(ctx.sessionId);
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.steeringInFlight.set(ctx.sessionId, current);
    try {
      if (previous !== undefined) {
        await previous;
        // The waiting caller's input was read before its predecessor's
        // append/consume. Deduplicate against the latest durable transcript.
        history = await this.deps.store.listMessages(ctx.sessionId);
      }
      return await this.injectSteeringPromptsOnce(ctx, history, options);
    } finally {
      release();
      if (this.steeringInFlight.get(ctx.sessionId) === current) this.steeringInFlight.delete(ctx.sessionId);
    }
  }

  private async injectSteeringPromptsOnce(
    ctx: Pick<TurnContext, "sessionId" | "turnId">,
    history: Message[],
    options: { recoverBoundOnly?: boolean },
  ): Promise<Message[]> {
    const { sessionId, turnId } = ctx;
    if (this.deps.inbox === undefined) return history;

    // Include promoted prompts: append/consume can be interrupted after the
    // message is durable and before the inbox has reached consumed.
    const pending = await this.deps.inbox.listRecoverable(sessionId);
    for (const prompt of pending) {
      if (prompt.kind !== "steer") continue;
      // A fresh-turn checkpoint resume first settles the interrupted turn's
      // own bound prompts. Preserve their lineage; unrelated and unbound
      // prompts remain for the ordinary safe-boundary injection path.
      if (options.recoverBoundOnly &&
        (prompt.status !== "promoted" || prompt.promotedTurnId !== turnId)) continue;
      if (history.some((m) => m.role === "user" && m.promptId === prompt.id)) {
        // A prior interrupted attempt already injected this steer; do not
        // append again, just reconcile the prompt to consumed.
        await this.deps.inbox.markPromoted(prompt.id);
        await this.deps.inbox.markConsumed(prompt.id);
        continue;
      }
      if (prompt.promotedTurnId !== undefined && prompt.promotedTurnId !== turnId) continue;
      await this.deps.inbox.markPromoted(prompt.id);
      await this.deps.inbox.bindPromotion(prompt.id, turnId);
      await this.deps.store.appendMessage({
        id: newMessageId(),
        sessionId,
        turnId,
        role: "user",
        content: `[steering] ${prompt.text}`,
        promptId: prompt.id,
        createdAt: this.deps.now(),
      });
      await this.deps.inbox.markConsumed(prompt.id);
    }
    if (pending.some((p) => p.kind === "steer")) {
      return await this.deps.store.listMessages(sessionId);
    }
    return history;
  }

  async renderToolResultForContext(
    ctx: TurnContext,
    call: ToolCall,
    result: ToolResult,
  ): Promise<string> {
    const { sessionId, turnId } = ctx;
    const budget = this.deps.toolOutputBudget;
    // Render the existing model view first: structured successes serialize,
    // failures expose their status/error detail, and null/undefined stay empty.
    // This does not change the caller's ToolResult or its structured output.
    const raw = renderToolResult(result) ?? "";

    // P0-7: redact secrets before the output crosses any boundary (artifact
    // file or inline message content). A redaction is observable as a
    // security.secret_redacted event; the sha256 covers the stored content.
    const redactedOut = protectToolOutputText(raw, {
      redact: this.deps.outputRedactor, detect: this.deps.injectionDetector,
    });
    const out = redactedOut.content;
    if (redactedOut.redacted > 0) {
      // P0-7: a redaction is observable with a structured source/reason/code
      // (not just a counter), so the event stream can attribute it.
      await this.deps.emit(sessionId, "security.secret_redacted", {
        toolCallId: call.id,
        tool: call.name,
        redacted: redactedOut.redacted,
        source: "tool-output-budget",
        reason: "secret redacted before boundary",
        code: "SECRET_REDACTED",
      }, turnId);
    }

    // Scan the complete redacted model text before reducing it to a preview.
    // Budget configuration and output shape must never disable this boundary.
    const injection = redactedOut.injection;
    const bytes = Buffer.byteLength(out, "utf8");
    let renderText: string;
    if (budget === undefined || bytes <= budget.maxInlineBytes) {
      renderText = out;
    } else {
      const hash = createHash("sha256").update(out).digest("hex");
      let ref = "(no artifact dir configured — inline truncated)";
      if (budget.artifactDir !== undefined) {
        // Provider correlation ids are untrusted values, never path parts.
        const identity = createHash("sha256").update(JSON.stringify([sessionId, turnId, call.id])).digest("hex");
        const path = join(budget.artifactDir, `tool-output-${identity}.txt`);
        try {
          await mkdir(dirname(path), { recursive: true });
          // Exclusive creation refuses pre-existing files and symlinks.
          await writeFile(path, out, { encoding: "utf8", flag: "wx", mode: 0o600 });
          ref = path;
          // P1-12: register the artifact under its own id — the path is only a
          // ref, never the identity. Sensitivity follows the tool semantics.
          if (this.deps.artifactStore !== undefined) {
            const artifact: Artifact = {
              id: newArtifactId(),
              sessionId,
              turnId,
              toolCallId: call.id,
              ref: path,
              mime: "text/plain",
              bytes: Buffer.byteLength(out, "utf8"),
              sha256: hash,
              createdAt: this.deps.now(),
              // P1-13: content that required redaction is classified high —
              // secret-bearing output is never labeled by tool semantics alone.
              sensitivity:
                redactedOut.redacted > 0 ? "high" : this.deps.semanticsOf(call.name).outputSensitivity,
              retention: "turn",
            };
            try {
              await this.deps.artifactStore.register(artifact);
              ref = `${path}#artifact:${artifact.id}`;
            } catch (err) {
              // P14-6: registry failure must not break the turn (the file is
              // already on disk and the hash is in the message trail) — but it
              // is reported, never silent.
              process.stderr.write(`[degraded] context-controller.artifact-register: ${err instanceof Error ? err.message : String(err)}\n`);
            }
          }
        } catch {
          ref = "(artifact write failed — inline truncated)";
        }
      }
      // maxInlineBytes is an artifact threshold, not a preview/marker cap.
      // Each preview body has its own 2000-byte limit (ASCII-compatible).
      // Only encode a bounded string slice, avoiding another full-size buffer.
      const preview = (fromTail: boolean): string => {
        let segment = fromTail ? out.slice(-2000) : out.slice(0, 2000);
        if (out.length > 2000) {
          if (fromTail && /[\uDC00-\uDFFF]/u.test(segment[0]!)) segment = segment.slice(1);
          if (!fromTail && /[\uD800-\uDBFF]/u.test(segment.at(-1)!)) segment = segment.slice(0, -1);
        }
        const encoded = Buffer.from(segment, "utf8");
        let start = fromTail ? Math.max(0, encoded.length - 2000) : 0;
        let end = fromTail ? encoded.length : Math.min(encoded.length, 2000);
        while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start++;
        while (end < encoded.length && (encoded[end]! & 0xc0) === 0x80) end--;
        return encoded.subarray(start, end).toString("utf8");
      };
      const head = preview(false);
      const tail = preview(true);
      renderText =
        `[tool output: ${bytes} bytes, exceeds inline budget (${budget.maxInlineBytes})]\n` +
        `[artifact: ${ref}]\n[sha256: ${hash}]\n` +
        `--- output head ---\n${head}\n--- output tail ---\n${tail}`;
    }

    // P0-8: untrusted tool output must stay data-only in the model's context.
    // The complete model view is scanned; on a hit the
    // content is replaced with a blocked notice (never the injection itself)
    // and the denial is observable as security.injection_denied. The full
    // (non-rendered) output is never fed back to the model.
    if (injection?.hasInjection) {
      await this.deps.emit(sessionId, "security.injection_denied", {
        source: "tool",
        target: call.name,
        toolCallId: call.id,
        reasons: injection.reasons,
        code: "SECURITY_DENIED",
      }, turnId);
      return (
        `[tool output blocked: prompt-injection detected in "${call.name}" output ` +
        `(${injection.reasons.join(", ")}) — content withheld]`
      );
    }
    return renderText;
  }
}

/** P17-6: project the durable working state into the protected-facts shape
 *  the preservation checker verifies against. */
function protectedFactsFrom(working: import("@ar/contracts").WorkingState, activeUsers: readonly Message[]): import("@ar/context").ProtectedFacts {
  return {
    goal: working.goal,
    constraints: [...working.constraints, ...activeUsers.map((message) => message.content)],
    pending: working.pending,
    decisions: working.decisions,
    filesChanged: working.filesChanged,
    commandsRun: working.commandsRun,
    testsRun: working.testsRun,
    failures: working.failures,
    unresolvedTools: working.toolRefs,
    memoryRefs: working.memoryRefs,
    skillRefs: working.toolRefs,
    childAgentRefs: working.childAgentRefs,
  };
}
