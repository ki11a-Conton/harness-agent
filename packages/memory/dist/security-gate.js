import { detectPromptInjection, detectSecrets } from "@ar/security";
/** Check content for injection or secrets; return the reason or null. */
export function checkUnsafeMemory(content, source) {
    const injection = detectPromptInjection(content);
    if (injection.hasInjection) {
        return { message: `injection detected (${injection.reasons.join(", ")})`, event: { detection: "injection", reasons: injection.reasons, content, source } };
    }
    const secret = detectSecrets(content);
    if (secret.hasSecret) {
        return { message: `secret detected (${secret.secrets.join(", ")})`, event: { detection: "secret", reasons: secret.secrets, content, source } };
    }
    return null;
}
/** Scan persisted entries for injection and secrets (Task B). */
export function scanMemoryEntries(entries) {
    const results = [];
    for (const entry of entries) {
        const issues = [];
        const injection = detectPromptInjection(entry.content);
        if (injection.hasInjection)
            issues.push({ detection: "injection", reasons: injection.reasons });
        const secret = detectSecrets(entry.content);
        if (secret.hasSecret)
            issues.push({ detection: "secret", reasons: secret.secrets });
        if (issues.length > 0)
            results.push({ entry, issues });
    }
    return results;
}
//# sourceMappingURL=security-gate.js.map