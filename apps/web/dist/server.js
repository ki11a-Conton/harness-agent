import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
/** Browser identity format: [A-Za-z0-9-]{8,64} (uuid v4 fits). */
export const FROM_RE = /^[A-Za-z0-9-]{8,64}$/;
/**
 * Command shapes mirror the gateway's private constants (gateway.ts
 * APPROVE_COMMAND / CANCEL_COMMAND — not exported, so redeclared here with a
 * comment). The gateway owns the actual parsing/execution; this server only
 * rejects non-command text so a typo never becomes a turn prompt.
 */
const APPROVE_COMMAND_RE = /^approve:([^:]+):(allow|deny)$/;
const CANCEL_COMMAND = "cancel";
/** SSE keepalive comment interval (30s, optional comment frames). */
const KEEPALIVE_MS = 30_000;
/** POST body cap (local tool; guards a runaway client). */
const MAX_BODY_BYTES = 1_000_000;
const STATIC_FILES = {
    "index.html": { contentType: "text/html; charset=utf-8" },
    "app.js": { contentType: "text/javascript; charset=utf-8" },
    "style.css": { contentType: "text/css; charset=utf-8" },
};
class HttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
/**
 * Zero-dependency HTTP server for the local web console: static assets,
 * /api/bootstrap, /api/events (SSE), /api/messages, /api/commands,
 * /api/history, /api/sessions. All inbound chat text is handed to the
 * gateway through the WebChannelAdapter; the server never touches Core
 * directly. Event streaming is a read-only view over the EventStore (same
 * polling pattern as Gateway.poll), enriched like the gateway does for
 * approval pushes.
 */
export class WebServer {
    adapter;
    bindings;
    events;
    store;
    approvalStore;
    host;
    requestedPort;
    pollDelayMs;
    staticDir;
    /** Static assets are read once and cached in memory (dev no-cache headers). */
    staticCache = new Map();
    connections = new Map();
    pendingDeliveries = [];
    server;
    boundPort;
    messageSeq = 0;
    constructor(deps) {
        this.adapter = deps.adapter;
        this.bindings = deps.bindings;
        this.events = deps.events;
        this.store = deps.store;
        this.approvalStore = deps.approvalStore;
        this.host = deps.host ?? process.env.HARNESS_WEB_HOST ?? "127.0.0.1";
        const configuredPort = Number(process.env.HARNESS_WEB_PORT ?? "8787");
        this.requestedPort = deps.port ?? (Number.isInteger(configuredPort) ? configuredPort : 8787);
        this.pollDelayMs = deps.pollDelayMs ?? 150;
        this.staticDir = deps.staticDir ?? join(dirname(fileURLToPath(import.meta.url)), "..", "public");
    }
    /** Actual bound port (useful with port 0 in tests). */
    get port() {
        return this.boundPort;
    }
    async start() {
        if (this.server !== undefined)
            throw new Error("web server already started");
        const server = createServer((req, res) => {
            void (async () => {
                try {
                    await this.handleRequest(req, res);
                }
                catch (err) {
                    try {
                        if (err instanceof HttpError) {
                            this.json(res, err.status, { ok: false, error: err.message });
                            return;
                        }
                        this.json(res, 500, {
                            ok: false,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                    catch {
                        // Response already started (e.g. SSE stream) — nothing left to do.
                    }
                }
            })();
        });
        this.server = server;
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(this.requestedPort, this.host, () => {
                server.removeListener("error", reject);
                resolve();
            });
        });
        const address = server.address();
        const boundPort = address !== null && typeof address === "object" ? address.port ?? this.requestedPort : this.requestedPort;
        this.boundPort = boundPort;
        process.stdout.write(`[web] listening on http://${this.host}:${boundPort}\n`);
        return { host: this.host, port: boundPort };
    }
    async stop() {
        for (const conn of [...this.connections.values()])
            this.closeConnection(conn);
        const server = this.server;
        this.server = undefined;
        if (server === undefined)
            return;
        await new Promise((resolve) => server.close(() => resolve()));
    }
    // --- routing -------------------------------------------------------------
    async handleRequest(req, res) {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname;
        if (req.method === "GET") {
            if (path === "/")
                return this.serveStatic(res, "index.html");
            if (path === "/app.js")
                return this.serveStatic(res, "app.js");
            if (path === "/style.css")
                return this.serveStatic(res, "style.css");
            if (path === "/api/bootstrap")
                return this.handleBootstrap(res, url);
            if (path === "/api/events")
                return this.handleEvents(res, url);
            if (path === "/api/history")
                return this.handleHistory(res, url);
            if (path === "/api/sessions")
                return this.handleSessions(res);
        }
        if (req.method === "POST") {
            if (path === "/api/messages")
                return this.handleMessages(req, res);
            if (path === "/api/commands")
                return this.handleCommands(req, res);
        }
        this.json(res, 404, { ok: false, error: "not found" });
    }
    // --- api handlers ---------------------------------------------------------
    /** Persist the browser's `from` (validated) or mint a fresh one. */
    async handleBootstrap(res, url) {
        const candidate = url.searchParams.get("from");
        const from = candidate !== null && FROM_RE.test(candidate) ? candidate : randomUUID();
        this.json(res, 200, { from });
    }
    /** SSE stream for one `from`: hello frame, raw session events, assistant
     *  text blocks, and the gateway's channel pushes. */
    async handleEvents(res, url) {
        const from = url.searchParams.get("from");
        if (from === null || !FROM_RE.test(from)) {
            this.json(res, 400, { ok: false, error: "invalid from" });
            return;
        }
        const existing = this.connections.get(from);
        if (existing !== undefined)
            this.closeConnection(existing); // reconnect replaces the old stream
        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });
        res.flushHeaders();
        const conn = {
            from,
            res,
            seq: 0,
            assistantCount: await this.initialAssistantCount(from),
            polling: false,
            closed: false,
        };
        this.connections.set(from, conn);
        this.adapter.register(from, {
            writeFrame: (frame) => this.writeFrame(conn, frame),
            close: () => this.closeConnection(conn),
        });
        this.writeFrame(conn, { type: "hello" });
        conn.pollTimer = setInterval(() => {
            void this.poll(conn);
        }, this.pollDelayMs);
        conn.keepaliveTimer = setInterval(() => {
            if (conn.closed)
                return;
            try {
                conn.res.write(": keepalive\n\n");
            }
            catch {
                this.closeConnection(conn);
            }
        }, KEEPALIVE_MS);
        res.on("close", () => this.closeConnection(conn));
    }
    /** User text → gateway (find-or-create session, run turn). */
    async handleMessages(req, res) {
        const { text, from } = await this.readJson(req);
        if (typeof from !== "string" || !FROM_RE.test(from)) {
            this.json(res, 400, { ok: false, error: "invalid from" });
            return;
        }
        if (typeof text !== "string" || text.trim() === "") {
            this.json(res, 400, { ok: false, error: "text is required" });
            return;
        }
        try {
            await this.deliver({ channelId: "web", from, text, messageId: `web_${++this.messageSeq}`, ts: Date.now() });
            this.json(res, 200, { ok: true });
        }
        catch (err) {
            this.json(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
    }
    /** Approval / cancel commands → gateway (mirrors its command grammar). */
    async handleCommands(req, res) {
        const { text, from } = await this.readJson(req);
        if (typeof from !== "string" || !FROM_RE.test(from)) {
            this.json(res, 400, { ok: false, error: "invalid from" });
            return;
        }
        if (typeof text !== "string" || (!APPROVE_COMMAND_RE.test(text) && text !== CANCEL_COMMAND)) {
            this.json(res, 400, { ok: false, error: "unknown command (expected approve:<id>:allow|deny or cancel)" });
            return;
        }
        try {
            await this.deliver({ channelId: "web", from, text, messageId: `web_${++this.messageSeq}`, ts: Date.now() });
            this.json(res, 200, { ok: true });
        }
        catch (err) {
            this.json(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
    }
    /** Past messages of the sender's session (rendered when switching tabs). */
    async handleHistory(res, url) {
        const from = url.searchParams.get("from");
        if (from === null || !FROM_RE.test(from)) {
            this.json(res, 400, { ok: false, error: "invalid from" });
            return;
        }
        const sessionId = this.bindings.get(from);
        if (sessionId === undefined) {
            this.json(res, 200, { sessionId: null, messages: [] });
            return;
        }
        const messages = await this.store.listMessages(sessionId);
        this.json(res, 200, { sessionId, messages });
    }
    /** Known conversations (from → session) with a first-message label. */
    async handleSessions(res) {
        const sessions = [];
        for (const { from, sessionId } of this.bindings.all()) {
            let createdAt;
            let firstText;
            try {
                const session = await this.store.getSession(sessionId);
                createdAt = session?.createdAt;
                const messages = await this.store.listMessages(sessionId);
                firstText = messages.find((m) => m.role === "user")?.content;
            }
            catch {
                // Stale binding (store read failure) — still list the id.
            }
            sessions.push({ from, sessionId, ...(createdAt !== undefined ? { createdAt } : {}), ...(firstText !== undefined ? { firstText } : {}) });
        }
        this.json(res, 200, { sessions });
    }
    // --- event streaming ------------------------------------------------------
    async poll(conn) {
        if (conn.closed || conn.polling)
            return;
        const sessionId = this.bindings.get(conn.from);
        if (sessionId === undefined)
            return; // no session bound for this sender yet
        conn.polling = true;
        try {
            const events = await this.events.list(sessionId, { afterSequence: conn.seq });
            let last = conn.seq;
            for (const ev of events) {
                last = ev.sequence;
                if (conn.closed)
                    return;
                this.writeFrame(conn, { type: "event", event: this.enrich(ev) });
            }
            conn.seq = last;
            await this.pushAssistantText(conn, sessionId);
        }
        catch {
            // Transient store errors must not kill the stream; the next tick retries.
        }
        finally {
            conn.polling = false;
        }
    }
    /**
     * Approval pushes carry the full §162 fields (action/agentId/policyRule) by
     * joining the pending request — the same enrichment the gateway performs in
     * eventToMessage; the raw event payload only has approvalId/target/reason.
     */
    enrich(ev) {
        if (ev.type !== "approval.created")
            return ev;
        const rawId = ev.payload.approvalId;
        const request = typeof rawId === "string" ? this.approvalStore.listPending().find((r) => r.id === rawId) : undefined;
        if (request === undefined)
            return ev;
        return {
            ...ev,
            payload: {
                ...ev.payload,
                action: request.action,
                agentId: request.agentId,
                ...(request.policyRule !== undefined ? { policyRule: request.policyRule } : {}),
            },
        };
    }
    /**
     * The runtime stores only completed assistant messages (it consumes the
     * model's text_delta stream internally — no per-token events on the trail),
     * so assistant text arrives as a whole block. The cursor is seeded when the
     * stream connects: history is served by /api/history, this channel only
     * forwards NEW messages.
     */
    async initialAssistantCount(from) {
        const sessionId = this.bindings.get(from);
        if (sessionId === undefined)
            return 0;
        try {
            const messages = await this.store.listMessages(sessionId);
            return messages.filter((m) => m.role === "assistant").length;
        }
        catch {
            return 0;
        }
    }
    async pushAssistantText(conn, sessionId) {
        const messages = await this.store.listMessages(sessionId);
        const assistants = messages.filter((m) => m.role === "assistant");
        while (conn.assistantCount < assistants.length) {
            const message = assistants[conn.assistantCount];
            if (message === undefined)
                break;
            conn.assistantCount += 1;
            if (conn.closed)
                return;
            this.writeFrame(conn, {
                type: "assistant_text",
                messageId: message.id,
                turnId: message.turnId,
                text: message.content,
            });
        }
    }
    // --- plumbing ---------------------------------------------------------------
    /**
     * Messages are delivered strictly one at a time so the pendingFrom
     * correlation in SessionBindings is exact: the session created while this
     * message is being processed belongs to this sender.
     */
    deliver(msg) {
        const previous = this.pendingDeliveries.at(-1);
        const run = previous === undefined ? this.deliverOne(msg) : previous.then(() => this.deliverOne(msg));
        // Keep only the tail, swallowing rejections: one failed delivery must
        // never block the next (the caller still sees the rejection via `run`).
        this.pendingDeliveries.length = 0;
        this.pendingDeliveries.push(run.catch(() => undefined));
        return run;
    }
    async deliverOne(msg) {
        this.bindings.pendingFrom = msg.from;
        try {
            await this.adapter.deliver(msg);
        }
        finally {
            this.bindings.pendingFrom = undefined;
        }
    }
    writeFrame(conn, frame) {
        if (conn.closed)
            return;
        try {
            conn.res.write(`data: ${JSON.stringify(frame)}\n\n`);
        }
        catch {
            this.closeConnection(conn);
        }
    }
    closeConnection(conn) {
        if (conn.closed)
            return;
        conn.closed = true;
        if (conn.pollTimer !== undefined)
            clearInterval(conn.pollTimer);
        if (conn.keepaliveTimer !== undefined)
            clearInterval(conn.keepaliveTimer);
        if (this.connections.get(conn.from) === conn) {
            this.connections.delete(conn.from);
            this.adapter.unregister(conn.from);
        }
        try {
            conn.res.end();
        }
        catch {
            // Already closed by the client.
        }
    }
    /** Static assets are cached in memory after the first read. */
    async serveStatic(res, name) {
        const cached = this.staticCache.get(name);
        if (cached !== undefined) {
            res.writeHead(200, {
                "Content-Type": cached.contentType,
                "Cache-Control": "no-cache", // development convenience: always fresh
            });
            res.end(cached.body);
            return;
        }
        let body;
        try {
            body = await readFile(join(this.staticDir, name));
        }
        catch {
            this.json(res, 404, { ok: false, error: "not found" });
            return;
        }
        const entry = { contentType: STATIC_FILES[name].contentType, body };
        this.staticCache.set(name, entry);
        res.writeHead(200, {
            "Content-Type": entry.contentType,
            "Cache-Control": "no-cache", // development convenience: always fresh
        });
        res.end(entry.body);
    }
    async readJson(req) {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buf.length;
            if (size > MAX_BODY_BYTES)
                throw new HttpError(413, "body too large");
            chunks.push(buf);
        }
        try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            return typeof parsed === "object" && parsed !== null ? parsed : {};
        }
        catch {
            throw new HttpError(400, "invalid JSON body");
        }
    }
    json(res, status, body) {
        const payload = JSON.stringify(body);
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
        res.end(payload);
    }
}
//# sourceMappingURL=server.js.map