import { createHash } from "node:crypto";
import { stableStringify } from "./serialization.js";
/**
 * P1-3 Durable Checkpoint — the serializable snapshot of a turn's run state
 * at a safe boundary (after a successful side-effect tool, after compaction,
 * after a verification gate, periodically). Every consumer of "where did we
 * get to" (resume, observability, evaluation) reads this single structure.
 *
 * Integrity contract:
 * - `schemaVersion` is fixed at CHECKPOINT_SCHEMA_VERSION; readers reject
 *   records with an unsupported version (they must not be silently parsed).
 * - `checksum` is a SHA-256 over the stable-JSON of every other field, so a
 *   torn/bad write is detectable on load and must never displace the last
 *   valid checkpoint.
 */
export const CHECKPOINT_SCHEMA_VERSION = 1;
/** Compute the stable args hash used by the tool ledger (same canonical
 *  serialization as the checkpoint checksum). */
export function computeArgsHash(args) {
    return createHash("sha256").update(stableStringifyForChecksum(args)).digest("hex");
}
/** Stable JSON serialization with sorted object keys — the checksum basis.
 *  Semantics mirror JSON.stringify so a value survives a write→parse
 *  round-trip with the same checksum: object keys holding `undefined` are
 *  omitted, array `undefined` slots become `null`, BigInt is rejected and
 *  cyclic values fail explicitly. Delegates to the Q-5 canonical
 *  `stableStringify` so args/config/checkpoint hashes all share one
 *  implementation. */
export function stableStringifyForChecksum(value) {
    return stableStringify(value);
}
/** SHA-256 checksum over the canonical payload (every field but checksum). */
export function computeCheckpointChecksum(payload) {
    return createHash("sha256").update(stableStringifyForChecksum(payload)).digest("hex");
}
/** Build a checkpoint with its integrity checksum precomputed. */
export function buildCheckpoint(payload) {
    return { ...payload, checksum: computeCheckpointChecksum(payload) };
}
export const DEFAULT_CHECKPOINT_POLICY = {
    afterSideEffectTools: true,
    afterCompaction: true,
    afterVerification: true,
    everyNIterations: 5,
};
//# sourceMappingURL=checkpoint.js.map