/**
 * Issue 6: prompt-injection detection gate for memory and skill persistence.
 *
 * Two-tier detection (structured, not naive substring — same discipline as
 * the network gate):
 *
 * - HARD patterns: unambiguous instruction-hijack families (dismissing
 *   previous instructions, overriding the system prompt, extracting the
 *   prompt, role-reversal, restriction bypass). Any hit denies the content.
 * - SOFT signals: directive framing combined with a command payload, plus
 *   standalone trap markers (decode-and-run, authority notices). These only
 *   produce flags and never deny: legitimate procedural lessons ("you must
 *   run node test.js to complete the task") share this shape.
 *
 * Scanning is line-aware so one poisoned line cannot hide inside otherwise
 * benign prose, and case-insensitive so casing tricks do not bypass it.
 */
export interface InjectionReport {
    hasInjection: boolean;
    /** Hard-pattern names that deny the content (empty when allowed). */
    reasons: string[];
    /** Soft-signal names worth surfacing (never a deny). */
    flags: string[];
}
export declare function detectPromptInjection(content: string): InjectionReport;
//# sourceMappingURL=injection-gate.d.ts.map