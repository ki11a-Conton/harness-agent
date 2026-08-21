// P3-1/P3-7/P3-8: model-callable delegation tools. P3-1 exposes read-only
// delegation (delegate_explore) — the child is forced to a read-only tool
// policy, so no workspace isolation is needed yet. P3-7 adds batch
// delegation (delegate_batch) through ParallelDelegator with a bounded task
// count. P3-8 renders every child completion as a structured, semi-trusted
// synthesis block (status/verified/findings/evidence) — the parent sees data,
// never an authority claim. delegate_worker (writable, P3-6) is NOT exposed
// here: it requires the sandbox to admit the isolated root and is added only
// once that gate exists.
import { z } from "zod";
const DEFAULT_MAX_BATCH_SIZE = 5;
/** P3-8: render a child completion for the parent model — structured,
 *  semi-trusted data (the pipeline labels tool output as semi-trusted; the
 *  model must never treat it as authoritative). */
export function renderDelegationResult(result) {
    const lines = [];
    lines.push("[Subagent completion]");
    lines.push(`status: ${result.status}`);
    if (result.verified)
        lines.push("verified: true");
    if (result.status === "failed" || result.status === "timeout") {
        lines.push(`error: ${result.error ?? result.summary}`);
        return lines.join("\n");
    }
    lines.push(`summary: ${result.summary}`);
    if (result.findings.length > 0) {
        lines.push("findings:");
        for (const finding of result.findings) {
            lines.push(`- ${finding.claim} (confidence ${finding.confidence})`);
            if (finding.evidenceRefs.length > 0) {
                lines.push(`  evidence: ${finding.evidenceRefs.join(", ")}`);
            }
        }
    }
    if (result.changedArtifacts.length > 0) {
        lines.push("changed files:");
        for (const artifact of result.changedArtifacts) {
            lines.push(`- ${artifact.path} (${artifact.sourceRef})`);
        }
    }
    if (result.testsRun.length > 0) {
        lines.push("tests run:");
        for (const run of result.testsRun) {
            lines.push(`- ${run.description}: ${run.passed ? "passed" : "failed"}`);
        }
    }
    if (result.blockers.length > 0) {
        lines.push(`blockers: ${result.blockers.join("; ")}`);
    }
    if (result.openQuestions.length > 0) {
        lines.push(`open questions: ${result.openQuestions.join("; ")}`);
    }
    lines.push(`child session: ${result.childSessionId}`);
    return lines.join("\n");
}
/** P3-1/P3-7: the production delegation tools. */
export function createDelegationTools(deps) {
    const maxBatchSize = deps.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    const readonlyAllow = { allow: [...deps.readonlyToolNames] };
    const delegateExplore = {
        name: "delegate_explore",
        description: "Delegate a read-only investigation to an isolated child agent. The child can " +
            "only read/search the workspace — it cannot write, edit or run commands. Use it for " +
            "parallel code exploration, large-repository searches, or multi-angle analysis. " +
            "Returns structured findings with evidence refs (semi-trusted data).",
        inputSchema: z.object({
            goal: z.string().min(1).describe("What the child should investigate (read-only)."),
            context: z.string().optional().describe("Optional focus/constraints for the child."),
        }),
        risk: "readonly",
        metadata: {
            name: "delegate_explore",
            version: "1.0.0",
            sideEffect: false,
            network: false,
            filesystem: true,
            process: false,
            interactive: false,
            retry: "safe",
            concurrencySafe: true,
        },
        async execute(input, context) {
            if (context.signal.aborted)
                return { status: "cancelled" };
            try {
                const result = await deps.delegator().delegate({
                    parentSessionId: context.sessionId,
                    goal: input.context !== undefined ? `${input.goal}\n\nFocus: ${input.context}` : input.goal,
                    toolPolicy: readonlyAllow,
                    writable: false,
                }, context.signal);
                return { status: "success", output: renderDelegationResult(result) };
            }
            catch (err) {
                return {
                    status: "failed",
                    error: {
                        code: "PROCESS_ERROR",
                        message: err instanceof Error ? err.message : String(err),
                        retryable: false,
                        safeToRetry: false,
                    },
                };
            }
        },
    };
    const delegateBatch = {
        name: "delegate_batch",
        description: `Run up to ${maxBatchSize} read-only investigations in parallel, each in an isolated child agent. ` +
            "Every child is restricted to read/search tools. Use it when several independent questions about the " +
            "workspace can be answered concurrently. Returns one structured completion block per task.",
        inputSchema: z.object({
            tasks: z
                .array(z.object({ id: z.string().min(1), goal: z.string().min(1) }))
                .min(1)
                .max(maxBatchSize)
                .describe(`1-${maxBatchSize} independent read-only investigations`),
        }),
        risk: "readonly",
        metadata: {
            name: "delegate_batch",
            version: "1.0.0",
            sideEffect: false,
            network: false,
            filesystem: true,
            process: false,
            interactive: false,
            retry: "safe",
            concurrencySafe: true,
        },
        async execute(input, context) {
            if (context.signal.aborted)
                return { status: "cancelled" };
            try {
                const results = await deps.parallelDelegator().delegateAll(input.tasks.map((task) => ({
                    parentSessionId: context.sessionId,
                    goal: task.goal,
                    toolPolicy: readonlyAllow,
                    writable: false,
                })), context.signal);
                const blocks = input.tasks.map((task, index) => {
                    const result = results[index];
                    return `--- task ${task.id} ---\n${renderDelegationResult(result)}`;
                });
                return { status: "success", output: blocks.join("\n\n") };
            }
            catch (err) {
                return {
                    status: "failed",
                    error: {
                        code: "PROCESS_ERROR",
                        message: err instanceof Error ? err.message : String(err),
                        retryable: false,
                        safeToRetry: false,
                    },
                };
            }
        },
    };
    // P3-6: write-capable worker. Registered ONLY when the harness wired a
    // worker agent + workspace manager (i.e. the isolation gate is closed) —
    // otherwise execute fails closed with an explicit "not wired" error.
    const delegateWorker = deps.workerAgentId !== undefined && deps.workspaceManager !== undefined
        ? {
            name: "delegate_worker",
            description: "Delegate a WRITE-CAPABLE task to an isolated child agent. The child works in a " +
                "private copy of the workspace (never your working directory directly); on success " +
                "its changes are applied back under conflict detection — a path you modified while " +
                "the child ran is never overwritten. Use it for bounded implementation tasks that can " +
                "proceed independently.",
            inputSchema: z.object({
                goal: z.string().min(1).describe("What the child should implement (write-capable)."),
                context: z.string().optional().describe("Optional focus/constraints for the child."),
            }),
            risk: "elevated",
            metadata: {
                name: "delegate_worker",
                version: "1.0.0",
                sideEffect: true,
                network: false,
                filesystem: true,
                process: false,
                interactive: false,
                retry: "none",
                concurrencySafe: false,
            },
            async execute(input, context) {
                if (context.signal.aborted)
                    return { status: "cancelled" };
                try {
                    const result = await deps.delegator().delegate({
                        parentSessionId: context.sessionId,
                        goal: input.context !== undefined
                            ? `${input.goal}\n\nFocus: ${input.context}`
                            : input.goal,
                        agentId: deps.workerAgentId(),
                        writable: true,
                    }, context.signal);
                    let output = renderDelegationResult(result);
                    // P3-5: physically merge the isolated patch into the parent
                    // workspace under conflict detection.
                    if (result.status === "success" && result.workspacePatch !== undefined) {
                        const applied = await deps.workspaceManager().apply(context.cwd, result.workspacePatch);
                        output += `\n\n[workspace merge]\napplied: ${applied.applied.join(", ") || "(none)"}`;
                        if (applied.conflicts.length > 0) {
                            output += `\nconflicts (child version NOT applied): ${applied.conflicts
                                .map((c) => `${c.path} (${c.detail})`)
                                .join("; ")}`;
                        }
                        if (applied.skipped.length > 0) {
                            output += `\nskipped: ${applied.skipped.map((s) => `${s.path}: ${s.detail}`).join("; ")}`;
                        }
                    }
                    return { status: "success", output };
                }
                catch (err) {
                    return {
                        status: "failed",
                        error: {
                            code: "PROCESS_ERROR",
                            message: err instanceof Error ? err.message : String(err),
                            retryable: false,
                            safeToRetry: false,
                        },
                    };
                }
            },
        }
        : undefined;
    const tools = [delegateExplore, delegateBatch];
    if (delegateWorker !== undefined)
        tools.push(delegateWorker);
    return tools;
}
//# sourceMappingURL=delegation-tools.js.map