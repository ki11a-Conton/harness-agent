import type {
  AgentDefinition,
  AgentEvent,
  AgentId,
  ContextBlock,
  DeclaredCapability,
  DelegationLimits,
  EventSink,
  EventStore,
  Evidence,
  NonFatalErrorSink,
  Session,
  SessionId,
  SessionStore,
  Timer,
  ToolPolicy,
} from "@ar/contracts";
import {
  AgentError,
  CAPABILITY_DIMENSIONS,
  DEFAULT_DELEGATION_LIMITS,
  RealTimer,
  errorInfo,
  newEventId,
  newMessageId,
  resolveChildLimits,
  stderrErrorSink,
} from "@ar/contracts";
import type { AgentRuntime, TurnOutcome } from "@ar/core";
import { composeBoundaryCapability } from "@ar/security";
import type { GrantedCapability } from "@ar/security";
import { detectPromptInjection } from "@ar/security";
import type {
  ChangedArtifactRef,
  DelegationRequest,
  DelegationResult,
  SubagentFinding,
  TestRunRef,
} from "./delegation.js";
import { AgentExecutionScheduler, type SchedulerToken } from "./scheduler.js";
import type { ChildWorkspaceHandle, ChildWorkspaceManager } from "./workspace-isolation.js";

const SUMMARY_MAX_CHARS = 2000;
const EVIDENCE_DESC_MAX_CHARS = 200;

/** Windows drive path or slash-separated path ending in a file extension. */
const ARTIFACT_RE =
  /(?:[A-Za-z]:[\\/][^\s"'`]+|(?:\.{0,2}[\\/])?[\w.-]+(?:[\\/][\w.-]+)+\.\w+)/g;

export interface DelegatorDeps {
  runtime: AgentRuntime;
  /** Session store used to read the parent session and enforce INV-009 bounds. */
  store: SessionStore;
  /** Default agent for child sessions when DelegationRequest.agentId is absent. */
  agentId: AgentId;
  limits?: Partial<DelegationLimits>;
  /** Event store for subagent.* events. AgentRuntime does not expose its
   *  EventStore, so delegation events are emitted through this dependency. */
  events?: EventStore;
  /** P1-6: global scheduler. When set, every delegation acquires a scheduling
   *  slot before its child session is created (queueing/fairness/global
   *  concurrency/depth/wall-clock) and releases it when the child turn ends. */
  scheduler?: AgentExecutionScheduler;
  now?: () => number;
  /** P1-7: injectable timer for delegation timeouts (deterministic tests). */
  timer?: Timer;
  /** P3-4: child workspace isolation. When set, `writable:true` delegations
   *  run the child in an isolated copy and return a workspacePatch (P3-5);
   *  without it, writable delegations are denied (P14-3 fail-closed). */
  workspaceManager?: ChildWorkspaceManager;
  /** P14-3: test-only escape hatch — when true, writable delegations without
   *  a workspaceManager fall back to the shared parent root (same as the
   *  pre-P14-3 behavior). NEVER set in production config; only useful for
   *  tests that do not care about workspace isolation. */
  testOnlyUnsafeSharedWorkspace?: boolean;
  /** P3-6: called when a child's isolated workspace root is created, so the
   *  host can admit that root into the child session's sandbox (the child
   *  must be able to write its own workspace). */
  onChildWorkspace?: (childSessionId: SessionId, root: string) => void;
  /** P3-6: called when the child's isolated workspace is disposed, so the
   *  host can remove the root from the sandbox allow-list. */
  onChildWorkspaceDisposed?: (childSessionId: SessionId) => void;
  /** P14-4: the parent's conferred capability (upper bound). A delegation
   *  that declares a non-tool capability is verified against this grant —
   *  the child may only narrow it. Absent this grant, ANY non-tool declared
   *  capability is denied (an unknown upper bound cannot prove narrowing). */
  parentCapability?: GrantedCapability;
  /** P14-6: typed channel for non-fatal failures (workspace cleanup /
   *  patch-extraction). Defaults to a stderr sink so reports stay observable. */
  nonFatal?: NonFatalErrorSink;
}

type RaceSettle =
  | { kind: "outcome"; outcome: TurnOutcome }
  | { kind: "cancel" }
  | { kind: "timeout" };

/**
 * SUBAGENT-001: spawns an isolated child session (INV-005) under the bounded
 * recursion guarantees of INV-009, then returns a structured result (§57).
 *
 * Pre-flight rejections (unknown parent/agent, limits breached) throw an
 * AgentError: no child session exists yet, so no DelegationResult can be
 * produced. Once the child session exists, failures return a structured
 * DelegationResult with a real childSessionId.
 */
export class Delegator {
  private readonly runtime: AgentRuntime;
  private readonly store: SessionStore;
  private readonly agentId: AgentId;
  private readonly limits: DelegationLimits;
  private readonly events?: EventStore;
  private readonly scheduler?: AgentExecutionScheduler;
  private readonly now: () => number;
  private readonly timer: Timer;
  private readonly workspaceManager?: ChildWorkspaceManager;
  private readonly testOnlyUnsafeSharedWorkspace: boolean;
  private readonly parentCapability?: GrantedCapability;
  private readonly nonFatal: NonFatalErrorSink;
  private readonly onChildWorkspace?: (childSessionId: SessionId, root: string) => void;
  private readonly onChildWorkspaceDisposed?: (childSessionId: SessionId) => void;

  constructor(deps: DelegatorDeps) {
    this.runtime = deps.runtime;
    this.store = deps.store;
    this.agentId = deps.agentId;
    this.limits = { ...DEFAULT_DELEGATION_LIMITS, ...deps.limits };
    this.events = deps.events;
    this.scheduler = deps.scheduler;
    this.now = deps.now ?? Date.now;
    this.timer = deps.timer ?? new RealTimer(this.now);
    this.workspaceManager = deps.workspaceManager;
    this.testOnlyUnsafeSharedWorkspace = deps.testOnlyUnsafeSharedWorkspace ?? false;
    this.parentCapability = deps.parentCapability;
    this.nonFatal = deps.nonFatal ?? stderrErrorSink("delegator");
    this.onChildWorkspace = deps.onChildWorkspace;
    this.onChildWorkspaceDisposed = deps.onChildWorkspaceDisposed;
  }

  async delegate(req: DelegationRequest, signal: AbortSignal): Promise<DelegationResult> {
    const limits: DelegationLimits = { ...this.limits, ...req.limits };
    const parent = await this.requireSession(req.parentSessionId);
    await this.enforceBounds(parent, limits);

    // P14-3: a writable delegation REQUIRES workspace isolation — fail-closed.
    // There is no implicit shared-write fallback to the parent root in
    // production; the only escape hatch is the explicitly test-only
    // testOnlyUnsafeSharedWorkspace flag. Denied before any child session or
    // scheduler slot exists, so no child can execute any tool.
    if (req.writable === true) {
      const isolationError = writableIsolationError({
        workspaceManager: this.workspaceManager,
        testOnlyUnsafeSharedWorkspace: this.testOnlyUnsafeSharedWorkspace,
      });
      if (isolationError !== undefined) {
        await this.emit(parent.id, "security.permission_denied", {
          reason: isolationError.info.message,
          code: "SECURITY_DENIED",
        });
        throw isolationError;
      }
    }

    // P14-4 child-agent boundary: a declared non-tool capability must NARROW
    // the parent grant (EffectiveCapability = Conferred ∩ Declared). Without a
    // parent grant, an unknown upper bound cannot prove narrowing — any
    // declaration is denied fail-closed. The tool dimension stays governed by
    // req.toolPolicy (restrictToolPolicy intersection) and is rejected here to
    // keep ONE source of truth for the tool surface. Denied before any child
    // session / scheduler slot exists.
    if (req.capability !== undefined) {
      const nonTool = Object.fromEntries(
        CAPABILITY_DIMENSIONS.filter((dim) => dim !== "tool").map((dim) => [dim, req.capability![dim]]),
      ) as DeclaredCapability;
      const declaredNonTool = Object.fromEntries(
        Object.entries(nonTool).filter(([, v]) => v !== undefined),
      ) as DeclaredCapability;
      if (Object.keys(declaredNonTool).length > 0) {
        if (this.parentCapability === undefined) {
          const error = errorInfo(
            "SECURITY_DENIED",
            "child-agent boundary denied: no parent capability grant configured; cannot verify declared capability is a narrowing",
          );
          await this.emit(parent.id, "security.capability_denied", {
            reason: error.message,
            source: "delegator",
            code: "SECURITY_DENIED",
          });
          throw new AgentError(error);
        }
        await composeBoundaryCapability("child-agent", this.parentCapability, declaredNonTool, {
          events: this.events !== undefined ? sinkOf(this.events, this.now) : undefined,
          sessionId: parent.id,
          source: "delegator",
        });
      }
      if (req.capability.tool !== undefined) {
        const error = errorInfo(
          "SECURITY_DENIED",
          "child-agent capability.tool is not a separate surface: narrow tools via toolPolicy",
        );
        await this.emit(parent.id, "security.capability_denied", {
          reason: error.message,
          source: "delegator",
          code: "SECURITY_DENIED",
        });
        throw new AgentError(error);
      }
    }

    // P1-6/P1-7: global scheduling before any child session exists. A request
    // that must WAIT queues (fairness); cancelling it while queued throws
    // here, so no child session is ever created for it. The optional tool
    // budget (DelegationLimits.maxToolCalls) is pre-reserved from the root
    // tree pool and refunded on release.
    const agentId = req.agentId ?? this.agentId;
    let token: SchedulerToken | undefined;
    if (this.scheduler !== undefined) {
      token = await this.scheduler.acquire(
        { parentSessionId: parent.id, agentId, ...(limits.maxToolCalls !== undefined ? { toolBudget: limits.maxToolCalls } : {}) },
        signal,
      );
    }

    const base = this.runtime.getAgent(agentId);
    if (base === undefined) {
      token?.release();
      throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown agent ${agentId}: cannot delegate`));
    }
    const childAgent: AgentDefinition =
      req.toolPolicy === undefined ? base : { ...base, tools: restrictToolPolicy(base.tools, req.toolPolicy) };

    // P1-10: a dead-on-arrival signal must not leave an orphan child session
    // behind — short-circuit before the session is created.
    if (signal.aborted) {
      token?.release();
      return {
        status: "cancelled",
        summary: "delegation cancelled before the child session was created",
        childSessionId: "" as SessionId,
        toolCalls: 0,
        durationMs: 0,
        evidence: [],
        artifacts: [],
        answer: "",
        findings: [],
        changedArtifacts: [],
        testsRun: [],
        openQuestions: [],
        blockers: [],
        suggestedNextActions: [],
        budgetUsed: { toolCalls: 0, durationMs: 0 },
        verified: false,
      };
    }

    let child: Session;
    try {
      child = await this.runtime.createSession({
        agent: childAgent,
        cwd: parent.cwd,
        parentId: parent.id,
      });
    } catch (err) {
      token?.release();
      throw new AgentError(errorInfo("INTERNAL_ERROR", `failed to create child session: ${describe(err)}`, { cause: err }));
    }
    // P3-10: attribute the child's per-call usage to its tree root.
    if (this.scheduler !== undefined && token !== undefined) {
      this.scheduler.bindSession(child.id, token.rootSessionId);
    }

    // P3-4: a write-capable child runs in an isolated workspace copy — never
    // the parent root directly. The child session's cwd is repointed to the
    // isolated root before any turn starts (no turn has run yet, so this is
    // safe); its changes return as a workspacePatch (P3-5).
    let workspace: ChildWorkspaceHandle | undefined;
    if (req.writable === true && this.workspaceManager !== undefined) {
      try {
        workspace = await this.workspaceManager.create({
          parentRoot: parent.cwd,
          childSessionId: child.id,
          writable: true,
        });
        await this.store.updateSession({ ...child, cwd: workspace.root });
        // P3-6: admit the isolated root into the child session's sandbox so
        // its own workspace is writable (and nothing outside it is).
        this.onChildWorkspace?.(child.id, workspace.root);
      } catch (err) {
        // P14-3: failed isolation must not leave a live orphan — the never-run
        // child session is marked cancelled (best-effort; the isolation failure
        // is the error surfaced) and the scheduler session binding is dropped
        // before the slot releases, so no token/root accounting leaks.
        try {
          await this.store.updateSession({ ...child, status: "cancelled" });
        } catch (cleanupErr) {
          // P14-6: store cleanup must not mask the isolation failure — but it
          // is reported on the non-fatal channel, never silent.
          this.nonFatal.report("delegator.cleanup:mark-cancelled", cleanupErr);
        }
        this.scheduler?.unbindSession(child.id);
        token?.release();
        throw new AgentError(
          errorInfo("INTERNAL_ERROR", `failed to isolate child workspace: ${describe(err)}`, { cause: err }),
        );
      }
    }

    await this.seedContext(child.id, req.context);
    await this.emit(parent.id, "subagent.started", {
      childSessionId: child.id,
      agentId,
      goal: req.goal,
      timeoutMs: limits.timeoutMs,
    });

    const startedAt = this.now();
    const internal = new AbortController();
    const onCallerAbort = () => internal.abort();
    if (signal.aborted) internal.abort();
    else signal.addEventListener("abort", onCallerAbort, { once: true });
    // P1-6: the scheduler's wall-clock / subtree cancellation aborts the same
    // internal controller, so a scheduler cancel lands as a turn.cancelled.
    let onTokenAbort: (() => void) | undefined;
    if (token !== undefined) {
      onTokenAbort = () => internal.abort();
      token.signal.addEventListener("abort", onTokenAbort, { once: true });
    }
    let timedOut = false;
    const timerHandle =
      limits.timeoutMs > 0
        ? this.timer.schedule(() => {
            timedOut = true;
            internal.abort();
          }, limits.timeoutMs)
        : undefined;

    let result: DelegationResult | undefined;
    try {
      const turn = await this.runtime.startTurn(child.id, req.goal);
      const run = this.runtime.runTurn(child.id, turn.id, internal.signal);
      const settled = await Promise.race<RaceSettle>([
        run.then((outcome) => ({ kind: "outcome" as const, outcome })),
        cancelWaiter(signal).then(() => ({ kind: "cancel" as const })),
        ...(limits.timeoutMs > 0
          ? [timeoutWaiter(this.timer, limits.timeoutMs).then(() => ({ kind: "timeout" as const }))]
          : []),
      ]);
      result = await this.settleToResult(child.id, settled, startedAt, limits.timeoutMs, timedOut);
    } catch (err) {
      result = {
        status: "failed",
        summary: `delegation failed: ${describe(err)}`,
        childSessionId: child.id,
        toolCalls: 0,
        durationMs: this.now() - startedAt,
        evidence: [],
        artifacts: [],
        error: describe(err),
        answer: "",
        findings: [],
        changedArtifacts: [],
        testsRun: [],
        openQuestions: [],
        blockers: [describe(err)],
        suggestedNextActions: [],
        budgetUsed: { toolCalls: 0, durationMs: this.now() - startedAt },
        verified: false,
      };
    } finally {
      if (timerHandle !== undefined) timerHandle.cancel();
      signal.removeEventListener("abort", onCallerAbort);
      // P3-10: stop attributing the child session to its root.
      if (this.scheduler !== undefined) this.scheduler.unbindSession(child.id);
      if (token !== undefined && onTokenAbort !== undefined) {
        token.signal.removeEventListener("abort", onTokenAbort);
        // P1-7: report actual tool-call usage so the tree budget can refund
        // the unused allocation.
        token.release(result?.toolCalls ?? 0);
      }
      // P3-4/P3-5: a successful isolated child hands its workspace diff to
      // the parent; the scratch copy is always disposed (also on failure).
      if (workspace !== undefined) {
        try {
          if (result !== undefined && result.status === "success" && workspace.mode === "isolated-copy") {
            result.workspacePatch = await workspace.diff();
          }
        } catch (diffErr) {
          // P14-6: patch extraction must never break the delegation result —
          // but the failure is reported, never silent.
          this.nonFatal.report("delegator.cleanup:workspace.diff", diffErr);
        }
        try {
          await workspace.dispose();
        } catch (disposeErr) {
          // P14-6: cleanup failure is non-fatal — reported, never silent.
          this.nonFatal.report("delegator.cleanup:workspace.dispose", disposeErr);
        }
        this.onChildWorkspaceDisposed?.(child.id);
      }
    }

    await this.emitFinished(parent.id, child.id, result);
    return result;
  }

  private async requireSession(sessionId: SessionId): Promise<Session> {
    const session = await this.store.getSession(sessionId);
    if (session === undefined) {
      throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown parent session ${sessionId}`));
    }
    return session;
  }

  /** INV-009: reject before creating any child when recursion bounds are hit.
   *  P3-3: the historical `maxChildren` is the backward-compatible alias of
   *  `maxChildrenTotal`; `maxActiveChildren` additionally caps concurrent
   *  ACTIVE children (running/waiting turns) — completed children never
   *  occupy an active slot, so a long-lived parent is never permanently
   *  exhausted by its own history. */
  private async enforceBounds(parent: Session, limits: DelegationLimits): Promise<void> {
    if (limits.maxDepth === 0) {
      throw this.boundError("leaf agent (maxDepth=0) cannot delegate");
    }
    const childCaps = resolveChildLimits(limits);
    if (childCaps.total === 0) {
      throw this.boundError("delegation disabled (maxChildren=0)");
    }
    const depth = await this.depthOf(parent.id);
    if (depth >= limits.maxDepth) {
      throw this.boundError(`max delegation depth ${limits.maxDepth} reached (current depth ${depth})`);
    }
    const children = await this.store.listSessions({ parentId: parent.id });
    if (children.length >= childCaps.total) {
      throw this.boundError(`max children ${childCaps.total} reached (current ${children.length})`);
    }
    if (childCaps.active !== undefined && childCaps.active > 0) {
      const activeChildren = await this.countActiveChildren(children);
      if (activeChildren >= childCaps.active) {
        throw this.boundError(
          `max active children ${childCaps.active} reached (current ${activeChildren} running/waiting)`,
        );
      }
    }
  }

  /** P3-3: a child is ACTIVE while its latest turn is still running or
   *  waiting (for user/approval); a session with no turn yet (just created,
   *  delegation about to start it) counts as active too. Sessions whose
   *  latest turn reached a terminal state are done and free their slot. */
  private async countActiveChildren(children: Session[]): Promise<number> {
    let active = 0;
    for (const child of children) {
      const turns = await this.store.listTurns(child.id);
      const latest = turns.length > 0 ? turns[turns.length - 1] : undefined;
      if (
        latest === undefined ||
        latest.status === "running" ||
        latest.status === "waiting_for_user" ||
        latest.status === "waiting_for_approval"
      ) {
        active += 1;
      }
    }
    return active;
  }

  private boundError(message: string): AgentError {
    return new AgentError(errorInfo("RESOURCE_LIMIT", message));
  }

  private async depthOf(sessionId: SessionId): Promise<number> {
    let depth = 0;
    let session = await this.store.getSession(sessionId);
    while (session?.parentId !== undefined) {
      depth += 1;
      session = await this.store.getSession(session.parentId);
    }
    return depth;
  }

  /** INV-005: the child carries only the injected context — never parent history.
   *  P0-8: low-trust blocks (untrusted/semi-trusted) are scanned for prompt
   *  injection before being seeded into the child; a hit is dropped and
   *  reported through the security event store when one is configured. */
  private async seedContext(childId: SessionId, blocks: ContextBlock[] | undefined): Promise<void> {
    if (blocks === undefined || blocks.length === 0) return;
    for (const block of blocks) {
      if (block.trust !== "trusted") {
        const report = detectPromptInjection(block.content);
        if (report.hasInjection) {
          await this.emit(childId, "security.injection_denied", {
            source: "subagent",
            target: block.id,
            reasons: report.reasons,
            code: "SECURITY_DENIED",
          });
          continue;
        }
      }
      await this.store.appendMessage({
        id: newMessageId(),
        sessionId: childId,
        role: "system",
        content: block.content,
        createdAt: this.now(),
      });
    }
  }

  private async settleToResult(
    childId: SessionId,
    settled: RaceSettle,
    startedAt: number,
    timeoutMs: number,
    timedOut: boolean,
  ): Promise<DelegationResult> {
    const outcome = settled.kind === "outcome" ? settled.outcome : undefined;
    let status: DelegationResult["status"];
    if (settled.kind === "timeout" || (settled.kind === "outcome" && timedOut)) {
      status = "timeout";
    } else if (settled.kind === "cancel") {
      status = "cancelled";
    } else if (outcome!.status === "completed") {
      status = "success";
    } else if (outcome!.status === "failed") {
      status = "failed";
    } else {
      status = "cancelled";
    }

    const base = {
      childSessionId: childId,
      toolCalls: outcome?.toolCalls ?? 0,
      durationMs: this.now() - startedAt,
      evidence: await this.collectEvidence(childId),
      artifacts: await this.collectArtifacts(childId),
      // P1-1: hand the child's working state to the parent unchanged — the
      // parent folds it into its own state instead of reconstructing a
      // parallel summary from the transcript.
      ...(outcome?.state !== undefined ? { workingState: outcome.state } : {}),
      // P1-8: structured completion protocol. Every field is derived from
      // real persisted state (working state + verification events + tool
      // result messages) — never from the transcript regex on its own.
      answer: await this.answerOf(childId, outcome),
      findings: await this.collectFindings(childId),
      changedArtifacts: await this.collectChangedArtifacts(childId, outcome),
      testsRun: await this.collectTestRuns(childId, outcome),
      openQuestions: outcome?.state?.openQuestions ?? [],
      blockers: await this.collectBlockers(childId, outcome),
      suggestedNextActions: outcome?.state?.pending ?? [],
      budgetUsed: {
        toolCalls: outcome?.toolCalls ?? 0,
        durationMs: this.now() - startedAt,
      },
      verified: outcome?.terminationReason === "verified_complete",
    };

    if (status === "success") {
      return { status, summary: await this.summarize(childId, outcome!), ...base };
    }
    if (status === "timeout") {
      return { status, summary: `delegation timed out after ${timeoutMs}ms`, error: `timeout after ${timeoutMs}ms`, ...base };
    }
    if (status === "cancelled") {
      return { status, summary: "delegation cancelled", ...base };
    }
    const error = outcome?.error?.message ?? "turn failed";
    return { status, summary: `delegation failed: ${error}`, error, ...base };
  }

  /** Summary from the final assistant message; falls back to the outcome. */
  private async summarize(childId: SessionId, outcome: TurnOutcome): Promise<string> {
    const messages = await this.store.listMessages(childId);
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role === "assistant" && message.content.length > 0) {
        return truncate(message.content, SUMMARY_MAX_CHARS);
      }
    }
    return `turn ${outcome.status}`;
  }

  /** Evidence from verification-gate events and persisted tool results. */
  private async collectEvidence(childId: SessionId): Promise<Evidence[]> {
    const evidence: Evidence[] = [];
    if (this.events !== undefined) {
      for (const event of await this.events.list(childId)) {
        if (event.type === "verification.completed") {
          evidence.push({
            type: "review",
            description: "verification passed",
            source: "verification.completed",
            timestamp: event.timestamp,
          });
        } else if (event.type === "verification.failed") {
          const reason = typeof event.payload.error === "string" ? event.payload.error : "failed";
          evidence.push({
            type: "review",
            description: `verification failed: ${reason}`,
            source: "verification.failed",
            timestamp: event.timestamp,
          });
        }
      }
    }
    const messages = await this.store.listMessages(childId);
    for (const message of messages) {
      if (message.role === "tool") {
        evidence.push({
          type: "review",
          description: `tool result: ${truncate(message.content, EVIDENCE_DESC_MAX_CHARS)}`,
          source: `message:${message.id}`,
          timestamp: message.createdAt,
        });
      }
    }
    return evidence;
  }

  /** Path-like tokens extracted from tool outputs. */
  private async collectArtifacts(childId: SessionId): Promise<string[]> {
    const artifacts = new Set<string>();
    const messages = await this.store.listMessages(childId);
    for (const message of messages) {
      if (message.role !== "tool") continue;
      for (const match of message.content.matchAll(ARTIFACT_RE)) {
        artifacts.add(match[0]);
      }
    }
    return [...artifacts];
  }

  /** P1-8: verification-gate events of the child, with their stable refs. */
  private async collectVerificationEvents(childId: SessionId): Promise<
    Array<{ id: string; passed: boolean; reason?: string; timestamp: number }>
  > {
    const events: Array<{ id: string; passed: boolean; reason?: string; timestamp: number }> = [];
    if (this.events === undefined) return events;
    for (const event of await this.events.list(childId)) {
      if (event.type === "verification.completed") {
        events.push({ id: event.id, passed: true, timestamp: event.timestamp });
      } else if (event.type === "verification.failed") {
        events.push({
          id: event.id,
          passed: false,
          reason: typeof event.payload.error === "string" ? event.payload.error : "verification failed",
          timestamp: event.timestamp,
        });
      }
    }
    return events;
  }

  /** P1-8: the child's final answer, verbatim from the final assistant
   *  message (truncated). Not a paraphrase: the parent can quote it. */
  private async answerOf(childId: SessionId, outcome: TurnOutcome | undefined): Promise<string> {
    const messages = await this.store.listMessages(childId);
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role === "assistant" && message.content.length > 0) {
        return truncate(message.content, SUMMARY_MAX_CHARS);
      }
    }
    return `turn ${outcome?.status ?? "unknown"}`;
  }

  /** P1-8: findings are derived from the child's verification-gate events —
   *  claim + stable event refs + confidence. No verification, no fabricated
   *  findings. */
  private async collectFindings(childId: SessionId): Promise<SubagentFinding[]> {
    const verification = await this.collectVerificationEvents(childId);
    return verification.map((event) => ({
      claim:
        event.passed ? "verification passed" : `verification failed: ${event.reason ?? "unknown"}`,
      evidenceRefs: [`event:${event.id}`],
      confidence: (event.passed ? "high" : "low") as SubagentFinding["confidence"],
    }));
  }

  /** P1-8: real changed artifacts — the working state is the authoritative
   *  source; each path is linked to the tool result message that produced it
   *  so the parent can open the original result. */
  private async collectChangedArtifacts(
    childId: SessionId,
    outcome: TurnOutcome | undefined,
  ): Promise<ChangedArtifactRef[]> {
    const state = outcome?.state;
    const paths = new Set<string>();
    if (state !== undefined) {
      for (const path of state.filesChanged) paths.add(path);
      for (const path of state.artifactRefs) paths.add(path);
    }
    if (paths.size === 0) return [];
    const messages = await this.store.listMessages(childId);
    const changed: ChangedArtifactRef[] = [];
    for (const path of paths) {
      const source = messages.find(
        (message) => message.role === "tool" && message.content.includes(path),
      );
      changed.push({
        path,
        sourceRef: source !== undefined ? `message:${source.id}` : "working-state",
      });
    }
    return changed;
  }

  /** P1-8: tests/verification the child ran — test commands from the working
   *  state (linked to their tool result messages) plus verification-gate
   *  events (stable event refs). */
  private async collectTestRuns(
    childId: SessionId,
    outcome: TurnOutcome | undefined,
  ): Promise<TestRunRef[]> {
    const runs: TestRunRef[] = [];
    const messages = await this.store.listMessages(childId);
    const state = outcome?.state;
    if (state !== undefined) {
      for (const command of state.testsRun) {
        const source = messages.find(
          (message) => message.role === "tool" && message.content.includes(command),
        );
        runs.push({
          description: command,
          passed: true,
          ...(source !== undefined ? { sourceRef: `message:${source.id}` } : {}),
        });
      }
    }
    for (const event of await this.collectVerificationEvents(childId)) {
      runs.push({
        description: event.passed ? "verification passed" : `verification failed: ${event.reason ?? "unknown"}`,
        passed: event.passed,
        sourceRef: `event:${event.id}`,
      });
    }
    return runs;
  }

  /** P1-8: blockers — observed working-state failures, verification failures
   *  and the turn error (when present). */
  private async collectBlockers(
    childId: SessionId,
    outcome: TurnOutcome | undefined,
  ): Promise<string[]> {
    const blockers: string[] = [];
    if (outcome?.state !== undefined) {
      blockers.push(...outcome.state.failures);
    }
    for (const event of await this.collectVerificationEvents(childId)) {
      if (!event.passed) blockers.push(`verification failed: ${event.reason ?? "unknown"}`);
    }
    if (outcome?.error !== undefined) blockers.push(outcome.error.message);
    return blockers;
  }

  private async emitFinished(
    parentId: SessionId,
    childId: SessionId,
    result: DelegationResult,
  ): Promise<void> {
    const payload = {
      childSessionId: childId,
      status: result.status,
      summary: result.summary,
      toolCalls: result.toolCalls,
      durationMs: result.durationMs,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
    if (result.status === "success") {
      await this.emit(parentId, "subagent.completed", payload);
    } else {
      await this.emit(parentId, "subagent.failed", payload);
    }
  }

  private async emit(
    sessionId: SessionId,
    type: AgentEvent["type"],
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (this.events === undefined) return;
    // P26-1: store-owned atomic sequence allocation (appendNew).
    await this.events.appendNew({
      id: newEventId(),
      sessionId,
      timestamp: this.now(),
      type,
      payload,
    });
  }
}

/** P14-4: adapt the delegator's EventStore to the EventSink shape so the
 *  shared boundary guard can emit security.capability_denied with the same
 *  sequence/timestamp accounting as `Delegator.emit`. */
function sinkOf(store: EventStore, now: () => number): EventSink {
  return {
    async emit(sessionId, type, payload, turnId) {
      // P26-1: store-owned atomic sequence allocation (appendNew).
      await store.appendNew({
        id: newEventId(),
        sessionId,
        ...(turnId !== undefined ? { turnId } : {}),
        timestamp: now(),
        type,
        payload,
      });
    },
  };
}

/** P14-3: writable delegation requires a ChildWorkspaceManager — fail-closed.
 *  No implicit shared-write fallback exists in production; the only escape
 *  hatch is the explicitly test-only `testOnlyUnsafeSharedWorkspace` flag.
 *  Returns the typed SECURITY_DENIED error when isolation is unavailable. */
export function writableIsolationError(deps: {
  workspaceManager: ChildWorkspaceManager | undefined;
  testOnlyUnsafeSharedWorkspace: boolean;
}): AgentError | undefined {
  if (deps.workspaceManager === undefined && !deps.testOnlyUnsafeSharedWorkspace) {
    return new AgentError(
      errorInfo(
        "SECURITY_DENIED",
        "writable delegation requires workspace isolation: no ChildWorkspaceManager configured",
      ),
    );
  }
  return undefined;
}

/** §54: the child's effective tool policy is the agent's policy restricted by
 *  the delegation request — allow-lists intersect, deny-lists union. */
export function restrictToolPolicy(base: ToolPolicy, restrict: ToolPolicy): ToolPolicy {
  const allow =
    base.allow === undefined && restrict.allow === undefined
      ? undefined
      : base.allow === undefined
        ? restrict.allow
        : restrict.allow === undefined
          ? base.allow
          : base.allow.filter((name) => restrict.allow!.includes(name));
  const deny =
    base.deny === undefined && restrict.deny === undefined
      ? undefined
      : [...new Set([...(base.deny ?? []), ...(restrict.deny ?? [])])];
  return { ...(allow !== undefined ? { allow } : {}), ...(deny !== undefined ? { deny } : {}) };
}

function cancelWaiter(signal: AbortSignal): Promise<"cancel"> {
  if (signal.aborted) return Promise.resolve("cancel" as const);
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve("cancel" as const), { once: true });
  });
}

function timeoutWaiter(timer: Timer, ms: number): Promise<"timeout"> {
  return new Promise((resolve) => {
    timer.schedule(() => resolve("timeout" as const), ms);
  });
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function describe(err: unknown): string {
  if (err instanceof AgentError) return err.info.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
