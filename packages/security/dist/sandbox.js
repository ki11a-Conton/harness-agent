import { isPathWithin, normaliseSeparators } from "@ar/contracts";
import { isAbsolute } from "node:path";
import { matchGlob } from "./glob.js";
import { detectNetworkIntent } from "./network-gate.js";
import { commandAllowlisted, hostCommandPlatform, parseCommandInvocation, surfaceDenied, } from "./process-gate.js";
import { canonicalizePath } from "./canonical-path.js";
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
 *
 * P14-1: every filesystem decision shares ONE canonicalisation semantic with
 * the capability guard — {@link canonicalizePath} (realpath of the deepest
 * existing ancestor + lexically resolved tail) feeding the shared pure
 * containment primitive {@link isPathWithin}.  No textual prefix matching.
 *
 * P14-2: exec allowlist matching is SEMANTIC (commandAllowlisted), never a
 * raw `startsWith` — a composed command (`git diff; rm …`) is never treated
 * as an argument extension of an allowlisted command.
 */
export class SandboxManager {
    workspaceRoot;
    cwd;
    policy;
    /** P3-6: per-instance additional allowed roots (e.g. an isolated child
     *  workspace). Contained like every other root — canonicalised, never a
     *  textual prefix match. */
    extraRoots;
    /** P14-2: command-analysis platform (cmd.exe vs POSIX shell semantics). */
    commandPlatform;
    constructor(workspaceRoot, cwd, policy, extraRoots = [], commandPlatform = hostCommandPlatform()) {
        this.workspaceRoot = workspaceRoot;
        this.cwd = cwd;
        this.policy = policy;
        this.extraRoots = extraRoots;
        this.commandPlatform = commandPlatform;
    }
    evaluate(request) {
        switch (request.operation) {
            case "read":
                return this.checkRead(request.target);
            case "write":
                return this.checkWrite(request.target);
            case "exec":
                return this.checkExec(request.target);
        }
    }
    checkRead(target) {
        if (this.policy.filesystem.mode === "full") {
            return { allowed: true, reason: "filesystem policy is full" };
        }
        const p = this.resolvePath(target);
        if (!p)
            return { allowed: false, reason: `invalid path: ${target}`, kind: "filesystem" };
        if (!this.withinAllowedRoots(p)) {
            return { allowed: false, reason: `path outside workspace: ${p}`, kind: "filesystem" };
        }
        return { allowed: true, reason: `read allowed within workspace (${this.policy.filesystem.mode})` };
    }
    checkWrite(target) {
        if (this.policy.filesystem.mode === "full") {
            return { allowed: true, reason: "filesystem policy is full" };
        }
        if (this.policy.filesystem.mode === "read-only") {
            return { allowed: false, reason: "filesystem policy is read-only", kind: "filesystem" };
        }
        const p = this.resolvePath(target);
        if (!p)
            return { allowed: false, reason: `invalid path: ${target}`, kind: "filesystem" };
        if (!this.withinAllowedRoots(p)) {
            return { allowed: false, reason: `path outside workspace: ${p}`, kind: "filesystem" };
        }
        return { allowed: true, reason: `write allowed within workspace (${this.policy.filesystem.mode})` };
    }
    checkExec(target) {
        const proc = this.policy.process;
        // P2-23 + P14-2: surface gate evaluated BEFORE the allowlist so an
        // explicitly-denied launch surface (interpreter eval, shell wrapper) never
        // runs even if its text happens to match an allowlist glob, and so a
        // COMPOSED command (`git diff; rm -rf /`) is treated as shell content,
        // never as "allowed program + arguments". Static intent classifier, NOT an
        // OS-level sandbox — see plan.md §P2-23 threat model.
        const inv = parseCommandInvocation(target, this.commandPlatform);
        const denied = surfaceDenied({ surface: inv.surface, argv0: inv.program, reasons: [], involvesShell: inv.involvesShell, involvesNetwork: inv.involvesNetwork }, proc.deniedSurfaces);
        if (denied.denied) {
            return { allowed: false, reason: denied.reason ?? "process surface denied", kind: "process" };
        }
        if (proc.allowedCommands !== undefined && proc.allowedCommands.length > 0) {
            const ok = commandAllowlisted(proc.allowedCommands, target, this.commandPlatform);
            if (!ok)
                return { allowed: false, reason: `command not in allowlist: ${target}`, kind: "process" };
        }
        // Phase 9 network gate: an exec command that carries network intent goes
        // through the network policy just like a dedicated network tool call.
        const net = this.policy.network;
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
                const blocked = intent.hosts.filter((h) => !allowedHosts.some((a) => a === h || a === `*.${h}` || matchGlob(a, h)));
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
    checkNetwork(url) {
        const net = this.policy.network;
        if (net.mode === "deny")
            return { allowed: false, reason: "network policy is deny", kind: "network" };
        if (net.mode === "allowlist") {
            let hostname = null;
            try {
                hostname = new URL(url).hostname;
            }
            catch {
                return { allowed: false, reason: `invalid URL: ${url}`, kind: "network" };
            }
            const ok = (net.hosts ?? []).some((h) => h === hostname || h === `*.${hostname}` || matchGlob(h, hostname));
            if (!ok)
                return { allowed: false, reason: `host not in allowlist: ${hostname}`, kind: "network" };
        }
        return { allowed: true, reason: `network allowed (${net.mode})` };
    }
    /**
     * Canonicalise a target for containment.  Returns null for inputs that can
     * never be a valid in-workspace path (empty, control chars, or a Windows
     * drive/UNC path smuggled as a relative path on a POSIX workspace).  All
     * other inputs are canonicalised via {@link canonicalizePath}: realpath of
     * the deepest existing ancestor + lexically resolved tail, so a not-yet
     * existing write target can never escape via `..` or a symlink.
     */
    resolvePath(target) {
        if (typeof target !== "string" || target.length === 0)
            return null;
        // Reject NUL / control chars outright: they either fail the syscall or
        // behave differently across platforms; neither is a normal workspace path.
        // eslint-disable-next-line no-control-regex
        if (/[\u0000-\u001f]/.test(target))
            return null;
        // On Windows, `C:\…` is a valid absolute path. On POSIX, it's a relative
        // path that could be used to smuggle an absolute Windows path past the
        // sandbox. Only reject Windows drive paths when the target is NOT already
        // absolute (i.e. when it would be treated as a relative path on this OS).
        if (!isAbsolute(target) && (WINDOWS_DRIVE_PATH.test(target) || UNC_PATH.test(target)))
            return null;
        return canonicalizePath(target, { cwd: this.cwd });
    }
    /**
     * P2-22: containment against EVERY allowed root (not just the workspace).
     * This is not a naive `startsWith`: an ancestor path that merely shares a
     * textual prefix (e.g. `/tmp/ws-2` vs `/tmp/ws`) must not count as inside.
     * Roots are canonicalised with the SAME function as targets (P14-1) — a
     * `/tmp -> /private/tmp` symlink or junction cannot dodge the boundary —
     * and, when the filesystem is marked case-insensitive, compared case-folded.
     */
    allowedRoots() {
        const roots = [canonicalizePath(this.workspaceRoot, { cwd: this.cwd })];
        for (const extra of this.extraRoots) {
            roots.push(canonicalizePath(extra, { cwd: this.cwd }));
        }
        for (const ap of this.policy.filesystem.allowedPaths ?? []) {
            // An empty allowed-path entry is not a path and can never contain
            // anything (it neither widens nor narrows scope). Skip it rather than
            // failing the whole decision — fail-closed containment is unchanged.
            if (ap === undefined || ap === "")
                continue;
            roots.push(canonicalizePath(ap, { cwd: this.cwd }));
        }
        return roots;
    }
    withinRoot(p, root) {
        return isPathWithin(p, root, this.policy.filesystem.caseInsensitive === true);
    }
    withinAllowedRoots(p) {
        return this.allowedRoots().some((root) => this.withinRoot(p, root));
    }
}
/**
 * Pure, deterministic containment check: is `p` (canonical/realpath-resolved)
 * inside root `root`?  Enforces a path-boundary (never a raw string prefix) so
 * a sibling like `/tmp/ws-2` is not counted inside `/tmp/ws`.  When
 * `caseInsensitive` is true, both sides are case-folded before comparison —
 * the recommended setting for macOS/Windows file systems.
 *
 * This is a thin wrapper over the shared {@link isPathWithin} primitive,
 * adding only separator normalisation (callers pass realpath-canonical paths,
 * which may still contain backslashes on Windows).  Lexical `.`/`..`
 * resolution is the caller's job (canonicalisation) — it cannot be done here
 * without I/O knowledge.
 */
export function containsPath(p, root, caseInsensitive) {
    return isPathWithin(normaliseSeparators(p), normaliseSeparators(root), caseInsensitive);
}
//# sourceMappingURL=sandbox.js.map