import type { AdmittedPrompt, InboxStore, PromptId, PromptKind, SessionId } from "@ar/contracts";
/**
 * Session inbox (plan.md Phase 1 Issue 3 / Phase 5.3).
 *
 * User input arriving while a turn is running is ADMITTED first, then routed:
 * steer → injected into the running turn at the next safe boundary; followup
 * → queued for a new turn after the current one ends. The two kinds never
 * share one queue.
 */
export declare class SessionInbox {
    private readonly store;
    constructor(store: InboxStore);
    /** Admit user input; the runtime drains `steer` prompts, the host drains
     *  `followup` prompts to start new turns. */
    admit(sessionId: SessionId, text: string, kind?: PromptKind, now?: () => number): Promise<AdmittedPrompt>;
    listPending(sessionId: SessionId): Promise<AdmittedPrompt[]>;
    /** Next follow-up prompt for the outer loop, or undefined when the queue is
     *  empty. Promoted so a crashed host does not re-start the same turn. */
    nextFollowup(sessionId: SessionId): Promise<AdmittedPrompt | undefined>;
    /** Mark a prompt consumed (its message was appended to the session). */
    consume(id: PromptId): Promise<void>;
}
/** In-memory inbox (tests, one-shot hosts). */
export declare class MemInboxStore implements InboxStore {
    prompts: AdmittedPrompt[];
    admit(prompt: AdmittedPrompt): Promise<void>;
    listPending(sessionId: SessionId): Promise<AdmittedPrompt[]>;
    listAll(sessionId: SessionId): Promise<AdmittedPrompt[]>;
    markPromoted(id: PromptId): Promise<void>;
    markConsumed(id: PromptId): Promise<void>;
}
export interface JSONLInboxStoreOptions {
    dataDir: string;
}
/** JSONL inbox: one AdmittedPrompt per line at <dataDir>/inbox.jsonl.
 *  Corrupt lines are skipped (same policy as the memory store). */
export declare class JSONLInboxStore implements InboxStore {
    private readonly file;
    private loaded;
    private prompts;
    constructor(opts: JSONLInboxStoreOptions);
    admit(prompt: AdmittedPrompt): Promise<void>;
    listPending(sessionId: SessionId): Promise<AdmittedPrompt[]>;
    listAll(sessionId: SessionId): Promise<AdmittedPrompt[]>;
    markPromoted(id: PromptId): Promise<void>;
    markConsumed(id: PromptId): Promise<void>;
    private update;
    private lockKey;
    private load;
    private persist;
    /**
     * P2-35 backup: copy the inbox file to `<dataDir>/backups/<stamp>/`.
     */
    backup(): Promise<{
        path: string;
        files: number;
        bytes: number;
    }>;
}
//# sourceMappingURL=inbox.d.ts.map