import type { ModelRef } from "@ar/contracts";

/**
 * P6-5: TokenEstimator — the single token-estimation seam. The pipeline and
 * runtime count context tokens through this interface; hosts that have a real
 * provider tokenizer can swap the heuristic without touching call sites.
 * No hard dependency on any single vendor's tokenizer: `estimate` falls back
 * to the byte heuristic when a model does not expose one.
 */
export interface TokenEstimator {
  estimate(text: string, model?: ModelRef): number;
}

/** ~4 UTF-8 bytes per token — the project-wide fallback (matches the compactor
 *  heuristic and CTX-001's byte budget). Deterministic and dependency-free. */
export class HeuristicTokenEstimator implements TokenEstimator {
  estimate(text: string): number {
    return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
  }
}

/** Default instance shared by pipeline/runtime call sites. */
export const DEFAULT_TOKEN_ESTIMATOR: TokenEstimator = new HeuristicTokenEstimator();
