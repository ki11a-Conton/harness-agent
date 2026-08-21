/** ~4 UTF-8 bytes per token — the project-wide fallback (matches the compactor
 *  heuristic and CTX-001's byte budget). Deterministic and dependency-free. */
export class HeuristicTokenEstimator {
    estimate(text) {
        return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
    }
}
/** Default instance shared by pipeline/runtime call sites. */
export const DEFAULT_TOKEN_ESTIMATOR = new HeuristicTokenEstimator();
//# sourceMappingURL=tokenizer.js.map