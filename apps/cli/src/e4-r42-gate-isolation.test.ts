/**
 * E4-R42 (K03) — a REAL gate run in its OWN controlled workspace.
 *
 * K03 observed that `release-command.test.ts` executes the real `typecheck`
 * gate (`tsc -b`) against the MAIN repo root, writing the shared
 * `apps/cli/dist/**` and `node_modules/.cache/tsbuildinfo/*` that other tests
 * read — an unconstrained overlap on shared build resources (and, together with
 * the legacy observation fixture in `apps/cli/src/`, the source of the orphan
 * `dist/e4-r24-fixture-*.js` files).
 *
 * This test proves the isolation boundary WITHOUT weakening the real evidence:
 * the gate command is executed for real (a real `tsc` process, a real non-zero
 * child), in a temp workspace that has its OWN git identity, package/script
 * config and build output/cache. The main repo's shared dist + build info must
 * be byte-for-byte untouched by the run.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runGateV2 } from "@ar/evaluation";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const TSC = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
const SHARED_DIST = join(REPO_ROOT, "apps", "cli", "dist");
const SHARED_BUILDINFO = join(REPO_ROOT, "node_modules", ".cache", "tsbuildinfo", "cli.tsbuildinfo");

let tempDirs: string[] = [];
afterEach(async () => {
  for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

/** A temp workspace with a REAL git identity + explainable build config. */
async function makeGateWorkspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), "e4-r42-gate-"));
  tempDirs.push(ws);
  await writeFile(join(ws, ".gitignore"), "out/\nlogs/\nnode_modules/\n", "utf8");
  await writeFile(join(ws, "package.json"), JSON.stringify({
    name: "e4-r42-gate-workspace", private: true, version: "0.0.0",
    scripts: { typecheck: "tsc -p tsconfig.json" },
  }, null, 2) + "\n", "utf8");
  await writeFile(join(ws, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
      rootDir: "./src", outDir: "./out", tsBuildInfoFile: "./out/.tsbuildinfo", skipLibCheck: true, types: [],
    },
    include: ["src"],
  }, null, 2) + "\n", "utf8");
  await mkdir(join(ws, "src"), { recursive: true });
  await writeFile(join(ws, "src", "index.ts"), "export const value: number = 1;\n", "utf8");
  // A real git identity: the evidence SHA must belong to THIS workspace.
  git(ws, ["init", "-q"]);
  git(ws, ["config", "user.email", "e4-r42@example.invalid"]);
  git(ws, ["config", "user.name", "E4 R42"]);
  git(ws, ["config", "commit.gpgsign", "false"]);
  git(ws, ["add", "-A"]);
  git(ws, ["commit", "-q", "-m", "e4-r42 gate workspace"]);
  return ws;
}

/** Snapshot the shared repo build resources so we can prove no pollution. */
async function sharedBuildSnapshot(): Promise<string> {
  const names = (await readdir(SHARED_DIST).catch(() => [] as string[])).sort();
  const buildInfo = await readFile(SHARED_BUILDINFO).catch(() => Buffer.from(""));
  return createHash("sha256")
    .update(JSON.stringify({ names, buildInfo: createHash("sha256").update(buildInfo).digest("hex") }))
    .digest("hex");
}

describe("E4-R42 (K03) real gate runs in an isolated workspace", () => {
  it("green AND real-nonzero child commands record consistent evidence; the shared dist/buildinfo is untouched", async () => {
    const ws = await makeGateWorkspace();
    const headSha = git(ws, ["rev-parse", "HEAD"]).trim();
    const before = await sharedBuildSnapshot();

    // ── REAL green command: a real `tsc` process emitting into the WORKSPACE ──
    const green = await runGateV2({
      gate: "typecheck",
      command: [process.execPath, TSC, "-p", "tsconfig.json"],
      cwd: ws,
      toolVersion: "e4-r42",
      environmentClass: "offline",
      providerCalls: 0,
      logDir: join(ws, "logs"),
      logRefBase: ws,
    });
    expect(green.exitCode).toBe(0);
    expect(green.passed).toBe(true);
    expect(green.state).toBe("passed");
    expect(green.cleanBefore).toBe(true);
    expect(green.cleanAfter).toBe(true);
    // The evidence SHA belongs to the WORKSPACE, never the main repo.
    expect(green.gitSha).toBe(headSha);
    expect(green.logRef?.path).toBeDefined();
    // The real build output landed in the WORKSPACE (its own outDir).
    const emitted = await readdir(join(ws, "out"));
    expect(emitted.some((f) => f.startsWith("index."))).toBe(true);

    // ── REAL non-zero child: a genuine failing process with a stderr message ──
    const red = await runGateV2({
      gate: "typecheck",
      command: [process.execPath, "-e", "process.stderr.write('gate-failure-detail'); process.exit(3)"],
      cwd: ws,
      toolVersion: "e4-r42",
      environmentClass: "offline",
      providerCalls: 0,
      logDir: join(ws, "logs"),
      logRefBase: ws,
    });
    expect(red.exitCode).toBe(3);
    expect(red.passed).toBe(false);
    expect(red.state).toBe("failed");
    // The REAL failure detail is recoverable from the saved log (never just a boolean).
    const redLog = await readFile(join(ws, red.logRef!.path), "utf8");
    expect(redLog).toContain("gate-failure-detail");
    expect(red.errorSummary ?? "").toContain("gate-failure-detail");

    // ── The shared build resources of the MAIN repo were never touched ──
    expect(await sharedBuildSnapshot()).toBe(before);
  }, 240_000);
});
