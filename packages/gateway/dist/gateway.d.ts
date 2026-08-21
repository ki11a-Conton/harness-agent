import type { AgentId, ApprovalStore, EventStore, SessionId } from "@ar/contracts";
import type { SessionService } from "@ar/session";
import type { ChannelAdapter } from "./channel.js";
import type { RpcMethodRegistry } from "./rpc.js";
export interface GatewayDeps {
    /** §84 method surface; the gateway drives sessions only through it. */
    rpc: RpcMethodRegistry;
    channels: ChannelAdapter[];
    /** Validates session ids handed back by `route` before reuse. */
    sessionService: SessionService;
    /** Read-only pending-request lookup so approval pushes carry full §162 fields. */
    approvalStore: ApprovalStore;
    /** Session events pushed back to channels; sink for §175 human.* events. */
    events: EventStore;
    /** Existing-session mapping by sender; undefined means "create a new session". */
    route?: (from: string) => SessionId | undefined;
    /** Agent + cwd used when a session must be created for an unknown sender. */
    sessionDefaults?: {
        agentId: AgentId;
        cwd: string;
    };
    /** Event-push poll interval (tests use small values). */
    pollDelayMs?: number;
    now?: () => number;
}
/**
 * Chat-channel gateway (§83): routes channel messages into sessions through
 * the §84 RPC surface only (no Core reach-through), forwards approval
 * decisions, pushes session events back to channels, and records §175 human
 * intervention events. Channel-specific logic stays inside adapters.
 */
export declare class Gateway {
    private readonly rpc;
    private readonly channels;
    private readonly sessionService;
    private readonly approvalStore;
    private readonly events;
    private readonly route?;
    private readonly sessionDefaults?;
    private readonly pollDelayMs;
    private readonly now;
    /** `${channelId}:${from}` → bound session id. */
    private readonly sessionByUser;
    /** session id → recipient for event pushes. */
    private readonly recipientBySession;
    private readonly lastTurnBySession;
    private readonly lastSequenceBySession;
    private readonly pollers;
    private started;
    constructor(deps: GatewayDeps);
    start(): Promise<void>;
    stop(): Promise<void>;
    private handleMessage;
    /** User text: find-or-create the sender's session, then send+run the turn. */
    private handleUserMessage;
    /** Find or create the session for a sender; replies when creation is impossible. */
    private bindSession;
    private runTurnAndReply;
    /** `approve:<id>:allow|deny`: resolve through session.approve, record §175. */
    private handleApproval;
    /** `cancel`: abort the sender's running turn (§175 human.cancel semantics). */
    private handleCancel;
    private startPoller;
    private poll;
    /** Map a session event to the channel text pushed to the user (others: ignore). */
    private eventToMessage;
    /** Record a §175 human intervention event on the session stream. */
    private emitHuman;
    private reply;
    private userKey;
}
//# sourceMappingURL=gateway.d.ts.map