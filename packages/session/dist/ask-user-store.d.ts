import type { AskId, AskUserReply, AskUserRequest, AskUserStore, SessionId } from "@ar/contracts";
/**
 * P1-4: JSONL ask-user store — durable, crash-safe pending questions.
 * One AskUserRequest per line at <dataDir>/ask-users.jsonl. Corrupt lines are
 * skipped (same policy as the inbox / memory stores).
 */
export interface JSONLAskUserStoreOptions {
    dataDir: string;
}
export declare class JSONLAskUserStore implements AskUserStore {
    private readonly file;
    private loaded;
    private asks;
    constructor(opts: JSONLAskUserStoreOptions);
    create(request: AskUserRequest): Promise<void>;
    get(id: AskId): Promise<AskUserRequest | undefined>;
    listPending(sessionId: SessionId): Promise<AskUserRequest[]>;
    markAnswered(id: AskId, reply: AskUserReply): Promise<void>;
    markWithdrawn(id: AskId): Promise<void>;
    private lockKey;
    private load;
    private persist;
}
//# sourceMappingURL=ask-user-store.d.ts.map