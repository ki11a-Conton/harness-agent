/** Immutable before/after state of a single file path. */
export type FileSnapshot = {
    exists: true;
    content: string;
    bytes: number;
} | {
    exists: false;
};
export type ChangeKind = "create" | "write" | "edit" | "delete";
export interface StagedChange {
    /** Path as given by the agent (may be relative; resolved against root). */
    path: string;
    /** Fully-resolved absolute path (guaranteed inside root). */
    absolutePath: string;
    kind: ChangeKind;
    before: FileSnapshot;
    after: FileSnapshot;
}
export type TransactionState = "open" | "committed" | "rolled_back";
/** Intent produced by `snapshot()`: the path and the desired end content. */
export interface ChangePlan {
    path: string;
    /** When set, the path should end up with this content. When omitted, the
     *  path should be deleted (delete). */
    content?: string;
}
export interface TransactionCommitResult {
    state: TransactionState;
    applied: string[];
}
export interface WorkspaceChangeTransactionOptions {
    root: string;
    /** Optional label for diagnostics / error messages (e.g. the turn id). */
    rootLabel?: string;
    encoding?: BufferEncoding;
}
/** Thrown when a path in the transaction resolves outside the workspace root. */
export declare class OutOfBoundsError extends Error {
    readonly path: string;
    constructor(path: string);
}
/** Thrown when a path in the transaction is a directory (not a file). */
export declare class NotAFileError extends Error {
    readonly path: string;
    constructor(path: string);
}
/** Thrown when a commit partially fails; carries which paths were applied. */
export declare class TransactionApplyError extends Error {
    readonly applied: string[];
    constructor(message: string, applied: string[]);
}
export declare class WorkspaceChangeTransaction {
    private readonly root;
    private readonly rootLabel;
    private readonly encoding;
    private changes;
    private _state;
    constructor(opts: WorkspaceChangeTransactionOptions);
    get state(): TransactionState;
    get rootDir(): string;
    entries(): readonly StagedChange[];
    /** Resolve a maybe-relative path against root and verify containment. */
    resolveInside(p: string): string;
    /** Capture the current on-disk state of a single file. */
    private readSnapshot;
    /**
     * Record an intent to change a set of paths. Stage is "open": nothing is
     * written yet. Each path's before-state is captured from disk at this point,
     * so a later rollback restores exactly what was there before this batch.
     *
     * Throws if staging after the transaction was committed / rolled back.
     */
    snapshot(plans: readonly ChangePlan[]): Promise<this>;
    /**
     * Apply every staged change. All-or-nothing: files are written via a temp
     * file + atomic rename; deletes happen only after all writes succeed. If any
     * operation fails, already-applied changes are rolled back and a
     * TransactionApplyError (carrying the applied set) is thrown.
     */
    commit(): Promise<TransactionCommitResult>;
    /** Revert every staged path to its before-state. Safe to call while open. */
    rollback(): Promise<void>;
    private tryRollbackApplied;
    /** Restore a single path to a target snapshot. */
    private restore;
    /** Write content atomically: temp file in the same dir, then rename. */
    private writeAtomic;
    private assertOpen;
}
//# sourceMappingURL=transaction.d.ts.map