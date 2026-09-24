/**
 * P31-2 — EnvironmentManager seam (P31).
 *
 * A host (CLI, web, embedded) resolves the environment a session executes in
 * and takes frozen snapshots of it per step. The shipped implementation is
 * `LocalEnvironmentManager` (packages/core); this file defines the boundary so
 * a remote/container manager can plug in later WITHOUT the step pipeline ever
 * depending on it (P31-4: "only ship local executor, do not claim remote").
 */
import type { EnvironmentId } from "./ids.js";
import type { EnvironmentSnapshot } from "./step-context.js";

/** Opaque handle to a resolved environment. */
export interface EnvironmentHandle {
  readonly id: EnvironmentId;
}

/** P31-2 — contract for resolving and snapshotting execution environments. */
export interface EnvironmentManager {
  /** Resolve the environment a session runs in (may be async: provision). */
  resolveForSession(session: { id: string; cwd?: string }): Promise<EnvironmentHandle>;
  /** Take a frozen snapshot of the handle's environment (used per step). */
  snapshot(handle: EnvironmentHandle): Promise<EnvironmentSnapshot>;
}

/**
 * P31-4 — Executor seam. Describes the host surface a tool may call WITHOUT
 * declaring remote support. The ONLY shipped implementation is the local one
 * (LocalEnvironmentManager + process execution); `filesystem`/`exec` here are
 * capability-shaped, so remote executors can implement them later.
 */
export type ExecutorFileSystemOperation =
  | { kind: "read"; path: string }
  | { kind: "write"; path: string; content: string }
  | { kind: "list"; path: string };

/** Result of a filesystem operation (kept minimal for now). */
export interface ExecutorFileSystemResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly content?: string;
  readonly entries?: string[];
}

/** P31-4 — remote-capable surface for filesystem ops. Only local shipped. */
export interface ExecutorFileSystem {
  read(path: string): Promise<{ ok: true; content: string } | { ok: false; error: string }>;
  write(path: string, content: string): Promise<{ ok: true } | { ok: false; error: string }>;
  list(path: string): Promise<{ ok: true; entries: string[] } | { ok: false; error: string }>;
}

/** P31-4 — command execution surface (shape only; local executor ships). */
export interface Executor {
  readonly kind: "local" | "remote";
  readonly filesystem: ExecutorFileSystem;
  exec(command: string, opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}