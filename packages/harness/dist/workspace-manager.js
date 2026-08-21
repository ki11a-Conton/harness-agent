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
import { isPathCanonicallyWithin } from "@ar/security";
const DEFAULT_MAX_PATCH_BYTES = 256 * 1024;
/** Directories never copied into an isolated child workspace. */
const SKIPPED_DIRECTORIES = new Set([
    "node_modules",
    ".git",
    "dist",
    "out",
    "build",
    ".cache",
    "coverage",
    "backups",
]);
export class DefaultChildWorkspaceManager {
    scratchRoot;
    now;
    maxPatchBytes;
    constructor(deps = {}) {
        this.scratchRoot = deps.scratchRoot ?? tmpdir();
        this.now = deps.now ?? Date.now;
        this.maxPatchBytes = deps.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
    }
    async create(input) {
        const parentRoot = resolve(input.parentRoot);
        if (!input.writable) {
            // Read-only child: share the parent root — it has no write rights, so
            // there is nothing to isolate (and no patch to produce).
            return {
                root: parentRoot,
                mode: "shared-readonly",
                diff: async () => ({ childSessionId: input.childSessionId, entries: [] }),
                dispose: async () => { },
            };
        }
        const root = await mkdtemp(join(this.scratchRoot, "child-ws-"));
        const baseline = new Map();
        await this.copyTree(parentRoot, parentRoot, root, baseline, new Set());
        return new this.IsolatedCopyHandle(root, input.childSessionId, baseline, this.maxPatchBytes);
    }
    async apply(parentRoot, patch, opts = {}) {
        const root = resolve(parentRoot);
        const conflictCheck = opts.conflictCheck ?? true;
        const applied = [];
        const conflicts = [];
        const skipped = [];
        for (const entry of patch.entries) {
            const target = safeJoin(root, entry.path);
            if (target === undefined) {
                skipped.push({ path: entry.path, detail: "path escapes the workspace root" });
                continue;
            }
            // P3-5 conflict check: did the parent change this path while the child
            // was running? The baseline is the parent hash at child start.
            if (conflictCheck && entry.parentBaselineHash !== undefined) {
                let currentHash;
                try {
                    currentHash = hashOf(await readFile(target));
                }
                catch {
                    currentHash = undefined; // file gone
                }
                if (currentHash !== entry.parentBaselineHash) {
                    conflicts.push({
                        path: entry.path,
                        detail: currentHash === undefined
                            ? "parent deleted this path while the child was running"
                            : "parent modified this path while the child was running",
                    });
                    continue;
                }
            }
            try {
                if (entry.kind === "deleted") {
                    await rm(target, { force: true });
                }
                else if (entry.content !== undefined) {
                    await mkdir(join(target, ".."), { recursive: true });
                    await writeFile(target, entry.content, "utf8");
                }
                else {
                    skipped.push({ path: entry.path, detail: `no content for ${entry.kind} entry` });
                    continue;
                }
                applied.push(entry.path);
            }
            catch (cause) {
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
    async copyTree(parentRoot, from, to, baseline, seen) {
        let entries;
        try {
            entries = await readdir(from, { withFileTypes: true });
        }
        catch {
            return; // unreadable subtree: skip
        }
        for (const entry of entries) {
            if (entry.isSymbolicLink())
                continue; // never copy symlinks (escape)
            if (entry.isDirectory()) {
                if (SKIPPED_DIRECTORIES.has(entry.name))
                    continue;
                await mkdir(join(to, entry.name), { recursive: true });
                await this.copyTree(parentRoot, join(from, entry.name), join(to, entry.name), baseline, seen);
                continue;
            }
            if (!entry.isFile())
                continue;
            const fromFile = join(from, entry.name);
            const relPath = relative(parentRoot, fromFile);
            if (seen.has(relPath))
                continue;
            seen.add(relPath);
            try {
                const content = await readFile(fromFile);
                baseline.set(relPath, hashOf(content));
                await writeFile(join(to, entry.name), content);
            }
            catch {
                // unreadable file: skip silently (best effort copy)
            }
        }
    }
    /** An isolated-copy handle: diffs against the baseline and cleans up. */
    IsolatedCopyHandle = class {
        childSessionId;
        baseline;
        maxPatchBytes;
        root;
        mode = "isolated-copy";
        disposed = false;
        constructor(root, childSessionId, baseline, maxPatchBytes) {
            this.childSessionId = childSessionId;
            this.baseline = baseline;
            this.maxPatchBytes = maxPatchBytes;
            this.root = root;
        }
        async diff() {
            if (this.disposed)
                return { childSessionId: this.childSessionId, entries: [] };
            const current = new Map();
            await collectHashes(this.root, this.root, current);
            const entries = [];
            const paths = new Set([...this.baseline.keys(), ...current.keys()]);
            for (const path of [...paths].sort()) {
                const before = this.baseline.get(path);
                const after = current.get(path);
                if (before === undefined && after !== undefined) {
                    const content = await readChild(this.root, path, this.maxPatchBytes);
                    if (content === undefined) {
                        entries.push({ path, kind: "skipped", detail: "file too large or unreadable for the patch" });
                    }
                    else {
                        entries.push({ path, kind: "added", contentHash: after, content });
                    }
                }
                else if (before !== undefined && after === undefined) {
                    entries.push({ path, kind: "deleted", parentBaselineHash: before });
                }
                else if (before !== undefined && after !== undefined && before !== after) {
                    const content = await readChild(this.root, path, this.maxPatchBytes);
                    if (content === undefined) {
                        entries.push({ path, kind: "skipped", detail: "file too large or unreadable for the patch" });
                    }
                    else {
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
        async dispose() {
            if (this.disposed)
                return;
            this.disposed = true;
            await rm(this.root, { recursive: true, force: true });
        }
    };
}
async function collectHashes(root, dir, out) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (entry.isSymbolicLink())
            continue;
        const abs = join(dir, entry.name);
        const rel = relative(root, abs);
        if (entry.isDirectory()) {
            await collectHashes(root, abs, out);
        }
        else if (entry.isFile()) {
            try {
                out.set(rel, hashOf(await readFile(abs)));
            }
            catch {
                // unreadable: omit
            }
        }
    }
}
async function readChild(root, rel, maxPatchBytes) {
    try {
        const abs = safeJoin(root, rel);
        if (abs === undefined)
            return undefined;
        const info = await stat(abs);
        if (info.size > maxPatchBytes)
            return undefined; // → skipped by caller?
        return await readFile(abs, "utf8");
    }
    catch {
        return undefined;
    }
}
function hashOf(content) {
    return createHash("sha256").update(content).digest("hex");
}
/** Resolve a relative path inside root, rejecting any traversal. */
export function safeJoin(root, rel) {
    if (rel === "")
        return undefined;
    if (rel.includes("..") && (rel === ".." || rel.startsWith(`..${sep}`) || rel.includes(`${sep}..${sep}`))) {
        return undefined;
    }
    if (rel.startsWith("/") || /^[a-z]:[\\/]/i.test(rel))
        return undefined;
    const target = resolve(root, rel);
    // P14-1: canonical containment (realpath of deepest existing ancestor +
    // lexically resolved tail), NOT a textual prefix check — a symlink component
    // inside root that points outside can never sneak past. Shares the exact
    // semantic with SandboxManager and the capability guard.
    if (!isPathCanonicallyWithin(target, resolve(root), process.cwd(), false))
        return undefined;
    return target;
}
//# sourceMappingURL=workspace-manager.js.map