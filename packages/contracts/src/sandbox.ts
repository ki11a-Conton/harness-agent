export type FilesystemMode = "read-only" | "workspace-write" | "full";

export interface FilesystemPolicy {
  mode: FilesystemMode;
  /** Absolute path prefixes allowed for writes/reads when mode !== "full". */
  allowedPaths?: string[];
}

export type NetworkMode = "deny" | "allowlist" | "full";

export interface NetworkPolicy {
  mode: NetworkMode;
  hosts?: string[];
}

export interface ProcessPolicy {
  timeoutMs?: number;
  maxProcesses?: number;
  maxOutputBytes?: number;
  maxMemoryMb?: number;
  allowedCommands?: string[];
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