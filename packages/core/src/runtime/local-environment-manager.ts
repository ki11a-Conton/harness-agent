/**
 * P31-2 — LocalEnvironmentManager.
 *
 * The ONLY shipped EnvironmentManager (P31-4: do not claim remote support).
 * Resolves the local process environment for a session and takes frozen
 * snapshots with a DETERMINISTIC environment id (same cwd+roots+shell →
 * same id across restarts) so step records remain correlatable.
 *
 * The manager keeps a small process-local registry of session cwd/roots so a
 * handle can be snapshotted later (P31-3); the id itself derives from the
 * deterministic factory and is stable across process runs.
 */
import { homedir } from "node:os";
import {
  buildLocalEnvironmentSnapshot,
  type EnvironmentHandle,
  type EnvironmentId,
  type EnvironmentManager,
  type EnvironmentSnapshot,
} from "@ar/contracts";

/** Shell executable for the current platform, chosen statically. */
export function currentShellPath(): string {
  const shell = process.env.SHELL ?? process.env.COMSPEC;
  if (shell !== undefined && shell.length > 0) return shell;
  return process.platform === "win32"
    ? "C:\\Windows\\System32\\cmd.exe"
    : "/bin/sh";
}

export interface LocalEnvironmentManagerOptions {
  /** Extra workspace roots beyond the session cwd (e.g. repo parent). */
  extraWorkspaceRoots?: readonly string[];
  /** The env to snapshot (defaults to process.env at construction). */
  env?: Readonly<Record<string, string | undefined>>;
}

/** P31-2 — local implementation of the environment seam. */
export class LocalEnvironmentManager implements EnvironmentManager {
  private readonly extraRoots: readonly string[];
  private readonly env: Readonly<Record<string, string | undefined>>;
  /** environment id → environment facts (cwd + roots) for snapshot(). */
  private readonly byEnvironment = new Map<
    string,
    { cwd: string; roots: readonly string[] }
  >();

  constructor(options: LocalEnvironmentManagerOptions = {}) {
    this.extraRoots = options.extraWorkspaceRoots ?? [];
    this.env = options.env ?? process.env;
  }

  /** Local environments need no provisioning: resolve is immediate. */
  async resolveForSession(session: { id: string; cwd?: string }): Promise<EnvironmentHandle> {
    const base = session.cwd ?? process.cwd();
    const roots = this.workspaceRootsFor(base);
    const handle: EnvironmentHandle = { id: deterministicLocalId(base, roots, currentShellPath()) };
    this.byEnvironment.set(handle.id, { cwd: base, roots });
    return handle;
  }

  /** Frozen snapshot of the handle (P31-3: per-step). */
  async snapshot(handle: EnvironmentHandle): Promise<EnvironmentSnapshot> {
    const facts = this.byEnvironment.get(handle.id);
    const cwd = facts?.cwd ?? process.cwd();
    const roots = facts?.roots ?? this.workspaceRootsFor(cwd);
    return buildLocalEnvironmentSnapshot({
      cwd,
      workspaceRoots: roots,
      shell: currentShellPath(),
      env: this.env,
      permissionsFingerprint: "",
    });
  }

  private workspaceRootsFor(cwd: string): readonly string[] {
    const home = homedir();
    const roots = [cwd];
    if (this.extraRoots.length > 0) roots.push(...this.extraRoots);
    // Future: scan upward for a VCS marker (package.json/.git). Kept minimal.
    void home;
    return roots;
  }
}

/** P31-1 — deterministic local id from facts (same inputs → same id, stable
 *  across restarts). Exported for reuse in the snapshot factory. */
export function deterministicLocalId(
  cwd: string,
  roots: readonly string[],
  shell: string,
): EnvironmentId {
  return buildLocalEnvironmentSnapshot({
    cwd,
    workspaceRoots: roots,
    shell,
    env: undefined,
    permissionsFingerprint: "",
  }).id;
}