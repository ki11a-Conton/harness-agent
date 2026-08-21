import type { CompactionSummary, Compactor, ContextBlock } from "@ar/contracts";
export declare function isCompactable(block: ContextBlock): boolean;
/**
 * Default implementation of the CTX-003 `Compactor` contract.
 *
 * Pure function for a given (blocks, summary) pair except for `timestamp`
 * (Date.now()) on the generated summary block, which is intentionally
 * non-deterministic per spec. No I/O.
 */
export declare class DefaultCompactor implements Compactor {
    private readonly nowFn;
    constructor(opts?: {
        now?: () => number;
    });
    compact(blocks: ContextBlock[], summary: CompactionSummary): ContextBlock[];
}
//# sourceMappingURL=compaction.d.ts.map