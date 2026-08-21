import type { ProcessSurface } from "@ar/contracts";
/**
 * P2-23 Process-surface audit & gate.
 *
 * A static classifier over the command string that the ProcessExecutor is about
 * to run through a shell (`/bin/sh -c` on POSIX, `cmd /c` on Windows). It
 * recognizes the *launch surface* — shell wrappers, interpreter `-e`/`-c`
 * evals, script-file interpreters, package managers, git, and network tools —
 * so operators can deny a whole surface (e.g. `interpreter-eval`) rather than
 * enumerating every command.
 *
 * IMPORTANT THREAT-MODEL BOUNDARY (documented in plan.md §P2-23):
 * this gate is a STATIC, best-effort intent classifier. It runs BEFORE the
 * process starts and inspects a string; it does NOT constrain what a running
 * process does (a subprocess can spawn further processes, read the network,
 * or exec a different interpreter). It therefore REPLACES NOTHING at the OS
 * boundary — it is one belt in a layered policy (permission engine + sandbox +
 * network intent gate + this surface gate). True process containment requires
 * an OS-level sandbox (seccomp/landlock/chroot/container), which is outside
 * this project's scope and explicitly called out.
 */
export interface ProcessCommandAnalysis {
    surface: ProcessSurface;
    /** First token's basename (strip path). Null when unparseable/empty. */
    argv0: string | null;
    /** Human-readable reasons that explain the classification. */
    reasons: string[];
    /** True when interpretation involves a shell wrapper (`-c`, `cmd /c`). */
    involvesShell: boolean;
    /** True when the surface is network-bearing (git fetch, curl, …). */
    involvesNetwork: boolean;
}
/**
 * P14-2 — the shell/composition surface of a command line.
 *
 * The command executor runs everything through a shell (`/bin/sh -c` on POSIX,
 * `cmd.exe /c` on Windows).  A command string can therefore carry SHELL
 * COMPOSITION — `;`, `&&`, `||`, `|`, `&`, `$(…)`, backticks, an embedded
 * newline, or redirection — which changes the real command semantics beyond
 * "allowed program + extra arguments".  This module detects those operators
 * (outside quoting, per-platform) so the sandbox can refuse to treat a
 * composed command as an "argument extension" of an allowlisted command.
 *
 * POSIX and Windows/Cmd and PowerShell have different operator and quoting
 * semantics; they are handled separately (no one regex pretends to cover all).
 */
export type CommandPlatform = "posix" | "windows";
/** The minimal, platform-aware representation of a command line (P14-2). */
export interface CommandInvocation {
    /** First program's basename, lowercased. Null when unparseable/empty. */
    program: string | null;
    /** Tokens after the program (quotes already stripped by tokenization). */
    argv: string[];
    /** Every shell composition operator found OUTSIDE quoting. */
    shellOperators: string[];
    /** True when any composition operator is present → NOT a plain program call. */
    hasShellOperators: boolean;
    /** Reused launch-surface classification (shell-wrapper / git / …). */
    surface: ProcessSurface;
    /** Reused shell-wrapper flag (cmd /c, powershell -Command, sh -c). */
    involvesShell: boolean;
    /** Reused network intent flag. */
    involvesNetwork: boolean;
    /** The platform the analysis assumed (host when unspecified). */
    platform: CommandPlatform;
}
/** Host platform as a CommandPlatform (cmd.exe on win32, else POSIX shell). */
export declare function hostCommandPlatform(): CommandPlatform;
/**
 * Scan a command line for shell composition operators OUTSIDE quoting, using
 * the platform's own operator/quoting rules:
 *
 *  - POSIX (`/bin/sh -c`): `;` `&&` `||` `|` `|&` `&` `$(` backtick, an
 *    embedded newline, and redirection `>` `<` `>>` `<<`.  Single quotes are
 *    fully literal; inside double quotes `$(` and backticks still execute
 *    (POSIX), while `;` `|` `&` are literal; `\` escapes the next char.
 *  - Windows cmd (`cmd /c`): `&` `&&` `||` `|` `>` `<` `>>` — cmd separates
 *    commands with `&` (NOT `;`, which is only an argument separator), `^`
 *    escapes the next char, double quotes are literal.
 *  - PowerShell: `;` `|` `&` `&&` `||` `$(` — inside double quotes these
 *    REMAIN live in a `-Command` payload (expandable strings), only single
 *    quotes are fully literal.
 *
 * Returns every operator found (deduplicated, in scan order).
 */
export declare function scanShellOperators(command: string, platform: CommandPlatform, isPowershell: boolean): string[];
/**
 * Parse a command line into the minimal {@link CommandInvocation} (P14-2).
 *
 * - program/argv come from the existing quote-aware tokenizer.
 * - shell composition operators are detected per-platform; when present, the
 *   launch surface is escalated to `shell-wrapper` (the command no longer is
 *   "allowed program + arguments", it is shell composition).
 * - `platform` defaults to the host; pass explicitly for cross-platform tests.
 */
export declare function parseCommandInvocation(command: string, platform?: CommandPlatform): CommandInvocation;
/**
 * P14-2 — semantic allowlist matching.  Replaces the old
 * `matchGlob(cmd, target) || target.startsWith(cmd)` prefix check.
 *
 * Rules:
 *  - A glob entry that matches the whole target always allows (explicit
 *    policy text, e.g. an all-commands glob or `git *`).
 *  - Otherwise the allowlist entry is parsed as a CommandInvocation:
 *      - `target` WITH composition operators can only match an allowlist
 *        entry that is token-identical (policy explicitly wrote the composed
 *        command); it is NEVER granted as an "argument extension" of a
 *        plain entry (`git diff` must not allow `git diff; rm -rf /`).
 *      - `target` WITHOUT operators may be an argv extension of a plain
 *        allowlist entry with the same program (`git diff` → `git diff --stat`),
 *        matched token-wise so `git diffx` is NOT `git diff` + args.
 */
export declare function commandAllowlisted(allowedCommands: readonly string[], target: string, platform?: CommandPlatform): boolean;
/** Classify a command string into a launch surface. Pure and deterministic. */
export declare function analyzeProcessCommand(command: string): ProcessCommandAnalysis;
/**
 * Evaluate a command against a process policy's `deniedSurfaces`. Static and
 * fail-closed: if the command's surface is denied, the command is rejected
 * BEFORE it runs. This complements (does not replace) the command allowlist
 * and the OS-level containment that a deployment may layer on top.
 */
export declare function surfaceDenied(analysis: ProcessCommandAnalysis, deniedSurfaces: ProcessSurface[] | undefined): {
    denied: boolean;
    reason?: string;
};
//# sourceMappingURL=process-gate.d.ts.map