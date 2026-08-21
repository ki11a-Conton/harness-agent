import { describe, expect, it } from "vitest";
import {
  analyzeProcessCommand,
  commandAllowlisted,
  parseCommandInvocation,
  scanShellOperators,
  surfaceDenied,
} from "./process-gate.js";

describe("P2-23 analyzeProcessCommand", () => {
  it("classifies shell wrappers: cmd /c , powershell -Command, bash/sh -c", () => {
    expect(analyzeProcessCommand("cmd /c dir").surface).toBe("shell-wrapper");
    expect(analyzeProcessCommand("cmd.exe /c rd /s /q C:\\x").surface).toBe("shell-wrapper");
    expect(analyzeProcessCommand("powershell -Command Get-ChildItem").surface).toBe("shell-wrapper");
    expect(analyzeProcessCommand("pwsh -EncodedCommand AAA=").surface).toBe("shell-wrapper");
    expect(analyzeProcessCommand("bash -c 'echo hi'").surface).toBe("shell-wrapper");
    expect(analyzeProcessCommand("sh -c 'curl x'").surface).toBe("shell-wrapper");
  });

  it("classifies interpreter evals: node -e, python -c, ruby -e, deno eval", () => {
    expect(analyzeProcessCommand("node -e 'spawn(x)'").surface).toBe("interpreter-eval");
    expect(analyzeProcessCommand("python -c 'print(1)'").surface).toBe("interpreter-eval");
    expect(analyzeProcessCommand("python3 -c pass").surface).toBe("interpreter-eval");
    expect(analyzeProcessCommand("ruby -e 'puts 1'").surface).toBe("interpreter-eval");
    expect(analyzeProcessCommand("perl -e 'print x'").surface).toBe("interpreter-eval");
    expect(analyzeProcessCommand("deno eval 'console.log(1)'").surface).toBe("interpreter-eval");
  });

  it("classifies running a script file vs eval (interpreter-script)", () => {
    expect(analyzeProcessCommand("node app.js").surface).toBe("interpreter-script");
    expect(analyzeProcessCommand("python main.py --flag").surface).toBe("interpreter-script");
    // Quoted program text must not split tokens: still an eval.
    expect(analyzeProcessCommand("node -e 'console.log(\"a b\")'").surface).toBe("interpreter-eval");
  });

  it("classifies package managers and recognizes the install verb", () => {
    const install = analyzeProcessCommand("npm install lodash");
    expect(install.surface).toBe("package-manager");
    expect(install.involvesNetwork).toBe(true);
    expect(analyzeProcessCommand("pip install requests").surface).toBe("package-manager");
    expect(analyzeProcessCommand("pnpm add foo").surface).toBe("package-manager");
    expect(analyzeProcessCommand("cargo add serde").surface).toBe("package-manager");
  });

  it("classifies git and flags network-bearing verbs", () => {
    expect(analyzeProcessCommand("git status").surface).toBe("git");
    expect(analyzeProcessCommand("git fetch origin").involvesNetwork).toBe(true);
    expect(analyzeProcessCommand("git clone https://x").involvesNetwork).toBe(true);
    expect(analyzeProcessCommand("git diff").involvesNetwork).toBe(false);
  });

  it("classifies network tools and plain commands", () => {
    expect(analyzeProcessCommand("curl -s https://x.com").surface).toBe("network-tool");
    expect(analyzeProcessCommand("wget http://x").involvesNetwork).toBe(true);
    expect(analyzeProcessCommand("ls -la").surface).toBe("plain");
    expect(analyzeProcessCommand("").surface).toBe("plain");
  });
});

describe("P2-23 surfaceDenied", () => {
  it("denies a named surface, allowlist-independent", () => {
    const evalCmd = analyzeProcessCommand("node -e 'x'");
    const decision = surfaceDenied(evalCmd, ["interpreter-eval"]);
    expect(decision.denied).toBe(true);
    expect(decision.reason).toContain("interpreter-eval");
  });

  it("allows every surface when no deniedSurfaces configured", () => {
    const evalCmd = analyzeProcessCommand("node -e 'x'");
    expect(surfaceDenied(evalCmd, undefined).denied).toBe(false);
    expect(surfaceDenied(evalCmd, []).denied).toBe(false);
  });

  it("allows a surface that is not denied", () => {
    const plain = analyzeProcessCommand("git status");
    expect(surfaceDenied(plain, ["interpreter-eval", "shell-wrapper"]).denied).toBe(false);
  });
});

describe("P14-2 scanShellOperators (POSIX)", () => {
  it("detects ; && || | & composition operators", () => {
    expect(scanShellOperators("git diff; rm -rf /", "posix", false)).toContain(";");
    expect(scanShellOperators("git diff && echo ok", "posix", false)).toContain("&&");
    expect(scanShellOperators("git diff || true", "posix", false)).toContain("||");
    expect(scanShellOperators("git diff | grep x", "posix", false)).toContain("|");
    expect(scanShellOperators("git diff & sleep 1", "posix", false)).toContain("&");
  });

  it("detects command substitution and backticks", () => {
    expect(scanShellOperators("git diff $(cat /etc/passwd)", "posix", false)).toContain("$(");
    expect(scanShellOperators("git diff `whoami`", "posix", false)).toContain("backtick");
  });

  it("detects embedded newline", () => {
    expect(scanShellOperators("git diff\nrm -rf /", "posix", false)).toContain("newline");
  });

  it("detects redirection operators", () => {
    expect(scanShellOperators("git diff > /etc/passwd", "posix", false)).toContain(">");
    expect(scanShellOperators("git diff < secret.txt", "posix", false)).toContain("<");
  });

  it("ignores operators inside single quotes", () => {
    expect(scanShellOperators("echo 'a;b&&c|d'", "posix", false)).toEqual([]);
    expect(scanShellOperators("git log --format='%s;%h'", "posix", false)).toEqual([]);
  });

  it("ignores ; | & inside double quotes but still flags $( and backtick", () => {
    expect(scanShellOperators("echo \"a;b\"", "posix", false)).toEqual([]);
    // POSIX: $() and backticks execute even inside double quotes.
    expect(scanShellOperators("echo \"$(whoami)\"", "posix", false)).toContain("$(");
    expect(scanShellOperators("echo \"`whoami`\"", "posix", false)).toContain("backtick");
  });

  it("respects backslash escapes", () => {
    expect(scanShellOperators("echo a\\;b", "posix", false)).toEqual([]);
  });

  it("flags nothing for a clean single-command line", () => {
    expect(scanShellOperators("git diff --stat", "posix", false)).toEqual([]);
    expect(scanShellOperators("pnpm test -- foo.test.ts", "posix", false)).toEqual([]);
  });
});

describe("P14-2 scanShellOperators (Windows cmd + PowerShell)", () => {
  it("cmd: detects & && || | as composition (NOT ;)", () => {
    expect(scanShellOperators("dir & del x", "windows", false)).toContain("&");
    expect(scanShellOperators("dir && echo ok", "windows", false)).toContain("&&");
    expect(scanShellOperators("dir || echo no", "windows", false)).toContain("||");
    expect(scanShellOperators("dir | findstr x", "windows", false)).toContain("|");
    // cmd uses & for separation; a bare ; is an argument separator, not command
    // chaining — must NOT be treated as composition for cmd.
    expect(scanShellOperators("dir ; del", "windows", false)).toEqual([]);
  });

  it("cmd: honors double-quote literals and caret escapes", () => {
    expect(scanShellOperators("echo \"a&b\"", "windows", false)).toEqual([]);
    expect(scanShellOperators("echo a^&b", "windows", false)).toEqual([]);
  });

  it("PowerShell: ; | & && || are composition even inside double quotes", () => {
    expect(scanShellOperators("powershell -Command \"Get-ChildItem; Remove-Item x\"", "windows", true)).toContain(";");
    expect(scanShellOperators("pwsh -Command \"a | b\"", "windows", true)).toContain("|");
    expect(scanShellOperators("pwsh -Command \"a & b\"", "windows", true)).toContain("&");
    expect(scanShellOperators("powershell -Command \"a && b\"", "windows", true)).toContain("&&");
    expect(scanShellOperators("powershell -Command \"$(x)\"", "windows", true)).toContain("$(");
  });

  it("PowerShell: single quotes are fully literal", () => {
    expect(scanShellOperators("powershell -Command 'a;b'", "windows", true)).toEqual([]);
  });
});

describe("P14-2 parseCommandInvocation", () => {
  it("extracts program and argv", () => {
    const inv = parseCommandInvocation("git diff --stat", "posix");
    expect(inv.program).toBe("git");
    expect(inv.argv).toEqual(["diff", "--stat"]);
    expect(inv.hasShellOperators).toBe(false);
    expect(inv.surface).toBe("git");
  });

  it("escalates a composed command to shell-wrapper surface", () => {
    const inv = parseCommandInvocation("git diff; rm -rf /", "posix");
    expect(inv.hasShellOperators).toBe(true);
    expect(inv.shellOperators).toContain(";");
    expect(inv.surface).toBe("shell-wrapper");
    expect(inv.involvesShell).toBe(true);
  });

  it("auto-detects the host platform when omitted", () => {
    const inv = parseCommandInvocation("ls -la");
    expect(inv.program).toBe("ls");
    expect(["posix", "windows"]).toContain(inv.platform);
  });
});

describe("P14-2 commandAllowlisted (semantic allowlist matching)", () => {
  const ALLOW = ["git diff", "pnpm test"];

  it("allows the exact allowlisted command", () => {
    expect(commandAllowlisted(ALLOW, "git diff", "posix")).toBe(true);
    expect(commandAllowlisted(ALLOW, "pnpm test", "posix")).toBe(true);
  });

  it("allows argument extension WITHOUT composition operators", () => {
    expect(commandAllowlisted(ALLOW, "git diff --stat", "posix")).toBe(true);
    expect(commandAllowlisted(ALLOW, "git diff --stat --no-color", "posix")).toBe(true);
    expect(commandAllowlisted(ALLOW, "pnpm test -- foo.test.ts", "posix")).toBe(true);
  });

  it("rejects a sibling program token (git diffx is NOT git diff + args)", () => {
    expect(commandAllowlisted(ALLOW, "git diffx", "posix")).toBe(false);
    expect(commandAllowlisted(ALLOW, "git difftool", "posix")).toBe(false);
  });

  it("rejects a different program entirely", () => {
    expect(commandAllowlisted(ALLOW, "rm -rf /", "posix")).toBe(false);
    expect(commandAllowlisted(ALLOW, "npm test", "posix")).toBe(false);
  });

  it("rejects composition after an allowlisted prefix (no argument-extension bypass)", () => {
    expect(commandAllowlisted(ALLOW, "git diff; rm -rf /", "posix")).toBe(false);
    expect(commandAllowlisted(ALLOW, "git diff && echo pwned", "posix")).toBe(false);
    expect(commandAllowlisted(ALLOW, "git diff || echo pwned", "posix")).toBe(false);
    expect(commandAllowlisted(ALLOW, "git diff | sh", "posix")).toBe(false);
    expect(commandAllowlisted(ALLOW, "git diff $(rm -rf /)", "posix")).toBe(false);
    expect(commandAllowlisted(ALLOW, "git diff `rm -rf /`", "posix")).toBe(false);
    expect(commandAllowlisted(ALLOW, "git diff\nrm -rf /", "posix")).toBe(false);
  });

  it("rejects chained operators for cmd and PowerShell wrappers", () => {
    expect(commandAllowlisted(["cmd /c dir"], "cmd /c dir & del x", "windows")).toBe(false);
    expect(commandAllowlisted(["cmd /c dir"], "cmd /c dir && del x", "windows")).toBe(false);
    expect(
      commandAllowlisted(["powershell -Command Get-ChildItem"], "powershell -Command \"Get-ChildItem; Remove-Item x\"", "windows"),
    ).toBe(false);
    expect(commandAllowlisted(["powershell -Command Get-ChildItem"], "powershell -Command \"Get-ChildItem | Out-File x\"", "windows")).toBe(false);
    expect(commandAllowlisted(["powershell -Command Get-ChildItem"], "powershell -Command \"Get-ChildItem & Remove-Item x\"", "windows")).toBe(false);
  });

  it("rejects an encoded PowerShell command", () => {
    // A wrapper that carries an encoded payload is shell content, never a plain
    // argument extension of the wrapper text.
    expect(commandAllowlisted(["powershell -Command x"], "powershell -EncodedCommand AAA=", "windows")).toBe(false);
  });

  it("glob entries still allow explicit shapes", () => {
    expect(commandAllowlisted(["**/*"], "git diff; rm -rf /", "posix")).toBe(true); // policy says everything
    expect(commandAllowlisted(["git *"], "git status", "posix")).toBe(true);
    expect(commandAllowlisted(["git *"], "git diff; rm -rf /", "posix")).toBe(false);
  });

  it("an allowlist entry that itself contains composition only matches token-identically", () => {
    const composed = ["npm run build && deploy"];
    expect(commandAllowlisted(composed, "npm run build && deploy", "posix")).toBe(true);
    // extension of a composed entry is NOT allowed
    expect(commandAllowlisted(composed, "npm run build && deploy && rm -rf /", "posix")).toBe(false);
    expect(commandAllowlisted(composed, "npm run build", "posix")).toBe(false);
  });
});