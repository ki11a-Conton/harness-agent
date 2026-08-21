export interface WorkspaceSettings {
    /** Glob patterns exactly as declared (positive + `!` negations). */
    patterns: string[];
    /** Concrete repo-relative member directories that match the patterns. */
    members: string[];
    /** True when a workspaces source was found (patterns are authoritative). */
    explicit: boolean;
    /** Repo-relative dirs that were tried as glob candidate roots. */
    candidateDirs: string[];
}
/** Load the workspaces patterns from pnpm-workspace.yaml + package.json. */
export declare function loadWorkspacePatterns(root: string): Promise<string[]>;
/** Match candidate dirs against a list of positive/negated glob patterns. */
export declare function matchGlobDirs(patterns: string[], candidateDirs: string[]): string[];
/** Collect repo-relative directory paths (excluding VCS / dependency dirs). */
export declare function listDirs(root: string): Promise<string[]>;
/** Full workspace resolution: patterns + matched members + candidates. */
export declare function resolveWorkspace(root: string, candidateDirs?: string[]): Promise<WorkspaceSettings>;
//# sourceMappingURL=workspace.d.ts.map