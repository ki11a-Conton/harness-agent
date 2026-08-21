/**
 * Q-1: tool-call execution extracted from runtime.ts. Owns the batch planner
 * (serial writes + bounded parallel read batches), the single-call pipeline
 * (policy gate → hooks → orchestrator → legacy/adaptive recovery → events)
 * and the stall-trace recorder. The AgentRuntime keeps the turn loop and
 * delegates here via `this.toolCallController`.
 *
 * All method bodies are byte-for-byte the ones that lived on AgentRuntime —
 * the only change is `this.<member>` → `this.deps.<member>` for the runtime
 * fields, and `emit` / `failAt` arriving as injected functions bound to the
 * runtime instance (same event sequence, same timestamps, same clock).
 * `recoveryUsage` is passed BY REFERENCE: it is the runtime-owned mutable
 * budget counter map the adaptive planner reads and writes.
 */
import { AdaptiveRecoveryPlanner, computeArgsHash, errorInfo, isToolAllowedByPolicy, newMessageId, sleep as timerSleep, } from "@ar/contracts";
import { AgentError } from "../errors.js";
import { AgentState } from "../state/agent-state.js";
import { HookRegistry } from "../lifecycle/hooks.js";
import { defaultSandboxPolicy, rethrowIfKill, RuntimeKilledError } from "./turn-helpers.js";
export class ToolCallController {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * Execute the iteration's tool calls. Consecutive concurrency-safe calls
     * (read-only, stateless — plan.md Phase 3.3) run in parallel up to
     * `maxParallelToolCalls`; everything else runs serially. Results are always
     * returned in CALL ORDER regardless of completion order, so the message
     * trail stays deterministic.
     *
     * The phase machine is single-threaded by design: the tool_pending
     * transition happens once per batch (or per serial call), and the
     * observing → thinking transitions run in the caller's results loop.
     */
    async executeToolCalls(ctx, state, calls, 
    /** P9-1: the model call that requested these tool calls (parent span). */
    parentCallId) {
        const { signal } = ctx;
        const executed = [];
        let i = 0;
        while (i < calls.length) {
            if (signal.aborted)
                break; // P2-37: stop the batch on a user interrupt.
            const call = calls[i];
            const safe = this.deps.toolCapabilityOf(call.name).concurrencySafe;
            if (safe && this.deps.maxParallelToolCalls > 1 && i + 1 < calls.length) {
                const batch = [call];
                let j = i + 1;
                while (j < calls.length &&
                    batch.length < this.deps.maxParallelToolCalls &&
                    this.deps.toolCapabilityOf(calls[j].name).concurrencySafe) {
                    batch.push(calls[j]);
                    j += 1;
                }
                state.transition("tool_pending");
                // P2-37: the parallel READ batch aborts as soon as `signal` fires rather
                // than waiting for every in-flight read to finish. Reads are stateless,
                // so a read that has not settled at abort time is simply dropped (its
                // result is not recorded); the reads themselves observe the aborted
                // signal and terminate promptly.
                const settled = await this.runReadBatch(ctx, batch, parentCallId);
                state.transition("observing");
                state.transition("thinking");
                for (const { call: c, result } of settled) {
                    executed.push({
                        call: c,
                        result,
                        streak: state.noteToolCall(c.name, c.args),
                    });
                    this.recordStallTrace(state, c, result);
                }
                i = j;
            }
            else {
                state.transition("tool_pending");
                const result = await this.executeToolCall(ctx, call, parentCallId);
                state.transition("observing");
                state.transition("thinking");
                if (signal.aborted) {
                    // P2-37: serial (write) chain — the interrupt took effect during this
                    // call. It returned a CANCELLED outcome (or the call already committed
                    // and returned success). Either way stop the remaining calls: do not
                    // keep firing later writes into an aborted turn, and never pretend the
                    // committed ones rolled back.
                    executed.push({
                        call,
                        result,
                        streak: state.noteToolCall(call.name, call.args),
                    });
                    this.recordStallTrace(state, call, result);
                    break;
                }
                executed.push({
                    call,
                    result,
                    streak: state.noteToolCall(call.name, call.args),
                });
                this.recordStallTrace(state, call, result);
                i += 1;
            }
        }
        return executed;
    }
    /**
     * P2-37: run a batch of concurrency-safe (read-only) tool calls in parallel,
     * but resolve as soon as the user `signal` aborts so an interrupt is honored
     * promptly instead of waiting for every in-flight read. Rejects on a P1-5
     * kill so fault injection still propagates. Settled results are returned in
     * call order.
     */
    async runReadBatch(ctx, batch, parentCallId) {
        const { signal } = ctx;
        if (signal.aborted || batch.length === 0)
            return [];
        return new Promise((resolve, reject) => {
            const results = new Array(batch.length);
            let remaining = batch.length;
            let done = false;
            const finish = (arr) => {
                if (done)
                    return;
                done = true;
                signal.removeEventListener("abort", onAbort);
                resolve(arr);
            };
            const fail = (err) => {
                if (done)
                    return;
                done = true;
                signal.removeEventListener("abort", onAbort);
                reject(err);
            };
            const onAbort = () => {
                // Read-only batch: drop reads that have not settled; return the settled
                // subset in call order. The turn cancellation is reported by the caller.
                finish([]);
            };
            signal.addEventListener("abort", onAbort, { once: true });
            batch.forEach((c, idx) => {
                this.executeToolCall(ctx, c, parentCallId)
                    .then((result) => {
                    results[idx] = { call: c, result };
                    remaining -= 1;
                    if (remaining === 0 && !done) {
                        finish(results.filter((r) => r !== undefined));
                    }
                })
                    .catch((err) => {
                    // P1-5 kills propagate to the batch's caller (never swallowed or
                    // mislabeled as a tool failure).
                    if (err instanceof RuntimeKilledError) {
                        fail(err);
                        return;
                    }
                    results[idx] = {
                        call: c,
                        result: {
                            status: "failed",
                            error: err instanceof AgentError ? err.info : errorInfo("INTERNAL_ERROR", String(err)),
                        },
                    };
                    remaining -= 1;
                    if (remaining === 0 && !done) {
                        finish(results.filter((r) => r !== undefined));
                    }
                });
            });
        });
    }
    /** P2-41: record one executed tool call into the turn's stall window. The
     *  arguments key and result fingerprint let the pure classifier distinguish a
     *  genuine stall (same call + same result) from progress (same call, NEW
     *  result). */
    recordStallTrace(state, call, result) {
        const isRead = this.deps.toolCapabilityOf(call.name).concurrencySafe;
        if (result.status === "success") {
            const trace = {
                name: call.name,
                argsKey: computeArgsHash(call.args),
                resultFingerprint: computeArgsHash({ output: result.output ?? "" }),
                ...(isRead ? { isRead: true } : {}),
            };
            // A read whose RESULT CHANGED vs the same prior call is evidence advancing
            // (a verification moving from failing->passing, new search hits, ...).
            // That is concrete progress, so it cancels any pending stall score.
            if (isRead && state.priorResultChanged(trace)) {
                state.recordProgress("new_evidence");
                state.recordProgress("verification_improved");
            }
            state.recordToolCall(trace);
        }
        else if (result.status === "failed" && result.error !== undefined) {
            state.recordToolCall({
                name: call.name,
                argsKey: computeArgsHash(call.args),
                errorCode: result.error.code,
                ...(isRead ? { isRead: true } : {}),
            });
        }
        else {
            state.recordToolCall({
                name: call.name,
                argsKey: computeArgsHash(call.args),
                ...(isRead ? { isRead: true } : {}),
            });
        }
    }
    async executeToolCall(ctx, call, parentCallId) {
        const { session, turnId, signal, agent } = ctx;
        // P1-20: tool latency starts at the request (includes policy gates,
        // permission/sandbox evaluation and retries).
        const toolStartedAt = this.deps.now();
        await this.deps.emit(session.id, "tool.requested", { toolCallId: call.id, name: call.name, args: call.args }, turnId, { spanId: call.id, parentSpanId: parentCallId });
        // P0-1: the session's frozen tool policy is the first gate (fail-closed).
        // Permission/sandbox evaluation still happens downstream in the
        // orchestrator; a policy-denied call never reaches hooks or execution.
        if (!isToolAllowedByPolicy(agent.tools, call.name)) {
            const error = errorInfo("PERMISSION_DENIED", `tool ${call.name} is denied by the session tool policy (allow=${JSON.stringify(agent.tools.allow ?? null)} deny=${JSON.stringify(agent.tools.deny ?? null)})`);
            const result = { status: "denied", error };
            await this.deps.emit(session.id, "tool.failed", { toolCallId: call.id, tool: call.name, error, durationMs: this.deps.now() - toolStartedAt }, turnId);
            await this.deps.emit(session.id, "security.permission_denied", {
                toolCallId: call.id,
                tool: call.name,
                target: call.name,
                reason: error.message,
                source: "tool-policy",
                code: "PERMISSION_DENIED",
            }, turnId);
            return result;
        }
        const hookCtx = { sessionId: session.id, turnId, agentId: session.agentId, timestamp: this.deps.now() };
        const allowed = await this.deps.hooks.beforeTool(hookCtx, call);
        if (allowed === null) {
            const error = errorInfo("PERMISSION_DENIED", `tool ${call.name} blocked by hook`);
            const result = { status: "denied", error };
            await this.deps.emit(session.id, "tool.failed", { toolCallId: call.id, tool: call.name, error, durationMs: this.deps.now() - toolStartedAt }, turnId);
            await this.deps.emit(session.id, "security.permission_denied", {
                toolCallId: call.id,
                tool: call.name,
                target: call.name,
                reason: error.message,
                source: "hook",
                code: "PERMISSION_DENIED",
            }, turnId);
            await this.deps.hooks.toolError(hookCtx, call, result);
            return result;
        }
        const request = {
            id: call.id,
            sessionId: session.id,
            turnId,
            agentId: session.agentId,
            call: allowed,
        };
        const execCtx = {
            sessionId: session.id,
            turnId,
            agentId: session.agentId,
            cwd: session.cwd,
            signal,
            permissions: agent.permissions,
            sandboxPolicy: this.deps.sandboxPolicy ?? defaultSandboxPolicy(),
        };
        let result;
        try {
            // P1-5: a kill here leaves the tool outcome unknown (reconciliation).
            await this.deps.failAt("tool.executing", { sessionId: session.id, turnId, toolCallId: call.id, tool: call.name });
            result = await this.deps.orchestrator.execute(request, execCtx);
        }
        catch (err) {
            // P1-5: a simulated kill is not a tool failure to recover from.
            rethrowIfKill(err);
            if (signal.aborted) {
                // P2-37: a user interrupt while the tool is in-flight must surface as a
                // CANCELLED tool outcome, not a fabricated failure the model would then
                // react to. The turn itself is cancelled by the caller; the committed
                // side effects are reported separately, never rolled back.
                result = { status: "cancelled" };
            }
            else {
                result = {
                    status: "failed",
                    error: err instanceof AgentError ? err.info : errorInfo("INTERNAL_ERROR", String(err)),
                };
            }
        }
        await this.deps.hooks.afterTool(hookCtx, call, result);
        if (result.status === "failed" || result.status === "denied") {
            await this.deps.hooks.toolError(hookCtx, call, result);
        }
        if ((result.status === "failed" || result.status === "timeout") && this.deps.recovery !== undefined) {
            // plan.md Phase 3.6: auto-retry ONLY idempotent read-only tools
            // (retry: "safe"). Tools with unknown or non-idempotent effects are
            // never blindly re-executed — the failed result flows to the model,
            // which decides. Retries are bounded by RecoveryPolicy and honor its
            // per-kind delay.
            const retryPolicy = this.deps.toolCapabilityOf(call.name).retry;
            for (let attempt = 1;; attempt += 1) {
                const decision = this.deps.recovery.decide(result.status === "timeout" ? "timeout" : "tool_failure", attempt);
                if (decision.action === "retry") {
                    if (retryPolicy !== "safe")
                        break;
                    if ((decision.retryDelayMs ?? 0) > 0) {
                        await timerSleep(this.deps.timer, decision.retryDelayMs ?? 0);
                    }
                    try {
                        result = await this.deps.orchestrator.execute(request, execCtx);
                    }
                    catch (err) {
                        // P1-5: a simulated kill is not a tool failure to recover from.
                        rethrowIfKill(err);
                        result = {
                            status: "failed",
                            error: err instanceof AgentError ? err.info : errorInfo("INTERNAL_ERROR", String(err)),
                        };
                    }
                    await this.deps.hooks.afterTool(hookCtx, call, result);
                    continue;
                }
                if (decision.action === "ask") {
                    const info = errorInfo("RESOURCE_LIMIT", `ask user: ${decision.reason}`);
                    result = { status: "failed", error: info };
                    await this.deps.hooks.toolError(hookCtx, call, result);
                }
                break;
            }
        }
        else if ((result.status === "failed" || result.status === "timeout") &&
            this.deps.adaptiveRecovery !== undefined) {
            // P2-42: adaptive recovery. Decide among a BOUNDED action set (retry,
            // change_strategy, delegate_specialist, ask_user, fail_safe) using the
            // planner's per-action budgets instead of the legacy retry/ask/fail
            // branch. A non-idempotent tool is never re-executed, so `retry` is kept
            // off its budget for this call; the failed result still flows to the
            // model at the end (the turn's maxToolCalls / stall / iteration budgets
            // bound the overall run).
            const retryPolicy = this.deps.toolCapabilityOf(call.name).retry;
            const planner = retryPolicy === "safe"
                ? this.deps.adaptiveRecovery
                : new AdaptiveRecoveryPlanner({ retry: { budget: 0 } });
            for (;;) {
                const decision = planner.decide(result.status === "timeout" ? "timeout" : "tool_failure", this.deps.recoveryUsage);
                this.deps.recoveryUsage[decision.action] = (this.deps.recoveryUsage[decision.action] ?? 0) + 1;
                if (decision.action === "retry") {
                    if (retryPolicy !== "safe")
                        break;
                    try {
                        result = await this.deps.orchestrator.execute(request, execCtx);
                    }
                    catch (err) {
                        rethrowIfKill(err);
                        result = {
                            status: "failed",
                            error: err instanceof AgentError ? err.info : errorInfo("INTERNAL_ERROR", String(err)),
                        };
                    }
                    await this.deps.hooks.afterTool(hookCtx, call, result);
                    continue;
                }
                // Self-heal actions: inject a bounded observation so the model changes
                // approach (vs. blindly retrying), then feed the failed result onward.
                // P3-9: delegate_specialist ACTUALLY delegates when the host wired a
                // specialist service (budget allows + task decomposable) instead of
                // only printing "try a different approach".
                if (decision.action === "change_strategy" || decision.action === "delegate_specialist") {
                    let content;
                    if (decision.action === "delegate_specialist" && this.deps.delegateSpecialist !== undefined) {
                        let turn;
                        try {
                            turn = await this.deps.store.getTurn(turnId);
                        }
                        catch {
                            turn = undefined;
                        }
                        try {
                            const outcome = await this.deps.delegateSpecialist({
                                sessionId: session.id,
                                turnId,
                                goal: turn?.input.text ?? "",
                                tool: call.name,
                                failure: decision.reason,
                                signal: execCtx.signal,
                            });
                            content =
                                outcome?.delegated === true
                                    ? `[recovery:delegate_specialist] a specialist subagent is investigating "${call.name}" failure in isolation. ${outcome.summary ?? "Its findings will appear when it completes."}`
                                    : `[recovery:delegate_specialist] specialist delegation unavailable (${outcome?.summary ?? "outside budget or scope"}); stop repeating "${call.name}" and try a different approach.`;
                        }
                        catch (cause) {
                            content = `[recovery:delegate_specialist] specialist delegation failed (${cause instanceof Error ? cause.message : String(cause)}); stop repeating "${call.name}" and try a different approach.`;
                        }
                    }
                    else {
                        content =
                            `[recovery:${decision.action}] "${call.name}" failed without a safe retry (${decision.reason}); ` +
                                "stop repeating it and try a different approach.";
                    }
                    await this.deps.store.appendMessage({
                        id: newMessageId(),
                        sessionId: session.id,
                        turnId,
                        role: "system",
                        content,
                        createdAt: this.deps.now(),
                    });
                    break;
                }
                // ask_user / fail_safe: cease auto-recovery here; the failed result is
                // surfaced to the model, and the turn's own budgets terminate it.
                break;
            }
        }
        // P1-20: every executed tool closes the loop with a duration (denied
        // calls already emitted tool.failed at their gate, no double emission).
        const durationMs = this.deps.now() - toolStartedAt;
        if (result.status === "success") {
            await this.deps.emit(session.id, "tool.completed", { toolCallId: call.id, tool: call.name, durationMs }, turnId, { spanId: call.id, parentSpanId: parentCallId });
        }
        else if (result.status === "failed" || result.status === "timeout") {
            // P2-37: a CANCELLED tool outcome (user interrupt during execution) is not
            // a tool failure — do not mislabel it as one. The turn's cancellation is
            // emitted separately by finishTurn.
            await this.deps.emit(session.id, "tool.failed", { toolCallId: call.id, tool: call.name, error: result.error, durationMs }, turnId);
        }
        return result;
    }
}
//# sourceMappingURL=tool-call-controller.js.map