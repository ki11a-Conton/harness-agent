import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, extname, join, relative } from "node:path";
import { createRequire } from "node:module";
import type { Parser as ParserType, Language as LanguageType, Node } from "@vscode/tree-sitter-wasm";
import ignore, { type Ignore } from "ignore";
import { resolveSearchScope } from "./navigate.js";

const require = createRequire(import.meta.url);
// The upstream runtime is UMD; native ESM cannot infer its named exports.
const { Parser, Language } = require("@vscode/tree-sitter-wasm") as typeof import("@vscode/tree-sitter-wasm");
const wasmDir = dirname(require.resolve("@vscode/tree-sitter-wasm"));
const extensions: Record<string, string> = { ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".py": "python", ".rs": "rust", ".go": "go" };
const skipped = new Set([".git", "node_modules", "dist", "build", "out", "coverage", "target", ".venv", "venv", "__pycache__", ".cache", ".harness", ".harness-agent"]);
const MAX_BYTES = 512 * 1024;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const slash = (path: string) => path.replace(/\\/g, "/");
const init = () => initialization ??= Parser.init({ locateFile: file => join(wasmDir, file) });
let initialization: Promise<void> | undefined;
const languages = new Map<string, Promise<LanguageType>>();

export interface SyntaxTag {
  name: string; kind: string; role: "definition" | "import" | "reference";
  line: number; endLine: number; column: number; text: string;
}
interface ParsedTags { tags: SyntaxTag[]; complete: boolean; bytes: number }
const cache = new Map<string, ParsedTags>();
let cachedBytes = 0;
const declaration = /^(?:function_declaration|generator_function_declaration|method_definition|method_declaration|class_declaration|class_definition|interface_declaration|type_alias_declaration|enum_declaration|variable_declarator|function_definition|assignment|function_item|struct_item|enum_item|trait_item|type_item|const_item|static_item|mod_item|type_spec|var_spec|const_spec)$/;
const identifier = /^(?:identifier|type_identifier|field_identifier|property_identifier|shorthand_property_identifier_pattern)$/;

async function parseTags(content: string, language: string, signal?: AbortSignal): Promise<ParsedTags> {
  const key = language + ":" + hash(content);
  const existing = cache.get(key);
  if (existing) { cache.delete(key); cache.set(key, existing); return existing; }
  await init(); signal?.throwIfAborted();
  let pending = languages.get(language);
  if (!pending) { pending = Language.load(join(wasmDir, `tree-sitter-${language}.wasm`)); languages.set(language, pending); }
  const parser = new Parser();
  let tree: ReturnType<ParserType["parse"]> = null;
  try {
    parser.setLanguage(await pending);
    const deadline = Date.now() + 250;
    tree = parser.parse(content, null, { progressCallback: () => { signal?.throwIfAborted(); if (Date.now() > deadline) throw new Error("syntax parse deadline"); } });
    if (!tree) throw new Error("syntax parse incomplete");
    const lines = content.split("\n");
    const tags: SyntaxTag[] = [];
    const stack: Node[] = [tree.rootNode];
    let visited = 0;
    while (stack.length && visited++ < 100000 && tags.length < 5000) {
      if (visited % 256 === 0) { signal?.throwIfAborted(); if (Date.now() > deadline) throw new Error("syntax walk deadline"); }
      const node = stack.pop()!;
      if (identifier.test(node.type)) {
        const parent = node.parent;
        const named = parent?.childForFieldName("name") ?? (parent?.type === "assignment" ? parent.childForFieldName("left") : null);
        const definition = parent !== null && parent !== undefined && declaration.test(parent.type) && named?.startIndex === node.startIndex;
        let imported = false;
        for (let ancestor = parent, depth = 0; ancestor && depth++ < 4; ancestor = ancestor.parent) {
          if (/^(?:import_statement|import_from_statement|import_spec|use_declaration|use_as_clause|import_clause|import_specifier)$/.test(ancestor.type)) { imported = true; break; }
        }
        tags.push({ name: node.text, kind: definition ? parent!.type : imported ? "import" : "reference",
          role: definition ? "definition" : imported ? "import" : "reference", line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1, column: node.startPosition.column + 1,
          text: (lines[node.startPosition.row] ?? "").trim().slice(0, 240) });
      }
      const children = node.namedChildren;
      for (let i = children.length - 1; i >= 0; i--) if (children[i]) stack.push(children[i]!);
    }
    const parsed = { tags, complete: !tree.rootNode.hasError && stack.length === 0, bytes: Buffer.byteLength(JSON.stringify(tags)) };
    cache.set(key, parsed); cachedBytes += parsed.bytes;
    while (cache.size > 256 || cachedBytes > 16 * 1024 * 1024) {
      const first = cache.keys().next().value;
      if (first === undefined) break;
      cachedBytes -= cache.get(first)!.bytes; cache.delete(first);
    }
    return parsed;
  } finally { tree?.delete(); parser.delete(); }
}

async function boundedRead(path: string, limit = MAX_BYTES): Promise<Buffer | undefined> {
  const handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW));
  try {
    const stats = await handle.stat(); if (!stats.isFile() || stats.size > limit) return undefined;
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, limit + 1, 0);
    if (bytesRead > limit) return undefined;
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

export interface SyntaxFile { file: string; sha256: string; language: string; tags: SyntaxTag[] }
export interface SyntaxIndex { files: SyntaxFile[]; complete: boolean; skippedFiles: number; fingerprint: string; indexer: "tree-sitter-wasm-v1" }

/** Explicitly scoped traversal; symlinks and ignored directories are never
 * enumerated. Each query hashes bounded source bytes, so same-size/mtime edits
 * invalidate parsed tags immediately. AST references remain candidates, not LSP. */
export async function buildSyntaxIndex(root: string, path = ".", signal?: AbortSignal, maxFiles = 500): Promise<SyntaxIndex> {
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 5000) throw new TypeError("invalid syntax file budget");
  const result: SyntaxIndex = { files: [], complete: true, skippedFiles: 0, fingerprint: "", indexer: "tree-sitter-wasm-v1" };
  const scope = await resolveSearchScope(root, path, skipped);
  if (!scope) return { ...result, complete: false };
  const rules: { base: string; matcher: Ignore }[] = [];
  const addIgnore = async (directory: string) => {
    try {
      const name = join(directory, ".gitignore"); const stat = await lstat(name);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
      const bytes = await boundedRead(name, 64 * 1024);
      if (bytes) rules.push({ base: directory, matcher: ignore().add(bytes.toString("utf8")) });
    } catch { /* absent ignore file does not authorize a broader scope */ }
  };
  const ignored = (name: string, directory: boolean) => {
    let excluded = false;
    for (const rule of rules) {
      const rel = slash(relative(rule.base, name));
      if (!rel || rel === ".." || rel.startsWith("../")) continue;
      const test = rule.matcher.test(rel + (directory ? "/" : ""));
      if (test.ignored) excluded = true; else if (test.unignored) excluded = false;
    }
    return excluded;
  };
  const ancestors: string[] = [];
  for (let parent = scope.type === "file" ? dirname(scope.path) : scope.path; parent !== scope.root; parent = dirname(parent)) ancestors.unshift(parent);
  await addIgnore(scope.root);
  for (const parent of ancestors) await addIgnore(parent);
  let bytesTotal = 0, entriesVisited = 0, tagsTotal = 0;
  const deadline = Date.now() + 10000;
  const visit = async (name: string, depth = 0): Promise<void> => {
    signal?.throwIfAborted();
    if (result.files.length >= maxFiles || bytesTotal > 16 * 1024 * 1024 || tagsTotal > 100000 || entriesVisited++ >= 50000 || depth > 64 || Date.now() > deadline) { result.complete = false; return; }
    let stat;
    try { stat = await lstat(name); } catch { result.complete = false; return; }
    if (stat.isSymbolicLink() || ignored(name, stat.isDirectory())) return;
    if (stat.isDirectory()) {
      const saved = rules.length;
      if (name !== scope.path && name !== scope.root) await addIgnore(name);
      try {
        const entries = (await readdir(name, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"));
        for (const entry of entries) { if (!entry.isSymbolicLink() && !skipped.has(entry.name)) await visit(join(name, entry.name), depth + 1); }
      } catch { result.complete = false; }
      finally { rules.length = saved; }
      return;
    }
    const language = extensions[extname(name)]; if (!stat.isFile() || !language) return;
    try {
      const bytes = await boundedRead(name);
      if (!bytes || bytes.includes(0)) { result.skippedFiles++; result.complete = false; return; }
      bytesTotal += bytes.length;
      const parsed = await parseTags(bytes.toString("utf8"), language, signal);
      result.complete &&= parsed.complete;
      tagsTotal += parsed.tags.length;
      result.files.push({ file: slash(relative(scope.root, name)), sha256: hash(bytes), language, tags: parsed.tags });
    } catch (error) { if (signal?.aborted) throw error; result.skippedFiles++; result.complete = false; }
  };
  await visit(scope.path);
  result.fingerprint = hash(JSON.stringify(result.files.map(file => [file.file, file.sha256])));
  return result;
}

export async function syntaxSymbolSearch(input: { root: string; path?: string; symbol: string; maxResults?: number; signal?: AbortSignal }) {
  const index = await buildSyntaxIndex(input.root, input.path, input.signal);
  const needle = input.symbol.normalize("NFKC").toLowerCase();
  const matches = index.files.flatMap(file => file.tags.filter(tag => tag.name.normalize("NFKC").toLowerCase() === needle)
    .map(tag => ({ ...tag, file: file.file, sha256: file.sha256 })));
  matches.sort((a, b) => Number(b.role === "definition") - Number(a.role === "definition") || a.file.localeCompare(b.file, "en") || a.line - b.line);
  return { fallback: false, indexer: index.indexer, semantic: false, hits: matches.slice(0, input.maxResults ?? 200),
    filesIndexed: index.files.length, complete: index.complete && matches.length <= (input.maxResults ?? 200), fingerprint: index.fingerprint };
}
