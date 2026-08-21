import { newEventId } from "@ar/contracts";
/** Channel command syntax: `approve:<id>:allow` or `approve:<id>:deny`. */
const APPROVE_COMMAND = /^approve:([^:]+):(allow|deny)$/;
/** Channel command that cancels the sender's running turn (§175 human.cancel). */
const CANCEL_COMMAND = "cancel";
/**
 * Chat-channel gateway (§83): routes channel messages into sessions through
 * the §84 RPC surface only (no Core reach-through), forwards approval
 * decisions, pushes session events back to channels, and records §175 human
 * intervention events. Channel-specific logic stays inside adapters.
 */
export class Gateway {
    rpc;
    channels;
    sessionService;
    approvalStore;
    events;
    route;
    sessionDefaults;
    pollDelayMs;
    now;
    /** `${channelId}:${from}` → bound session id. */
    sessionByUser = new Map();
    /** session id → recipient for event pushes. */
    recipientBySession = new Map();
    lastTurnBySession = new Map();
    lastSequenceBySession = new Map();
    pollers = new Map();
    started = false;
    constructor(deps) {
        this.rpc = deps.rpc;
        this.channels = deps.channels;
        this.sessionService = deps.sessionService;
        this.approvalStore = deps.approvalStore;
        this.events = deps.events;
        this.route = deps.route;
        this.sessionDefaults = deps.sessionDefaults;
        this.pollDelayMs = deps.pollDelayMs ?? 50;
        this.now = deps.now ?? Date.now;
    }
    async start() {
        if (this.started) {
            throw new Error("gateway already started");
        }
        this.started = true;
        for (const channel of this.channels) {
            await channel.connect();
            channel.onMessage((msg) => this.handleMessage(msg));
        }
    }
    async stop() {
        if (!this.started)
            return;
        this.started = false;
        for (const timer of this.pollers.values()) {
            clearInterval(timer);
        }
        this.pollers.clear();
        for (const channel of this.channels) {
            await channel.disconnect();
        }
    }
    // --- message routing ----------------------------------------------------
    async handleMessage(msg) {
        if (!this.started)
            return;
        try {
            const approve = APPROVE_COMMAND.exec(msg.text);
            if (approve !== null) {
                await this.handleApproval(msg, approve[1], approve[2]);
                return;
            }
            if (msg.text.trim() === CANCEL_COMMAND) {
                await this.handleCancel(msg);
                return;
            }
            await this.handleUserMessage(msg);
        }
        catch (err) {
            await this.reply(msg, `[error] ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /** User text: find-or-create the sender's session, then send+run the turn. */
    async handleUserMessage(msg) {
        const key = this.userKey(msg);
        let sessionId = this.sessionByUser.get(key);
        if (sessionId === undefined) {
            sessionId = await this.bindSession(key, msg);
            if (sessionId === undefined)
                return;
        }
        const { turnId } = (await this.rpc.invoke("session.send", {
            sessionId,
            text: msg.text,
        }));
        this.lastTurnBySession.set(sessionId, turnId);
        // The run must not block message handling, or a cancel could never land.
        void this.runTurnAndReply(msg, sessionId, turnId);
    }
    /** Find or create the session for a sender; replies when creation is impossible. */
    async bindSession(key, msg) {
        let sessionId = this.route?.(msg.from);
        if (sessionId !== undefined) {
            try {
                await this.sessionService.resume(sessionId);
            }
            catch {
                sessionId = undefined; // stale route → fall through to creation
            }
        }
        if (sessionId === undefined) {
            const defaults = this.sessionDefaults;
            if (defaults === undefined) {
                await this.reply(msg, "[error] no default agent configured for session creation");
                return undefined;
            }
            const session = (await this.rpc.invoke("session.create", {
                agentId: defaults.agentId,
                cwd: defaults.cwd,
            }));
            sessionId = session.id;
        }
        this.sessionByUser.set(key, sessionId);
        this.recipientBySession.set(sessionId, { channelId: msg.channelId, from: msg.from });
        this.startPoller(sessionId);
        return sessionId;
    }
    async runTurnAndReply(msg, sessionId, turnId) {
        try {
            const outcome = (await this.rpc.invoke("session.run", { sessionId, turnId }));
            await this.reply(msg, `[run] ${outcome.status} turn:${turnId} calls:${outcome.toolCalls ?? 0} iterations:${outcome.iterations ?? 0}`);
        }
        catch (err) {
            await this.reply(msg, `[run] error: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /** `approve:<id>:allow|deny`: resolve through session.approve, record §175. */
    async handleApproval(msg, rawId, value) {
        const request = this.approvalStore.listPending().find((r) => r.id === rawId);
        if (request === undefined) {
            await this.reply(msg, `[approve] error: unknown or already-resolved approval: ${rawId}`);
            return;
        }
        const decidedBy = `${msg.channelId}:${msg.from}`;
        const decision = (await this.rpc.invoke("session.approve", {
            approvalId: rawId,
            value,
            decidedBy,
        }));
        await this.emitHuman(request.sessionId, "human.approval", {
            approvalId: request.id,
            value: decision.value,
            decidedBy,
        });
        await this.reply(msg, `[approve] ${decision.id} ${decision.value}`);
    }
    /** `cancel`: abort the sender's running turn (§175 human.cancel semantics). */
    async handleCancel(msg) {
        const sessionId = this.sessionByUser.get(this.userKey(msg));
        if (sessionId === undefined) {
            await this.reply(msg, "[cancel] no session");
            return;
        }
        const turnId = this.lastTurnBySession.get(sessionId);
        if (turnId === undefined) {
            await this.reply(msg, "[cancel] not_running");
            return;
        }
        const result = (await this.rpc.invoke("session.cancel", {
            sessionId,
            turnId,
        }));
        await this.emitHuman(sessionId, "human.cancel", { text: msg.text, turnId }, turnId);
        await this.reply(msg, `[cancel] ${result.status}`);
    }
    // --- event push ----------------------------------------------------------
    startPoller(sessionId) {
        if (this.pollers.has(sessionId))
            return;
        const timer = setInterval(() => {
            void this.poll(sessionId);
        }, this.pollDelayMs);
        this.pollers.set(sessionId, timer);
    }
    async poll(sessionId) {
        try {
            const afterSequence = this.lastSequenceBySession.get(sessionId) ?? 0;
            const events = await this.events.list(sessionId, { afterSequence });
            let last = afterSequence;
            for (const ev of events) {
                last = ev.sequence;
                const text = this.eventToMessage(ev);
                if (text === undefined)
                    continue;
                const recipient = this.recipientBySession.get(sessionId);
                const channel = recipient === undefined
                    ? undefined
                    : this.channels.find((c) => c.id === recipient.channelId);
                if (channel !== undefined && recipient !== undefined) {
                    await channel.send(recipient.from, text);
                }
            }
            this.lastSequenceBySession.set(sessionId, last);
        }
        catch {
            // A transient store error must not kill the push loop; the next tick retries.
        }
    }
    /** Map a session event to the channel text pushed to the user (others: ignore). */
    eventToMessage(ev) {
        switch (ev.type) {
            case "approval.created": {
                const request = this.approvalStore
                    .listPending()
                    .find((r) => r.id === ev.payload.approvalId);
                const id = request?.id ?? String(ev.payload.approvalId);
                const lines = [
                    `[approval] ${ev.sessionId} requests approval`,
                    `  action: ${request?.action ?? "unknown"}`,
                    `  target: ${request?.target ?? String(ev.payload.target ?? "")}`,
                    `  reason: ${request?.reason ?? String(ev.payload.reason ?? "")}`,
                ];
                if (request?.agentId !== undefined)
                    lines.push(`  agent: ${request.agentId}`);
                if (request?.policyRule !== undefined)
                    lines.push(`  policy: ${request.policyRule}`);
                lines.push(`  expires: ${String(request?.expiresAt ?? ev.payload.expiresAt)}`);
                lines.push(`  reply: approve:${id}:allow | approve:${id}:deny`);
                return lines.join("\n");
            }
            case "tool.permission_requested":
                return `[permission] ${String(ev.payload.tool ?? "tool")} awaits approval ${String(ev.payload.approvalId)}`;
            case "run.limit_reached":
                return `[limit] ${String(ev.payload.limit)}: ${String(ev.payload.used)}`;
            default:
                return undefined;
        }
    }
    // --- helpers -------------------------------------------------------------
    /** Record a §175 human intervention event on the session stream. */
    async emitHuman(sessionId, type, payload, turnId) {
        const sequence = await this.events.nextSequence(sessionId);
        await this.events.append({
            id: newEventId(),
            sessionId,
            ...(turnId !== undefined ? { turnId } : {}),
            sequence,
            timestamp: this.now(),
            type,
            payload,
        });
    }
    async reply(msg, text) {
        const channel = this.channels.find((c) => c.id === msg.channelId);
        if (channel !== undefined) {
            await channel.send(msg.from, text);
        }
    }
    userKey(msg) {
        return `${msg.channelId}:${msg.from}`;
    }
}
//# sourceMappingURL=gateway.js.map