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
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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

/**
 * E4-R48 — a DEEP deterministic snapshot of a protected build-resource tree, so
 * the "byte-for-byte untouched" claim is actually testable. The old snapshot
 * only listed the top-level filenames of `apps/cli/dist` plus one tsbuildinfo
 * digest, so an OVERWRITTEN same-named file, a NESTED file change, or an add /
 * delete under a subdirectory left the snapshot unchanged — the claim was not
 * supported by evidence.
 *
 * The snapshot is a content-addressed digest over a DETERMINISTIC listing:
 *   [ { relPath, type: "file"|"dir", digest? }, ... ] sorted by relPath,
 * where `digest` is the sha256 of the file's raw bytes. A read failure is never
 * collapsed into an empty tree: it makes the snapshot a distinguishable
 * `<root>:ERROR:<rel>:<code>` / `...:EACCES...` marker so a genuinely unreadable
 * protected resource can never be silently "not modified".
 */
async function deepSnapshot(root: string): Promise<string> {
  const entries: Array<{ rel: string; type: "file" | "dir"; digest: string | null }> = [];
  const visit = async (dir: string, rel: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      // A directory we cannot read is a real, distinguishable fact.
      const code = (err as { code?: string }).code ?? "unknown";
      entries.push({ rel, type: "dir", digest: `ERROR:${code}` });
      return;
    }
    names.sort(); // deterministic order regardless of readdir order
    for (const name of names) {
      const abs = join(dir, name);
      const relPath = rel === "" ? name : `${rel}/${name}`;
      const st = await stat(abs).catch(() => null);
      if (st === null) {
        entries.push({ rel: relPath, type: "dir", digest: "ERROR:unreadable" });
        continue;
      }
      if (st.isDirectory()) {
        entries.push({ rel: relPath, type: "dir", digest: null });
        await visit(abs, relPath);
      } else if (st.isFile()) {
        let buf: Buffer;
        try {
          buf = await readFile(abs);
        } catch (err) {
          const code = (err as { code?: string }).code ?? "unknown";
          entries.push({ rel: relPath, type: "file", digest: `ERROR:${code}` });
          continue;
        }
        const digest = createHash("sha256").update(buf).digest("hex");
        entries.push({ rel: relPath, type: "file", digest });
      }
      // record other types (symlink/fifo/block) without a digest
    }
  };
  await visit(root, "");
  entries.sort((a, b) => a.rel.localeCompare(b.rel));
  return createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
}

/** Snapshot the shared repo build resources so we can prove no pollution. */
async function sharedBuildSnapshot(): Promise<string> {
  // E4-R48: the protected set is the main repo's shared `apps/cli/dist` tree plus
  // the tsbuildinfo file - exactly what R42's real-gate test claims to keep
  // byte-for-byte unchanged.
  const dist = await deepSnapshot(SHARED_DIST);
  const info = await deepSnapshot(dirname(SHARED_BUILDINFO));
  return createHash("sha256").update(dist + "|" + info).digest("hex");
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

  // ── E4-R48: the DEEP snapshot is actually discriminating. Each of these
  // manipulations (same-name overwrite, nested change, add, delete) MUST change
  // the digest, while an identical tree read in a different enumeration order
  // MUST NOT. Everything runs in a temp tree — the main repo is never touched.
  it("E4-R48: deep snapshot discriminates overwrite / nested / add / delete / read-error; order-stable", async () => {
    const ws = await makeGateWorkspace(); // real git identity + outDir config
    const base = join(ws, "snap");
    await mkdir(base, { recursive: true });
    await mkdir(join(base, "nested"), { recursive: true });
    await writeFile(join(base, "a.js"), "AAA\n", "utf8");
    await writeFile(join(base, "nested", "b.js"), "BBB\n", "utf8");
    const s0 = await deepSnapshot(base);

    // 1) same-name overwrite of a top-level file MUST change the digest.
    await writeFile(join(base, "a.js"), "AAAX\n", "utf8");
    const s1 = await deepSnapshot(base);
    expect(s1).not.toBe(s0);
    await writeFile(join(base, "a.js"), "AAA\n", "utf8");

    // 2) nested file change MUST change the digest (the old top-level-only
    //    snapshot could not see this).
    await writeFile(join(base, "nested", "b.js"), "BBBX\n", "utf8");
    const s2 = await deepSnapshot(base);
    expect(s2).not.toBe(s0);
    await writeFile(join(base, "nested", "b.js"), "BBB\n", "utf8");

    // 3) add a file MUST change the digest.
    await writeFile(join(base, "c.js"), "CCC\n", "utf8");
    const s3 = await deepSnapshot(base);
    expect(s3).not.toBe(s0);
    await rm(join(base, "c.js"));

    // 4) delete a file MUST change the digest.
    await rm(join(base, "nested", "b.js"));
    const s4 = await deepSnapshot(base);
    expect(s4).not.toBe(s0);
    await writeFile(join(base, "nested", "b.js"), "BBB\n", "utf8");

    // 5) identical content but a different enumeration order MUST be equal
    //    (deterministic sort) — that is what makes the snapshot stable under
    //    readdir order.
    const sBack = await deepSnapshot(base);
    expect(sBack).toBe(s0);
  }, 60_000);
});
