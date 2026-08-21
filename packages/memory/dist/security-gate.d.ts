import type { MemoryEntry } from "@ar/contracts";
export interface SecurityDeniedEvent {
    detection: "injection" | "secret";
    reasons: string[];
    content: string;
    /** P0-7: which gate surfaced the denial (e.g. "memory-store",
     *  "sqlite-memory-store"), so hosts can attribute the rejection. */
    source: string;
}
export interface UnsafeMemory {
    message: string;
    event: SecurityDeniedEvent;
}
/** Check content for injection or secrets; return the reason or null. */
export declare function checkUnsafeMemory(content: string, source: string): UnsafeMemory | null;
/** Scan persisted entries for injection and secrets (Task B). */
export declare function scanMemoryEntries(entries: MemoryEntry[]): Array<{
    entry: MemoryEntry;
    issues: {
        detection: "injection" | "secret";
        reasons: string[];
    }[];
}>;
//# sourceMappingURL=security-gate.d.ts.map