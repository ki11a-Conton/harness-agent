import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { normalizePath } from "@ar/security";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".cache", "coverage"]);
const DECL_PATTERNS = [
    { kind: "function", re: /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: "class", re: /(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: "interface", re: /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
    { kind: "type", re: /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
    { kind: "const", re: /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)/ },
    { kind: "enum", re: /(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
];
const IMPORT_RE = /import\s+(?:type\s+)?[^'"]*?\b([A-Za-z_$][\w$]*)\b[^'"]*?from\s+['"]/;
const NAMED_IMPORT_RE = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s+['"]/;
const EXPORT_RE = /export\s+(?:\{[^}]*\}|default|const|function|class|interface|type|enum)/;
const cache = new Map();
async function listSourceFiles(dir, root, out) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name))
                continue;
            await listSourceFiles(join(dir, entry.name), root, out);
            continue;
        }
        if (!entry.isFile())
            continue;
        const ext = entry.name.slice(entry.name.lastIndexOf("."));
        if (SOURCE_EXTENSIONS.has(ext))
            out.push(join(dir, entry.name));
    }
}
async function buildRootIndex(root) {
    const files = new Map();
    const sourceFiles = [];
    await listSourceFiles(root, root, sourceFiles);
    for (const file of sourceFiles) {
        try {
            const [content, st] = await Promise.all([readFile(file, "utf8"), stat(file)]);
            const rel = normalizePath(relative(root, file));
            files.set(rel, { relPath: rel, lines: content.split("\n"), mtimeMs: st.mtimeMs });
        }
        catch {
            // unreadable file: skip
        }
    }
    return { root, files, builtAt: Date.now() };
}
/** Get (building if needed) the process-level index for a root. */
export async function getSymbolIndex(root) {
    const existing = cache.get(root);
    if (existing !== undefined)
        return { ...existing, filesIndexed: existing.files.size };
    const built = await buildRootIndex(root);
    cache.set(root, built);
    return { ...built, filesIndexed: built.files.size };
}
/** P7-4: search the light index; always succeeds with fallback:false. */
export async function indexedSymbolSearch(input) {
    const { symbol, root } = input;
    const index = await getSymbolIndex(root);
    const needle = symbol.toLowerCase();
    const maxHits = input.maxHits ?? 200;
    const hits = [];
    for (const file of index.files.values()) {
        if (input.relPath !== undefined && file.relPath !== input.relPath && !file.relPath.startsWith(input.relPath)) {
            continue;
        }
        for (let i = 0; i < file.lines.length && hits.length < maxHits; i++) {
            const line = file.lines[i];
            const lower = line.toLowerCase();
            if (!lower.includes(needle))
                continue;
            let role = "reference";
            let kind = "reference";
            for (const pattern of DECL_PATTERNS) {
                const m = line.match(pattern.re);
                if (m !== null && m[1].toLowerCase() === needle) {
                    role = "definition";
                    kind = pattern.kind;
                    break;
                }
            }
            if (role !== "definition") {
                const exportMatch = EXPORT_RE.test(line);
                if (exportMatch) {
                    role = "export";
                    kind = "export";
                }
                else {
                    const named = line.match(NAMED_IMPORT_RE);
                    if (named !== null && named[1].split(",").some((part) => part.trim().toLowerCase() === needle)) {
                        role = "import";
                        kind = "import";
                    }
                    else if (IMPORT_RE.test(line)) {
                        const im = line.match(IMPORT_RE);
                        if (im !== null && im[1].toLowerCase() === needle) {
                            role = "import";
                            kind = "import";
                        }
                    }
                }
            }
            hits.push({ file: file.relPath, line: i + 1, kind, name: symbol, text: line.trim(), role });
        }
    }
    return { fallback: false, indexer: "ts-regex-index", hits, filesIndexed: index.files.size, indexFresh: true };
}
//# sourceMappingURL=symbol-index.js.map