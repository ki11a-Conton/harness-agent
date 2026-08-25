import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SandboxPolicy } from "@ar/contracts";
import type { CommandPlatform } from "./process-gate.js";
import { SandboxManager, containsPath } from "./sandbox.js";

let ws: string;
let outside: string;

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "ar-sandbox-"));
  outside = mkdtempSync(join(tmpdir(), "ar-outside-"));
  writeFileSync(join(outside, "secret.txt"), "top secret");
  mkdirSync(join(ws, "sub"));
  writeFileSync(join(ws, "sub", "file.txt"), "hello");
});

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function makeManager(
  policy?: Partial<SandboxPolicy>,
  commandPlatform?: CommandPlatform,
): SandboxManager {
  const p: SandboxPolicy = {
    filesystem: { mode: "workspace-write", allowedPaths: [ws] },
    network: { mode: "deny", hosts: [] },
    process: { timeoutMs: 1000, maxOutputBytes: 1024 },
    ...policy,
  };
  return new SandboxManager(ws, ws, p, [], commandPlatform);
}

describe("SandboxManager filesystem", () => {
  it("allows reads inside the workspace", () => {
    const m = makeManager();
    expect(m.checkRead(join(ws, "sub", "file.txt")).allowed).toBe(true);
    expect(m.checkRead("sub/file.txt").allowed).toBe(true);
  });

  it("allows writes inside the workspace", () => {
    const m = makeManager();
    expect(m.checkWrite(join(ws, "new.txt")).allowed).toBe(true);
    expect(m.checkWrite("newdir/new.txt").allowed).toBe(true);
  });

  it("denies reads outside the workspace (absolute path)", () => {
    const m = makeManager();
    expect(m.checkRead(join(outside, "secret.txt")).allowed).toBe(false);
  });

  it("denies ../ escape", () => {
    const m = makeManager();
    expect(m.checkRead("../outside/secret.txt").allowed).toBe(false);
  });

  it("denies writes outside the workspace", () => {
    const m = makeManager();
    expect(m.checkWrite(join(outside, "new.txt")).allowed).toBe(false);
  });

  it("denies Windows drive paths outside the workspace", () => {
    const m = makeManager();
    expect(m.checkWrite("C:\\Windows\\System32\\evil.txt").allowed).toBe(false);
    expect(m.checkRead("D:\\secret.txt").allowed).toBe(false);
  });

  it("denies UNC paths", () => {
    const m = makeManager();
    expect(m.checkRead("\\\\server\\share\\file.txt").allowed).toBe(false);
    expect(m.checkWrite("\\\\server\\share\\write.txt").allowed).toBe(false);
  });

  it("denies symlink escape", () => {
    const link = join(ws, "escape-link");
    try {
      symlinkSync(outside, link, "junction");
    } catch {
      return; // symlink creation unsupported on this host
    }
    const m = makeManager();
    const real = realpathSync(link);
    expect(real.startsWith(ws)).toBe(false);
    expect(m.checkRead(join(link, "secret.txt")).allowed).toBe(false);
  });

  it("read-only mode denies writes", () => {
    const m = makeManager({ filesystem: { mode: "read-only", allowedPaths: [ws] } });
    expect(m.checkWrite(join(ws, "x.txt")).allowed).toBe(false);
    expect(m.checkRead(join(ws, "sub", "file.txt")).allowed).toBe(true);
  });

  it("full mode allows everything", () => {
    const m = makeManager({ filesystem: { mode: "full" } });
    expect(m.checkRead(join(outside, "secret.txt")).allowed).toBe(true);
    expect(m.checkWrite(join(outside, "x.txt")).allowed).toBe(true);
  });
});

describe("SandboxManager network", () => {
  it("denies when policy is deny", () => {
    const m = makeManager();
    expect(m.checkNetwork("https://evil.example.com/x").allowed).toBe(false);
  });

  it("allowlist matches hostnames and globs", () => {
    const m = makeManager({
      network: { mode: "allowlist", hosts: ["api.github.com", "*.npmjs.org"] },
    });
    expect(m.checkNetwork("https://api.github.com/repos/x").allowed).toBe(true);
    expect(m.checkNetwork("https://registry.npmjs.org/pkg").allowed).toBe(true);
    expect(m.checkNetwork("https://evil.example.com").allowed).toBe(false);
  });

  it("full allows anything", () => {
    const m = makeManager({ network: { mode: "full" } });
    expect(m.checkNetwork("https://anything.example.com").allowed).toBe(true);
  });

  it("rejects invalid URLs under allowlist", () => {
    const m = makeManager({ network: { mode: "allowlist", hosts: ["ok.example.com"] } });
    expect(m.checkNetwork("not a url").allowed).toBe(false);
  });
});

describe("SandboxManager process", () => {
  it("enforces command allowlist", () => {
    const m = makeManager({
      process: { allowedCommands: ["pnpm test", "git diff"] },
    });
    expect(m.checkExec("pnpm test").allowed).toBe(true);
    expect(m.checkExec("git diff --stat").allowed).toBe(true);
    const denied = m.checkExec("rm -rf /");
    expect(denied.allowed).toBe(false);
    expect(denied.kind).toBe("process");
    expect(m.checkExec("npm run secret").allowed).toBe(false);
  });

  it("allows all commands when no allowlist", () => {
    const m = makeManager();
    expect(m.checkExec("anything at all").allowed).toBe(true);
  });

  it("denies local commands only when they carry network intent (Phase 9 gate)", () => {
    const m = makeManager();
    const local = m.checkExec("node test.js");
    expect(local.allowed).toBe(true);
    expect(local.kind).toBeUndefined();

    const net = m.checkExec("curl -s http://evil.example.com/x");
    expect(net.allowed).toBe(false);
    expect(net.kind).toBe("network");
    expect(net.reason).toContain("curl");
  });

  it("network gate: allowlist mode permits only commands whose hosts are allowed", () => {
    const m = makeManager({ network: { mode: "allowlist", hosts: ["api.github.com"] } });
    expect(m.checkExec("curl https://api.github.com/repos/x").allowed).toBe(true);
    expect(m.checkExec("curl https://evil.example.com").allowed).toBe(false);
    // No URL/host in the command -> nothing to validate against -> denied.
    expect(m.checkExec("git push origin main").allowed).toBe(false);
  });

  it("network gate: full mode skips the check entirely", () => {
    const m = makeManager({ network: { mode: "full" } });
    expect(m.checkExec("curl http://anything.example.com").allowed).toBe(true);
  });

  it("process allowlist still wins before the network gate", () => {
    const m = makeManager({ process: { allowedCommands: ["node test.js"] } });
    expect(m.checkExec("node test.js").allowed).toBe(true);
    expect(m.checkExec("curl http://x.com").allowed).toBe(false);
  });

  it("P2-23: denied process surface is rejected even when allowlisted (fail-closed)", () => {
    const m = makeManager({
      process: { allowedCommands: ["node -e 'x'"], deniedSurfaces: ["interpreter-eval"] },
    });
    const d = m.checkExec("node -e 'x'");
    expect(d.allowed).toBe(false);
    expect(d.kind).toBe("process");
    expect(d.reason).toContain("interpreter-eval");
  });

  it("P2-23: denied surface does not affect other surfaces", () => {
    const m = makeManager({ process: { deniedSurfaces: ["shell-wrapper"] } });
    expect(m.checkExec("node test.js").allowed).toBe(true);
    expect(m.checkExec("cmd /c dir").allowed).toBe(false);
  });

  it("P2-23: surface gate runs before the command allowlist", () => {
    const m = makeManager({
      process: { allowedCommands: ["cd /tmp"], deniedSurfaces: ["shell-wrapper"] },
    });
    expect(m.checkExec("sh -c 'cd /tmp'").allowed).toBe(false);
  });
});

describe("SandboxManager evaluate", () => {
  it("routes by operation", () => {
    const m = makeManager({ process: { allowedCommands: ["pnpm test"] } });
    expect(m.evaluate({ target: join(ws, "f.txt"), operation: "read", policy: m.policy }).allowed).toBe(true);
    expect(m.evaluate({ target: "../outside/x", operation: "write", policy: m.policy }).allowed).toBe(false);
    expect(m.evaluate({ target: "rm -rf *", operation: "exec", policy: m.policy }).allowed).toBe(false);
    expect(m.evaluate({ target: "pnpm test", operation: "exec", policy: m.policy }).allowed).toBe(true);
  });
});

describe("P2-22 filesystem sandbox hardening", () => {
  it("rejects control-character and NUL-padded paths as invalid (not just outside)", () => {
    const m = makeManager();
    expect(m.checkRead("sub/file.txt\u0000x").allowed).toBe(false);
    expect(m.checkRead("\nsub/file.txt").allowed).toBe(false);
    expect(m.checkWrite("ok\u0000name.tx").allowed).toBe(false);
  });

  it("does NOT treat a path merely sharing a textual prefix as inside (ancestor collision)", () => {
    // A "sibling" of ws that merely extends the basename (ws + "-sibling")
    // must not be counted as inside the workspace boundary.
    const sibling = join(dirname(ws), `${basename(ws)}-sibling`);
    const m = makeManager();
    expect(m.checkRead(join(sibling, "secret.txt")).allowed).toBe(false);
    expect(m.checkWrite(join(sibling, "x.txt")).allowed).toBe(false);
  });

  it("honors allowedPaths as an extra writable/readable root (temp / artifact dir)", () => {
    const artifact = mkdtempSync(join(tmpdir(), "ar-artifact-"));
    try {
      const m = new SandboxManager(ws, ws, {
        filesystem: { mode: "workspace-write", allowedPaths: [ws, artifact] },
        network: { mode: "deny", hosts: [] },
        process: { timeoutMs: 1000 },
      });
      expect(m.checkWrite(join(artifact, "out.bin")).allowed).toBe(true);
      expect(m.checkRead(join(artifact, "x.bin")).allowed).toBe(true);
      // The workspace itself remains in scope.
      expect(m.checkRead(join(ws, "sub", "file.txt")).allowed).toBe(true);
      // Still outside every allowed root.
      expect(m.checkWrite(join(outside, "x.txt")).allowed).toBe(false);
    } finally {
      rmSync(artifact, { recursive: true, force: true });
    }
  });

  it("keeps read vs write scopes separate (read-only still allows reads)", () => {
    const m = makeManager({ filesystem: { mode: "read-only", allowedPaths: [ws] } });
    expect(m.checkRead(join(ws, "sub", "file.txt")).allowed).toBe(true);
    expect(m.checkWrite(join(ws, "x.txt")).allowed).toBe(false);
  });

  it("containsPath enforces a path boundary, not a raw string prefix", () => {
    expect(containsPath("/tmp/ws/sub/f.txt", "/tmp/ws", false)).toBe(true);
    expect(containsPath("/tmp/ws", "/tmp/ws", false)).toBe(true);
    expect(containsPath("/tmp/ws2/x", "/tmp/ws", false)).toBe(false); // ancestor collision
    expect(containsPath("/tmp/ws-2/x", "/tmp/ws", false)).toBe(false); // sibling collision
  });

  it("containsPath handles trailing-slash roots and Windows-style separators", () => {
    expect(containsPath("/tmp/ws/a", "/tmp/ws/", false)).toBe(true);
    expect(containsPath("C:\\ws\\a", "C:\\ws", false)).toBe(true);
    expect(containsPath("C:\\ws2\\a", "C:\\ws", false)).toBe(false);
  });

  it("containsPath case-folds only when caseInsensitive is requested", () => {
    // Case-sensitive default: a different-cased path is a different path.
    expect(containsPath("/TMP/WS/x", "/tmp/ws", false)).toBe(false);
    // Case-insensitive: the same textual path, differently cased, is inside.
    expect(containsPath("/TMP/WS/x", "/tmp/ws", true)).toBe(true);
    expect(containsPath("/tmp/WS/x", "/tmp/ws", true)).toBe(true);
    // Case-insensitive must NOT erase a genuinely different sibling.
    expect(containsPath("/tmp/ws2/x", "/tmp/ws", true)).toBe(false);
  });

  it("case-insensitive fold also rejects a truly-different sibling, not only exact root", () => {
    const m = makeManager({ filesystem: { mode: "workspace-write", allowedPaths: [ws], caseInsensitive: true } });
    // A different child dir under ws is still allowed in case-insensitive mode…
    expect(m.checkWrite(join(ws, "AnyCase", "x.txt")).allowed).toBe(true);
    // …but the outside dir remains outside even with case folded differently.
    expect(m.checkWrite(join(outside, "SECRET.txt")).allowed).toBe(false);
  });

  it("workspace root itself is always inside (self reference)", () => {
    const m = makeManager();
    expect(m.checkRead(ws).allowed).toBe(true);
    expect(m.checkWrite(join(ws, "file.txt")).allowed).toBe(true);
  });

  it("symlink via a junction pointing out of scope is denied (junction escape)", () => {
    const junction = join(ws, "junction-out");
    try {
      symlinkSync(outside, junction, "junction");
    } catch {
      return;
    }
    const m = makeManager();
    expect(m.checkRead(join(junction, "secret.txt")).allowed).toBe(false);
    expect(m.checkWrite(join(junction, "x.txt")).allowed).toBe(false);
  });
});
describe("P14-2 exec allowlist semantic matching", () => {
  it("allows an exact allowlisted command and its argument extensions", () => {
    const m = makeManager(
      { process: { allowedCommands: ["pnpm test", "git diff"] } },
      "posix",
    );
    expect(m.checkExec("pnpm test").allowed).toBe(true);
    expect(m.checkExec("git diff").allowed).toBe(true);
    // Argument extension WITHOUT composition operators is allowed.
    expect(m.checkExec("git diff --stat").allowed).toBe(true);
    expect(m.checkExec("pnpm test -- foo.test.ts").allowed).toBe(true);
  });

  it("rejects a sibling program even when it shares a textual prefix (git diffx)", () => {
    const m = makeManager({ process: { allowedCommands: ["git diff"] } }, "posix");
    expect(m.checkExec("git diffx").allowed).toBe(false);
    expect(m.checkExec("git difftool").allowed).toBe(false);
  });

  it("rejects a command not in the allowlist", () => {
    const m = makeManager(
      { process: { allowedCommands: ["pnpm test", "git diff"] } },
      "posix",
    );
    expect(m.checkExec("rm -rf /").allowed).toBe(false);
    expect(m.checkExec("npm run secret").allowed).toBe(false);
  });

  it("POSIX: rejects shell composition after an allowlisted prefix (no argument-extension bypass)", () => {
    const m = makeManager(
      { process: { allowedCommands: ["git diff", "pnpm test"] } },
      "posix",
    );
    // P14-2: these all contain POSIX shell composition operators → denied even
    // though they TEXTUALLY start with an allowlisted command.
    expect(m.checkExec("git diff; rm -rf /").allowed).toBe(false);
    expect(m.checkExec("git diff && echo pwned").allowed).toBe(false);
    expect(m.checkExec("git diff || true").allowed).toBe(false);
    expect(m.checkExec("git diff | sh").allowed).toBe(false);
    expect(m.checkExec("git diff $(cat /etc/passwd)").allowed).toBe(false);
    expect(m.checkExec("git diff `whoami`").allowed).toBe(false);
    expect(m.checkExec("git diff\nrm -rf /").allowed).toBe(false);
  });

  it("Windows cmd: `&` composition after an allowlisted prefix is rejected; `;` is inert on cmd", () => {
    const m = makeManager(
      { process: { allowedCommands: ["git diff"] } },
      "windows",
    );
    // cmd separates commands with `&`, NOT `;`.
    expect(m.checkExec("git diff & rm -rf /").allowed).toBe(false);
    expect(m.checkExec("git diff && rm -rf /").allowed).toBe(false);
    expect(m.checkExec("git diff | more").allowed).toBe(false);
    // `;` is NOT a composition operator on cmd — so this is not an injection.
    // It is also not a valid argv extension (`diff;` ≠ `diff`), so it stays
    // denied fail-closed: never allowed as a bare argument extension.
    expect(m.checkExec("git diff; rm -rf /").allowed).toBe(false);
  });

  it("rejects composed cmd.exe and PowerShell commands", () => {
    const m = makeManager(
      { process: { allowedCommands: ["cmd /c dir", "powershell -Command Get-ChildItem"] } },
      "windows",
    );
    // cmd chained operators
    expect(m.checkExec("cmd /c dir & del /f x").allowed).toBe(false);
    expect(m.checkExec("cmd /c dir && del x").allowed).toBe(false);
    // PowerShell operators
    expect(m.checkExec("powershell -Command \"Get-ChildItem; Remove-Item x\"").allowed).toBe(false);
    expect(m.checkExec("powershell -Command \"Get-ChildItem | Out-File x\"").allowed).toBe(false);
    expect(m.checkExec("powershell -Command \"Get-ChildItem & Remove-Item x\"").allowed).toBe(false);
    // Encoded command is not an extension of the plain wrapper.
    expect(m.checkExec("powershell -EncodedCommand AAA=").allowed).toBe(false);
  });

  it("glob allowlist entries still permit plain commands (P36-5: no shell composition via glob)", () => {
    const m = makeManager({ process: { allowedCommands: ["**/*"] } }, "posix");
    expect(m.checkExec("git diff").allowed).toBe(true);
    // P36-5 (INV-P36-005): a broad glob is a plain-command allowlist rule — it
    // cannot authorize shell composition, even when it says "everything".
    expect(m.checkExec("git diff; rm -rf /").allowed).toBe(false);
    expect(m.checkExec("rm -rf /").allowed).toBe(true);
  });

  it("surfaceDenied still runs before the allowlist (shell-wrapper rejected)", () => {
    const m = makeManager(
      { process: { allowedCommands: ["**/*"], deniedSurfaces: ["shell-wrapper"] } },
      "posix",
    );
    // A composed command's surface is escalated to shell-wrapper → denied.
    expect(m.checkExec("git diff; rm -rf /").allowed).toBe(false);
    // Plain commands remain allowed.
    expect(m.checkExec("git diff").allowed).toBe(true);
  });
});

describe("P14-1 canonicalization regressions", () => {
  it("an empty allowedPaths entry is ignored (never widens or crashes the check)", () => {
    // A policy with a stray "" entry (e.g. built before a var was set) must
    // not fail the sandbox nor open a hole: the empty string is not a path
    // and contains nothing.
    const m = makeManager({
      filesystem: { mode: "workspace-write", allowedPaths: [ws, ""] },
    });
    expect(m.checkWrite(join(ws, "ok.txt")).allowed).toBe(true);
    expect(m.checkWrite(join(outside, "x.txt")).allowed).toBe(false);
    expect(m.checkRead(join(outside, "secret.txt")).allowed).toBe(false);
  });

  it("absolute traversal via .. is denied (/ws/../outside/secret.txt)", () => {
    const m = makeManager();
    expect(m.checkRead(join(ws, "..", basename(outside), "secret.txt")).allowed).toBe(false);
    expect(m.checkWrite(join(ws, "..", basename(outside), "new.txt")).allowed).toBe(false);
  });

  it("multi-level absolute traversal is denied (/ws/sub/../../outside/secret.txt)", () => {
    const m = makeManager();
    // /ws/sub → .. → /ws → .. → tmpdir → outside/secret.txt (outside ws).
    const target = join(ws, "sub", "..", "..", basename(outside), "secret.txt");
    expect(m.checkRead(target).allowed).toBe(false);
  });

  it("trailing separators and duplicate separators are still inside (no false denial)", () => {
    const m = makeManager();
    expect(m.checkRead(`${ws}/sub/`).allowed).toBe(true);
    expect(m.checkRead(`${ws}//sub//file.txt`).allowed).toBe(true);
  });

  it(". segments are resolved and stay inside", () => {
    const m = makeManager();
    expect(m.checkRead(`${ws}/./sub/./file.txt`).allowed).toBe(true);
  });

  it("traversal out via .. then into a sibling text-prefix root is denied", () => {
    // /ws/sub → .. → /ws → .. → tmpdir → <sibling>/x.txt. The sibling shares
    // the textual prefix `basename(ws)` but lives OUTSIDE /ws — the canonical
    // ancestor walk must not lose the tail segments nor let the prefix fool it.
    const sibling = join(dirname(ws), `${basename(ws)}-sibling`);
    const m = makeManager();
    expect(m.checkWrite(join(ws, "sub", "..", "..", basename(sibling), "x.txt")).allowed).toBe(false);
  });

  it("symlink escape with a NON-EXISTENT tail is denied on write (deepest existing ancestor is the symlink)", () => {
    const link = join(ws, "out-link");
    try {
      symlinkSync(outside, link, "junction");
    } catch {
      return; // symlink creation unsupported on this host
    }
    const m = makeManager();
    // The deepest existing ancestor of /ws/out-link/deep/new.txt is the
    // symlink itself → realpath resolves it to /outside → containment denies.
    expect(m.checkWrite(join(link, "deep", "new.txt")).allowed).toBe(false);
    expect(m.checkRead(join(link, "deep", "secret.txt")).allowed).toBe(false);
  });

  it("symlink pointing INSIDE the workspace stays allowed (no false positive denial)", () => {
    const link = join(ws, "in-link");
    try {
      symlinkSync(join(ws, "sub"), link, "junction");
    } catch {
      return;
    }
    const m = makeManager();
    expect(m.checkRead(join(link, "file.txt")).allowed).toBe(true);
  });

  it("case-insensitive policy rejects a differently-cased OUTSIDE sibling", () => {
    const m = makeManager({
      filesystem: { mode: "workspace-write", allowedPaths: [ws], caseInsensitive: true },
    });
    const upperSibling = join(dirname(ws), `${basename(ws).toUpperCase()}-SIBLING`);
    expect(m.checkRead(join(upperSibling, "x.txt")).allowed).toBe(false);
  });
});

describe("P3-6 sandbox extra roots", () => {
  it("admits a child's isolated workspace root as a writable extra root", () => {
    const p: SandboxPolicy = {
      filesystem: { mode: "workspace-write", allowedPaths: [ws] },
      network: { mode: "deny", hosts: [] },
      process: { timeoutMs: 1000, maxOutputBytes: 1024 },
    };
    const isolated = join(outside, "child-ws");
    mkdirSync(isolated, { recursive: true });
    const m = new SandboxManager(ws, ws, p, [isolated]);
    // The isolated child workspace (outside the parent root) is writable...
    expect(m.checkWrite(join(isolated, "out.ts")).allowed).toBe(true);
    // ...and the parent workspace remains writable as usual...
    expect(m.checkWrite(join(ws, "main.ts")).allowed).toBe(true);
    // ...but an unrelated location outside the extra root stays denied.
    expect(m.checkWrite(join(outside, "other", "x.txt")).allowed).toBe(false);
  });
});
