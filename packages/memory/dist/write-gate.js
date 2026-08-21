import { detectPromptInjection, detectSecrets } from "@ar/security";
export const DEFAULT_MEMORY_WRITE_POLICY = {
    minImportance: 0.6,
    minNovelty: 0.4,
    episodicMinImportance: 0.8,
};
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
export function evaluateCandidate(candidate, policy = DEFAULT_MEMORY_WRITE_POLICY) {
    const isEpisodic = candidate.type === "episodic";
    const importanceThreshold = isEpisodic
        ? policy.episodicMinImportance
        : policy.minImportance;
    // Security checks first (Issue 6/6b): injected content and secrets must
    // never be persisted, regardless of importance or novelty. The denial is
    // structured (P0-7) — code + source + details — so it can be surfaced on
    // the event stream, not just as a bare stderr message.
    const injection = detectPromptInjection(candidate.content);
    if (injection.hasInjection) {
        return {
            allowed: false,
            reason: `injection detected: ${injection.reasons.join(", ")}`,
            code: "INJECTION_DENIED",
            source: "memory-write-gate",
            details: injection.reasons,
        };
    }
    const secret = detectSecrets(candidate.content);
    if (secret.hasSecret) {
        return {
            allowed: false,
            reason: `secret detected: ${secret.secrets.join(", ")}`,
            code: "SECRET_REDACTED",
            source: "memory-write-gate",
            details: secret.secrets,
        };
    }
    if (candidate.importance < importanceThreshold) {
        return {
            allowed: false,
            reason: `importance ${candidate.importance} below threshold ${importanceThreshold}${isEpisodic ? " (episodic)" : ""}`,
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
//# sourceMappingURL=write-gate.js.map