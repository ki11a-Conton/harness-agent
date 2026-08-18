import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type {
  NetworkPolicy,
  ProcessPolicy,
  SandboxDecision,
  SandboxPolicy,
  SandboxRequest,
} from "@ar/contracts";
import { matchGlob, normalizePath } from "./glob.js";
import { detectNetworkIntent } from "./network-gate.js";

/**
 * SandboxManager per AGENT_ARCHITECTURE_PLAN §19–§20.
 * Enforces filesystem scope (with symlink-escape detection via realpath),
 * network policy and process policy. Deterministic, testable, no bypass.
 */
export class SandboxManager {
  constructor(
    readonly workspaceRoot: string,
    readonly cwd: string,
    readonly policy: SandboxPolicy,
  ) {}

  evaluate(request: SandboxRequest): SandboxDecision {
    switch (request.operation) {
      case "read":
        return this.checkRead(request.target);
      case "write":
        return this.checkWrite(request.target);
      case "exec":
        return this.checkExec(request.target);
    }
  }

  checkRead(target: string): SandboxDecision {
    if (this.policy.filesystem.mode === "full") {
      return { allowed: true, reason: "filesystem policy is full" };
    }
    const p = this.resolvePath(target);
    if (!p) return { allowed: false, reason: `invalid path: ${target}`, kind: "filesystem" };
    if (!this.insideWorkspace(p)) {
      return { allowed: false, reason: `path outside workspace: ${p}`, kind: "filesystem" };
    }
    return { allowed: true, reason: `read allowed within workspace (${this.policy.filesystem.mode})` };
  }

  checkWrite(target: string): SandboxDecision {
    if (this.policy.filesystem.mode === "full") {
      return { allowed: true, reason: "filesystem policy is full" };
    }
    const p = this.resolvePath(target);
    if (!p) return { allowed: false, reason: `invalid path: ${target}`, kind: "filesystem" };
    if (!this.insideWorkspace(p)) {
      return { allowed: false, reason: `path outside workspace: ${p}`, kind: "filesystem" };
    }
    if (this.policy.filesystem.mode === "read-only") {
      return { allowed: false, reason: "filesystem policy is read-only", kind: "filesystem" };
    }
    return { allowed: true, reason: `write allowed within workspace (${this.policy.filesystem.mode})` };
  }

  checkExec(target: string): SandboxDecision {
    const proc = this.policy.process;
    if (proc.allowedCommands !== undefined && proc.allowedCommands.length > 0) {
      const ok = proc.allowedCommands.some((cmd) => matchGlob(cmd, target) || target.startsWith(cmd));
      if (!ok) return { allowed: false, reason: `command not in allowlist: ${target}`, kind: "process" };
    }
    // Phase 9 network gate: an exec command that carries network intent goes
    // through the network policy just like a dedicated network tool call.
    const net: NetworkPolicy = this.policy.network;
    if (net.mode !== "full") {
      const intent = detectNetworkIntent(target);
      if (intent.hasNetworkIntent) {
        if (net.mode === "deny") {
          return {
            allowed: false,
            reason: `network denied: ${intent.reasons.join("; ")}`,
            kind: "network",
          };
        }
        const allowedHosts = net.hosts ?? [];
        const blocked = intent.hosts.filter(
          (h) => !allowedHosts.some((a) => a === h || a === `*.${h}` || matchGlob(a, h)),
        );
        if (intent.hosts.length === 0 || blocked.length > 0) {
          return {
            allowed: false,
            reason: `network host not allowed: ${intent.hosts.join(", ") || "no host to validate"}`,
            kind: "network",
          };
        }
      }
    }
    return { allowed: true, reason: "exec allowed by process policy" };
  }

  checkNetwork(url: string): SandboxDecision {
    const net: NetworkPolicy = this.policy.network;
    if (net.mode === "deny") return { allowed: false, reason: "network policy is deny", kind: "network" };
    if (net.mode === "allowlist") {
      let hostname: string | null = null;
      try {
        hostname = new URL(url).hostname;
      } catch {
        return { allowed: false, reason: `invalid URL: ${url}`, kind: "network" };
      }
      const ok = (net.hosts ?? []).some(
        (h) => h === hostname || h === `*.${hostname}` || matchGlob(h, hostname),
      );
      if (!ok) return { allowed: false, reason: `host not in allowlist: ${hostname}`, kind: "network" };
    }
    return { allowed: true, reason: `network allowed (${net.mode})` };
  }

  resolvePath(target: string): string | null {
    if (typeof target !== "string" || target.length === 0) return null;
    const absolute = isAbsolute(target) ? target : resolve(this.cwd, target);
    try {
      return realpathSync(absolute);
    } catch {
      // Path may not exist yet (write). Resolve the deepest existing ancestor.
      return resolveParent(absolute);
    }
  }

  private insideWorkspace(p: string): boolean {
    const root = realWorkspaceRoot(this.workspaceRoot);
    const normalized = normalizePath(p);
    const rootNorm = normalizePath(root);
    if (normalized === rootNorm) return true;
    return normalized.startsWith(rootNorm.endsWith("/") ? rootNorm : `${rootNorm}/`);
  }
}

function realWorkspaceRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/** For non-existent paths, resolve the realpath of the deepest existing ancestor. */
function resolveParent(p: string): string {
  let current = p;
  for (let i = 0; i < 10; i++) {
    try {
      return realpathSync(current);
    } catch {
      const parent = current.slice(0, Math.max(0, current.lastIndexOf(sep)));
      if (!parent || parent === current) return p;
      current = parent;
    }
  }
  return p;
}