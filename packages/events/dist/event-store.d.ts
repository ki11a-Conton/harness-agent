import type { AgentEvent, EventStore, SessionId } from "@ar/contracts";
export declare class JSONLEventStore implements EventStore {
    private readonly dataDir;
    private appendChain;
    private readonly cache;
    /** P5-1: observable read traffic — total JSONL lines parsed. Lets the perf
     *  test prove linear (not quadratic) append behaviour without wall-clock
     *  thresholds. */
    private linesReadTotal;
    constructor(opts: {
        dataDir: string;
    });
    /** P5-1: introspection for the performance test — how many JSONL lines were
     *  actually read off disk since construction. */
    debugStats(): {
        linesRead: number;
        cachedSessions: number;
    };
    /** P5-5 (JSONL side): drop the in-memory cache for a session so the next
     *  read re-syncs from disk (used by cross-instance tests). */
    clearCache(sessionId?: SessionId): void;
    private filePath;
    private readEvents;
    /** P5-2: cache-backed load — first touch reads the file once, later reads
     *  are O(1) memory hits (single-process store; see class docs). */
    private load;
    private enqueue;
    /**
     * Append an event and assign its authoritative sequence.
     *
     * P2-33 determinism guarantees:
     * 1. Globally monotonic per session — the sequence is always derived from
     *    the last persisted event (last sequence + 1), never from a caller-supplied
     *    value. The store is the sole sequence authority: any `sequence` present on
     *    the incoming event is overwritten, so a parallel producer's stale or
     *    guessed sequence can never corrupt the total order.
     * 2. Ordered append — all appends are serialized through [[appendChain]], so
     *    parallel tool/subagent completions receive distinct, strictly increasing
     *    sequences in append order.
     * 3. Real timestamps — the caller's `timestamp` is preserved verbatim (it is
     *    the moment the completion actually happened, which may differ from append
     *    time). Replay reads the order from `sequence` only, never from wall-clock.
     *
     * A caller-supplied `timestamp` that is not a finite, non-negative number is
     * rejected so replay never has to cope with NaN/negative timestamps.
     */
    append(event: AgentEvent): Promise<AgentEvent>;
    list(sessionId: SessionId, opts?: {
        afterSequence?: number;
        limit?: number;
    }): Promise<AgentEvent[]>;
    stream(sessionId: SessionId, opts?: {
        afterSequence?: number;
    }): AsyncIterable<AgentEvent>;
    nextSequence(sessionId: SessionId): Promise<number>;
    /**
     * P2-35 backup: copy the whole event store to `<dataDir>/backups/<stamp>/`,
     * excluding temp files and the `backups` directory itself.
     */
    backup(opts?: {
        now?: () => Date;
    }): Promise<{
        path: string;
        files: number;
        bytes: number;
    }>;
}
//# sourceMappingURL=event-store.d.ts.map