import type { SandboxDecision, SandboxPolicy, SandboxRequest } from "@ar/contracts";
import { type CommandPlatform } from "./process-gate.js";
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
export declare class SandboxManager {
    readonly workspaceRoot: string;
    readonly cwd: string;
    readonly policy: SandboxPolicy;
    /** P3-6: per-instance additional allowed roots (e.g. an isolated child
     *  workspace). Contained like every other root — canonicalised, never a
     *  textual prefix match. */
    private readonly extraRoots;
    /** P14-2: command-analysis platform (cmd.exe vs POSIX shell semantics). */
    private readonly commandPlatform;
    constructor(workspaceRoot: string, cwd: string, policy: SandboxPolicy, extraRoots?: string[], commandPlatform?: CommandPlatform);
    evaluate(request: SandboxRequest): SandboxDecision;
    checkRead(target: string): SandboxDecision;
    checkWrite(target: string): SandboxDecision;
    checkExec(target: string): SandboxDecision;
    checkNetwork(url: string): SandboxDecision;
    /**
     * Canonicalise a target for containment.  Returns null for inputs that can
     * never be a valid in-workspace path (empty, control chars, or a Windows
     * drive/UNC path smuggled as a relative path on a POSIX workspace).  All
     * other inputs are canonicalised via {@link canonicalizePath}: realpath of
     * the deepest existing ancestor + lexically resolved tail, so a not-yet
     * existing write target can never escape via `..` or a symlink.
     */
    resolvePath(target: string): string | null;
    /**
     * P2-22: containment against EVERY allowed root (not just the workspace).
     * This is not a naive `startsWith`: an ancestor path that merely shares a
     * textual prefix (e.g. `/tmp/ws-2` vs `/tmp/ws`) must not count as inside.
     * Roots are canonicalised with the SAME function as targets (P14-1) — a
     * `/tmp -> /private/tmp` symlink or junction cannot dodge the boundary —
     * and, when the filesystem is marked case-insensitive, compared case-folded.
     */
    private allowedRoots;
    private withinRoot;
    private withinAllowedRoots;
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
export declare function containsPath(p: string, root: string, caseInsensitive: boolean): boolean;
//# sourceMappingURL=sandbox.d.ts.map