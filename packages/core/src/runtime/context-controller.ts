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
import { errorInfo, newArtifactId, newMessageId } from "@ar/contracts";
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
import { AgentState } from "../state/agent-state.js";
import type { RecoveryPolicy } from "../recovery/recovery.js";
import {
  buildStateDigest,
  renderToolResult,
  TRUST_BOUNDARY_PROMPT,
  trimMessageHistory,
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

/** Q-1: result of buildContext — either proceed with updated context state
 *  or finish the turn on overflow. */
export type ContextUpdate =
  | { action: "proceed"; history: Message[]; system: string; lastReportTokens: number | undefined; digestAppended: boolean; overflowAttempt: number }
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
  ) => Promise<AgentEvent>;
  now: () => number;
  failAt: (point: FaultPoint, ctx: FaultPointContext) => Promise<void>;
  context?: { pipeline: ContextPipeline; budget: ContextBudget; instructionOpts?: InstructionDiscoveryOptions };
  skills?: () => Skill[] | SkillDiscovery | Promise<Skill[] | SkillDiscovery>;
  skillSelector?: (entries: SkillIndexEntry[]) => SkillIndexEntry[];
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
  ) => Promise<TurnOutcome>;
  toolOutputBudget?: { maxInlineBytes: number; artifactDir?: string };
  outputRedactor?: (content: string) => { content: string; redacted: number };
  artifactStore?: ArtifactStore;
  semanticsOf: (name: string) => ToolSemantics;
  injectionDetector?: (content: string) => { hasInjection: boolean; reasons: string[] };
  inbox?: InboxStore;
}

export class ContextController {
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
    reactiveCompacted: boolean,
  ): Promise<ContextUpdate> {
    const { sessionId, turnId, session } = ctx;
    let system = agent.systemPrompt;

        if (this.deps.context !== undefined) {
          // Task 3: skill index — awaited once per build; provider errors
          // propagate like discovery errors (never swallowed). P0-7: the
          // provider may additionally report rejected skills.
          const disco = this.deps.skills !== undefined ? await this.deps.skills() : undefined;
          const skills = disco !== undefined && !Array.isArray(disco) ? disco.skills : disco;
          const built = await this.deps.context.pipeline.build({
            cwd: session.cwd,
            systemPrompt: agent.systemPrompt,
            priorBlocks,
            budget: this.deps.context.budget,
            instructionOpts: this.deps.context.instructionOpts,
            messages: history,
            // P1-2: what must survive compaction comes from the runtime's
            // working state (summaryOverride); the pipeline never synthesizes
            // summary content.
            summaryOverride: workingStateToCompactionSummary(working),
            ...(skills !== undefined
              ? {
                  skills: (this.deps.skillSelector !== undefined
                    ? this.deps.skillSelector(
                        skills.map((skill) => ({
                          name: skill.manifest.name,
                          description: skill.manifest.description ?? "",
                        })),
                      )
                    : skills.map((skill) => ({
                        name: skill.manifest.name,
                        description: skill.manifest.description ?? "",
                      }))),
                }
              : {}),
          });
          lastReportTokens = built.report.used;
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
                sec.detection === "injection" ? "security.skill_denied" : "security.secret_redacted",
                {
                  reason: sec.detection === "injection"
                    ? `injection detected (${sec.reasons.join(", ")})`
                    : `secret detected (${sec.reasons.join(", ")})`,
                  code: sec.detection === "injection" ? "SKILL_DENIED" : "SECRET_REDACTED",
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
          if (built.compacted) {
            this.deps.compactCounter.value += 1;
            await this.deps.emit(sessionId, "context.compacted", {
              compressed: 1,
              reason: "auto-compact (context budget)",
              reactive: false,
              totalCount: this.deps.compactCounter.value,
            }, turnId);
            if (!digestAppended) {
              // Structured compaction summary (plan.md Phase 4/5): the model
              // keeps goal/completed-work/commands/errors after compaction;
              // full history stays in the store (transcript fallback).
              digestAppended = true;
              await this.deps.store.appendMessage({
                id: newMessageId(),
                sessionId,
                turnId,
                role: "system",
                content: buildStateDigest(working, "context compacted — older tool outputs were folded into this summary"),
                createdAt: this.deps.now(),
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
          if (built.report.used < this.deps.context.budget.maxTokens) {
            const headroom = this.deps.context.budget.maxTokens - built.report.used;
            const messagesTokens = built.report.messagesTokens ?? 0;
            if (messagesTokens > headroom) {
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
                content: buildStateDigest(working, "message history trimmed — older messages folded into this summary; continue concisely"),
                createdAt: this.deps.now(),
              });
              history = await this.deps.store.listMessages(sessionId);
              history = trimMessageHistory(history, headroom);
            }
          }
          if (built.report.used > this.deps.context.budget.maxTokens) {
            overflowAttempt += 1;
            const decision =
              this.deps.recovery?.decide("context_overflow", overflowAttempt) ?? {
                action: "fail_safe" as const,
                reason: `context overflow: used ${built.report.used} > maxTokens ${this.deps.context.budget.maxTokens}`,
              };
            if (decision.action === "ask" || decision.action === "fail_safe") {
              await this.deps.emit(sessionId, "run.limit_reached", { limit: "maxTokens", used: built.report.used }, turnId);
              return { action: "finish", outcome: await this.deps.finishTurn(
                ctx, "failed", state, working,
                errorInfo("RESOURCE_LIMIT", decision.reason),
                "context_limit",
                toolLedger,
              ) };
            }
          }
        }

    return {
      action: "proceed",
      history,
      system,
      lastReportTokens,
      digestAppended,
      overflowAttempt,
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
    ctx: TurnContext,
    history: Message[],
  ): Promise<Message[]> {
    const { sessionId, turnId } = ctx;
    if (this.deps.inbox === undefined) return history;

    const pending = await this.deps.inbox.listPending(sessionId);
    for (const prompt of pending) {
      if (prompt.kind !== "steer") continue;
      if (history.some((m) => m.promptId === prompt.id)) {
        // A prior interrupted attempt already injected this steer; do not
        // append again, just reconcile the prompt to consumed.
        await this.deps.inbox.markPromoted(prompt.id);
        await this.deps.inbox.markConsumed(prompt.id);
        continue;
      }
      await this.deps.inbox.markPromoted(prompt.id);
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
    const raw = result.output;
    if (budget === undefined || typeof raw !== "string") return renderToolResult(result);

    // P0-7: redact secrets before the output crosses any boundary (artifact
    // file or inline message content). A redaction is observable as a
    // security.secret_redacted event; the sha256 covers the stored content.
    const redactedOut = this.deps.outputRedactor !== undefined ? this.deps.outputRedactor(raw) : { content: raw, redacted: 0 };
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

    const bytes = Buffer.byteLength(out, "utf8");
    let renderText: string;
    if (bytes <= budget.maxInlineBytes) {
      renderText = renderToolResult({ ...result, output: out });
    } else {
      const hash = createHash("sha256").update(out).digest("hex");
      let ref = "(no artifact dir configured — inline truncated)";
      if (budget.artifactDir !== undefined) {
        const path = join(budget.artifactDir, `${sessionId}-${turnId}-${call.id}.txt`);
        try {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, out, "utf8");
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
            } catch {
              // Registry failure must not break the turn; the file itself is
              // already on disk and the hash is in the message trail.
            }
          }
        } catch {
          ref = "(artifact write failed — inline truncated)";
        }
      }
      const head = out.slice(0, 2000);
      const tail = out.slice(-2000);
      renderText =
        `[tool output: ${bytes} bytes, exceeds inline budget (${budget.maxInlineBytes})]\n` +
        `[artifact: ${ref}]\n[sha256: ${hash}]\n` +
        `--- output head ---\n${head}\n--- output tail ---\n${tail}`;
    }

    // P0-8: untrusted tool output must stay data-only in the model's context.
    // The rendered text the model actually sees is scanned; on a hit the
    // content is replaced with a blocked notice (never the injection itself)
    // and the denial is observable as security.injection_denied. The full
    // (non-rendered) output is never fed back to the model.
    if (this.deps.injectionDetector !== undefined) {
      const report = this.deps.injectionDetector(renderText);
      if (report.hasInjection) {
        await this.deps.emit(sessionId, "security.injection_denied", {
          source: "tool",
          target: call.name,
          toolCallId: call.id,
          reasons: report.reasons,
          code: "SECURITY_DENIED",
        }, turnId);
        return (
          `[tool output blocked: prompt-injection detected in "${call.name}" output ` +
          `(${report.reasons.join(", ")}) — content withheld]`
        );
      }
    }
    return renderText;
  }
}
