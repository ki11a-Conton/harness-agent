import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { snapshotEnvironment } from "./env-snapshot.js";

let cwd: string;
const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "env-remote-security-"));
  git("init", "-q");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
});
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

it.each([
  ["https://build-user:opaqueFixturePass9q@example.invalid/org/repo.git", "https://example.invalid/org/repo.git"],
  ["https://opaqueFixtureToken9q@example.invalid/org/repo.git", "https://example.invalid/org/repo.git"],
  ["https://build%40user:opaque%40FixturePass9q@example.invalid/org/repo.git", "https://example.invalid/org/repo.git"],
  ["https://example.invalid/org/repo.git?access_token=opaqueFixturePass9q#opaqueFragment9q", "https://example.invalid/org/repo.git"],
  ["ssh://git:opaqueFixturePass9q@example.invalid:2222/org/repo.git", "ssh://example.invalid:2222/org/repo.git"],
  ["https://build-user:opaqueFixturePass9q@", "[redacted: invalid remote URL]"],
])("snapshot removes authentication material from native Git origin %s", async (remote, safe) => {
  git("remote", "add", "origin", remote);
  const snapshot = await snapshotEnvironment({ cwd, probeLimit: 0 });
  expect(snapshot.git.available).toBe(true);
  expect(snapshot.git.remote).toBe(safe);
  const serialized = JSON.stringify(snapshot);
  expect(serialized).not.toMatch(/opaque(?:Fixture|%40Fixture|Fragment)/);
  expect(serialized).not.toContain("build-user");
  expect(serialized).not.toContain("build%40user");
});

it.each([
  "git@example.invalid:org/repo.git",
  "ssh://git@example.invalid/org/repo.git",
  "/srv/local-repository.git",
  "../local-repository.git",
  "C:\\repositories\\local.git",
  "file:///srv/local-repository.git",
  "https://example.invalid/org/repo.git",
])("retains a usable repository identity for safe remote %s", async remote => {
  git("remote", "add", "origin", remote);
  expect((await snapshotEnvironment({ cwd, probeLimit: 0 })).git.remote)
    .toBe(remote === "ssh://git@example.invalid/org/repo.git" ? "ssh://example.invalid/org/repo.git" : remote);
});

it("retains null when there is no origin", async () => {
  expect((await snapshotEnvironment({ cwd, probeLimit: 0 })).git.remote).toBeNull();
});
