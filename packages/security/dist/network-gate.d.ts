/**
 * Phase 9 network gate: structured detection of network intent in exec
 * commands. This is NOT a naive substring scan of the command text — the
 * command is tokenized with shell quoting/separator awareness, and each
 * classification (binary / subcommand / URL literal / interpreter inline
 * code / encoded shell) is checked at its correct position, so benign
 * lookalikes (`echo curl`, `type curl.md`, `git status`) stay allowed.
 *
 * The gate is a best-effort static classifier: commands like `node script.js`
 * whose network activity lives inside a file are only caught when a URL or
 * host literal appears in the argument list. OS-level network namespaces are
 * out of scope for this harness.
 */
export interface NetworkIntentReport {
    hasNetworkIntent: boolean;
    /** Human-readable reasons, joined into the deny message / security event. */
    reasons: string[];
    /** Detected hosts (hostname, IP, or host:port host) for allowlist checks. */
    hosts: string[];
}
/**
 * Detect whether a shell command line carries network intent.
 * Pure, deterministic, no side effects.
 */
export declare function detectNetworkIntent(command: string): NetworkIntentReport;
//# sourceMappingURL=network-gate.d.ts.map