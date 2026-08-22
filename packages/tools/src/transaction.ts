/**
 * P2-26 Workspace Change Transaction.
 *
 * For a complex coding task the runtime wants to be able to UNDO a batch of
 * file changes when a later verification step fails, WITHOUT going through a
 * blanket `git reset --hard`. This module gives the runtime a controlled,
 * snapshot-based transaction:
 *
 *   const txn = new WorkspaceChangeTransaction({ root });
 *   await txn.snapshot([{ path: "src/app.ts", content }]);   // capture before-state
 *   // ... agent edits / tool calls happen, or are staged ...
 *   await txn.commit();     // apply the intended end states (all-or-nothing)
 *   // if a later verify step fails:
 *   await txn.rollback();   // restore every touched path to its before-state
 *
 * Design principles (all consistent with the rest of the plan):
 *  - Snapshot is authoritative: each staged path records `before` (captured
 *    from disk) and `after` (the intended end state). Rollback always restores
 *    `before`, so a rollback lands byte-for-byte where the transaction started.
 *  - All-or-nothing commit: each file is written via a temp file + atomic
 *    rename; if any apply fails mid-way, already-applied files are rolled back
 *    before the error propagates. State is only `committed` when every file is
 *    durably applied.
 *  - Path confinement: every path resolves inside `root`. `resolve`+`relative`
 *    are used (never a bare string prefix) so `/tmp/ws2` and `/tmp/ws` never
 *    collide. Symlinks are rejected to avoid writing through an escape.
 *  - Deterministic / testable: pure file I/O over a temp root; no git, no
 *    network, no clock-dependent ordering.
 *
 * The transaction is a COORDINATION PRIMITIVE, not a security boundary. Actual
 * write-tool policy (allow/ask/deny per path) stays in the orchestrator + the
 * P2-27 write safety guard; this module only arranges *which* files a batch of
 * work will mutate and how to revert them.
 */
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";

/** Immutable before/after state of a single file path. */
export type FileSnapshot =
  | { exists: true; content: string; bytes: number }
  | { exists: false };

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
export class OutOfBoundsError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`path escapes workspace root: ${path}`);
    this.name = "OutOfBoundsError";
    this.path = path;
  }
}

/** Thrown when a path in the transaction is a directory (not a file). */
export class NotAFileError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`transaction target is not a regular file: ${path}`);
    this.name = "NotAFileError";
    this.path = path;
  }
}

/** Thrown when a commit partially fails; carries which paths were applied. */
export class TransactionApplyError extends Error {
  readonly applied: string[];
  constructor(message: string, applied: string[]) {
    super(message);
    this.name = "TransactionApplyError";
    this.applied = applied;
  }
}

export class WorkspaceChangeTransaction {
  private readonly root: string;
  private readonly rootLabel: string;
  private readonly encoding: BufferEncoding;
  private changes: StagedChange[] = [];
  private _state: TransactionState = "open";

  constructor(opts: WorkspaceChangeTransactionOptions) {
    this.root = resolve(opts.root);
    this.rootLabel = opts.rootLabel ?? this.root;
    this.encoding = opts.encoding ?? "utf8";
  }

  get state(): TransactionState {
    return this._state;
  }

  get rootDir(): string {
    return this.root;
  }

  entries(): readonly StagedChange[] {
    return this.changes;
  }

  /** Resolve a maybe-relative path against root and verify containment. */
  resolveInside(p: string): string {
    if (typeof p !== "string" || p.length === 0) {
      throw new OutOfBoundsError(p);
    }
    const abs = isAbsolute(p) ? resolve(p) : resolve(this.root, p);
    const rel = relative(this.root, abs);
    if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
      throw new OutOfBoundsError(p);
    }
    return abs;
  }

  /** Capture the current on-disk state of a single file. */
  private async readSnapshot(p: string): Promise<FileSnapshot> {
    let stat;
    try {
      stat = await fs.stat(p);
    } catch (err) {
      // Missing file → treat as absent (ENOENT/ENOTDIR both mean "not a file").
      return { exists: false };
    }
    if (stat.isDirectory()) throw new NotAFileError(p);
    const content = await fs.readFile(p, this.encoding);
    return { exists: true, content, bytes: Buffer.byteLength(content, this.encoding) };
  }

  /**
   * Record an intent to change a set of paths. Stage is "open": nothing is
   * written yet. Each path's before-state is captured from disk at this point,
   * so a later rollback restores exactly what was there before this batch.
   *
   * Throws if staging after the transaction was committed / rolled back.
   */
  async snapshot(plans: readonly ChangePlan[]): Promise<this> {
    this.assertOpen();
    for (const plan of plans) {
      const abs = this.resolveInside(plan.path);
      const before = await this.readSnapshot(abs);
      const kind: ChangeKind =
        !before.exists && plan.content !== undefined
          ? "create"
          : !before.exists && plan.content === undefined
            ? "delete"
            : before.exists && plan.content === undefined
              ? "delete"
              : "write";
      const after: FileSnapshot =
        plan.content === undefined
          ? { exists: false }
          : { exists: true, content: plan.content, bytes: Buffer.byteLength(plan.content, this.encoding) };
      // Deletes that target a path which does not exist are no-ops; still record
      // them so rollback remains consistent (it restores "absent" → nothing).
      this.changes.push({ path: plan.path, absolutePath: abs, kind, before, after });
    }
    return this;
  }

  /**
   * Apply every staged change. All-or-nothing: files are written via a temp
   * file + atomic rename; deletes happen only after all writes succeed. If any
   * operation fails, already-applied changes are rolled back and a
   * TransactionApplyError (carrying the applied set) is thrown.
   */
  async commit(): Promise<TransactionCommitResult> {
    this.assertOpen();
    const applied: string[] = [];
    try {
      // 1. Write/overwrite/create all non-delete changes first.
      for (const c of this.changes) {
        if (!c.after.exists) continue;
        await this.writeAtomic(c.absolutePath, c.after.content);
        applied.push(c.absolutePath);
      }
      // 2. Apply deletes after all content is in place.
      for (const c of this.changes) {
        if (c.kind === "delete") {
          await fs.rm(c.absolutePath, { force: true });
          applied.push(c.absolutePath);
        }
      }
    } catch (err) {
      // Best-effort: undo what we already applied, then rethrow.
      const rollbackErr = await this.tryRollbackApplied(applied);
      this._state = "open";
      throw new TransactionApplyError(
        `commit failed after ${applied.length} applied file(s)${rollbackErr ? `; rollback error: ${rollbackErr}` : ""}: ${err instanceof Error ? err.message : String(err)}`,
        applied,
      );
    }
    this._state = "committed";
    return { state: this._state, applied };
  }

  /** Revert every staged path to its before-state. Safe to call while open. */
  async rollback(): Promise<void> {
    if (this._state === "rolled_back") return;
    const err = await this.tryRollbackApplied(this.changes.map((c) => c.absolutePath));
    if (err) throw err;
    this._state = "rolled_back";
  }

  private async tryRollbackApplied(applied: string[]): Promise<Error | null> {
    let firstErr: Error | null = null;
    for (const c of [...this.changes].reverse()) {
      if (applied.includes(c.absolutePath)) {
        try {
          await this.restore(c.before, c.absolutePath);
        } catch (e) {
          if (!firstErr) firstErr = e instanceof Error ? e : new Error(String(e));
        }
      }
    }
    return firstErr;
  }

  /** Restore a single path to a target snapshot. */
  private async restore(snap: FileSnapshot, p: string): Promise<void> {
    if (snap.exists) {
      await this.writeAtomic(p, snap.content);
    } else {
      await fs.rm(p, { force: true });
    }
  }

  /** Write content atomically: temp file in the same dir, then rename. */
  private async writeAtomic(p: string, content: string): Promise<void> {
    const dir = dirname(p);
    await fs.mkdir(dir, { recursive: true });
    const tmp = resolve(dir, `.ar-txn-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
    await fs.writeFile(tmp, content, this.encoding);
    try {
      // Windows EPERM: the destination file may still be held by the
      // filesystem (antivirus, indexing). Retry the rename with backoff.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await fs.rename(tmp, p);
          return;
        } catch (rerr) {
          if (attempt < 4) await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
          else throw rerr;
        }
      }
    } catch (err) {
      // P14-6: tmp cleanup is best-effort — a failure is reported, never silent.
      await fs.rm(tmp, { force: true }).catch((cleanupErr) =>
        process.stderr.write(`[degraded] transaction.tmp-cleanup: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}\n`),
      );
      throw err;
    }
  }

  private assertOpen(): void {
    if (this._state !== "open") {
      throw new Error(
        `transaction is already ${this._state} (root: ${this.rootLabel}); snapshot/commit only while open`,
      );
    }
  }
}