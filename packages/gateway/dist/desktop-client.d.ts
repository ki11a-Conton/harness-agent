import type { AgentEvent, ApprovalStore } from "@ar/contracts";
import type { InMemoryTransport } from "./transport.js";
/** Constructor options for the §85 desktop client. */
export interface DesktopClientOptions {
    /**
     * Client endpoint of a transport pair whose server side is bound to the
     * runtime RPC registry (createRuntimeRpc). This is the client's ONLY
     * runtime-facing dependency: every method forwards through it.
     */
    transport: InMemoryTransport;
    /** Agent + cwd used by createSession when its arguments are omitted. */
    sessionDefaults?: {
        agentId: string;
        cwd: string;
    };
    /**
     * §162 approval-UI exception: read-only pending lookup. The §84 RPC
     * surface has no pending-approval listing method, so the client reads
     * pending requests through this injected store — never mutating it;
     * every decision still goes through the session.approve RPC.
     */
    approvalStore?: ApprovalStore;
    /** Event-poll interval for run()/subscribe() (tests use small values). */
    pollDelayMs?: number;
}
/**
 * Desktop client (§85): the desktop owns rendering, interaction, approval
 * UI, session browsing, and event display — never the agent loop, tool
 * execution, permission logic, or session persistence. This class is a thin
 * UI-facing surface over the §84 RPC methods; it holds no direct reference
 * to the runtime, registry, session store, or event store.
 */
export declare class DesktopClient {
    #private;
    constructor(opts: DesktopClientOptions);
    createSession(agentId?: string, cwd?: string): Promise<{
        sessionId: string;
    }>;
    send(sessionId: string, text: string): Promise<{
        turnId: string;
    }>;
    /**
     * Run a turn and return its outcome. While the turn is running, the
     * session's event stream is exposed to the UI layer (§85 event display)
     * by incremental polling of the session.subscribe RPC. The callback
     * receives the session's events from its start, so a full run is covered
     * (turn.started → tool.* → turn.completed); the UI filters by
     * turnId/sessionId. A final drain after the run settles guarantees the
     * terminal events are delivered even when the run finishes between polls.
     */
    run(sessionId: string, turnId: string, onEvent?: (e: AgentEvent) => void): Promise<{
        status: string;
        toolCalls: number;
        iterations: number;
    }>;
    cancel(sessionId: string, turnId: string): Promise<{
        status: string;
    }>;
    resume(sessionId: string): Promise<{
        session: unknown;
    }>;
    approve(approvalId: string, allow: boolean, decidedBy?: string): Promise<{
        value: string;
    }>;
    /**
     * Pending approvals for the §162 approval UI. The RPC surface has no
     * pending-approval listing method, so this reads the injected store
     * read-only (see DesktopClientOptions.approvalStore); decisions still go
     * through session.approve RPC.
     */
    listPendingApprovals(): Promise<unknown[]>;
    /**
     * Subscribe to a session's event stream (§85 event display). The §84 RPC
     * surface only provides snapshots (session.subscribe returns the event
     * list — EventStore.stream is server-side), so delivery is snapshot +
     * incremental polling, the portable choice; a future streaming RPC
     * wrapping EventStore.stream can replace this loop. Resolves when
     * `signal` aborts; without a signal the subscription keeps polling.
     */
    subscribe(sessionId: string, afterSequence?: number, onEvent?: (e: AgentEvent) => void, signal?: AbortSignal): Promise<void>;
}
//# sourceMappingURL=desktop-client.d.ts.map