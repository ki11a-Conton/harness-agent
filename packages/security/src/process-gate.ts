import type { ProcessSurface } from "@ar/contracts";
import { matchGlob } from "./glob.js";

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
export function hostCommandPlatform(): CommandPlatform {
  return process.platform === "win32" ? "windows" : "posix";
}

/** Simple POSIX/CMD-aware tokenizer: splits on whitespace, honoring single
 *  quotes, double quotes, and backslash escapes (so `node -e 'spawn("x")'`
 *  does not split inside the quoted program text). */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "\\" && inSingle === false) {
      const next = command[i + 1];
      if (next !== undefined) {
        current += next;
        i += 1;
        continue;
      }
      current += c;
      continue;
    }
    if (c === "'" && inDouble === false) {
      inSingle = !inSingle;
      continue;
    }
    if (c === '"' && inSingle === false) {
      inDouble = !inDouble;
      continue;
    }
    if (/\s/.test(c) && inSingle === false && inDouble === false) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += c;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const seg = norm.split("/").pop() ?? norm;
  return seg.toLowerCase();
}

// ---------------------------------------------------------------------------
// P14-2 — shell composition operator detection
// ---------------------------------------------------------------------------

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
export function scanShellOperators(command: string, platform: CommandPlatform, isPowershell: boolean): string[] {
  const found: string[] = [];
  const add = (op: string) => {
    if (!found.includes(op)) found.push(op);
  };
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  const n = command.length;
  const chars = [...command];
  const at = (idx: number): string => chars[idx] ?? "";

  while (i < n) {
    const c = at(i);
    // --- quoting toggles -------------------------------------------------
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      i += 1;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      i += 1;
      continue;
    }
    // Escapes: POSIX uses backslash, cmd uses caret. PowerShell ` is an
    // escape char but rarely used for operators; treat as ordinary.
    if (!inSingle) {
      if (platform === "windows" && !isPowershell && c === "^") {
        i += 2;
        continue;
      }
      if (platform === "posix" && c === "\\") {
        i += 2;
        continue;
      }
    }
    // --- operator detection ---------------------------------------------
    if (inSingle) {
      i += 1;
      continue; // single quotes: fully literal on every platform
    }
    const two = c + at(i + 1);
    const three = c + at(i + 1) + at(i + 2);

    if (platform === "posix") {
      // `$(` command substitution (live inside double quotes too)
      if (c === "$" && at(i + 1) === "(") {
        add("$(");
        i += 2;
        continue;
      }
      if (c === "`") {
        add("backtick");
        i += 1;
        continue;
      }
      if (!inDouble) {
        if (three === "|&") {
          add("|&");
          i += 2;
          continue;
        }
        if (two === "&&" || two === "||" || two === ">>" || two === "<<") {
          add(two);
          i += 2;
          continue;
        }
        if (c === ";" || c === "&" || c === "|" || c === ">" || c === "<" || c === "(" || c === ")") {
          add(c);
          i += 1;
          continue;
        }
        if (c === "\n") {
          add("newline");
          i += 1;
          continue;
        }
      } else if (c === ">" || c === "<") {
        // redirection inside double quotes is literal in POSIX — skip
      }
      i += 1;
      continue;
    }

    if (isPowershell) {
      if (c === "$" && at(i + 1) === "(") {
        add("$(");
        i += 2;
        continue;
      }
      if (two === "&&" || two === "||") {
        add(two);
        i += 2;
        continue;
      }
      // PowerShell `;` `|` `&` stay live inside double quotes (expandable)
      if (c === ";" || c === "|" || c === "&" || c === ">" || c === "<") {
        add(c);
        i += 1;
        continue;
      }
      if (c === "\n") {
        add("newline");
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    // Windows cmd (non-PowerShell)
    if (!inDouble) {
      if (two === "&&" || two === "||" || two === ">>") {
        add(two);
        i += 2;
        continue;
      }
      if (c === "&" || c === "|" || c === ">" || c === "<") {
        add(c);
        i += 1;
        continue;
      }
    }
    i += 1;
  }
  return found;
}

const POWERSHELL_NAMES = new Set(["powershell", "pwsh", "powershell.exe", "pwsh.exe"]);

/**
 * Parse a command line into the minimal {@link CommandInvocation} (P14-2).
 *
 * - program/argv come from the existing quote-aware tokenizer.
 * - shell composition operators are detected per-platform; when present, the
 *   launch surface is escalated to `shell-wrapper` (the command no longer is
 *   "allowed program + arguments", it is shell composition).
 * - `platform` defaults to the host; pass explicitly for cross-platform tests.
 */
export function parseCommandInvocation(
  command: string,
  platform: CommandPlatform = hostCommandPlatform(),
): CommandInvocation {
  const analysis = analyzeProcessCommand(command);
  const tokens = tokenize(command.trim());
  const program = analysis.argv0;
  const argv = program === null ? [] : tokens.slice(1);
  const isPowershell = program !== null && POWERSHELL_NAMES.has(program);
  const shellOperators = scanShellOperators(command, platform, isPowershell);
  const hasShellOperators = shellOperators.length > 0;
  return {
    program,
    argv,
    shellOperators,
    hasShellOperators,
    // Any composed command is shell content, never "a plain allowed program":
    // escalate its surface so a `deniedSurfaces: ["shell-wrapper"]` policy
    // rejects it even when the allowlist would otherwise match.
    surface: hasShellOperators ? "shell-wrapper" : analysis.surface,
    involvesShell: analysis.involvesShell || hasShellOperators,
    involvesNetwork: analysis.involvesNetwork,
    platform,
  };
}

/** True when `prefix` is a token-level prefix of `tokens` (argv extension). */
function isTokenPrefix(prefix: readonly string[], tokens: readonly string[]): boolean {
  if (prefix.length === 0) return true;
  if (prefix.length > tokens.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== tokens[i]) return false;
  }
  return true;
}

function tokensEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

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
export function commandAllowlisted(
  allowedCommands: readonly string[],
  target: string,
  platform: CommandPlatform = hostCommandPlatform(),
): boolean {
  // Explicit glob match first (policy text that intentionally allows a shape).
  for (const cmd of allowedCommands) {
    if (matchGlob(cmd, target)) return true;
  }
  const inv = parseCommandInvocation(target, platform);
  if (inv.program === null) return false;
  for (const cmd of allowedCommands) {
    // Skip glob entries — already handled above.
    if (cmd.includes("*") || cmd.includes("?")) continue;
    const rule = parseCommandInvocation(cmd, platform);
    if (rule.program === null || rule.program !== inv.program) continue;
    if (rule.hasShellOperators) {
      // Policy explicitly wrote a composed command: only token-identical
      // targets match; no extension of a composed allowlist entry.
      if (tokensEqual(rule.argv, inv.argv)) return true;
      continue;
    }
    if (inv.hasShellOperators) continue; // composed target ≠ plain-entry extension
    if (isTokenPrefix(rule.argv, inv.argv)) return true;
  }
  return false;
}

const EVAL_ALIASES: Record<string, string> = {
  node: "node",
  bun: "node", // bun also supports -e
  deno: "node", // deno eval / run
  python: "python",
  python3: "python",
  py: "python",
  ruby: "ruby",
  perl: "perl",
  php: "php",
  pwsh: "pwsh",
  powershell: "pwsh",
  bash: "bash",
  sh: "sh",
  zsh: "zsh",
  dash: "sh",
  cmd: "cmd",
  "cmd.exe": "cmd",
};

const PACKAGE_MANAGERS = new Set([
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "bunx",
  "deno",
  "pip",
  "pip3",
  "pipx",
  "poetry",
  "pipenv",
  "pip-tools",
  "cargo",
  "uv",
]);

const NETWORK_TOOLS = new Set(["curl", "wget", "fetch", "ssh", "scp", "sftp", "aria2c", "telnet", "nc", "ncat"]);

/** `-e`/`-c` trigger flags per interpreter family, in recognition order. */
function isSingleLineEval(argv0: string, flags: string[]): boolean {
  if (EVAL_ALIASES[argv0] === "node") {
    return flags.some((f) => f === "-e" || f === "--eval" || f === "-p");
  }
  if (EVAL_ALIASES[argv0] === "python") {
    return flags.some((f) => f === "-c");
  }
  if (EVAL_ALIASES[argv0] === "ruby") {
    return flags.some((f) => f === "-e");
  }
  if (EVAL_ALIASES[argv0] === "perl") {
    return flags.some((f) => f === "-e");
  }
  return false;
}

/** Leading dash-prefixed flags after argv0. */
function leadingFlags(tokens: string[]): string[] {
  const flags: string[] = [];
  for (let i = 1; i < tokens.length && tokens[i]!.startsWith("-"); i++) {
    flags.push(tokens[i]!);
  }
  return flags;
}

/** Classify a command string into a launch surface. Pure and deterministic. */
export function analyzeProcessCommand(command: string): ProcessCommandAnalysis {
  if (typeof command !== "string" || command.trim().length === 0) {
    return { surface: "plain", argv0: null, reasons: ["empty command"], involvesShell: false, involvesNetwork: false };
  }
  const tokens = tokenize(command.trim());
  const argv0 = tokens[0] === undefined ? null : basename(tokens[0]);
  if (argv0 === null) {
    return { surface: "plain", argv0: null, reasons: ["unparseable command"], involvesShell: false, involvesNetwork: false };
  }
  const reasons: string[] = [];
  let involvesShell = false;
  let involvesNetwork = false;

  // Shell wrappers: bash/sh/zsh/dash -c "…", cmd /c "…", powershell -Command.
  if (argv0 === "cmd" || argv0 === "cmd.exe") {
    // cmd uses SLASH flags (/c), not dash flags (-c), so scan raw tokens.
    if (tokens.slice(1).some((t) => t.toLowerCase() === "/c" || t.toLowerCase() === "/k")) {
      involvesShell = true;
      reasons.push("cmd.exe /c wrapper");
      return { surface: "shell-wrapper", argv0, reasons, involvesShell, involvesNetwork };
    }
  }
  if (argv0 === "powershell" || argv0 === "pwsh") {
    const flags = leadingFlags(tokens);
    if (flags.some((f) => f === "-Command" || f === "-c" || f === "-enc" || f === "-EncodedCommand")) {
      involvesShell = true;
      reasons.push("powershell -Command wrapper");
      return { surface: "shell-wrapper", argv0, reasons, involvesShell, involvesNetwork };
    }
  }
  if (["bash", "sh", "zsh", "dash"].includes(argv0)) {
    const flags = leadingFlags(tokens);
    // eval vs wrapper: `bash -c "…"` is a shell-wrapper running a program
    if (flags.includes("-c")) {
      involvesShell = true;
      reasons.push(`${argv0} -c wrapper`);
      return { surface: "shell-wrapper", argv0, reasons, involvesShell, involvesNetwork };
    }
  }

  // Interpreter evals: node -e/--eval, python -c, ruby -e, perl -e.
  const flags = leadingFlags(tokens);
  if (isSingleLineEval(argv0, flags)) {
    reasons.push(`${argv0} inline eval (${flags[0]})`);
    involvesNetwork = (flags.some((f) => f === "-p") && argv0 === "node") || involvesNetwork;
    return { surface: "interpreter-eval", argv0, reasons, involvesShell, involvesNetwork };
  }

  // deno eval
  if (argv0 === "deno" && tokens[1] === "eval") {
    reasons.push("deno eval");
    return { surface: "interpreter-eval", argv0, reasons, involvesShell, involvesNetwork };
  }

  // Interpreter running a script file (node app.js, python main.py, bash x.sh)
  if (["node", "bun", "deno", "python", "python3", "py", "ruby", "perl", "php", "bash", "sh", "zsh"].includes(argv0)) {
    reasons.push(`${argv0} running a file/script`);
    return { surface: "interpreter-script", argv0, reasons, involvesShell, involvesNetwork };
  }

  // Package managers (dependency install/management surface).
  if (PACKAGE_MANAGERS.has(argv0)) {
    const verb = tokens.slice(1).find((t) => !t.startsWith("-")) ?? tokens[1];
    reasons.push(`package manager ${argv0}${verb !== undefined ? ` (${verb})` : ""}`);
    involvesNetwork = involvesNetwork || !["ls", "list", "view", "why"].includes(verb ?? "");
    return { surface: "package-manager", argv0, reasons, involvesShell, involvesNetwork };
  }

  // git surface (git fetch/clone/pull/push are network-bearing).
  if (argv0 === "git") {
    const verb = tokens[1];
    involvesNetwork = ["fetch", "clone", "pull", "push", "remote", "submodule", "fsck"].includes(verb ?? "");
    reasons.push(`git ${verb ?? ""}`);
    return { surface: "git", argv0, reasons, involvesShell, involvesNetwork };
  }

  // Network tools.
  if (NETWORK_TOOLS.has(argv0)) {
    involvesNetwork = true;
    reasons.push(`network tool ${argv0}`);
    return { surface: "network-tool", argv0, reasons, involvesShell, involvesNetwork };
  }

  reasons.push("plain command");
  return { surface: "plain", argv0, reasons, involvesShell, involvesNetwork };
}

/**
 * Evaluate a command against a process policy's `deniedSurfaces`. Static and
 * fail-closed: if the command's surface is denied, the command is rejected
 * BEFORE it runs. This complements (does not replace) the command allowlist
 * and the OS-level containment that a deployment may layer on top.
 */
export function surfaceDenied(
  analysis: ProcessCommandAnalysis,
  deniedSurfaces: ProcessSurface[] | undefined,
): { denied: boolean; reason?: string } {
  if (deniedSurfaces === undefined || deniedSurfaces.length === 0) return { denied: false };
  if (deniedSurfaces.includes(analysis.surface)) {
    return { denied: true, reason: `process surface '${analysis.surface}' is denied` };
  }
  return { denied: false };
}