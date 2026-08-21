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
import { analyzeProcessCommand, surfaceDenied } from "./process-gate.js";

/** `C:\…`, `C:/…`, `d:\…` — an absolute drive path on Windows. Never a valid
 *  relative path inside a POSIX workspace. */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
/** `\\server\share\…` (also `//server/share`)
 *  — a UNC path, absolute on Windows. Always outside scope. */
const UNC_PATH = /^[\\/]{2}/;

/**
 * SandboxManager per AGENT_ARCHITECTURE_PLAN §19–§20.
 * Enforces filesystem scope (with symlink-escape detection via realpath),
 * network policy and process policy. Deterministic, testable, no bypass.
 */
export class SandboxManager {
  /** P3-6: per-instance additional allowed roots (e.g. an isolated child
   *  workspace). Contained like every other root — realpath-canonicalized,
   *  never a textual prefix match. */
  private readonly extraRoots: string[];

  constructor(
    readonly workspaceRoot: string,
    readonly cwd: string,
    readonly policy: SandboxPolicy,
    extraRoots: string[] = [],
  ) {
    this.extraRoots = extraRoots;
  }

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
    if (!this.withinAllowedRoots(p)) {
      return { allowed: false, reason: `path outside workspace: ${p}`, kind: "filesystem" };
    }
    return { allowed: true, reason: `read allowed within workspace (${this.policy.filesystem.mode})` };
  }

  checkWrite(target: string): SandboxDecision {
    if (this.policy.filesystem.mode === "full") {
      return { allowed: true, reason: "filesystem policy is full" };
    }
    if (this.policy.filesystem.mode === "read-only") {
      return { allowed: false, reason: "filesystem policy is read-only", kind: "filesystem" };
    }
    const p = this.resolvePath(target);
    if (!p) return { allowed: false, reason: `invalid path: ${target}`, kind: "filesystem" };
    if (!this.withinAllowedRoots(p)) {
      return { allowed: false, reason: `path outside workspace: ${p}`, kind: "filesystem" };
    }
    return { allowed: true, reason: `write allowed within workspace (${this.policy.filesystem.mode})` };
  }

  checkExec(target: string): SandboxDecision {
    const proc = this.policy.process;
    // P2-23 surface gate: fail-closed, evaluated BEFORE the allowlist so an
    // explicitly-denied launch surface (e.g. interpreter eval) never runs even
    // if its text happens to match an allowlist glob. This is a static intent
    // classifier, NOT an OS-level sandbox — see plan.md §P2-23 threat model.
    const denied = surfaceDenied(analyzeProcessCommand(target), proc.deniedSurfaces);
    if (denied.denied) {
      return { allowed: false, reason: denied.reason ?? "process surface denied", kind: "process" };
    }
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
    // Reject NUL / control chars outright: they either fail the syscall or
    // behave differently across platforms; neither is a normal workspace path.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(target)) return null;
    // On Windows, `C:\…` is a valid absolute path. On POSIX, it's a relative
    // path that could be used to smuggle an absolute Windows path past the
    // sandbox. Only reject Windows drive paths when the target is NOT already
    // absolute (i.e. when it would be treated as a relative path on this OS).
    if (!isAbsolute(target) && (WINDOWS_DRIVE_PATH.test(target) || UNC_PATH.test(target))) return null;
    const absolute = isAbsolute(target) ? target : resolve(this.cwd, target);
    try {
      return realpathSync(absolute);
    } catch {
      // Path may not exist yet (write). Resolve the deepest existing ancestor.
      return resolveParent(absolute);
    }
  }

  /**
   * P2-22: containment against EVERY allowed root (not just the workspace).
   * This is not a naive `startsWith`: an ancestor path that merely shares a
   * textual prefix (e.g. `/tmp/ws-2` vs `/tmp/ws`) must not count as inside.
   * Roots are realpath-canonicalized (so a `/tmp -> /private/tmp` symlink or
   * junction cannot be used to dodge the boundary) and, when the filesystem
   * is marked case-insensitive, compared case-folded.
   */
  private allowedRoots(): string[] {
    const roots = [realWorkspaceRoot(this.workspaceRoot)];
    for (const extra of this.extraRoots) {
      roots.push(realWorkspaceRoot(extra));
    }
    for (const ap of this.policy.filesystem.allowedPaths ?? []) {
      roots.push(realResolve(isAbsolute(ap) ? ap : resolve(this.cwd, ap)));
    }
    return roots;
  }

  private withinRoot(p: string, root: string): boolean {
    return containsPath(p, root, this.policy.filesystem.caseInsensitive === true);
  }

  private withinAllowedRoots(p: string): boolean {
    return this.allowedRoots().some((root) => this.withinRoot(p, root));
  }
}

/**
 * Pure, deterministic containment check: is `p` (realpath-resolved) inside
 * root `root`? Enforces a path-boundary (never a raw string prefix) so a
 * sibling like `/tmp/ws-2` is not counted inside `/tmp/ws`. When
 * `caseInsensitive` is true, both sides are case-folded before comparison —
 * the recommended setting for macOS/Windows file systems.
 */
export function containsPath(p: string, root: string, caseInsensitive: boolean): boolean {
  const fold = (s: string): string => {
    const n = normalizePath(s);
    return caseInsensitive ? n.toLowerCase() : n;
  };
  const t = fold(p);
  const r = fold(root);
  if (t === r) return true;
  return t.startsWith(r.endsWith("/") ? r : `${r}/`);
}

function realWorkspaceRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/** Realpath an allowed-root entry, falling back to its deepest existing ancestor. */
function realResolve(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolveParent(p);
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