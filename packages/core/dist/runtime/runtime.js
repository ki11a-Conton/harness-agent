import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AdaptiveRecoveryPlanner, DEFAULT_CHECKPOINT_POLICY, DEFAULT_TOOL_CAPABILITY, DEFAULT_TOOL_SEMANTICS, EFFECTIVE_AGENT_SNAPSHOT_KEY, RUNTIME_POLICY_SNAPSHOT_KEY, computeArgsHash, errorInfo, isToolAllowedByPolicy, newArtifactId, newEventId, newMessageId, newSessionId, newTurnId, newWorkingState, snapshotEffectiveConfig, STALL_WINDOW_SIZE, defaultAskUserLifecycle, RealTimer, } from "@ar/contracts";
import { estimateMessageTokens } from "@ar/context";
import { applyWorkingStateMutation } from "@ar/contracts";
import { AgentError } from "../errors.js";
import { AgentState } from "../state/agent-state.js";
import { HookRegistry } from "../lifecycle/hooks.js";
import { RecoveryPolicy } from "../recovery/recovery.js";
import { buildResumePrompt, DEFAULT_RUNTIME_TOOL_SEMANTICS, isContextOverflowError, isEffectiveAgentConfig, rethrowIfKill, renderToolResult, toContextBlock, trimMessageHistory, updateWorkingState, workingStateToCompactionSummary, ASK_GATE_TOOL, } from "./turn-helpers.js";
import { ToolCallController } from "./tool-call-controller.js";
import { RunBudgetTracker } from "./run-budget.js";
/** P1-6: deterministic hash of a policy value (session fingerprinting). */
function stableHashOf(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
import { ContextController } from "./context-controller.js";
import { ModelCallController } from "./model-call-controller.js";
import { VerificationController } from "./verification-controller.js";
import { RecoveryController } from "./recovery-controller.js";
/**
 * P2-41: non-identical stall patterns detected by default. `identical_tool` is
 * excluded — the legacy `maxRepeatedIdenticalToolCalls` gate already owns it.
 * The rest (alternating loop, repeated error, unchanged repeated read,
 * verification fix loop, no-progress churn) were previously invisible.
 */
const DEFAULT_ENABLED_STALL_PATTERNS = [
    "alternating_loop",
    "repeated_error",
    "repeated_read_no_change",
    "verification_fix_loop",
    "no_progress",
];
// Q-1: defaultSandboxPolicy / FaultPoint / FaultPointContext /
// RuntimeKilledError / rethrowIfKill / TurnOutcome / TurnOutcomeStatus /
// TurnOutcomeDetail / ResumeResult / ASK_GATE_TOOL moved to turn-helpers.ts
// (shared with the extracted controllers); re-exported here so the public
// @ar/core surface (apps/cli, fault-injection tests importing ./runtime.js)
// is unchanged.
export { defaultSandboxPolicy, RuntimeKilledError, ASK_GATE_TOOL, TRUST_BOUNDARY_PROMPT } from "./turn-helpers.js";
export class AgentRuntime {
    store;
    events;
    modelProvider;
    orchestrator;
    hooks;
    agents;
    maxIterationsPerTurn;
    maxRepeatedIdenticalToolCalls;
    maxStallRecoveries;
    /** P2-41: non-identical stall patterns the runtime actively detects. */
    enabledStallPatterns;
    /** P2-41: recovery budget for pattern-based stalls. */
    maxPatternStallRecoveries;
    maxVerificationFailures;
    maxParallelToolCalls;
    toolCapabilityOf;
    toolSemanticsOf;
    toolOutputBudget;
    artifactStore;
    outputRedactor;
    injectionDetector;
    inbox;
    reportModelUsage;
    now;
    /** Q-7: injectable timer driving retry-backoff sleeps. */
    timer;
    sandboxPolicy;
    context;
    task;
    verifier;
    verificationPlanner;
    recovery;
    /** P2-42: adaptive recovery planner (bounded action budgets). */
    adaptiveRecovery;
    /** P2-42: per-turn ledger of recovery-action uses against their budgets. */
    recoveryUsage = {};
    skills;
    skillSelector;
    /** P2-8: loads skill bodies for the selected skills (progressive disclosure). */
    skillBodyBlocks;
    /** P2-2: pre-turn memory retrieval (memory prior blocks + memory.retrieved). */
    memoryBlocks;
    /** P2-5: post-turn reflection hook (never alters the turn result). */
    onTurnComplete;
    /** P3-9: host-provided specialist delegation for adaptive recovery. */
    delegateSpecialist;
    toolSpecs;
    toolSelector;
    changedPathsProvider;
    baselineFilesProvider;
    /** P1-20: cumulative compaction count (observability metric). Q-1: boxed
     *  so the context + model-call controllers share it by reference. */
    compactCounter = { value: 0 };
    checkpointStore;
    checkpointPolicy;
    failpoint;
    /** P2-43: ask-user gate — durable store, handler, and pure lifecycle. */
    askUserStore;
    askUser;
    askUserLifecycle;
    /** Q-1: tool-call execution (batch planning, single-call pipeline, stall
     *  traces) delegated to the extracted controller module. */
    toolCallController;
    /** Q-1: context pipeline + steering injection + tool-output rendering
     *  delegated to the extracted controller module. */
    contextController;
    /** Q-1: verification gate delegated to the extracted controller module. */
    verificationController;
    /** Q-1: model-call + post-completion processing delegated to the extracted
     *  controller module. */
    modelCallController;
    /** Q-1: recovery/persistence helpers (finishTurn / checkpoint / park /
     *  reconstruct) delegated to the extracted controller module. */
    recoveryController;
    constructor(deps) {
        this.store = deps.store;
        this.events = deps.events;
        this.modelProvider = deps.modelProvider;
        this.orchestrator = deps.orchestrator;
        this.hooks = deps.hooks ?? new HookRegistry();
        this.agents = new Map(deps.agents.map((a) => [a.id, a]));
        this.maxIterationsPerTurn = deps.maxIterationsPerTurn ?? 20;
        this.maxRepeatedIdenticalToolCalls = deps.maxRepeatedIdenticalToolCalls ?? 3;
        this.maxStallRecoveries = deps.maxStallRecoveries ?? 1;
        this.enabledStallPatterns = new Set(deps.enabledStallPatterns ?? DEFAULT_ENABLED_STALL_PATTERNS);
        this.maxPatternStallRecoveries = deps.maxPatternStallRecoveries ?? 1;
        this.maxVerificationFailures = deps.maxVerificationFailures ?? 3;
        this.maxParallelToolCalls = deps.maxParallelToolCalls ?? 4;
        this.toolCapabilityOf = deps.toolCapabilityOf ?? (() => DEFAULT_TOOL_CAPABILITY);
        this.toolSemanticsOf = deps.toolSemanticsOf;
        this.toolOutputBudget = deps.toolOutputBudget;
        this.artifactStore = deps.artifactStore;
        this.outputRedactor = deps.outputRedactor;
        this.injectionDetector = deps.injectionDetector;
        this.inbox = deps.inbox;
        this.reportModelUsage = deps.reportModelUsage;
        this.now = deps.now ?? Date.now;
        this.timer = deps.timer ?? new RealTimer(this.now);
        this.sandboxPolicy = deps.sandboxPolicy;
        this.context = deps.context;
        this.task = deps.task;
        this.verifier = deps.verifier;
        this.verificationPlanner = deps.verificationPlanner;
        this.recovery = deps.recovery;
        this.adaptiveRecovery = deps.adaptiveRecovery;
        this.skills = deps.skills;
        this.skillSelector = deps.skillSelector;
        this.skillBodyBlocks = deps.skillBodyBlocks;
        this.memoryBlocks = deps.memoryBlocks;
        this.onTurnComplete = deps.onTurnComplete;
        this.delegateSpecialist = deps.delegateSpecialist;
        this.toolSpecs = deps.toolSpecs ?? [];
        this.toolSelector = deps.toolSelector;
        this.changedPathsProvider = deps.changedPathsProvider;
        this.baselineFilesProvider = deps.baselineFilesProvider;
        this.checkpointStore = deps.checkpointStore;
        this.checkpointPolicy = { ...DEFAULT_CHECKPOINT_POLICY, ...deps.checkpointPolicy };
        this.failpoint = deps.failpoint;
        this.askUserStore = deps.askUserStore;
        this.askUser = deps.askUser;
        this.askUserLifecycle = deps.askUserLifecycle ?? defaultAskUserLifecycle;
        // Q-1: recovery/persistence helpers delegated to the extracted controller.
        // Constructed FIRST because the context + model-call controllers bind
        // checkpoint/finishTurn/parkForUserInput to it.
        this.recoveryController = new RecoveryController({
            store: this.store,
            events: this.events,
            emit: (sessionId, type, payload, turnId, spans) => this.emit(sessionId, type, payload, turnId, spans),
            now: () => this.now(),
            checkpointStore: this.checkpointStore,
            askUserStore: this.askUserStore,
            askUser: this.askUser,
            semanticsOf: (name) => this.semanticsOf(name),
        });
        // Q-1: tool-call execution delegated to the extracted controller. The
        // bindings below are captured once (all fields above are readonly);
        // `recoveryUsage` is passed by reference — the shared mutable budget map.
        this.toolCallController = new ToolCallController({
            orchestrator: this.orchestrator,
            store: this.store,
            hooks: this.hooks,
            emit: (sessionId, type, payload, turnId, spans) => this.emit(sessionId, type, payload, turnId, spans),
            failAt: (point, ctx) => this.failAt(point, ctx),
            now: () => this.now(),
            timer: this.timer,
            sandboxPolicy: this.sandboxPolicy,
            recovery: this.recovery,
            adaptiveRecovery: this.adaptiveRecovery,
            recoveryUsage: this.recoveryUsage,
            toolCapabilityOf: (toolName) => this.toolCapabilityOf(toolName),
            maxParallelToolCalls: this.maxParallelToolCalls,
            delegateSpecialist: this.delegateSpecialist,
        });
        // Q-1: context pipeline + steering + tool-output rendering delegated to
        // the extracted controller. `compactCounter` is shared by reference with
        // the model-call controller (reactive compaction).
        this.contextController = new ContextController({
            store: this.store,
            emit: (sessionId, type, payload, turnId, spans) => this.emit(sessionId, type, payload, turnId, spans),
            now: () => this.now(),
            failAt: (point, ctx) => this.failAt(point, ctx),
            context: this.context,
            skills: this.skills,
            skillSelector: this.skillSelector,
            skillBodyBlocks: this.skillBodyBlocks,
            recovery: this.recovery,
            compactCounter: this.compactCounter,
            checkpoint: (ctx, working, state, toolLedger, reason, budgetUsage) => this.recoveryController.checkpoint(ctx, working, state, toolLedger, reason, budgetUsage),
            finishTurn: (ctx, status, state, working, error, terminationReason, ledger) => this.recoveryController.finishTurn(ctx, status, state, working, error, terminationReason, ledger),
            toolOutputBudget: this.toolOutputBudget,
            outputRedactor: this.outputRedactor,
            artifactStore: this.artifactStore,
            semanticsOf: (name) => this.semanticsOf(name),
            injectionDetector: this.injectionDetector,
            inbox: this.inbox,
        });
        // Q-1: verification gate delegated to the extracted controller.
        this.verificationController = new VerificationController({
            task: this.task,
            verifier: this.verifier,
            store: this.store,
            now: () => this.now(),
            changedPathsProvider: this.changedPathsProvider,
            baselineFilesProvider: this.baselineFilesProvider,
            ...(this.verificationPlanner !== undefined
                ? { planVerification: this.verificationPlanner }
                : {}),
        });
        // Q-1: model-call + post-completion delegated to the extracted
        // controller. runVerificationGate is bound to the verification
        // controller; checkpoint/finishTurn/parkForUserInput/wallClockExceeded
        // are bound to the runtime (they are recovery/recovery-adjacent and stay
        // on AgentRuntime to avoid a controller ↔ runtime cycle).
        this.modelCallController = new ModelCallController({
            store: this.store,
            emit: (sessionId, type, payload, turnId, spans) => this.emit(sessionId, type, payload, turnId, spans),
            now: () => this.now(),
            failAt: (point, ctx) => this.failAt(point, ctx),
            toolSpecs: this.toolSpecs,
            ...(this.toolSelector !== undefined ? { toolSelector: this.toolSelector } : {}),
            recovery: this.recovery,
            timer: this.timer,
            compactCounter: this.compactCounter,
            maxVerificationFailures: this.maxVerificationFailures,
            afterVerificationCheckpoint: this.checkpointPolicy.afterVerification,
            contextBudgetMaxTokens: this.context?.budget.maxTokens ?? 0,
            checkpoint: (ctx, working, state, toolLedger, reason, budgetUsage) => this.recoveryController.checkpoint(ctx, working, state, toolLedger, reason, budgetUsage),
            finishTurn: (ctx, status, state, working, error, terminationReason, ledger) => this.recoveryController.finishTurn(ctx, status, state, working, error, terminationReason, ledger),
            parkForUserInput: (ctx, state, working, call, ledger) => this.recoveryController.parkForUserInput(ctx, state, working, call, ledger),
            runVerificationGate: (ctx) => this.verificationController.runVerificationGate(ctx),
            wallClockExceeded: (agent, turn) => this.wallClockExceeded(agent, turn),
        });
    }
    /** P1-5: invoke the fault injector at a kill point (no-op when absent). */
    async failAt(point, ctx) {
        if (this.failpoint === undefined)
            return;
        await this.failpoint(point, ctx);
    }
    getHooks() {
        return this.hooks;
    }
    async emit(sessionId, type, payload, turnId, spans) {
        const sequence = await this.events.nextSequence(sessionId);
        return this.events.append({
            id: newEventId(),
            sessionId,
            ...(turnId !== undefined ? { turnId } : {}),
            ...(spans?.spanId !== undefined ? { spanId: spans.spanId } : {}),
            ...(spans?.parentSpanId !== undefined ? { parentSpanId: spans.parentSpanId } : {}),
            sequence,
            timestamp: this.now(),
            type,
            payload,
        });
    }
    async createSession(opts) {
        if (!this.agents.has(opts.agent.id)) {
            throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown agent ${opts.agent.id}`));
        }
        const session = {
            id: newSessionId(),
            ...(opts.parentId !== undefined ? { parentId: opts.parentId } : {}),
            agentId: opts.agent.id,
            model: opts.agent.model,
            cwd: opts.cwd,
            status: "active",
            createdAt: this.now(),
            updatedAt: this.now(),
        };
        await this.store.createSession(session);
        // P0-1: freeze the effective configuration (model/systemPrompt/tools/
        // permissions/skills/limits) into the session state. runTurn honors this
        // snapshot instead of re-reading the registry, so delegation restrictions
        // survive resume, and later registry changes cannot silently widen a
        // running session. Persistence failure fails session creation (fail-closed:
        // a session without a frozen policy must not run against the base agent).
        await this.store.saveStateSnapshot(session.id, {
            [EFFECTIVE_AGENT_SNAPSHOT_KEY]: snapshotEffectiveConfig(opts.agent),
            // P1-6: freeze the runtime policy hashes too, so a resume can detect
            // host-policy drift (safe-resume gate).
            [RUNTIME_POLICY_SNAPSHOT_KEY]: {
                version: 1,
                contextPolicyHash: this.context !== undefined ? stableHashOf(this.context) : undefined,
                retryPolicyHash: this.recovery !== undefined ? stableHashOf(this.recovery) : undefined,
                schedulerPolicyHash: undefined,
                toolSemanticsHash: this.toolSemanticsOf !== undefined ? String(this.toolSemanticsOf.length) : undefined,
                createdAt: this.now(),
            },
        });
        await this.emit(session.id, "session.created", { sessionId: session.id, agentId: session.agentId });
        await this.hooks.dispatch("session_start", {
            sessionId: session.id,
            agentId: session.agentId,
            timestamp: this.now(),
        });
        return session;
    }
    async startTurn(sessionId, text) {
        const session = await this.store.getSession(sessionId);
        if (!session)
            throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown session ${sessionId}`));
        if (session.status !== "active") {
            throw new AgentError(errorInfo("INTERNAL_ERROR", `session ${sessionId} is ${session.status}`));
        }
        const input = { sessionId, text };
        const turn = {
            id: newTurnId(),
            sessionId,
            input,
            status: "running",
            startedAt: this.now(),
        };
        await this.store.createTurn(turn);
        await this.store.appendMessage({
            id: newMessageId(),
            sessionId,
            turnId: turn.id,
            role: "user",
            content: text,
            createdAt: this.now(),
        });
        await this.emit(sessionId, "turn.started", { turnId: turn.id, text }, turn.id);
        return turn;
    }
    /** Execute one turn: model round-trips + tool calls, bounded and cancellable.
     *  `opts.initialState` seeds the working state from a restored checkpoint
     *  (P1-4 resume) instead of the turn input text. */
    async runTurn(sessionId, turnId, signal, opts = {}) {
        const outcome = await this.runTurnCore(sessionId, turnId, signal, opts);
        // P2-5: post-turn reflection hook — fired exactly once per terminal
        // outcome (the host owns the reflection pipeline). Errors are swallowed:
        // reflection must never change the turn result.
        if (this.onTurnComplete !== undefined) {
            try {
                await this.onTurnComplete({ sessionId, turnId, outcome });
            }
            catch (cause) {
                process.stderr.write(`[runtime] onTurnComplete failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
            }
        }
        return outcome;
    }
    /** P2-5: runTurn body (the wrapper fires the post-turn reflection hook).
     *  Model round-trips + tool calls, bounded and cancellable. */
    async runTurnCore(sessionId, turnId, signal, opts = {}) {
        // Q-1: turn initialization extracted to prepareTurn (session/agent/turn
        // resolution, TurnContext, AgentState, working state, tool ledger).
        const { ctx, state, turn, working, toolLedger } = await this.prepareTurn(sessionId, turnId, signal, opts);
        const priorBlocks = [];
        // P2-2: pre-turn memory retrieval — runs once per turn, before the first
        // model call. The retrieved memory blocks join the context pipeline as
        // semi-trusted prior data; their ids land in the working state's
        // memoryRefs and one memory.retrieved event is emitted per turn.
        if (this.memoryBlocks !== undefined) {
            const memoryBlocks = await this.memoryBlocks({
                sessionId,
                turnId,
                goal: working.goal,
                cwd: ctx.session.cwd,
            });
            if (memoryBlocks.length > 0) {
                priorBlocks.push(...memoryBlocks);
                const memoryIds = [];
                for (const block of memoryBlocks) {
                    const id = block.id.startsWith("memory:") ? block.id.slice("memory:".length) : block.id;
                    if (id.length > 0 && !memoryIds.includes(id))
                        memoryIds.push(id);
                }
                const known = new Set(working.memoryRefs);
                for (const id of memoryIds) {
                    if (!known.has(id)) {
                        working.memoryRefs.push(id);
                        known.add(id);
                    }
                }
                await this.emit(sessionId, "memory.retrieved", {
                    query: working.goal,
                    count: memoryIds.length,
                    memoryIds,
                    suppressed: 0,
                }, turnId);
            }
        }
        let overflowAttempt = 0;
        let verificationFailures = 0;
        let reactiveCompacted = false;
        let digestAppended = false;
        let lastReportTokens;
        // P0-10: unified run-budget tracker (replaces scattered counters).
        const budget = new RunBudgetTracker(ctx.agent.limits, this.now);
        // P0-10: maxTurns — a turn-level cap, consumed at the start of each turn.
        const turnBreach = budget.onTurnStart();
        if (turnBreach !== undefined) {
            await this.emit(sessionId, "run.limit_reached", { ...turnBreach, used: turnBreach.used }, turnId);
            return this.recoveryController.finishTurn(ctx, "failed", state, working, errorInfo("RESOURCE_LIMIT", `maxTurns (${turnBreach.allowed}) reached`), "agent_limit", toolLedger);
        }
        try {
            for (let i = 0; i < this.maxIterationsPerTurn; i++) {
                if (signal.aborted) {
                    return this.recoveryController.finishTurn(ctx, "cancelled", state, working, undefined, "cancelled", toolLedger);
                }
                // P1-3 periodic checkpoint: every N model iterations at a safe
                // boundary (between model calls). Iteration 0 is the warm-up.
                if (this.checkpointPolicy.everyNIterations > 0 &&
                    state.getIteration() > 0 &&
                    state.getIteration() % this.checkpointPolicy.everyNIterations === 0) {
                    await this.recoveryController.checkpoint(ctx, working, state, toolLedger, "periodic:iteration", lastReportTokens !== undefined ? { maxTokens: this.context?.budget.maxTokens ?? 0, usedTokens: lastReportTokens } : undefined);
                }
                const durationBreach = budget.onDurationCheck();
                if (durationBreach !== undefined) {
                    await this.emit(sessionId, "run.limit_reached", { ...durationBreach }, turnId);
                    return this.recoveryController.finishTurn(ctx, "failed", state, working, errorInfo("RESOURCE_LIMIT", `maxDurationMs (${durationBreach.allowed}ms) exceeded after ${durationBreach.used}ms`), "time_limit", toolLedger);
                }
                await this.hooks.dispatch("before_model", {
                    sessionId, turnId, agentId: ctx.session.agentId, timestamp: this.now(),
                });
                // P0-9: model.started is emitted by the model-call controller per
                // attempt with a callId (usage/latency/retry attribution).
                const client = this.modelProvider.createClient(ctx.agent.model, {});
                let history = await this.store.listMessages(sessionId);
                // Steer injection (plan.md Issue 3 / Phase 5.3, P2-36): user steering
                // admitted while the turn is running lands here — the safe boundary
                // before the model call — as a user message. Follow-up prompts stay
                // queued for the host's outer loop.
                //
                // P2-36 exactly-once: the steer transition spans two stores (session
                // message + inbox status), so a crash between append and consume would
                // otherwise double-inject on resume. We therefore check `history` for
                // an already-appended message carrying `promptId` and skip (reconciling
                // the prompt to consumed) when one exists.
                // Q-1: steering prompt injection extracted to injectSteeringPrompts.
                history = await this.contextController.injectSteeringPrompts(ctx, history);
                if (reactiveCompacted && history.length > 12) {
                    // Reactive compact (plan.md Phase 4/5): after a context-length model
                    // error the runtime retries with a REDUCED history — the state
                    // digest message (appended below) plus the most recent messages.
                    // The full transcript stays in the store (transcript fallback).
                    history = history.slice(-12);
                }
                // Q-1: context pipeline + compaction + overflow extracted to buildContext.
                // Returns TurnOutcome on overflow failure, undefined to proceed.
                // Mutates: history, system, lastReportTokens, digestAppended, overflowAttempt
                // (via the returned ContextUpdate object).
                const ctxUpdate = await this.contextController.buildContext(ctx, ctx.agent, turn, working, priorBlocks, state, toolLedger, history, ctx.agent.systemPrompt, lastReportTokens, digestAppended, overflowAttempt, reactiveCompacted);
                if (ctxUpdate.action === "finish")
                    return ctxUpdate.outcome;
                let system = ctxUpdate.system;
                history = ctxUpdate.history;
                lastReportTokens = ctxUpdate.lastReportTokens;
                digestAppended = ctxUpdate.digestAppended;
                overflowAttempt = ctxUpdate.overflowAttempt;
                const modelResult = await this.modelCallController.callModelWithRetry(ctx, client, history, system, working, state, toolLedger, lastReportTokens, reactiveCompacted, budget);
                if (modelResult.status === "cancelled") {
                    return this.recoveryController.finishTurn(ctx, "cancelled", state, working, undefined, "cancelled", toolLedger);
                }
                if (modelResult.status === "failed") {
                    return this.recoveryController.finishTurn(ctx, "failed", state, working, modelResult.error, "model_error", toolLedger);
                }
                // completed
                reactiveCompacted = modelResult.reactiveCompacted;
                // Q-1: post-completion processing extracted to handleModelCompletion.
                const completion = await this.modelCallController.handleModelCompletion(ctx, modelResult, turn, working, state, toolLedger, lastReportTokens, verificationFailures);
                if (completion.action === "continue_loop") {
                    verificationFailures = completion.verificationFailures;
                    continue;
                }
                // P0-11: report per-call token usage to the tree budget (scheduler).
                if (this.reportModelUsage !== undefined && modelResult.usage !== undefined) {
                    this.reportModelUsage(sessionId, modelResult.usage.inputTokens ?? 0, modelResult.usage.outputTokens ?? 0);
                }
                // P0-10: maxEstimatedCostUsd — check immediately after model usage so a
                // runaway cost stops BEFORE the next model call.
                if (modelResult.usage !== undefined) {
                    const costBreach = budget.onModelUsage(modelResult.usage.inputTokens ?? 0, modelResult.usage.outputTokens ?? 0, modelResult.usage.estimatedCostUsd ?? 0);
                    if (costBreach !== undefined) {
                        await this.emit(sessionId, "run.limit_reached", { ...costBreach }, turnId);
                        return this.recoveryController.finishTurn(ctx, "failed", state, working, errorInfo("RESOURCE_LIMIT", `maxEstimatedCostUsd (${costBreach.allowed}) exceeded after ${costBreach.used}`), "agent_limit", toolLedger);
                    }
                }
                // P0-10: maxOutputChars — assistant text counts toward the output cap
                // (tool output is metered separately by toolOutputBudget). A breach
                // stops the turn before more tokens are generated.
                if (modelResult.assistantText !== undefined) {
                    const outputBreach = budget.onOutput(modelResult.assistantText.length);
                    if (outputBreach !== undefined) {
                        await this.emit(sessionId, "run.limit_reached", { ...outputBreach }, turnId);
                        return this.recoveryController.finishTurn(ctx, "failed", state, working, errorInfo("RESOURCE_LIMIT", `maxOutputChars (${outputBreach.allowed}) exceeded after ${outputBreach.used}`), "agent_limit", toolLedger);
                    }
                }
                if (completion.action === "finish")
                    return completion.outcome;
                // proceed to execute tools
                const toolCalls = completion.toolCalls;
                // P0-10: maxSubagents — consumed before any delegate tool actually
                // spawns a child (never after the fact).
                for (const call of toolCalls) {
                    if (call.name.startsWith("delegate")) {
                        const spawnBreach = budget.onSubagentSpawn();
                        if (spawnBreach !== undefined) {
                            await this.emit(sessionId, "run.limit_reached", { ...spawnBreach }, turnId);
                            return this.recoveryController.finishTurn(ctx, "failed", state, working, errorInfo("RESOURCE_LIMIT", `maxSubagents (${spawnBreach.allowed}) reached`), "agent_limit", toolLedger);
                        }
                    }
                }
                const executed = await this.toolCallController.executeToolCalls(ctx, state, toolCalls, modelResult.callId);
                const toolAction = await this.handleToolResults(ctx, executed, working, state, toolLedger, priorBlocks, lastReportTokens, budget);
                if (toolAction.action === "continue_loop")
                    continue;
                if (toolAction.action === "finish")
                    return toolAction.outcome;
                // done: fall through to next iteration
            }
            const info = errorInfo("RESOURCE_LIMIT", `maxIterationsPerTurn (${this.maxIterationsPerTurn}) reached`);
            await this.emit(sessionId, "run.limit_reached", { limit: "maxIterationsPerTurn", used: this.maxIterationsPerTurn }, turnId);
            return this.recoveryController.finishTurn(ctx, "failed", state, working, info, "agent_limit", toolLedger);
        }
        finally {
            const current = await this.store.getSession(sessionId);
            if (current)
                await this.store.updateSession({ ...current, updatedAt: this.now() });
        }
    }
    /**
     * Q-1: turn initialization extracted from runTurn — resolves the session,
     * agent and turn (throwing AgentError on unknown ids), bundles the five
     * read-only values into the TurnContext, and creates the per-turn mutable
     * accumulators: AgentState (with beginTurn applied), the working state
     * (seeded from the restored checkpoint on resume, else the turn input),
     * and the empty tool execution ledger. Pure wiring, no events emitted.
     */
    async prepareTurn(sessionId, turnId, signal, opts) {
        const session = await this.store.getSession(sessionId);
        if (!session)
            throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown session ${sessionId}`));
        const agent = await this.resolveAgent(session);
        // Q-1: bundle the five read-only turn values into a single context object.
        const ctx = { sessionId, turnId, signal, session, agent };
        const state = new AgentState(sessionId, session.agentId, this.now);
        state.beginTurn(turnId);
        const turn = await this.store.getTurn(turnId);
        if (!turn)
            throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown turn ${turnId}`));
        // P1-4: a resuming turn seeds its working state from the restored
        // checkpoint instead of the (resume) input text; otherwise a fresh
        // per-turn working state is the single run-state structure — the
        // compaction digest, pipeline summary override and the final TurnOutcome
        // all read from it (no parallel journal/summary copies).
        const working = opts?.initialState !== undefined ? opts.initialState : newWorkingState(turn.input.text);
        // P1-3/P1-4: checkpoint material tracked per turn — the durable tool
        // execution ledger and the last observed context usage so a checkpoint
        // can carry budget usage without re-reading the transcript.
        const toolLedger = [];
        return { ctx, state, turn, working, toolLedger };
    }
    // Q-1: executeToolCalls / runReadBatch / recordStallTrace / executeToolCall
    // moved to tool-call-controller.ts (ToolCallController). runTurn delegates
    // via this.toolCallController; the method bodies are unchanged except for
    // `this.<field>` → `this.deps.<field>` bindings.
    /**
     * Q-1: post-execution processing extracted from runTurn. Handles:
     *   - render tool results + append messages + context blocks
     *   - update working state + count tool calls
     *   - tool ledger recording + side-effect checkpoints
     *   - stall detection (identical-call streak + pattern-based)
     *   - maxToolCalls limit check
     *   - post-batch abort check
     * priorBlocks is modified in place (push).
     */
    async handleToolResults(ctx, executed, working, state, toolLedger, priorBlocks, lastReportTokens, budget) {
        const { sessionId, turnId, signal, agent } = ctx;
        for (const { call, result, streak } of executed) {
            // P0-12: update_plan is a runtime-internal tool that applies
            // working state mutations directly — no external execution.
            if (call.name === "update_plan") {
                const mutations = call.args.mutations;
                if (mutations !== undefined) {
                    for (const mutation of mutations) {
                        applyWorkingStateMutation(working, mutation);
                    }
                }
                // Skip the normal tool processing (no block, no message, no ledger).
                state.countToolCall();
                continue;
            }
            const content = await this.contextController.renderToolResultForContext(ctx, call, result);
            priorBlocks.push(toContextBlock(call.id, result, content));
            await this.store.appendMessage({
                id: newMessageId(),
                sessionId,
                turnId,
                role: "tool",
                content,
                toolCallId: call.id,
                createdAt: this.now(),
            });
            updateWorkingState(call, result, working, this.semanticsOf(call.name));
            state.countToolCall();
            // P1-3/P1-4: record the call in the durable execution ledger (the
            // side-effect-safety basis for resume/reconciliation) and checkpoint
            // after a successful side-effect tool — a durable safe boundary for
            // long tasks.
            toolLedger.push({
                toolCallId: call.id,
                tool: call.name,
                argsHash: computeArgsHash(call.args),
                started: this.now(),
                completed: this.now(),
                status: result.status,
                ...(result.output !== undefined
                    ? { resultHash: computeArgsHash({ output: result.output }) }
                    : {}),
                sideEffect: this.semanticsOf(call.name).sideEffectScope !== "none",
            });
            if (this.semanticsOf(call.name).sideEffectScope !== "none" && result.status === "success") {
                // P2-41: a landed side effect (new artifact / file diff) is concrete
                // progress — clear the stall window so a later similar call is not
                // misjudged as stagnation.
                state.recordProgress("new_artifact");
                // P1-5: kill after the effect landed but BEFORE its checkpoint —
                // the window where only the store result message proves it.
                await this.failAt("tool.completed", { sessionId, turnId, toolCallId: call.id, tool: call.name });
                if (this.checkpointPolicy.afterSideEffectTools) {
                    await this.recoveryController.checkpoint(ctx, working, state, toolLedger, `tool:completed:${call.name}`, lastReportTokens !== undefined ? { maxTokens: this.context?.budget.maxTokens ?? 0, usedTokens: lastReportTokens } : undefined);
                    // P1-5: kill AFTER the checkpoint persisted (a durable safety
                    // boundary exists — resume can proceed from it).
                    await this.failAt("tool.checkpointed", { sessionId, turnId, toolCallId: call.id, tool: call.name });
                }
            }
            if (this.maxRepeatedIdenticalToolCalls > 0 &&
                streak >= this.maxRepeatedIdenticalToolCalls) {
                // plan.md Phase 11 stall recovery: before terminating, give the
                // model one bounded chance to change strategy. The streak is
                // reset and a system observation is injected; a second streak
                // (recovery budget exhausted) terminates as before.
                if (this.maxStallRecoveries > 0 && state.useStallRecovery(this.maxStallRecoveries)) {
                    await this.emit(sessionId, "retry.stallRecovery", {
                        streak,
                        allowed: this.maxRepeatedIdenticalToolCalls,
                        remaining: this.maxStallRecoveries,
                    }, turnId);
                    state.resetToolStreak();
                    await this.store.appendMessage({
                        id: newMessageId(),
                        sessionId,
                        turnId,
                        role: "system",
                        content: `[stall recovery — the identical tool call "${call.name}" was repeated ${streak} times without progress]\n` +
                            "The call keeps returning the same result. Try a different approach or stop repeating it.",
                        createdAt: this.now(),
                    });
                    continue;
                }
                await this.emit(sessionId, "run.limit_reached", { limit: "maxRepeatedToolCalls", used: streak, allowed: this.maxRepeatedIdenticalToolCalls }, turnId);
                return { action: "finish", outcome: await this.recoveryController.finishTurn(ctx, "failed", state, working, errorInfo("RESOURCE_LIMIT", `maxRepeatedToolCalls (${this.maxRepeatedIdenticalToolCalls}) reached: repeated identical call ${call.name}`), "tool_limit", toolLedger) };
            }
            // P2-41: broader stall PATTERNS beyond the identical-call gate. The
            // pure window classifier reports a specific pattern when the recent
            // executions show no progress; if that pattern is enabled we treat it
            // exactly like the identical gate: bounded recovery (inject a system
            // observation, clear the window) then terminate.
            const stallPattern = state.stallPattern();
            if (stallPattern !== null &&
                this.enabledStallPatterns.has(stallPattern)) {
                if (this.maxPatternStallRecoveries > 0 && state.useStallRecovery(this.maxPatternStallRecoveries + this.maxStallRecoveries)) {
                    await this.emit(sessionId, "retry.stallRecovery", {
                        pattern: stallPattern,
                        allowed: STALL_WINDOW_SIZE,
                        remaining: this.maxPatternStallRecoveries,
                    }, turnId);
                    state.clearStallWindow();
                    await this.store.appendMessage({
                        id: newMessageId(),
                        sessionId,
                        turnId,
                        role: "system",
                        content: `[stall recovery — detected "${stallPattern}" (repeated tool work without progress)]\n` +
                            "Try a different approach or stop repeating the same work.",
                        createdAt: this.now(),
                    });
                    continue;
                }
                await this.emit(sessionId, "run.limit_reached", { limit: "stallPattern", used: 1, allowed: this.maxPatternStallRecoveries, pattern: stallPattern }, turnId);
                return { action: "finish", outcome: await this.recoveryController.finishTurn(ctx, "failed", state, working, errorInfo("RESOURCE_LIMIT", `stall pattern detected: ${stallPattern}`), "tool_limit", toolLedger) };
            }
            if (agent.limits.maxToolCalls !== undefined) {
                const breach = budget.onToolCall();
                if (breach !== undefined) {
                    await this.emit(sessionId, "run.limit_reached", { ...breach }, turnId);
                    return { action: "finish", outcome: await this.recoveryController.finishTurn(ctx, "failed", state, working, errorInfo("RESOURCE_LIMIT", `maxToolCalls (${agent.limits.maxToolCalls}) reached`), "tool_limit", toolLedger) };
                }
            }
        }
        // P2-37: a user interrupt arrived during the tool batch. Side effects
        // that already COMMITTED (recorded above into the durable ledger,
        // working state and transcript) are KEPT and reported on the cancelled
        // outcome — cancel is not a rollback. Remaining calls were not run.
        if (signal.aborted) {
            return { action: "finish", outcome: await this.recoveryController.finishTurn(ctx, "cancelled", state, working, undefined, "cancelled", toolLedger) };
        }
        return { action: "done" };
    }
    /**
     * P2-43 — submit a user's reply to a pending ask and resume the turn. This
     * is the "resume after reply" boundary. It records the answer (store
     * markAnswered when configured, else in-memory), injects the reply as a
     * user message tagged with the ask id (exactly-once: a transcript message
     * carrying askId proves it was already injected — P2-36 pattern), emits
     * ask.user_replied, and returns the resumable prompt. The host then calls
     * runTurn() again (seeded with the reply) to continue.
     */
    async submitUserAnswer(sessionId, turnId, askId, text) {
        const pending = (this.askUserStore !== undefined
            ? await this.askUserStore.get(askId)
            : undefined) ?? {
            id: askId,
            sessionId,
            turnId,
            reason: "missing_critical_input",
            question: this.askUserLifecycle.fingerprint({ id: askId, sessionId, turnId, reason: "missing_critical_input", question: "", status: "pending", createdAt: this.now() }),
            status: "pending",
            createdAt: this.now(),
        };
        // Exactly-once resume injection: if a prior submitUserAnswer already
        // appended the resumed message for this ask, a duplicate submission is an
        // IDEMPOTENT success (not an error) — we return resumed:true so a host that
        // retries an answer (e.g. after a crash between our reply and its ack) does
        // not treat the recovery as a failure, and we never append a second message.
        const history = await this.store.listMessages(sessionId);
        if (history.some((m) => m.askId === askId)) {
            return { resumed: true, message: `already resumed for ask ${askId}` };
        }
        if (!this.askUserLifecycle.isPending(pending)) {
            return { resumed: false, message: `ask ${askId} is not pending` };
        }
        const reply = { requestId: askId, text, answeredAt: this.now() };
        if (this.askUserStore !== undefined) {
            await this.askUserStore.markAnswered(askId, reply);
        }
        const prompt = this.askUserLifecycle.resumePrompt(reply);
        await this.store.appendMessage({
            id: newMessageId(),
            sessionId,
            turnId,
            role: "user",
            content: prompt.content,
            askId,
            createdAt: this.now(),
        });
        await this.emit(sessionId, "ask.user_replied", {
            askId,
            turnId,
            text,
        }, turnId);
        return { resumed: true, message: `resumed turn ${turnId} with reply` };
    }
    /** P1-4: restore an interrupted session from its most recent durable
     *  checkpoint and continue the task. Resume is NOT a replay of the old
     *  transcript: the model receives the checkpoint working state plus what
     *  happened AFTER the checkpoint (completed side effects that must not be
     *  replayed, and started-but-unconfirmed tools that need reconciliation),
     *  then the normal loop continues in a fresh turn seeded from that state.
     *
     *  Throws RESUME_FAILED when no usable checkpoint exists or no agent can be
     *  resolved for the session (fail-closed: we never invent a recovery we
     *  cannot back with durable state). */
    async resumeTurn(sessionId, signal) {
        const session = await this.store.getSession(sessionId);
        if (!session)
            throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown session ${sessionId}`));
        const agent = await this.resolveAgent(session);
        if (this.checkpointStore === undefined) {
            throw new AgentError(errorInfo("RESUME_FAILED", `session ${sessionId} has no checkpoint store — cannot resume safely`));
        }
        const checkpoint = await this.checkpointStore.loadLatest(sessionId);
        if (checkpoint === undefined) {
            throw new AgentError(errorInfo("RESUME_FAILED", `session ${sessionId} has no durable checkpoint — refusing to resume`));
        }
        const turnId = checkpoint.turnId;
        const { working, committedSideEffects, unresolvedTools, replayedEventCount } = await this.recoveryController.reconstructResumeState(sessionId, turnId, checkpoint);
        // P2-40: each started-but-unconfirmed tool that must be reconciled is its
        // own reconciliation retry-kind event. Reconciliation is never auto-redone
        // (spec maxAttempts 0) — we only surface the fact so the taxonomy/report can
        // hold the runtime to that promise.
        for (const unresolved of unresolvedTools) {
            await this.emit(sessionId, "retry.reconciliation", {
                toolCallId: unresolved.toolCallId,
                tool: unresolved.tool,
                sideEffect: unresolved.sideEffect,
                started: unresolved.started,
            }, turnId);
        }
        const resumePrompt = buildResumePrompt(working, committedSideEffects, unresolvedTools);
        const turn = await this.startTurn(sessionId, resumePrompt);
        const outcome = await this.runTurn(sessionId, turn.id, signal, { initialState: working });
        await this.emit(sessionId, "session.resumed", {
            checkpointId: checkpoint.checkpointId,
            previousTurnId: turnId,
            resumedTurnId: turn.id,
            replayedEventCount,
            committedSideEffects: committedSideEffects.length,
            unresolvedTools: unresolvedTools.length,
        }, turn.id);
        return {
            sessionId,
            checkpointId: checkpoint.checkpointId,
            ...(turnId !== undefined ? { turnId } : {}),
            state: working,
            committedSideEffects,
            unresolvedTools,
            replayedEventCount,
            outcome,
        };
    }
    wallClockExceeded(agent, turn) {
        const max = agent.limits.maxDurationMs;
        if (max === undefined)
            return undefined;
        const elapsed = this.now() - turn.startedAt;
        return elapsed > max ? elapsed : undefined;
    }
    /** P1-11: execution semantics of a tool — injected lookup first, then the
     *  built-in registry, then the conservative default. Never name-matched. */
    semanticsOf(name) {
        return this.toolSemanticsOf?.(name) ?? DEFAULT_RUNTIME_TOOL_SEMANTICS[name] ?? DEFAULT_TOOL_SEMANTICS;
    }
    getAgent(agentId) {
        return this.agents.get(agentId);
    }
    /**
     * P0-1: resolve the effective agent for a session.
     *
     * - Sessions created by this runtime version carry a persisted
     *   EffectiveAgentConfig snapshot; runTurn honors it, so delegation
     *   restrictions survive resume and registry changes can never widen a
     *   running session.
     * - Legacy sessions (no snapshot) fall back to the registry definition,
     *   preserving pre-P0-1 behavior. This is the only base-agent fallback
     *   path; a present-but-corrupt/mismatched snapshot fails closed instead.
     */
    async resolveAgent(session) {
        const snapshot = await this.store.loadStateSnapshot(session.id);
        if (snapshot === undefined) {
            const base = this.agents.get(session.agentId);
            if (!base)
                throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown agent ${session.agentId}`));
            return base;
        }
        const cfg = snapshot[EFFECTIVE_AGENT_SNAPSHOT_KEY];
        if (!isEffectiveAgentConfig(cfg)) {
            throw new AgentError(errorInfo("INTERNAL_ERROR", `session ${session.id} has a corrupt effective-agent snapshot: refusing to run against the base agent`));
        }
        if (cfg.agentId !== session.agentId) {
            throw new AgentError(errorInfo("INTERNAL_ERROR", `session ${session.id} effective-agent snapshot agentId ${cfg.agentId} does not match session agentId ${session.agentId}`));
        }
        // P1-6: safe-resume gate — detect host policy drift since the session was
        // created. Never silently change security semantics: the change is
        // observable on the event stream so a strict host can refuse to resume.
        const runtimePolicy = snapshot[RUNTIME_POLICY_SNAPSHOT_KEY];
        if (runtimePolicy?.version === 1 && this.context !== undefined) {
            const currentContextHash = stableHashOf(this.context);
            if (runtimePolicy.contextPolicyHash !== undefined && runtimePolicy.contextPolicyHash !== currentContextHash) {
                await this.emit(session.id, "policy.changed_on_resume", {
                    contextPolicyChanged: true,
                    contextPolicyHash: currentContextHash,
                    stored: runtimePolicy.contextPolicyHash,
                }, undefined);
            }
        }
        // Metadata (name/description/mode) is cosmetic and not part of the
        // security boundary; fall back to the registry when available.
        const meta = this.agents.get(session.agentId);
        return {
            id: cfg.agentId,
            name: meta?.name ?? cfg.agentId,
            description: meta?.description ?? "",
            mode: meta?.mode ?? "primary",
            model: cfg.model,
            systemPrompt: cfg.systemPrompt,
            tools: cfg.tools,
            permissions: cfg.permissions,
            skills: cfg.skills,
            limits: cfg.limits,
        };
    }
}
// Q-1: below are re-exports of pure helpers now living in ./turn-helpers.js.
// Public API preserved: renderToolResult/buildResumePrompt are re-exported
// so `export * from ./runtime.js` in index.ts stays stable.
export { renderToolResult, buildResumePrompt };
//# sourceMappingURL=runtime.js.map