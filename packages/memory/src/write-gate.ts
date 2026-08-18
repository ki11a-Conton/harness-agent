import type { MemoryCandidate } from "@ar/contracts";
import { detectPromptInjection, detectSecrets } from "@ar/security";

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

export const DEFAULT_MEMORY_WRITE_POLICY: MemoryWritePolicy = {
  minImportance: 0.6,
  minNovelty: 0.4,
  episodicMinImportance: 0.8,
};

export interface WriteGateResult {
  allowed: boolean;
  /** Empty when allowed; otherwise names the failing criterion. */
  reason: string;
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
export function evaluateCandidate(
  candidate: MemoryCandidate,
  policy: MemoryWritePolicy = DEFAULT_MEMORY_WRITE_POLICY,
): WriteGateResult {
  const isEpisodic = candidate.type === "episodic";
  const importanceThreshold = isEpisodic
    ? policy.episodicMinImportance
    : policy.minImportance;

  // Security checks first (Issue 6/6b): injected content and secrets must
  // never be persisted, regardless of importance or novelty.
  const injection = detectPromptInjection(candidate.content);
  if (injection.hasInjection) {
    return {
      allowed: false,
      reason: `injection detected: ${injection.reasons.join(", ")}`,
    };
  }
  const secret = detectSecrets(candidate.content);
  if (secret.hasSecret) {
    return {
      allowed: false,
      reason: `secret detected: ${secret.secrets.join(", ")}`,
    };
  }

  if (candidate.importance < importanceThreshold) {
    return {
      allowed: false,
      reason: `importance ${candidate.importance} below threshold ${importanceThreshold}${
        isEpisodic ? " (episodic)" : ""
      }`,
    };
  }
  if (candidate.novelty < policy.minNovelty) {
    return {
      allowed: false,
      reason: `novelty ${candidate.novelty} below threshold ${policy.minNovelty}`,
    };
  }
  return { allowed: true, reason: "" };
}
