export type FilesystemMode = "read-only" | "workspace-write" | "full";

export interface FilesystemPolicy {
  mode: FilesystemMode;
  /** Absolute path prefixes allowed for writes/reads when mode !== "full". */
  allowedPaths?: string[];
  /**
   * P2-22: set true when the workspace filesystem is case-insensitive
   * (macOS/Windows defaults). Containment checks then compare case-folded
   * paths so a differently-cased path cannot be mistaken for outside-scope
   * (and vice versa) on such file systems. On a case-sensitive POSIX root
   * this defaults to false and exact (realpath-canonical) matching applies.
   */
  caseInsensitive?: boolean;
}

export type NetworkMode = "deny" | "allowlist" | "full";

export interface NetworkPolicy {
  mode: NetworkMode;
  hosts?: string[];
}

/** P2-23: the launch surface of a process command (from a static analysis of
 *  the command string). Used to recognize shell wrappers / interpreter evals /
 *  package managers / git before they run. */
export type ProcessSurface =
  | "shell-wrapper" // cmd /c , powershell -Command, bash/sh/zsh -c
  | "interpreter-eval" // node -e, python -c, ruby -e, deno eval
  | "interpreter-script" // node app.js, python main.py
  | "package-manager" // npm/pnpm/yarn/pip/cargo … install/add
  | "git" // git fetch/clone/pull/push…
  | "network-tool" // curl/wget…
  | "plain"; // anything else

export interface ProcessPolicy {
  timeoutMs?: number;
  maxProcesses?: number;
  maxOutputBytes?: number;
  maxMemoryMb?: number;
  allowedCommands?: string[];
  /** P2-23: process surfaces to deny outright (fail-closed), independent of
   *  command allowlist. E.g. preventing eval-style interpreter invocation. */
  deniedSurfaces?: ProcessSurface[];
}

export interface SandboxPolicy {
  filesystem: FilesystemPolicy;
  network: NetworkPolicy;
  process: ProcessPolicy;
}

export interface SandboxState {
  workspaceRoot: string;
  cwd: string;
  policy: SandboxPolicy;
}

export interface SandboxRequest {
  target: string;
  operation: "read" | "write" | "exec";
  policy: SandboxPolicy;
}

export interface SandboxDecision {
  allowed: boolean;
  reason: string;
  /** Which policy dimension produced the decision (Phase 9 security events). */
  kind?: "filesystem" | "process" | "network";
}