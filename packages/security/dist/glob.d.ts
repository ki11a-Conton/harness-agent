/**
 * Gitignore-style glob matching used by permission rules and sandbox checks.
 * Supported: `**` (any segments, optional), `*` (within a segment), `?` (one char).
 * Patterns are matched against normalized `/`-separated paths.
 */
export declare function normalizePath(p: string): string;
export declare function globToRegex(pattern: string): RegExp;
export declare function matchGlob(pattern: string, target: string): boolean;
//# sourceMappingURL=glob.d.ts.map