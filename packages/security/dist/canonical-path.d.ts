export interface CanonicalizeOptions {
    /** Working directory used to resolve relative paths. */
    cwd: string;
}
/**
 * Canonicalise `target` for containment checks.  Throws on empty input and
 * NUL/control characters (never silently accepts a degenerate path).
 *
 * Returns a forward-slash separated, absolute, canonical path:
 *   - existing path        → realpath (symlinks/junctions resolved)
 *   - non-existent path    → realpath(deepest existing ancestor) + tail,
 *                            with `.`/`..` in the tail lexically resolved
 *                            against the canonical ancestor
 */
export declare function canonicalizePath(target: string, opts: CanonicalizeOptions): string;
/**
 * Convenience: canonicalise a path and check it is within a canonical root
 * using the shared pure containment primitive.  Keeps the two canonicalisation
 * sides (target and root) on the same code path.
 */
export declare function isPathCanonicallyWithin(target: string, root: string, cwd: string, caseInsensitive: boolean): boolean;
//# sourceMappingURL=canonical-path.d.ts.map