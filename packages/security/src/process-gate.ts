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