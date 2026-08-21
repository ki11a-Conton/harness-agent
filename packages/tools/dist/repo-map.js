/**
 * P2-30 Repository Map Cache.
 *
 * Builds an ephemeral "map" of a (possibly large) repository and caches it in
 * memory as workspace knowledge, so the agent does not re-scan / re-read the
 * whole tree on every turn. The map covers:
 *   - file tree (path + size, capped)
 *   - package map (package.json / pyproject.toml / Cargo.toml / go.mod / …)
 *   - entrypoints (main/module/bin + common source entry files)
 *   - test command hints (scripts "test"/"test:*", build, lint)
 *   - detected languages (by extension)
 *
 * Invalidation model
 * ------------------
 * Change is detected by a *stat fingerprint* over the file set
 * (`path:size:mtimeMs`, sha1). On `get()`, if the fingerprint is unchanged the
 * cached map is returned as fresh — no re-read of file contents or manifests.
 * When the fingerprint diverges, the map is rebuilt: invalidation is driven by
 * an actual repo change, not a time TTL.
 *
 * `noteChange("/rel/path")` supports path-level dirtying from the write/edit
 * surfaces so one mutation forces exactly one rebuild even when a quick rewrite
 * preserves size and (rounded) mtime — i.e. it closes the mtime-granularity gap.
 *
 * Ephemeral, bounded workspace knowledge: never persisted; `maxFiles` caps the
 * file tree (`complete:false` when truncated). A single reader runs at most one
 * in-flight build; concurrent `get()` share it.
 */
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { matchGlobDirs, resolveWorkspace } from "./workspace.js";
const SKIP_DIRS = new Set([
    ".git",
    "node_modules",
    ".DS_Store",
    "dist",
    "build",
    "coverage",
    "__pycache__",
    ".venv",
    "venv",
    "target",
    ".next",
]);
const MAX_MANIFEST_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 50_000;
const MAX_DEPS = 64;
const LANGUAGE_BY_EXT = {
    ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".py": "python", ".go": "go", ".rs": "rust", ".rb": "ruby", ".php": "php",
    ".java": "java", ".kt": "kotlin", ".c": "c", ".h": "c", ".cpp": "cpp",
    ".cc": "cpp", ".cs": "csharp", ".swift": "swift", ".sh": "shell", ".bash": "shell",
    ".zsh": "shell", ".ps1": "powershell", ".sql": "sql", ".html": "html",
    ".css": "css", ".scss": "scss", ".json": "json", ".md": "markdown",
    ".yml": "yaml", ".yaml": "yaml", ".toml": "toml",
};
/** Manifest file basenames treated as a package boundary. */
const MANIFEST_NAMES = new Set([
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
]);
const LOCKFILES = new Set([
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "bun.lock",
    "poetry.lock",
    "Pipfile.lock",
    "Cargo.lock",
    "go.sum",
]);
async function walkFiles(root, rel, onFile) {
    if (rel === "")
        rel = ".";
    let entries;
    try {
        entries = await fs.readdir(join(root, rel), { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const e of entries) {
        if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name))
                continue;
            const relDir = rel === "." ? e.name : `${rel}/${e.name}`;
            await walkFiles(root, relDir, onFile);
        }
        else if (e.isFile()) {
            const relFile = rel === "." ? e.name : `${rel}/${e.name}`;
            const keep = await onFile(join(root, relFile), relFile);
            if (keep === false)
                return;
        }
    }
}
/** Cheap stat walk returning repo-relative entries, skipping VCS/dep dirs. */
export async function scanRepoStats(root, maxFiles = DEFAULT_MAX_FILES) {
    const out = [];
    await walkFiles(root, ".", async (abs, relFile) => {
        if (out.length >= maxFiles)
            return false;
        const st = await fs.stat(abs).catch(() => null);
        if (!st || !st.isFile())
            return true;
        out.push({ path: relFile, size: st.size, mtimeMs: st.mtimeMs });
        return true;
    });
    return out;
}
export function repoFingerprint(entries) {
    const h = createHash("sha1");
    const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const e of sorted)
        h.update(`${e.path}:${e.size}:${Math.floor(e.mtimeMs)};`);
    return h.digest("hex");
}
export class RepositoryMapCache {
    rootResolved;
    maxFiles;
    map = null;
    build = null;
    dirtyPath = null;
    counters = { hits: 0, builds: 0, lastBuildMs: 0 };
    constructor(opts) {
        this.rootResolved = resolve(opts.root);
        this.maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    }
    /** Cache statistics — useful for evaluating the value of the cache. */
    get stats() {
        return this.counters;
    }
    /** True when a fresh map is already held (no work needed on next get()). */
    isFresh() {
        return this.map !== null;
    }
    /** Return the current cached map or null if never built / invalidated. */
    peek() {
        return this.map;
    }
    /**
     * Get the repository map. Reuses the cache when the stat fingerprint is
     * unchanged; rebuilds (deduplicating concurrent calls) when the repo changed
     * or the cache was invalidated / dirty-marked.
     */
    async get() {
        // Fast path handled synchronously from here on; the shared build promise
        // makes concurrent gets coalesce onto one scan.
        if (this.map && !this.dirtyPath) {
            const cur = await scanRepoStats(this.rootResolved, this.maxFiles);
            if (repoFingerprint(cur) === this.map.fingerprint) {
                this.counters.hits++;
                return this.map;
            }
        }
        if (this.build) {
            this.dirtyPath = null;
            return await this.build;
        }
        this.counters.builds++;
        const startedAt = Date.now();
        const build = this.doBuild();
        this.build = build;
        try {
            const map = await build;
            this.map = map;
            this.counters.lastBuildMs = Date.now() - startedAt;
            return map;
        }
        finally {
            if (this.build === build)
                this.build = null;
            this.dirtyPath = null;
        }
    }
    /**
     * Incremental invalidation from the mutation surface: record that a path
     * changed so the next get() rebuilds even if size + rounded mtime match
     * (covers quick rewrites in the same mtime tick).
     */
    noteChange(relPath) {
        this.dirtyPath ??= relPath ?? "*";
    }
    /** Drop the cached map entirely; the next get() rebuilds from scratch. */
    invalidate() {
        this.map = null;
        this.dirtyPath = null;
    }
    async doBuild() {
        const files = [];
        const statEntries = [];
        const statByPath = new Map();
        const manifestPaths = [];
        const langCount = new Map();
        const lockDirs = new Set();
        let complete = true;
        // P2-30+: workspace glob awareness. When the repo declares workspaces we
        // treat manifests OUTSIDE the member set as non-boundaries (monorepo glob
        // 精细化); when none are declared we keep the prior scan-everything
        // behavior so non-monorepo repos are unchanged.
        const ws = await resolveWorkspace(this.rootResolved);
        const memberDirs = ws.explicit && ws.members.length > 0 ? new Set(ws.members) : null;
        await walkFiles(this.rootResolved, ".", async (abs, relFile) => {
            if (files.length >= this.maxFiles) {
                complete = false;
                return false;
            }
            const st = await fs.stat(abs).catch(() => null);
            if (!st || !st.isFile())
                return true;
            files.push({ path: relFile, size: st.size });
            statByPath.set(relFile, st.size);
            statEntries.push({ path: relFile, size: st.size, mtimeMs: st.mtimeMs });
            const base = relFile.split("/").pop() ?? relFile;
            const dir = dirOf(relFile, base);
            if (MANIFEST_NAMES.has(base)) {
                // Restrict package boundaries to declared workspace member dirs when the
                // repo explicitly scopes packages (monorepo glob 精细化); a manifest OUTSIDE
                // the member set is still tracked as a file but is not a boundary.
                if (!memberDirs || dir === "." || memberDirs.has(dir))
                    manifestPaths.push(relFile);
            }
            if (LOCKFILES.has(base))
                lockDirs.add(dir);
            const ext = extOf(base);
            const lang = LANGUAGE_BY_EXT[ext];
            if (lang)
                langCount.set(lang, (langCount.get(lang) ?? 0) + 1);
            return true;
        });
        const packages = [];
        const allEntrypoints = [];
        const allTestCommands = [];
        for (const rel of manifestPaths) {
            const base = rel.split("/").pop() ?? rel;
            const pkg = await readPackage(this.rootResolved, rel, base, statByPath, lockDirs);
            if (!pkg)
                continue;
            packages.push(pkg);
            const prefix = pkg.dir === "." ? "" : `${pkg.dir}/`;
            for (const ep of pkg.entrypoints)
                allEntrypoints.push(`${prefix}${ep}`);
            for (const tc of pkg.testCommands)
                allTestCommands.push(tc);
        }
        // P2-30+: link the intra-repo dependency graph (workspace: protocol +
        // sibling-name matches, resolved against the real local package index).
        const dependencyGraph = resolvePackageGraph(packages, ws.explicit);
        const languages = [...langCount.entries()]
            .map(([lang, count]) => ({ lang, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 40);
        const map = {
            root: this.rootResolved,
            fileCount: files.length,
            files,
            packages,
            languages,
            entrypoints: dedupe(allEntrypoints).slice(0, 200),
            testCommands: dedupe(allTestCommands).slice(0, 200),
            fingerprint: repoFingerprint(statEntries),
            builtAt: Date.now(),
            complete,
            workspaces: ws.explicit ? { patterns: [...ws.patterns], members: [...ws.members] } : null,
            dependencyGraph,
        };
        return map;
    }
}
async function readPackage(root, rel, base, statByPath, lockDirs) {
    const dir = dirOf(rel, base);
    const size = statByPath.get(rel) ?? 0;
    const entrypoints = [];
    const testCommands = [];
    let name = dir;
    let version;
    const prodDeps = [];
    const devDeps = [];
    // P2-30+: deps declared with the `workspace:` protocol (strong intra-repo refs).
    const workspaceDeps = [];
    if (MANIFEST_NAMES.has(base) && size > 0 && size <= MAX_MANIFEST_BYTES) {
        const text = await fs.readFile(join(root, rel), "utf8").catch(() => "");
        if (text)
            parseManifest(base, text, name, (o) => {
                if (o.name)
                    name = o.name;
                if (o.version)
                    version = o.version;
                if (o.entrypoints)
                    entrypoints.push(...o.entrypoints);
                if (o.testCommands)
                    testCommands.push(...o.testCommands);
                prodDeps.push(...o.prodDeps);
                devDeps.push(...o.devDeps);
                workspaceDeps.push(...o.workspaceDeps);
            });
    }
    else if (base === "pyproject.toml") {
        testCommands.push("test: pytest");
    }
    else if (base === "Cargo.toml") {
        testCommands.push("test: cargo test");
    }
    else if (base === "go.mod") {
        testCommands.push("test: go test ./...");
    }
    if (entrypoints.length === 0) {
        const prefix = dir === "." ? "" : `${dir}/`;
        const candidates = [
            "src/index.ts", "src/main.ts", "index.ts", "main.ts", "src/index.tsx",
            "src/index.js", "index.js", "main.js", "app.py", "src/__main__.py",
            "main.go", "src/main.rs",
        ];
        for (const c of candidates) {
            if (statByPath.has(`${prefix}${c}`)) {
                entrypoints.push(c);
                break;
            }
        }
    }
    // P2-30+: internal deps are resolved against the real local package index in
    // doBuild. `workspaceDeps` carries the strong signals captured from the
    // manifest (`workspace:` protocol refs); the resolver adds sibling-name
    // matches when the repo declares workspaces.
    return {
        dir,
        name,
        version,
        entrypoints: dedupe(entrypoints).slice(0, 6),
        testCommands: dedupe(testCommands).slice(0, 6),
        hasLockfile: lockDirs.has(dir),
        prodDeps: dedupe(prodDeps).slice(0, MAX_DEPS),
        devDeps: dedupe(devDeps).slice(0, MAX_DEPS),
        internalDeps: [],
        workspaceDeps: dedupe(workspaceDeps).slice(0, MAX_DEPS),
    };
}
/**
 * P2-30+: resolve the intra-repo dependency graph. A package's internal deps are
 * the local packages it references via the `workspace:` protocol; plus, when the
 * repo explicitly declares workspaces, sibling packages referenced by bare name
 * in its dependencies. Name matches are only trusted as internal when the repo
 * is known to be a monorepo, so a published dep that merely shares a local name
 * is not spuriously linked.
 */
export function resolvePackageGraph(packages, workspacesExplicit = false) {
    const byName = new Set(packages.map((p) => p.name));
    return packages.map((p) => {
        const strong = p.workspaceDeps.filter((n) => n !== p.name);
        const sibling = workspacesExplicit
            ? p.prodDeps.concat(p.devDeps).filter((n) => n !== p.name)
            : [];
        const matches = new Set(strong);
        // Sibling bare-name matches are only a signal when the repo is a declared
        // monorepo AND the name is actually a local package.
        for (const n of sibling) {
            if (byName.has(n))
                matches.add(n);
        }
        return { name: p.name, internalDeps: [...matches].sort() };
    });
}
function parseManifest(base, text, fallbackName, emit) {
    const out = {
        name: fallbackName,
        version: undefined,
        entrypoints: [],
        testCommands: [],
        prodDeps: [],
        devDeps: [],
        workspaceDeps: [],
    };
    if (base === "package.json") {
        try {
            const m = JSON.parse(text);
            if (typeof m.name === "string")
                out.name = m.name;
            if (typeof m.version === "string")
                out.version = m.version;
            if (typeof m.main === "string")
                out.entrypoints.push(m.main);
            if (typeof m.module === "string")
                out.entrypoints.push(m.module);
            if (typeof m.bin === "string")
                out.entrypoints.push(m.bin);
            else if (m.bin && typeof m.bin === "object")
                out.entrypoints.push(...Object.values(m.bin));
            const scripts = m.scripts ?? {};
            for (const key of ["test", "test:unit", "test:integration", "build", "lint", "typecheck", "check"]) {
                if (typeof scripts[key] === "string")
                    out.testCommands.push(`${key}: ${scripts[key]}`);
            }
            collectDepNames(m.dependencies, out.prodDeps, out.workspaceDeps);
            collectDepNames(m.peerDependencies, out.prodDeps, out.workspaceDeps);
            collectDepNames(m.devDependencies, out.devDeps, out.workspaceDeps);
        }
        catch {
            // unparsable manifest → keep minimal name from dir
        }
    }
    else if (base === "pyproject.toml") {
        const m = /(?:^|\n)\s*name\s*=\s*["']([^"']+)["']/.exec(text);
        if (m)
            out.name = m[1];
    }
    else if (base === "Cargo.toml") {
        const m = /\[package\]\s*[\s\S]*?^\s*name\s*=\s*"([^"]+)"/m.exec(text);
        if (m)
            out.name = m[1];
    }
    else if (base === "go.mod") {
        const m = /(?:^|\n)module\s+(\S+)/.exec(text);
        if (m)
            out.name = m[1];
    }
    emit(out);
}
function collectDepNames(deps, out, workspaceDeps) {
    if (!deps)
        return;
    for (const [k, v] of Object.entries(deps)) {
        out.push(k);
        // `workspace:*` / `workspace:^` / `workspace:~` are explicit intra-repo refs.
        if (typeof v === "string" && v.startsWith("workspace:"))
            workspaceDeps.push(k);
    }
}
/** Repo-relative dir of a manifest/entry file; "." at the repo root. */
function dirOf(rel, base) {
    const idx = rel.length - base.length - 1; // index of the "/" before the basename
    return idx > 0 ? rel.slice(0, idx) : ".";
}
function dedupe(arr) {
    return [...new Set(arr)];
}
function extOf(file) {
    const base = file.split("/").pop() ?? file;
    const i = base.lastIndexOf(".");
    return i > 0 ? base.slice(i).toLowerCase() : "";
}
//# sourceMappingURL=repo-map.js.map