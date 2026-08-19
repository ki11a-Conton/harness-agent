import { describe, expect, it } from "vitest";
import { analyzeProcessCommand, surfaceDenied } from "./process-gate.js";

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