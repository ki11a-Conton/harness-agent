import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { realpath } from "node:fs/promises";
import { resolveExecCwd } from "./exec.js";

// ---------------------------------------------------------------------------
// E4-R07 — a LEGITIMATE workspace-root alias must not read as a symlink escape.
//
// Root cause under test: the containment check realpath-ed the candidate but
// compared it against the UN-canonicalized workspace root, so any root reached
// through an alias escapes its own root. POSIX symlink and Windows junction are
// the same class of path the Windows CI runner hits (junction / 8.3 short name).
// ---------------------------------------------------------------------------

function makeAlias(target: string, aliasPath: string): boolean {
  try {
    if (process.platform === "win32") {
      // A junction needs no elevation and is the Windows analogue of an alias.
      execFileSync("cmd.exe", ["/c", "mklink", "/J", aliasPath, target], { stdio: "ignore" });
    } else {
      symlinkSync(target, aliasPath, "dir");
    }
    return true;
  } catch {
    return false; // host cannot create aliases — skip rather than flake
  }
}

let real = "";
let alias = "";
let outside = "";
let hasAlias = false;

beforeAll(() => {
  real = mkdtempSync(join(tmpdir(), "ar-exec-real-"));
  outside = mkdtempSync(join(tmpdir(), "ar-exec-out2-"));
  mkdirSync(join(real, "sub"), { recursive: true });
  writeFileSync(join(real, "sub", "inside.txt"), "y");
  alias = join(real, "..", "ar-exec-alias-" + basename(real));
  hasAlias = makeAlias(real, alias);
  if (!hasAlias) {
    process.stderr.write("[e4-r07] alias creation unavailable on this host; alias cases skip\n");
  }
});

afterAll(() => {
  if (alias !== "") rmSync(alias, { recursive: true, force: true });
  rmSync(real, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("resolveExecCwd — E4-R07 legitimate root alias", () => {
  it("'.': an aliased root resolves inside the real directory (no false escape)", async () => {
    if (!hasAlias) return;
    const got = await resolveExecCwd(".", alias);
    expect(existsSync(join(got, "sub", "inside.txt")), "resolved path must be the real dir, got " + got).toBe(true);
  });

  it("undefined and empty cwd behave like '.' under an aliased root", async () => {
    if (!hasAlias) return;
    const dot = await resolveExecCwd(".", alias);
    expect(await resolveExecCwd(undefined, alias)).toBe(dot);
    expect(await resolveExecCwd("", alias)).toBe(dot);
  });

  it("relative subpath and absolute-in-root cwd both resolve under an aliased root", async () => {
    if (!hasAlias) return;
    const viaRelative = await resolveExecCwd("sub", alias);
    expect(existsSync(join(viaRelative, "inside.txt"))).toBe(true);
    const viaAbsolute = await resolveExecCwd(join(alias, "sub"), alias);
    expect(viaAbsolute).toBe(viaRelative);
  });

  it("a link INSIDE the aliased workspace pointing outside is STILL rejected", async () => {
    if (!hasAlias) return;
    const leak = join(real, "leak-link");
    let linked = false;
    try {
      symlinkSync(outside, leak, "dir");
      linked = true;
    } catch {
      try {
        execFileSync("cmd.exe", ["/c", "mklink", "/J", leak, outside], { stdio: "ignore" });
        linked = true;
      } catch {
        linked = false;
      }
    }
    if (!linked) {
      rmSync(leak, { recursive: true, force: true });
      return;
    }
    await expect(resolveExecCwd("leak-link", alias)).rejects.toThrow("WORKSPACE_POLICY:symlink-escape");
    rmSync(leak, { recursive: true, force: true });
  });

  it("escaping through an aliased root is STILL rejected", async () => {
    if (!hasAlias) return;
    await expect(resolveExecCwd("..", alias)).rejects.toThrow("WORKSPACE_POLICY:cwd-outside");
  });

  it("non-existent and file cwd keep their stable policy errors under an alias", async () => {
    if (!hasAlias) return;
    await expect(resolveExecCwd("no-such-dir", alias)).rejects.toThrow("WORKSPACE_POLICY:cwd-unresolvable");
    await expect(resolveExecCwd("sub/inside.txt", alias)).rejects.toThrow("WORKSPACE_POLICY:cwd-not-directory");
  });

  it("diagnostic: record lexical vs canonical root/candidate forms on failure", async () => {
    if (!hasAlias) return;
    try {
      await resolveExecCwd(".", alias);
    } catch (err) {
      const canonicalRoot = await realpath(alias).catch(() => "<unresolvable>");
      const canonicalCandidate = await realpath(resolve(alias)).catch(() => "<unresolvable>");
      process.stderr.write(
        "[e4-r07] FAIL lexicalRoot=" + alias +
        " canonicalRoot=" + canonicalRoot +
        " lexicalCandidate=" + resolve(alias) +
        " canonicalCandidate=" + canonicalCandidate +
        " relative=" + relative(alias, canonicalRoot) +
        " err=" + String(err) + "\n",
      );
      throw err;
    }
    void realpathSync;
  });
});
