import type { ErrorCode, MemoryCandidate } from "@ar/contracts";
/**
 * §67 memory write gate policy. All thresholds are inclusive (a candidate
 * equal to the threshold is allowed) and configurable.
 */
export interface MemoryWritePolicy {
    /** Minimum importance for explicit/procedural candidates (default 0.6). */
    minImportance: number;
    /** Minimum novelty for every candidate (default 0.4). */
    minNovelty: number;
    /** Higher importance bar for episodic candidates (default 0.8, §67). */
    episodicMinImportance: number;
}
export declare const DEFAULT_MEMORY_WRITE_POLICY: MemoryWritePolicy;
export interface WriteGateResult {
    allowed: boolean;
    /** Empty when allowed; otherwise names the failing criterion. */
    reason: string;
    /** P0-7: security-deny error code (injection → INJECTION_DENIED, secret → SECRET_REDACTED). Undefined for quota denials. */
    code?: ErrorCode;
    /** P0-7: subsystem that surfaced the denial ("memory-write-gate"). */
    source?: string;
    /** P0-7: named sub-detections (injection reasons / secret kinds). */
    details?: string[];
}
/**
 * §67 write gate: candidate -> importance -> novelty -> policy -> persist.
 *
 * The default policy does not persist every candidate: importance >= 0.6 and
 * novelty >= 0.4 are required, and episodic memories carry a higher bar
 * (importance >= 0.8). There is intentionally no API for unlimited automatic
 * writes: no bulk write exists, and every persistence flow must evaluate a
 * candidate here first (memory is learned, probabilistic, and must never
 * silently override authoritative architecture, §146).
 */
export declare function evaluateCandidate(candidate: MemoryCandidate, policy?: MemoryWritePolicy): WriteGateResult;
//# sourceMappingURL=write-gate.d.ts.map