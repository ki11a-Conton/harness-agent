import type { ApprovalStore, EventStore, SessionStore } from "@ar/contracts";
import type { SessionBindings } from "./bindings.js";
import type { WebChannelAdapter } from "./adapter.js";
/** Browser identity format: [A-Za-z0-9-]{8,64} (uuid v4 fits). */
export declare const FROM_RE: RegExp;
export interface WebServerDeps {
    adapter: WebChannelAdapter;
    bindings: SessionBindings;
    events: EventStore;
    store: SessionStore;
    approvalStore: ApprovalStore;
    /** Defaults: 127.0.0.1:8787 — loopback only, overridable via env. */
    host?: string;
    port?: number;
    /** Raw-event poll interval (tests use small values). */
    pollDelayMs?: number;
    /** Directory holding index.html / app.js / style.css. */
    staticDir?: string;
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
export declare class WebServer {
    private readonly adapter;
    private readonly bindings;
    private readonly events;
    private readonly store;
    private readonly approvalStore;
    private readonly host;
    private readonly requestedPort;
    private readonly pollDelayMs;
    private readonly staticDir;
    /** Static assets are read once and cached in memory (dev no-cache headers). */
    private readonly staticCache;
    private readonly connections;
    private readonly pendingDeliveries;
    private server?;
    private boundPort?;
    private messageSeq;
    constructor(deps: WebServerDeps);
    /** Actual bound port (useful with port 0 in tests). */
    get port(): number | undefined;
    start(): Promise<{
        host: string;
        port: number;
    }>;
    stop(): Promise<void>;
    private handleRequest;
    /** Persist the browser's `from` (validated) or mint a fresh one. */
    private handleBootstrap;
    /** SSE stream for one `from`: hello frame, raw session events, assistant
     *  text blocks, and the gateway's channel pushes. */
    private handleEvents;
    /** User text → gateway (find-or-create session, run turn). */
    private handleMessages;
    /** Approval / cancel commands → gateway (mirrors its command grammar). */
    private handleCommands;
    /** Past messages of the sender's session (rendered when switching tabs). */
    private handleHistory;
    /** Known conversations (from → session) with a first-message label. */
    private handleSessions;
    private poll;
    /**
     * Approval pushes carry the full §162 fields (action/agentId/policyRule) by
     * joining the pending request — the same enrichment the gateway performs in
     * eventToMessage; the raw event payload only has approvalId/target/reason.
     */
    private enrich;
    /**
     * The runtime stores only completed assistant messages (it consumes the
     * model's text_delta stream internally — no per-token events on the trail),
     * so assistant text arrives as a whole block. The cursor is seeded when the
     * stream connects: history is served by /api/history, this channel only
     * forwards NEW messages.
     */
    private initialAssistantCount;
    private pushAssistantText;
    /**
     * Messages are delivered strictly one at a time so the pendingFrom
     * correlation in SessionBindings is exact: the session created while this
     * message is being processed belongs to this sender.
     */
    private deliver;
    private deliverOne;
    private writeFrame;
    private closeConnection;
    /** Static assets are cached in memory after the first read. */
    private serveStatic;
    private readJson;
    private json;
}
//# sourceMappingURL=server.d.ts.map