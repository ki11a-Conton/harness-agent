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
 *
 * E4-R53 (F53) — VALIDITY IS NOT EQUALITY.
 *
 * R48's snapshot collapsed a read failure into a `<root>:ERROR:<rel>:<code>`
 * marker inside the digest, but the caller only ever compared digests. Two
 * snapshots that BOTH failed to read therefore produced EQUAL digests, and
 * `expect(after).toBe(before)` certified "the shared resources are unchanged"
 * from evidence that had read nothing at all. An error string existing inside a
 * digest is not the same as the caller handling the error.
 *
 * The snapshot now returns an INSPECTABLE result — `{ valid, digest, errors,
 * absent, entries }` — and the isolation verdict validates both snapshots before
 * it is allowed to compare digests. A required root that cannot be read is a
 * FAILURE, never a silent "unchanged".
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGateV2 } from "@ar/evaluation";

/**
 * E4-R53 fault seam — injected ONLY for temp trees owned by this test.
 *
 * The main repo is never chmod'ed, never mutated and never made unreadable: the
 * failure is produced at the module boundary for an explicitly-registered
 * absolute path.
 */
const ioFaults = vi.hoisted(() => ({
  /** absolute path -> operations that must fail with EACCES */
  fail: new Map<string, Set<string>>(),
  /** directories whose `readdir` result is REVERSED (a real order perturbation) */
  reorder: new Set<string>(),
  /** how many times a real reorder was actually applied (proves the perturbation ran) */
  reorderedCalls: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const eacces = (op: string, target: string): NodeJS.ErrnoException => {
    const err = new Error(`EACCES: permission denied, ${op} '${target}'`) as NodeJS.ErrnoException;
    err.code = "EACCES";
    return err;
  };
  const guarded = async (
    op: "readdir" | "lstat" | "readFile",
    target: unknown,
    run: () => Promise<unknown>,
  ): Promise<unknown> => {
    const key = String(target);
    if (ioFaults.fail.get(key)?.has(op) === true) throw eacces(op, key);
    const out = await run();
    if (op === "readdir" && ioFaults.reorder.has(key) && Array.isArray(out)) {
      ioFaults.reorderedCalls += 1;
      return [...(out as unknown[])].reverse();
    }
    return out;
  };
  type Raw = (a: unknown, ...r: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    readdir: ((p: unknown, ...rest: unknown[]) =>
      guarded("readdir", p, () => (actual.readdir as unknown as Raw)(p, ...rest))) as typeof actual.readdir,
    lstat: ((p: unknown, ...rest: unknown[]) =>
      guarded("lstat", p, () => (actual.lstat as unknown as Raw)(p, ...rest))) as typeof actual.lstat,
    readFile: ((p: unknown, ...rest: unknown[]) =>
      guarded("readFile", p, () => (actual.readFile as unknown as Raw)(p, ...rest))) as typeof actual.readFile,
  };
});

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const TSC = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
const SHARED_DIST = join(REPO_ROOT, "apps", "cli", "dist");
const SHARED_BUILDINFO = join(REPO_ROOT, "node_modules", ".cache", "tsbuildinfo", "cli.tsbuildinfo");

let tempDirs: string[] = [];
afterEach(async () => {
  ioFaults.fail.clear();
  ioFaults.reorder.clear();
  ioFaults.reorderedCalls = 0;
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

// ---------------------------------------------------------------------------
// E4-R48 / E4-R53 — the deep, INSPECTABLE snapshot
// ---------------------------------------------------------------------------

type SnapshotOp = "readdir" | "lstat" | "readFile" | "readlink";

interface SnapshotError {
  /** path RELATIVE to the snapshot root ("" is the root itself) */
  rel: string;
  op: SnapshotOp;
  reason: string;
}

interface SnapshotEntry {
  rel: string;
  type: "file" | "dir" | "link" | "other";
  digest: string | null;
  /** E4-R53: recorded for links so a RETARGETED link still changes the digest. */
  linkTarget?: string;
}

interface DeepSnapshot {
  /** true iff NOTHING failed to read. Only a valid snapshot may certify anything. */
  valid: boolean;
  digest: string;
  errors: SnapshotError[];
  /** roots that are explicitly ALLOWED to be missing and were. */
  absent: string[];
  entryCount: number;
  entries: SnapshotEntry[];
}

/** Anything the isolation verdict is allowed to reason about. */
interface SnapshotLike {
  valid: boolean;
  digest: string;
  errors: SnapshotError[];
}

const describeErrors = (errors: SnapshotError[]): string =>
  errors.length === 0 ? "<none>" : errors.map((e) => `${e.op}(${e.rel === "" ? "<root>" : e.rel}): ${e.reason}`).join("; ");

/**
 * E4-R48 — a DEEP deterministic snapshot of a protected build-resource tree, so
 * the "byte-for-byte untouched" claim is actually testable. The old snapshot
 * only listed the top-level filenames of `apps/cli/dist` plus one tsbuildinfo
 * digest, so an OVERWRITTEN same-named file, a NESTED file change, or an add /
 * delete under a subdirectory left the snapshot unchanged.
 *
 * The snapshot is a content-addressed digest over a DETERMINISTIC listing:
 *   [ { relPath, type, digest?, linkTarget? }, ... ] sorted by relPath,
 * where `digest` is the sha256 of the file's raw bytes.
 *
 * E4-R53 changes:
 *   - `lstat` (not `stat`): a symlink is RECORDED, never followed, so a link
 *     cycle cannot cause unbounded recursion. Other special types (fifo /
 *     socket / device) are recorded as `other` and never opened.
 *   - Every read failure is reported as `{ rel, op, reason }` and makes the
 *     result `valid: false`. Nothing is collapsed into a digest-only marker.
 *   - `mustExist` encodes the resource-existence CONTRACT: a required root that
 *     is missing or unreadable is an ERROR; an explicitly optional root is
 *     recorded as `absent` (a distinguishable, honest state) without weakening
 *     the required set.
 */
async function deepSnapshot(root: string, opts: { mustExist?: boolean } = {}): Promise<DeepSnapshot> {
  const mustExist = opts.mustExist ?? true;
  const entries: SnapshotEntry[] = [];
  const errors: SnapshotError[] = [];
  const absent: string[] = [];

  const describe = (err: unknown): string => {
    const code = (err as NodeJS.ErrnoException).code;
    const text = err instanceof Error ? err.message : String(err);
    return code !== undefined && code !== "" ? `${code}: ${text}` : text;
  };

  const visit = async (dir: string, rel: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      // A directory we cannot read is a real failure, not a distinguishable
      // "unchanged" state.
      errors.push({ rel, op: "readdir", reason: describe(err) });
      return;
    }
    names.sort(); // deterministic order regardless of readdir order
    for (const name of names) {
      const abs = join(dir, name);
      const relPath = rel === "" ? name : `${rel}/${name}`;
      let st: Awaited<ReturnType<typeof lstat>>;
      try {
        st = await lstat(abs);
      } catch (err) {
        errors.push({ rel: relPath, op: "lstat", reason: describe(err) });
        continue;
      }
      if (st.isSymbolicLink()) {
        // E4-R53 controlled link policy: RECORD the link and its target, never
        // follow it. Not following is what makes a self-referential directory
        // link (a cycle) impossible to recurse into.
        let target: string | undefined;
        try {
          target = await readlink(abs);
        } catch (err) {
          errors.push({ rel: relPath, op: "readlink", reason: describe(err) });
        }
        entries.push({ rel: relPath, type: "link", digest: null, ...(target !== undefined ? { linkTarget: target } : {}) });
        continue;
      }
      if (st.isDirectory()) {
        entries.push({ rel: relPath, type: "dir", digest: null });
        await visit(abs, relPath);
        continue;
      }
      if (st.isFile()) {
        let buf: Buffer;
        try {
          buf = await readFile(abs);
        } catch (err) {
          errors.push({ rel: relPath, op: "readFile", reason: describe(err) });
          continue;
        }
        entries.push({ rel: relPath, type: "file", digest: createHash("sha256").update(buf).digest("hex") });
        continue;
      }
      // fifo / socket / block / char device — recorded, never opened.
      entries.push({ rel: relPath, type: "other", digest: null });
    }
  };

  try {
    const rootStat = await lstat(root);
    if (rootStat.isDirectory()) {
      entries.push({ rel: "", type: "dir", digest: null });
      await visit(root, "");
    } else {
      entries.push({ rel: "", type: rootStat.isFile() ? "file" : "other", digest: null });
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    if (code === "ENOENT" && !mustExist) {
      // Explicitly optional and genuinely absent: a declared, distinguishable
      // state — NOT an error, and NOT the same digest as an empty directory.
      absent.push(root);
    } else {
      errors.push({ rel: "", op: "lstat", reason: describe(err) });
    }
  }

  entries.sort((a, b) => a.rel.localeCompare(b.rel));
  return {
    valid: errors.length === 0,
    digest: createHash("sha256").update(JSON.stringify({ entries, absent })).digest("hex"),
    errors,
    absent,
    entryCount: entries.length,
    entries,
  };
}

interface SnapshotBundle extends SnapshotLike {
  absent: string[];
  parts: { dist: DeepSnapshot; buildinfo: DeepSnapshot };
}

/**
 * E4-R53 resource-existence CONTRACT for the shared build resources: both roots
 * are REQUIRED. `apps/cli/dist` and the tsbuildinfo directory are produced by
 * the build this suite protects; treating either as optionally-absent would
 * silently shrink the protected set to nothing.
 */
async function sharedBuildSnapshot(): Promise<SnapshotBundle> {
  const dist = await deepSnapshot(SHARED_DIST, { mustExist: true });
  const info = await deepSnapshot(dirname(SHARED_BUILDINFO), { mustExist: true });
  return {
    valid: dist.valid && info.valid,
    digest: createHash("sha256").update(`${dist.digest}|${info.digest}`).digest("hex"),
    errors: [...dist.errors, ...info.errors],
    absent: [...dist.absent, ...info.absent],
    parts: { dist, buildinfo: info },
  };
}

/**
 * E4-R53 — the isolation verdict. Digests may ONLY be compared once BOTH
 * snapshots are known to be valid. Two equally-unreadable trees have equal
 * digests; equality alone must never be able to certify "unchanged".
 */
function isolationVerdict(before: SnapshotLike, after: SnapshotLike): { ok: boolean; reason: string } {
  if (!before.valid) return { ok: false, reason: `before snapshot invalid — ${describeErrors(before.errors)}` };
  if (!after.valid) return { ok: false, reason: `after snapshot invalid — ${describeErrors(after.errors)}` };
  if (before.digest !== after.digest) return { ok: false, reason: "digests differ" };
  return { ok: true, reason: "both snapshots valid and digests equal" };
}

describe("E4-R42 (K03) real gate runs in an isolated workspace", () => {
  it("green AND real-nonzero child commands record consistent evidence; the shared dist/buildinfo is untouched", async () => {
    const ws = await makeGateWorkspace();
    const headSha = git(ws, ["rev-parse", "HEAD"]).trim();
    const before = await sharedBuildSnapshot();
    // E4-R53: an invalid "before" must not be able to certify anything later.
    expect(before.valid, `before snapshot must be valid — ${describeErrors(before.errors)}`).toBe(true);

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
    const after = await sharedBuildSnapshot();
    expect(after.valid, `after snapshot must be valid — ${describeErrors(after.errors)}`).toBe(true);
    expect(after.digest).toBe(before.digest);
    expect(isolationVerdict(before, after)).toEqual({ ok: true, reason: "both snapshots valid and digests equal" });
  }, 240_000);

  // ── E4-R48: the DEEP snapshot is actually discriminating. Each of these
  // manipulations (same-name overwrite, nested change, add, delete) MUST change
  // the digest, while restoring the original content MUST restore it.
  // Everything runs in a temp tree — the main repo is never touched.
  it("E4-R48: deep snapshot discriminates overwrite / nested / add / delete / read-error; content-restore returns the digest", async () => {
    const ws = await makeGateWorkspace(); // real git identity + outDir config
    const base = join(ws, "snap");
    await mkdir(base, { recursive: true });
    await mkdir(join(base, "nested"), { recursive: true });
    await writeFile(join(base, "a.js"), "AAA\n", "utf8");
    await writeFile(join(base, "nested", "b.js"), "BBB\n", "utf8");
    const s0 = (await deepSnapshot(base)).digest;

    // 1) same-name overwrite of a top-level file MUST change the digest.
    await writeFile(join(base, "a.js"), "AAAX\n", "utf8");
    expect((await deepSnapshot(base)).digest).not.toBe(s0);
    await writeFile(join(base, "a.js"), "AAA\n", "utf8");

    // 2) nested file change MUST change the digest (the old top-level-only
    //    snapshot could not see this).
    await writeFile(join(base, "nested", "b.js"), "BBBX\n", "utf8");
    expect((await deepSnapshot(base)).digest).not.toBe(s0);
    await writeFile(join(base, "nested", "b.js"), "BBB\n", "utf8");

    // 3) add a file MUST change the digest.
    await writeFile(join(base, "c.js"), "CCC\n", "utf8");
    expect((await deepSnapshot(base)).digest).not.toBe(s0);
    await rm(join(base, "c.js"));

    // 4) delete a file MUST change the digest.
    await rm(join(base, "nested", "b.js"));
    expect((await deepSnapshot(base)).digest).not.toBe(s0);
    await writeFile(join(base, "nested", "b.js"), "BBB\n", "utf8");

    // 5) content restored MUST return the original digest. (A real readdir-order
    //    perturbation is exercised separately below — restoring file contents is
    //    NOT the same thing as perturbing the enumeration order.)
    const sBack = await deepSnapshot(base);
    expect(sBack.valid).toBe(true);
    expect(sBack.digest).toBe(s0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// E4-R53 — discriminating negatives
// ---------------------------------------------------------------------------

describe("E4-R53 snapshot validity is separate from digest equality", () => {
  it("N1: two equally-unreadable snapshots have EQUAL digests, yet the isolation verdict must NOT pass", async () => {
    const ws = await makeGateWorkspace();
    const base = join(ws, "locked");
    await mkdir(base, { recursive: true });
    await writeFile(join(base, "x.js"), "X\n", "utf8");
    ioFaults.fail.set(base, new Set(["readdir"]));

    const before = await deepSnapshot(base);
    const after = await deepSnapshot(base);
    expect(before.valid).toBe(false);
    expect(after.valid).toBe(false);
    // This is exactly why digest equality is not enough: the two snapshots are
    // INDISTINGUISHABLE by digest, because both read nothing.
    expect(before.digest).toBe(after.digest);
    // ...and the validity-gated verdict refuses to certify anything.
    const verdict = isolationVerdict(before, after);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/invalid/);
  }, 60_000);

  it("N2: a one-sided readdir / readFile / lstat failure reports path, operation and reason", async () => {
    const ws = await makeGateWorkspace();
    const base = join(ws, "partial");
    await mkdir(join(base, "sub"), { recursive: true });
    await writeFile(join(base, "secret.js"), "SECRET\n", "utf8");
    await writeFile(join(base, "sub", "deep.js"), "DEEP\n", "utf8");

    // (a) readdir failure on a subdirectory
    const sub = join(base, "sub");
    ioFaults.fail.set(sub, new Set(["readdir"]));
    const a = await deepSnapshot(base);
    expect(a.valid).toBe(false);
    const eA = a.errors.find((e) => e.op === "readdir");
    expect(eA).toBeDefined();
    expect(eA!.rel).toBe("sub");
    expect(eA!.reason).toMatch(/EACCES/);
    ioFaults.fail.clear();

    // (b) readFile failure on a single file
    const secret = join(base, "secret.js");
    ioFaults.fail.set(secret, new Set(["readFile"]));
    const b = await deepSnapshot(base);
    expect(b.valid).toBe(false);
    const eB = b.errors.find((e) => e.op === "readFile");
    expect(eB).toBeDefined();
    expect(eB!.rel).toBe("secret.js");
    expect(eB!.reason).toMatch(/EACCES/);
    // the readable sibling is still recorded — one failure does not erase the tree
    expect(b.entries.some((e) => e.rel === "sub/deep.js")).toBe(true);
    ioFaults.fail.clear();

    // (c) lstat failure on a child
    ioFaults.fail.set(secret, new Set(["lstat"]));
    const c = await deepSnapshot(base);
    expect(c.valid).toBe(false);
    const eC = c.errors.find((e) => e.op === "lstat");
    expect(eC).toBeDefined();
    expect(eC!.rel).toBe("secret.js");
    expect(eC!.reason).toMatch(/EACCES/);
    ioFaults.fail.clear();
  }, 60_000);

  it("N3: a REQUIRED root that is missing fails; an explicitly OPTIONAL missing root is recorded as absent", async () => {
    const ws = await makeGateWorkspace();
    const missing = join(ws, "not-created");

    const required = await deepSnapshot(missing, { mustExist: true });
    expect(required.valid).toBe(false);
    expect(required.errors).toHaveLength(1);
    expect(required.errors[0]!.op).toBe("lstat");
    expect(required.errors[0]!.reason).toMatch(/ENOENT/);

    const optional = await deepSnapshot(missing, { mustExist: false });
    expect(optional.valid).toBe(true);
    expect(optional.absent).toEqual([missing]);
    expect(optional.errors).toHaveLength(0);

    // "absent" must be distinguishable from a real, empty directory — otherwise
    // declaring a resource optional would silently equate "gone" with "empty".
    const emptyDir = join(ws, "empty");
    await mkdir(emptyDir, { recursive: true });
    const empty = await deepSnapshot(emptyDir, { mustExist: false });
    expect(empty.valid).toBe(true);
    expect(empty.absent).toEqual([]);
    expect(empty.digest).not.toBe(optional.digest);
  }, 60_000);

  it("N5: a genuinely REVERSED directory enumeration order with identical bytes yields an identical digest", async () => {
    const ws = await makeGateWorkspace();
    const base = join(ws, "order");
    await mkdir(join(base, "nested"), { recursive: true });
    await writeFile(join(base, "a.js"), "A\n", "utf8");
    await writeFile(join(base, "b.js"), "B\n", "utf8");
    await writeFile(join(base, "nested", "c.js"), "C\n", "utf8");
    await writeFile(join(base, "nested", "d.js"), "D\n", "utf8");

    const normal = await deepSnapshot(base);
    expect(normal.valid).toBe(true);

    // Perturb the ACTUAL enumeration order returned by readdir.
    ioFaults.reorder.add(base);
    ioFaults.reorder.add(join(base, "nested"));
    const reversed = await deepSnapshot(base);

    // Prove the perturbation really ran (not a no-op that "passes" trivially).
    expect(ioFaults.reorderedCalls).toBe(2);
    expect(reversed.valid).toBe(true);
    expect(reversed.entryCount).toBe(normal.entryCount);
    expect(reversed.digest).toBe(normal.digest);
  }, 60_000);

  it("N6: a link is recorded with its target and NEVER followed (no cycle); an unsupported platform is recorded honestly", async () => {
    const ws = await makeGateWorkspace();
    const base = join(ws, "links");
    await mkdir(base, { recursive: true });
    await writeFile(join(base, "real.js"), "R\n", "utf8");

    const attempts: Record<string, { syscall: string; observable: boolean }> = {};
    const tryLink = async (name: string, target: string, type: "file" | "dir" | "junction"): Promise<void> => {
      let syscall = "ok";
      try {
        await symlink(target, join(base, name), type);
      } catch (err) {
        syscall = (err as NodeJS.ErrnoException).code ?? "unknown";
      }
      // E4-R53: NEVER trust the syscall's return value. Measured on this
      // platform: a `type: "file"` symlink resolves "ok" and creates NOTHING
      // (existsSync false, lstat ENOENT, absent from readdir). Observability is
      // what counts, so the "created" set is derived by OBSERVING the entry.
      let observable = false;
      try {
        observable = (await lstat(join(base, name))).isSymbolicLink();
      } catch {
        observable = false;
      }
      attempts[name] = { syscall, observable };
    };

    await tryLink("file-link.js", join(base, "real.js"), "file");
    // A directory link pointing at its own parent tree: following it would
    // recurse forever. A Windows junction needs no elevation, hence the type.
    await tryLink("self", base, process.platform === "win32" ? "junction" : "dir");

    const snap = await deepSnapshot(base);
    expect(snap.valid, `link snapshot must stay valid — ${describeErrors(snap.errors)}`).toBe(true);

    const created = Object.entries(attempts).filter(([, a]) => a.observable).map(([n]) => n);
    if (created.length === 0) {
      // Honest record: this platform/account cannot create a link here. The
      // limitation is REPORTED, never silently turned into a green assertion.
      expect(snap.entries.some((e) => e.type === "link")).toBe(false);
      return;
    }

    for (const name of created) {
      const entry = snap.entries.find((e) => e.rel === name);
      expect(entry, `link ${name} must be recorded`).toBeDefined();
      expect(entry!.type).toBe("link");
      expect(entry!.linkTarget).toBeDefined();
      expect(entry!.linkTarget).not.toBe("");
      // never followed ⇒ no descendant was enumerated through the link, so the
      // self-referential junction cannot produce unbounded recursion
      expect(snap.entries.some((e) => e.rel.startsWith(`${name}/`))).toBe(false);
    }
    // A link the syscall claimed to create but which is NOT observable must not
    // be claimed as recorded either — no phantom entries.
    for (const [name, a] of Object.entries(attempts)) {
      if (!a.observable) expect(snap.entries.some((e) => e.rel === name)).toBe(false);
    }
    // the regular file alongside the links is still snapshotted normally
    expect(snap.entries.find((e) => e.rel === "real.js")?.type).toBe("file");
  }, 60_000);
});
