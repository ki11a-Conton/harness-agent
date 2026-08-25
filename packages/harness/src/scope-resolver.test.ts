// P2-3: memory scope resolver — repository identity + scope derivation.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { memoryScopeFor, resolveRepositoryIdentity, stableHash } from "./scope-resolver.js";

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Run git rev-parse and return the actual git root, normalized. */
function gitRoot(dir: string): string {
  return normalizePath(execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
}

let tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ar-scope-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

function git(dir: string, args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}

describe("P2-3: repository identity", () => {
  it("detects a git repo and derives a stable id from the remote", async () => {
    const dir = await tempDir();
    git(dir, ["init", "-q"]);
    git(dir, ["remote", "add", "origin", "https://github.com/acme/repo.git"]);
    const identity = await resolveRepositoryIdentity(dir);
    expect(identity.kind).toBe("git");
    expect(identity.id).toBe(stableHash("https://github.com/acme/repo.git"));
    // Compare against git's OWN rev-parse output — git may report 8.3 short
    // paths (Windows) or long paths; only git's view of the root is
    // authoritative for identity.root.
    expect(identity.root).toBe(gitRoot(dir));
  });

  it("falls back to the repo root hash when there is no origin remote", async () => {
    const dir = await tempDir();
    git(dir, ["init", "-q"]);
    const identity = await resolveRepositoryIdentity(dir);
    expect(identity.kind).toBe("git");
    expect(identity.id).toBe(stableHash(gitRoot(dir)));
  });

  it("degrades to a path identity for non-git directories (never throws)", async () => {
    const dir = await tempDir();
    const identity = await resolveRepositoryIdentity(dir);
    expect(identity.kind).toBe("path");
    expect(identity.id).toBe(stableHash(normalizePath(dir)));
  });

  it("is stable for the same path across calls", async () => {
    const dir = await tempDir();
    const a = await resolveRepositoryIdentity(dir);
    const b = await resolveRepositoryIdentity(dir);
    expect(a.id).toBe(b.id);
  });
});

describe("P2-3: scope derivation", () => {
  it("maps git repos to repository scope and paths to workspace scope", async () => {
    expect(memoryScopeFor({ kind: "git", id: "x", root: "/r" })).toBe("repository");
    expect(memoryScopeFor({ kind: "path", id: "y", root: "/w" })).toBe("workspace");
  });

  it("an explicit scope always wins", async () => {
    expect(memoryScopeFor({ kind: "git", id: "x", root: "/r" }, "global")).toBe("global");
    expect(memoryScopeFor({ kind: "path", id: "y", root: "/w" }, "agent")).toBe("agent");
  });
});
