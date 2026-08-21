import { errorInfo, isPermissionOrSandboxDenied, isTimeoutErrorCode, newApprovalId } from "@ar/contracts";
import { classifySupplyChain, DeterministicPermissionEngine, defaultEffectForRisk, SandboxManager, } from "@ar/security";
/**
 * ToolOrchestrator per AGENT_ARCHITECTURE_PLAN §14 (INV-001, INV-002).
 * The 12-step pipeline is mandatory — no step may be silently skipped:
 *
 *   resolve → validate → normalize → risk → permission → approval
 *   → sandbox → execute → timeout/output limits → evidence → events → normalize
 */
export class ToolOrchestrator {
    registry;
    permission;
    approval;
    approvalExpiresMs;
    workspaceRoot;
    events;
    now;
    sandboxExtraRoots;
    constructor(deps) {
        this.registry = deps.registry;
        this.permission = deps.permission ?? new DeterministicPermissionEngine();
        this.approval = deps.approval;
        this.approvalExpiresMs = deps.approvalExpiresMs ?? 60_000;
        this.workspaceRoot = deps.workspaceRoot;
        this.events = deps.events;
        this.now = deps.now ?? Date.now;
        this.sandboxExtraRoots = deps.sandboxExtraRoots;
    }
    async execute(request, context) {
        const started = this.now();
        try {
            // 1. resolve tool
            const tool = this.registry.get(request.call.name);
            if (!tool) {
                return this.fail(request, context, "TOOL_SCHEMA_ERROR", `unknown tool: ${request.call.name}`, started);
            }
            // 2+3. validate & normalize arguments
            const parsed = tool.inputSchema.safeParse(request.call.args);
            if (!parsed.success) {
                const detail = parsed.error.issues
                    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
                    .join("; ");
                return this.fail(request, context, "TOOL_SCHEMA_ERROR", `schema validation failed for ${tool.name}: ${detail}`, started);
            }
            const args = parsed.data;
            // 4. classify risk + permission surface
            const surface = this.classify(tool, args);
            // 5. evaluate permission (agent policy comes from the runtime context)
            const decision = await this.permission.evaluate({
                action: surface.action,
                resource: surface.resource,
                ...(surface.target !== undefined ? { target: surface.target } : {}),
                agentId: request.agentId,
                sessionId: request.sessionId,
                ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
            }, this.effectivePolicy(context.permissions, tool.risk, surface));
            if (decision.effect === "deny") {
                await this.emit("tool.permission_resolved", request, context, { effect: "deny", reason: decision.reason });
                return this.failPermission(request, context, decision, started, surface.target);
            }
            // 6. approval when policy says "ask"
            if (decision.effect === "ask") {
                const resolved = await this.requestApproval(request, context, tool, surface, decision, started);
                if (resolved !== null)
                    return resolved;
            }
            else {
                await this.emit("tool.permission_resolved", request, context, { effect: "allow", reason: decision.reason });
            }
            // 7. resolve sandbox
            const sandboxDecision = this.evaluateSandbox(context, surface);
            if (!sandboxDecision.allowed) {
                await this.emit("tool.permission_resolved", request, context, { effect: "deny", reason: sandboxDecision.reason });
                await this.emitSecurityDenial(request, context, sandboxDecision, surface);
                return this.failSandbox(request, context, sandboxDecision, started);
            }
            // 8. execute
            await this.emit("tool.started", request, context, {});
            let result;
            try {
                result = await this.runBounded(tool, args, request, context);
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return this.fail(request, context, "INTERNAL_ERROR", message, started);
            }
            // 9. enforce timeout/output limits
            if (result.status === "timeout") {
                return this.fail(request, context, "PROCESS_TIMEOUT", "tool execution timed out", started, result);
            }
            result = this.applyOutputLimit(result, context);
            // 10. capture evidence into the event trail
            if (result.evidence === undefined && result.status === "success") {
                const evidence = this.buildEvidence(tool, args);
                if (evidence)
                    result = { ...result, evidence: [evidence] };
            }
            await this.emit("tool.completed", request, context, {
                status: result.status,
                durationMs: this.now() - started,
                evidence: result.evidence ?? [],
                outputPreview: this.preview(result.output),
            });
            // 12. normalize result
            return this.normalize(result);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return this.fail(request, context, "INTERNAL_ERROR", message, started);
        }
    }
    // --- pipeline helpers ---------------------------------------------------
    classify(tool, args) {
        const m = tool.metadata;
        if (m.process) {
            const cmd = this.str(args.command ?? args.cmd) ?? "";
            // P2-25: surface dependency-install / remote-code-execution as their OWN
            // permission resource, so they are NOT gated like a generic command.
            const sc = classifySupplyChain(cmd);
            const resource = sc === "command" ? "command" : sc;
            return {
                action: "exec",
                resource,
                target: cmd,
                ...(sc !== "command" ? { supplyChain: sc } : {}),
            };
        }
        if (m.network) {
            return { action: "exec", resource: "network", target: this.str(args.url) };
        }
        if (m.filesystem) {
            const target = this.str(args.path ?? args.file) || ".";
            return { action: tool.risk === "readonly" ? "read" : "edit", resource: "file", target };
        }
        return { action: tool.risk === "readonly" ? "read" : "exec", resource: "tool" };
    }
    effectivePolicy(agentPolicy, risk, surface) {
        // P2-25: remote code execution (curl|sh) escalates to critical → deny by
        // default unless the operator grants the `exec:remote_code_execution`
        // resource explicitly.
        const effectiveRisk = surface?.supplyChain === "remote_code_execution" ? "critical" : risk;
        if (agentPolicy.defaultEffect === undefined) {
            return { ...agentPolicy, defaultEffect: defaultEffectForRisk(effectiveRisk) };
        }
        return agentPolicy;
    }
    async requestApproval(request, context, tool, surface, decision, started) {
        if (!this.approval) {
            // Fail closed: no approval surface exists -> deny.
            return this.fail(request, context, "APPROVAL_DENIED", `policy asked for approval but no approval resolver is configured`, started);
        }
        const approvalRequest = {
            id: newApprovalId(),
            sessionId: request.sessionId,
            ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
            agentId: request.agentId,
            action: surface.action,
            target: surface.target ?? request.call.name,
            reason: `${tool.name}: ${decision.reason}`,
            ...(decision.rule?.id !== undefined ? { policyRule: decision.rule.id } : {}),
            createdAt: this.now(),
            expiresAt: this.now() + this.approvalExpiresMs,
        };
        await this.emit("tool.permission_requested", request, context, { approvalId: approvalRequest.id });
        await this.emit("approval.created", request, context, {
            approvalId: approvalRequest.id,
            target: approvalRequest.target,
            reason: approvalRequest.reason,
            expiresAt: approvalRequest.expiresAt,
        });
        const approval = await this.approval.resolve(approvalRequest, context.signal);
        await this.emit("approval.resolved", request, context, { approvalId: approvalRequest.id, value: approval.value });
        await this.emit("tool.permission_resolved", request, context, { effect: approval.value, approvalId: approvalRequest.id });
        switch (approval.value) {
            case "allow":
                return null;
            case "deny":
                return this.fail(request, context, "APPROVAL_DENIED", `approval denied by ${approval.decidedBy ?? "user"}`, started);
            case "expired":
                return this.fail(request, context, "APPROVAL_DENIED", "approval expired", started);
            case "cancelled":
                return {
                    status: "cancelled",
                    error: errorInfo("USER_CANCELLED", "approval cancelled"),
                };
        }
    }
    evaluateSandbox(context, surface) {
        if (surface.resource === "tool") {
            return { allowed: true, reason: "no sandbox surface for generic tool" };
        }
        const root = this.workspaceRoot ?? context.cwd;
        const extraRoots = this.sandboxExtraRoots?.(context.sessionId) ?? [];
        const manager = new SandboxManager(root, context.cwd, context.sandboxPolicy, [...extraRoots]);
        switch (surface.resource) {
            case "file":
                return manager.evaluate({
                    target: surface.target ?? "",
                    operation: surface.action === "read" ? "read" : "write",
                    policy: context.sandboxPolicy,
                });
            case "command":
                return manager.evaluate({
                    target: surface.target ?? "",
                    operation: "exec",
                    policy: context.sandboxPolicy,
                });
            case "network":
                return manager.checkNetwork(surface.target ?? "");
            default:
                return { allowed: true, reason: "no sandbox restriction" };
        }
    }
    async emitSecurityDenial(request, context, decision, surface) {
        // Per-dimension security events (P0-7): every sandbox denial is observable
        // in the event trail with a structured target, reason, source and code.
        const target = surface.target ?? "";
        switch (decision.kind) {
            case "network":
                await this.emit("security.network_denied", request, context, {
                    target,
                    reason: decision.reason,
                    source: "sandbox-network",
                    code: "SANDBOX_NETWORK_DENIED",
                });
                break;
            case "filesystem":
                await this.emit("security.filesystem_denied", request, context, {
                    target,
                    reason: decision.reason,
                    source: "sandbox-filesystem",
                    code: "SANDBOX_FILESYSTEM_DENIED",
                });
                break;
            case "process":
                await this.emit("security.process_denied", request, context, {
                    target,
                    reason: decision.reason,
                    source: "sandbox-process",
                    code: "SANDBOX_PROCESS_DENIED",
                });
                break;
        }
    }
    async runBounded(tool, args, request, context) {
        const timeoutMs = context.sandboxPolicy.process.timeoutMs;
        if (timeoutMs === undefined) {
            return tool.execute(args, context);
        }
        const ac = new AbortController();
        const link = () => ac.abort();
        context.signal.addEventListener("abort", link, { once: true });
        let timer;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => {
                ac.abort();
                resolve({ status: "timeout", error: errorInfo("PROCESS_TIMEOUT", `tool ${tool.name} exceeded ${timeoutMs}ms`) });
            }, timeoutMs);
        });
        try {
            const exec = tool.execute(args, {
                ...context,
                signal: ac.signal,
                onOutput: (event) => {
                    // Stream process output to the event trail as tool.output.
                    void this.emit("tool.output", request, context, { ...event }).catch(() => { });
                },
            });
            // Prevent unhandled rejections when timeout/cancel wins the race.
            exec.catch(() => { });
            return await Promise.race([exec, timeout]);
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
            context.signal.removeEventListener("abort", link);
        }
    }
    applyOutputLimit(result, context) {
        const maxBytes = context.sandboxPolicy.process.maxOutputBytes;
        if (maxBytes === undefined || typeof result.output !== "string")
            return result;
        if (Buffer.byteLength(result.output, "utf8") <= maxBytes)
            return result;
        return {
            ...result,
            output: `${result.output.slice(0, maxBytes)}\n…[output truncated at ${maxBytes} bytes]`,
        };
    }
    buildEvidence(tool, args) {
        const when = this.now();
        const m = tool.metadata;
        if (m.process) {
            return { type: "command", description: `${tool.name} ran`, source: String(args.command ?? ""), timestamp: when };
        }
        if (m.filesystem) {
            return { type: "file", description: `${tool.name} accessed`, source: String(args.path ?? ""), timestamp: when };
        }
        if (m.network) {
            return { type: "http", description: `${tool.name} requested`, source: String(args.url ?? ""), timestamp: when };
        }
        return undefined;
    }
    normalize(result) {
        return {
            status: result.status,
            ...(result.output !== undefined ? { output: result.output } : {}),
            ...(result.error !== undefined ? { error: result.error } : {}),
            ...(result.evidence !== undefined ? { evidence: result.evidence } : {}),
            ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
        };
    }
    preview(output) {
        if (typeof output === "string")
            return output.slice(0, 500);
        try {
            return JSON.stringify(output).slice(0, 500);
        }
        catch {
            // Best-effort: JSON.stringify throws on circular refs / BigInt; degrade
            // to string coercion for the preview only — the real output is untouched.
            return String(output).slice(0, 500);
        }
    }
    fail(request, context, code, message, started, base) {
        let status = "failed";
        if (isTimeoutErrorCode(code) || base?.status === "timeout")
            status = "timeout";
        else if (base?.status === "cancelled")
            status = "cancelled";
        else if (isPermissionOrSandboxDenied(code))
            status = "denied";
        const result = {
            status,
            ...(base?.output !== undefined ? { output: base.output } : {}),
            error: errorInfo(code, message, { evidence: base?.error?.evidence }),
        };
        void this.emit("tool.failed", request, context, { error: result.error, durationMs: this.now() - started }).catch(() => { });
        return result;
    }
    failPermission(request, context, decision, started, target) {
        void this.emit("security.permission_denied", request, context, {
            target: target ?? "",
            reason: decision.reason,
            source: "permission-engine",
            code: "PERMISSION_DENIED",
            ...(decision.rule?.id !== undefined ? { ruleId: decision.rule.id } : {}),
        }).catch(() => { });
        return this.fail(request, context, "PERMISSION_DENIED", `permission denied: ${decision.reason}`, started);
    }
    failSandbox(request, context, decision, started) {
        const code = decision.kind === "filesystem" ? "SANDBOX_FILESYSTEM_DENIED"
            : decision.kind === "process" ? "SANDBOX_PROCESS_DENIED"
                : decision.kind === "network" ? "SANDBOX_NETWORK_DENIED"
                    : "SANDBOX_DENIED";
        return this.fail(request, context, code, `sandbox denied: ${decision.reason}`, started);
    }
    async emit(type, request, context, payload) {
        if (!this.events)
            return;
        const full = {
            toolCallId: request.id,
            tool: request.call.name,
            ...payload,
        };
        try {
            await this.events.emit(request.sessionId, type, full, request.turnId);
        }
        catch {
            // Event emission must never break execution.
        }
    }
    str(v) {
        if (typeof v === "string")
            return v;
        if (Array.isArray(v)) {
            const first = v.find((x) => typeof x === "string");
            return typeof first === "string" ? first : undefined;
        }
        return undefined;
    }
}
//# sourceMappingURL=orchestrator.js.map