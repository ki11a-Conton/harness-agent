/**
 * Issue 6b: secret detection gate for memory persistence.
 *
 * Structured patterns for API keys, tokens, private keys, and credential
 * assignments. Mirror of the injection-gate discipline: word-boundary,
 * case-insensitive, structured (not naive substring).
 */
export interface SecretReport {
    hasSecret: boolean;
    /** Matched secret-family names (empty when allowed). */
    secrets: string[];
}
export declare function detectSecrets(content: string): SecretReport;
/**
 * P0-7: replace every matched secret span with "[redacted]" so secret-bearing
 * content can safely cross boundaries (tool-output artifacts, provider error
 * summaries). Returns the redacted content and how many spans were replaced.
 * Patterns are applied in registration order; an already-redacted span cannot
 * match any later pattern, so replacements never stack.
 */
export declare function redactSecrets(content: string): {
    content: string;
    redacted: number;
};
//# sourceMappingURL=secret-gate.d.ts.map