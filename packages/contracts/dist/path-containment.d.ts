export type PathKind = "posix-absolute" | "windows-drive" | "unc" | "relative";
export declare function classifyPath(p: string): PathKind;
/**
 * Normalise path separators to forward slashes, collapse duplicate slashes,
 * and strip trailing slash (except for the root `/`).  A leading double slash
 * (UNC marker, `//server/share`) is preserved.
 */
export declare function normaliseSeparators(p: string): string;
/**
 * Pure lexical resolution of `.` and `..` path segments WITHOUT touching the
 * filesystem.  Uses `path.posix.resolve` / `path.win32.resolve` which are
 * pure string operations on every platform.
 *
 * - Absolute POSIX paths (`/a/b`) → resolved via `posix.resolve`
 * - Windows drive paths (`C:\a\b`) → resolved via `win32.resolve`
 * - UNC paths (`\\server\share\a`) → resolved via `win32.resolve`
 * - Relative paths → segments are resolved lexically (no cwd available),
 *   `..` that would go above the first segment is clamped.
 *
 * The result is forward-slash separated with no trailing slash.
 */
export declare function lexicalNormalize(p: string): string;
/**
 * Pure boundary-aware containment check.
 *
 * BOTH inputs MUST already be canonical (absolute, normalised, realpath- or
 * lexical-resolved).  This function does NOT resolve `.`/`..` or normalise
 * separators — those steps are the caller's responsibility because they may
 * require I/O (realpath) before calling here.
 *
 * A candidate is inside a root when:
 *   - it equals the root, OR
 *   - its path is `root + "/" + <anything>` (the boundary is enforced by the
 *     trailing slash, so `/tmp/ws-2` is NOT inside `/tmp/ws`).
 *
 * When `caseInsensitive` is true, both sides are lowercased before comparison
 * (intended for macOS / Windows file systems).
 */
export declare function isPathWithin(candidate: string, root: string, caseInsensitive: boolean): boolean;
//# sourceMappingURL=path-containment.d.ts.map