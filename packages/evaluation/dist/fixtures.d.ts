/**
 * Create a temporary workspace for eval fixtures (test-only).
 *
 * Relative keys may contain ".." to place files OUTSIDE the workspace
 * (path-traversal fixtures, e.g. { "../escape.txt": "secret" }). Paths that
 * would escape `os.tmpdir()` are rejected so cleanup() stays safe. All created
 * paths are tracked and removed by cleanup().
 */
export declare function makeTempWorkspace(files: Record<string, string>): Promise<string>;
/** Remove every fixture workspace (and escaped file) created so far. Idempotent. */
export declare function cleanup(): Promise<void>;
//# sourceMappingURL=fixtures.d.ts.map