import type { DiscoveredInstruction, InstructionDiscovery, InstructionDiscoveryOptions } from "@ar/contracts";
/**
 * Hierarchical instruction discovery (CTX-001).
 *
 * Scope semantics:
 * - "root":   the topmost AGENTS.md found while walking up the ancestor chain
 *             of cwd (the climb stops at the first ancestor without the file,
 *             or at the filesystem root). Listed first in the result.
 * - "nested": AGENTS.md files found under cwd's subtree; the scan starts at
 *             cwd's child directories (never cwd itself), skips the
 *             allowlisted directories above and does not follow symlinks.
 *             Listed by ascending directory depth (ties by path).
 * - "cwd":    cwd's own AGENTS.md, listed last. When that document is also
 *             the topmost of the ancestor chain (cwd is the repository root),
 *             it appears exactly once with scope "cwd" (no separate root).
 *
 * The three scopes are mutually exclusive buckets: a path is never reported
 * twice. Ancestor-chain documents strictly between cwd and the topmost root
 * fit no bucket and are not reported.
 *
 * Reading is best-effort: a document that cannot be read (EACCES, race) is
 * skipped silently. An invalid cwd (missing, not a directory) rejects.
 */
export declare class HierarchicalInstructionDiscovery implements InstructionDiscovery {
    discover(cwd: string, opts?: InstructionDiscoveryOptions): Promise<DiscoveredInstruction[]>;
    private findAncestorDocs;
    /** Seeds the nested scan at cwd's child directories (never cwd itself). */
    private scanNestedChildren;
    private scanNestedDir;
    private readDoc;
}
//# sourceMappingURL=discovery.d.ts.map