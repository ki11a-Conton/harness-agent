/**
 * P2-29 Search / Code Navigation Tools.
 *
 * Unified navigation primitives so the agent does not have to guess at paths
 * by repeatedly issuing read_file attempts:
 *   - file search   → existing search_files (glob) tool
 *   - text search   → grepFiles()  (regex over file contents)
 *   - symbol search → symbolSearch() (regex fallback when no symbol index)
 *   - repo tree     → repoTree()   (nested tree of files/dirs)
 *   - dependency    → deferred (needs a real graph; read only when an index exists)
 *
 * No symbol index is maintained (out of scope), so symbol search degrades to a
 * clear, documented fallback: a small set of language-agnostic symbol regexes
 * over matched lines. The fallback is honest — it returns `fallback: true` and a
 * `indexer` note so consumers know this is heuristic, not a semantic index.
 *
 * All functions are pure-ish over a root dir, skip VCS/dependency dirs
 * (.git / node_modules / .svg? no), cap output, and guard against binary and
 * oversized files. They are read-only.
 */
import { promises as fs } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { matchGlob } from "@ar/security";
const SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store", "dist", "build", "coverage"]);
const MAX_READ_BYTES = 512 * 1024; // skip files larger than this for text search
const MAX_LINE = 2000;
/** Recursive walk yielding files (with rel path), skipping VCS/dep dirs. */
export async function walkFiles(root, rel = ".", onFile, onDir) {
    if (rel === "")
        rel = "."; // path.relative returns "" for identical paths
    let entries;
    try {
        entries = await fs.readdir(join(root, rel), { withFileTypes: true });
    }
    catch {
        return;
    }
    const dirs = entries.filter((e) => e.isDirectory());
    if (onDir)
        onDir(entries.map((e) => e.name), join(root, rel), rel);
    for (const e of entries) {
        if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name))
                continue;
            await walkFiles(root, rel === "." ? e.name : `${rel}/${e.name}`, onFile, onDir);
        }
        else if (e.isFile()) {
            const relFile = rel === "." ? e.name : `${rel}/${e.name}`;
            const keep = await onFile(join(root, relFile), relFile);
            if (keep === false)
                return;
        }
    }
    void dirs;
}
export function grepFiles(input) {
    return (async () => {
        const { root, relPath } = input;
        const start = resolve(root, relPath ?? ".");
        let re;
        try {
            re = new RegExp(input.pattern, input.caseSensitive ? "" : "i");
        }
        catch (err) {
            throw err; // exposed by caller as a schema/argument error
        }
        const hits = [];
        const base = resolve(root);
        await walkFiles(base, relative(base, start), async (abs, relFile) => {
            if (hits.length >= (input.maxHits ?? 200))
                return false;
            if (input.fileGlob) {
                const candidate = relFile.split("/").pop();
                if (!matchGlob(input.fileGlob, candidate))
                    return;
            }
            let stat;
            try {
                stat = await fs.stat(abs);
            }
            catch {
                return;
            }
            if (stat.size > MAX_READ_BYTES)
                return;
            let text;
            try {
                text = await fs.readFile(abs, "utf8");
            }
            catch {
                return; // binary or unreadable → skip
            }
            // Refuse obvious binary content.
            if (text.includes("\u0000"))
                return;
            const lines = text.split("\n");
            for (let i = 0; i < lines.length && hits.length < (input.maxHits ?? 200); i++) {
                const line = lines[i];
                if (line.length > MAX_LINE)
                    continue;
                const m = line.search(re);
                if (m >= 0) {
                    hits.push({ file: relFile, line: i + 1, column: m + 1, text: line.slice(0, MAX_LINE) });
                }
            }
            return;
        });
        return hits;
    })();
}
/** Language-agnostic symbol patterns (fallback when no symbol index exists). */
const SYMBOL_PATTERNS = [
    { label: "function", re: /\bfunction\s+([A-Za-z_$][\w$]*)\b/g },
    { label: "class", re: /\bclass\s+([A-Za-z_$][\w$]*)\b/g },
    { label: "type", re: /\b(?:type|interface)\s+([A-Za-z_$][\w$]*)\b/g },
    { label: "const", re: /\bconst\s+([A-Za-z_$][\w$]*)\s*=/g },
    { label: "method", re: /\b([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g },
    { label: "export", re: /\bexport\s+(?:default\s+)?(?:function|class|const|type|interface)\s+([A-Za-z_$][\w$]*)/g },
    { label: "def", re: /\bdef\s+([A-Za-z_$][\w$]*)\s*\(/g }, // python
    { label: "import", re: /\b(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g },
];
/** Regex fallback symbol search. Returns `fallback: true` + an indexer note. */
export async function symbolSearch(input) {
    const { root, relPath, symbol } = input;
    const start = resolve(root, relPath ?? ".");
    const base = resolve(root);
    // Build a per-marker regex. `//g` not needed; we test the whole matched text.
    const want = symbol === "" ? null : new RegExp(`\\b${escapeRegExp(symbol)}\\b`, "i");
    const hits = [];
    const cap = input.maxHits ?? 200;
    await walkFiles(base, relative(base, start), async (abs, relFile) => {
        if (hits.length >= cap)
            return false;
        let text;
        try {
            const stat = await fs.stat(abs);
            if (stat.size > MAX_READ_BYTES)
                return;
            text = await fs.readFile(abs, "utf8");
        }
        catch {
            return;
        }
        if (text.includes("\u0000"))
            return;
        for (const { label, re } of SYMBOL_PATTERNS) {
            // Fresh copy per file/pattern; global so lastIndex advances each exec.
            const scanner = new RegExp(re.source, `g${re.flags.includes("i") ? "i" : ""}`);
            let m;
            while ((m = scanner.exec(text)) !== null) {
                const matched = m[0];
                if (want && !want.test(matched)) {
                    // advance through the matched span even when we skip it
                    scanner.lastIndex = Math.max(scanner.lastIndex, m.index + (m[0]?.length || 1));
                    continue;
                }
                const lineNo = text.slice(0, m.index).split("\n").length;
                hits.push({ file: relFile, line: lineNo, kind: label, name: m[1], text: matched.slice(0, MAX_LINE) });
                if (hits.length >= cap)
                    return false;
            }
        }
        return true;
    });
    return {
        fallback: true,
        indexer: "regex-symbol-fallback (no semantic symbol index; connect a language server/LSP index to upgrade)",
        hits,
    };
}
export function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** Nested directory/file tree of the repo (for orientation / repo map). */
export async function repoTree(input) {
    const { root, relPath } = input;
    const start = resolve(root, relPath ?? ".");
    const base = resolve(root);
    const maxDepth = input.depth ?? 6;
    const cap = input.maxEntries ?? 500;
    const out = [];
    let count = 0;
    await walkFiles(base, relative(base, start), async (abs, relFile) => {
        if (count >= cap)
            return false;
        const depth = depthOf(relFile);
        if (depth > maxDepth)
            return true;
        const stat = await fs.stat(abs).catch(() => null);
        out.push({ path: relFile, type: stat?.isDirectory() ? "dir" : "file", depth });
        count++;
    }, () => { });
    // walkFiles only reports files; add directories by scanning rel paths.
    const dirSet = new Set();
    for (const e of out) {
        const parts = e.path.split("/");
        for (let i = 1; i < parts.length; i++)
            dirSet.add(parts.slice(0, i).join("/"));
    }
    for (const d of [...dirSet]) {
        const depth = depthOf(d);
        if (depth <= maxDepth)
            out.push({ path: d, type: "dir", depth });
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out.slice(0, cap);
}
function depthOf(rel) {
    return rel === "." ? 0 : rel.split("/").length;
}
/** Walk a directory's immediate children (used by repo_tree to avoid re-list). */
export function normalizeSlashes(p) {
    return p.split(sep).join("/");
}
//# sourceMappingURL=navigate.js.map