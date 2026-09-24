// P3-4/P3-5: production child-workspace manager — the filesystem side of
// child isolation. Read-only children share the parent root; write-capable
// children run in a temporary isolated copy (node_modules/.git/dist/... are
// never copied) and report their changes as a structured patch whose entries
// carry the parent baseline hash for P3-5 conflict detection. All paths are
// relative and validated against traversal before any read/write.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { SessionId } from "@ar/contracts";
import { isNodeErrorCode } from "@ar/contracts";
import { isPathCanonicallyWithin } from "@ar/security";
import type {
  ApplyPatchOptions,
  ApplyPatchResult,
  ChildWorkspaceHandle,
  ChildWorkspaceManager,
  WorkspacePatch,
  WorkspacePatchEntry,
} from "@ar/agents";

const DEFAULT_MAX_PATCH_BYTES = 256 * 1024;

/** Directories never copied into an isolated child workspace. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  ".cache",
  "coverage",
  "backups",
]);

export interface DefaultChildWorkspaceManagerDeps {
  /** Scratch root for isolated copies (default system temp). */
  scratchRoot?: string;
  now?: () => number;
  /** Max bytes of a file admitted into a patch (default 256 KiB). */
  maxPatchBytes?: number;
}

export class DefaultChildWorkspaceManager implements ChildWorkspaceManager {
  private readonly scratchRoot: string;
  private readonly now: () => number;
  private readonly maxPatchBytes: number;

  constructor(deps: DefaultChildWorkspaceManagerDeps = {}) {
    this.scratchRoot = deps.scratchRoot ?? tmpdir();
    this.now = deps.now ?? Date.now;
    this.maxPatchBytes = deps.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
  }

  async create(input: {
    parentRoot: string;
    childSessionId: SessionId;
    writable: boolean;
  }): Promise<ChildWorkspaceHandle> {
    const parentRoot = resolve(input.parentRoot);
    if (!input.writable) {
      // Read-only child: share the parent root — it has no write rights, so
      // there is nothing to isolate (and no patch to produce).
      return {
        root: parentRoot,
        mode: "shared-readonly",
        diff: async () => ({ childSessionId: input.childSessionId, entries: [] }),
        dispose: async () => {},
      };
    }

    const root = await mkdtemp(join(this.scratchRoot, "child-ws-"));
    const baseline = new Map<string, string>();
    await this.copyTree(parentRoot, parentRoot, root, baseline, new Set());
    return new this.IsolatedCopyHandle(root, input.childSessionId, baseline, this.maxPatchBytes);
  }

  async apply(
    parentRoot: string,
    patch: WorkspacePatch,
    opts: ApplyPatchOptions = {},
  ): Promise<ApplyPatchResult> {
    const root = resolve(parentRoot);
    const conflictCheck = opts.conflictCheck ?? true;
    const applied: string[] = [];
    const conflicts: { path: string; detail: string }[] = [];
    const skipped: { path: string; detail: string }[] = [];

    for (const entry of patch.entries) {
      const target = safeJoin(root, entry.path);
      if (target === undefined) {
        skipped.push({ path: entry.path, detail: "path escapes the workspace root" });
        continue;
      }
      // P3-5 conflict check: did the parent change this path while the child
      // was running? The baseline is the parent hash at child start.
      if (conflictCheck && entry.parentBaselineHash !== undefined) {
        let currentHash: string | undefined;
        try {
          currentHash = hashOf(await readFile(target));
        } catch (err) {
          // P14-6: a vanished file is an EXPECTED conflict outcome (parent or
          // child deleted it) — an explicit sentinel; other read failures are
          // reported, never silent.
          currentHash = undefined;
          if (!isNodeErrorCode(err, "ENOENT")) {
            process.stderr.write(`[degraded] workspace-manager.baseline-read: ${err instanceof Error ? err.message : String(err)}\n`);
          }
        }
        if (currentHash !== entry.parentBaselineHash) {
          conflicts.push({
            path: entry.path,
            detail:
              currentHash === undefined
                ? "parent deleted this path while the child was running"
                : "parent modified this path while the child was running",
          });
          continue;
        }
      }
      try {
        if (entry.kind === "deleted") {
          await rm(target, { force: true });
        } else if (entry.content !== undefined) {
          await mkdir(join(target, ".."), { recursive: true });
          await writeFile(target, entry.content, "utf8");
        } else {
          skipped.push({ path: entry.path, detail: `no content for ${entry.kind} entry` });
          continue;
        }
        applied.push(entry.path);
      } catch (cause) {
        skipped.push({
          path: entry.path,
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    return { applied, conflicts, skipped };
  }

  /** Copy the parent tree into the child root, skipping the ignored
   *  directories; records baseline hashes for diff/conflict detection.
   *  `parentRoot` anchors the global relative path of every copied file. */
  private async copyTree(
    parentRoot: string,
    from: string,
    to: string,
    baseline: Map<string, string>,
    seen: Set<string>,
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(from, { withFileTypes: true });
    } catch (err) {
      // P14-6: an unreadable subtree is skipped — reported so the isolation
      // copy gap is observable, never silent.
      process.stderr.write(`[degraded] workspace-manager.copy-readdir: ${err instanceof Error ? err.message : String(err)}\n`);
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // never copy symlinks (escape)
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        await mkdir(join(to, entry.name), { recursive: true });
        await this.copyTree(parentRoot, join(from, entry.name), join(to, entry.name), baseline, seen);
        continue;
      }
      if (!entry.isFile()) continue;
      const fromFile = join(from, entry.name);
      const relPath = relative(parentRoot, fromFile);
      if (seen.has(relPath)) continue;
      seen.add(relPath);
      try {
        const content = await readFile(fromFile);
        baseline.set(relPath, hashOf(content));
        await writeFile(join(to, entry.name), content);
      } catch (err) {
        // P14-6: an unreadable/copy-failed file is skipped (best effort copy)
        // but reported — the isolation copy gap must be observable.
        process.stderr.write(`[degraded] workspace-manager.copy-file: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }

  /** An isolated-copy handle: diffs against the baseline and cleans up. */
  private IsolatedCopyHandle = class implements ChildWorkspaceHandle {
    readonly root: string;
    readonly mode = "isolated-copy" as const;
    private disposed = false;
    constructor(
      root: string,
      private readonly childSessionId: SessionId,
      private readonly baseline: Map<string, string>,
      private readonly maxPatchBytes: number,
    ) {
      this.root = root;
    }

    async diff(): Promise<WorkspacePatch> {
      if (this.disposed) return { childSessionId: this.childSessionId, entries: [] };
      const current = new Map<string, string>();
      await collectHashes(this.root, this.root, current);
      const entries: WorkspacePatchEntry[] = [];
      const paths = new Set([...this.baseline.keys(), ...current.keys()]);
      for (const path of [...paths].sort()) {
        const before = this.baseline.get(path);
        const after = current.get(path);
        if (before === undefined && after !== undefined) {
          const content = await readChild(this.root, path, this.maxPatchBytes);
          if (content === undefined) {
            entries.push({ path, kind: "skipped", detail: "file too large or unreadable for the patch" });
          } else {
            entries.push({ path, kind: "added", contentHash: after, content });
          }
        } else if (before !== undefined && after === undefined) {
          entries.push({ path, kind: "deleted", parentBaselineHash: before });
        } else if (before !== undefined && after !== undefined && before !== after) {
          const content = await readChild(this.root, path, this.maxPatchBytes);
          if (content === undefined) {
            entries.push({ path, kind: "skipped", detail: "file too large or unreadable for the patch" });
          } else {
            entries.push({
              path,
              kind: "modified",
              contentHash: after,
              content,
              parentBaselineHash: before,
            });
          }
        }
      }
      return { childSessionId: this.childSessionId, entries };
    }

    async dispose(): Promise<void> {
      if (this.disposed) return;
      this.disposed = true;
      await rm(this.root, { recursive: true, force: true });
    }
  };
}

async function collectHashes(
  root: string,
  dir: string,
  out: Map<string, string>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // P14-6: a vanished/unreadable source dir during disposal is expected
    // (workspace already cleaned up) — reported if not ENOENT, never silent.
    if (!isNodeErrorCode(err, "ENOENT")) {
      process.stderr.write(`[degraded] workspace-manager.dispose-readdir: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const abs = join(dir, entry.name);
    const rel = relative(root, abs);
    if (entry.isDirectory()) {
      await collectHashes(root, abs, out);
    } else if (entry.isFile()) {
      try {
        out.set(rel, hashOf(await readFile(abs)));
      } catch (err) {
        // P14-6: an unreadable file is omitted from the hash tree — reported
        // unless it simply vanished (ENOENT), never silent.
        if (!isNodeErrorCode(err, "ENOENT")) {
          process.stderr.write(`[degraded] workspace-manager.hash-read: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    }
  }
}

async function readChild(
  root: string,
  rel: string,
  maxPatchBytes: number,
): Promise<string | undefined> {
  try {
    const abs = safeJoin(root, rel);
    if (abs === undefined) return undefined;
    const info = await stat(abs);
    if (info.size > maxPatchBytes) return undefined; // → skipped by caller?
    return await readFile(abs, "utf8");
  } catch {
    return undefined;
  }
}

function hashOf(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Resolve a relative path inside root, rejecting any traversal. */
export function safeJoin(root: string, rel: string): string | undefined {
  if (rel === "") return undefined;
  if (rel.includes("..") && (rel === ".." || rel.startsWith(`..${sep}`) || rel.includes(`${sep}..${sep}`))) {
    return undefined;
  }
  if (rel.startsWith("/") || /^[a-z]:[\\/]/i.test(rel)) return undefined;
  const target = resolve(root, rel);
  // P14-1: canonical containment (realpath of deepest existing ancestor +
  // lexically resolved tail), NOT a textual prefix check — a symlink component
  // inside root that points outside can never sneak past. Shares the exact
  // semantic with SandboxManager and the capability guard.
  if (!isPathCanonicallyWithin(target, resolve(root), process.cwd(), false)) return undefined;
  return target;
}
