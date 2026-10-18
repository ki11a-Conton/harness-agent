import { mkdtemp, mkdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { newAgentId, newSessionId, type ToolExecutionContext } from "@ar/contracts";
import { buildRelevantCodeMap } from "./relevant-code-map.js";
import { createRepoMapTool, makeRepoMapResolver } from "./tools/repo-map-tool.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 8 : 0, retryDelay: 50 });
});
async function fixture(files: Record<string, string>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "coding-scope-"))); roots.push(root);
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
  return root;
}
function context(cwd: string): ToolExecutionContext {
  return { cwd, sessionId: newSessionId(), agentId: newAgentId(), signal: new AbortController().signal,
    permissions: { rules: [] }, sandboxPolicy: { filesystem: { mode: "read-only" }, network: { mode: "deny" }, process: {} } };
}
const languages = [
  { name: "typescript", ext: "ts", symbol: "formatInvoice", definition: "export function formatInvoice(value: number) { return String(value); }\n", caller: "import { formatInvoice } from './target.js';\nexport function renderInvoice() { return formatInvoice(2); }\n" },
  { name: "python", ext: "py", symbol: "format_invoice", definition: "def format_invoice(value):\n    return str(value)\n", caller: "from target import format_invoice\ndef render_invoice():\n    return format_invoice(2)\n" },
  { name: "rust", ext: "rs", symbol: "format_invoice", definition: "pub fn format_invoice(value: i32) -> String { value.to_string() }\n", caller: "use crate::target::format_invoice;\npub fn render_invoice() -> String { format_invoice(2) }\n" },
  { name: "go", ext: "go", symbol: "FormatInvoice", definition: "package billing\nfunc FormatInvoice(value int) int { return value }\n", caller: "package billing\nfunc RenderInvoice() int { return FormatInvoice(2) }\n" },
];
it.each(languages)("scoped repository map reaches $name targets beyond the global 500-file budget", async sample => {
  const root = await fixture({ [`zzz-target/target.${sample.ext}`]: sample.definition, [`zzz-target/caller.${sample.ext}`]: sample.caller });
  await mkdir(join(root, "aaa-noise"));
  await Promise.all(Array.from({ length: 510 }, (_, i) => writeFile(join(root, "aaa-noise", `${String(i).padStart(4, "0")}.ts`), `export function noise${i}() { return 0; }\n`)));
  const broad = await buildRelevantCodeMap({ root, query: sample.symbol });
  expect(broad.filesIndexed).toBe(500); expect(broad.complete).toBe(false); expect(broad.files.some(f => f.path.startsWith("zzz-target/"))).toBe(false);
  const tool = createRepoMapTool();
  const result = await tool.execute({ query: sample.symbol, queryPath: "zzz-target", maxFiles: 20 }, context(root));
  expect(result.status).toBe("success");
  const map = result.output!.relevantCode!;
  expect(map.scope).toBe("zzz-target"); expect(map.filesIndexed).toBe(2); expect(map.complete).toBe(true); expect(map.semantic).toBe(false);
  expect(map.files.map(f => f.path)).toContain(`zzz-target/target.${sample.ext}`); expect(map.files.map(f => f.path)).toContain(`zzz-target/caller.${sample.ext}`);
  expect(result.output!.fileCount).toBe(20); expect(result.output!.complete).toBe(false);
  expect(result.output!.files.every(f => f.path.startsWith("aaa-noise/"))).toBe(true); // overview stays independently global/bounded
  expect(Buffer.byteLength(JSON.stringify(map))).toBeLessThanOrEqual(6400);
});
it("scoped map fingerprints describe their subset and ignore unrelated content changes", async () => {
  const root = await fixture({ "src/a.ts": "export function targetOne() {}\n", "other/b.ts": "export function unrelated() {}\n" });
  const first = await buildRelevantCodeMap({ root, path: "src", query: "targetOne" });
  await writeFile(join(root, "other/b.ts"), "export function externallyChanged() {}\n");
  const unchanged = await buildRelevantCodeMap({ root, path: "src", query: "targetOne" });
  expect(unchanged.fingerprint).toBe(first.fingerprint); expect(unchanged.scope).toBe("src");
  const current = await stat(join(root, "src/a.ts")); await writeFile(join(root, "src/a.ts"), "export function targetTwo() {}\n"); await utimes(join(root, "src/a.ts"), current.atime, current.mtime);
  const changed = await buildRelevantCodeMap({ root, path: "src", query: "targetTwo" });
  expect(changed.fingerprint).not.toBe(first.fingerprint); expect(changed.files[0]?.symbols.some(s => s.name === "targetTwo")).toBe(true);
});
it("scope can name a single file without widening to its siblings", async () => {
  const root = await fixture({ "src/a.ts": "export const selected = 1;\n", "src/b.ts": "export const unrelated = 2;\n" });
  const map = await buildRelevantCodeMap({ root, path: "src/a.ts", query: "selected" });
  expect(map.scope).toBe("src/a.ts"); expect(map.filesIndexed).toBe(1); expect(map.files.map(f => f.path)).toEqual(["src/a.ts"]);
});
it("queryPath preserves significant spaces instead of silently selecting another directory", async () => {
  const root = await fixture({ " target/a.ts": "export function wanted() {}\n", "target/b.ts": "export function unwanted() {}\n" });
  const tool = createRepoMapTool();
  const input = tool.inputSchema.parse({ query: "wanted", queryPath: " target", maxFiles: 1 });
  expect(input.queryPath).toBe(" target");
  const map = (await tool.execute(input, context(root))).output!.relevantCode!;
  expect(map.scope).toBe(" target"); expect(map.files.map(f => f.path)).toEqual([" target/a.ts"]);
});
it("scoped repository map preserves root and nested ignores and refuses symlink escape", async () => {
  const root = await fixture({ ".gitignore": "private/\n*.generated.ts\n", "src/.gitignore": "hidden.ts\n", "src/hidden.ts": "function hiddenNested() {}\n", "src/visible.ts": "export function publicTarget() {}\n", "src/skip.generated.ts": "function hiddenGenerated() {}\n", "private/key.ts": "function confidentialTarget() {}\n" });
  const outside = await fixture({ "outside.ts": "function outsideSecretSymbol() {}\n" });
  await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  const tool = createRepoMapTool();
  const allowed = await tool.execute({ query: "publicTarget", queryPath: "src" }, context(root));
  expect(allowed.output!.relevantCode!.files.map(f => f.path)).toEqual(["src/visible.ts"]);
  for (const queryPath of ["private", "escape", outside, "../"]) {
    const r = await tool.execute({ query: "outsideSecretSymbol confidentialTarget", queryPath }, context(root));
    expect(r.output?.relevantCode?.files ?? []).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('"name":"outsideSecretSymbol"'); expect(JSON.stringify(r)).not.toContain('"name":"confidentialTarget"');
  }
});
it("queryPath without query is rejected before repository enumeration", async () => {
  let called = false; const resolver = makeRepoMapResolver(); const original = resolver.resolve;
  resolver.resolve = async (...args) => { called = true; return original(...args); };
  const root = await fixture({ "src/a.ts": "export const a=1" });
  const result = await createRepoMapTool(resolver).execute({ queryPath: "src" }, context(root));
  expect(result.error?.code).toBe("TOOL_SCHEMA_ERROR"); expect(called).toBe(false);
});
it("a narrow token budget remains bounded without dropping the requested scope identity", async () => {
  const root = await fixture({ "src/a.ts": "export function target() {}\n" });
  const map = await buildRelevantCodeMap({ root, path: "src", query: "查找相关目标函数".repeat(20), maxTokens: 128 });
  expect(Buffer.byteLength(JSON.stringify(map))).toBeLessThanOrEqual(512); expect(map.scope).toBe("src"); expect(map.truncated).toBe(true);
});
it("unrepresentable scope metadata fails instead of returning an oversized result", async () => {
  const root = await fixture({ "src/a.ts": "export function target() {}\n" });
  await expect(buildRelevantCodeMap({ root, path: "x".repeat(600), query: "target", maxTokens: 128 })).rejects.toThrow("scope metadata");
});
it("aborted scoped indexing returns no source content", async () => {
  const root = await fixture({ "src/a.ts": "export function target() {}\n" });
  const controller = new AbortController(); controller.abort();
  await expect(buildRelevantCodeMap({ root, path: "src", query: "target", signal: controller.signal })).rejects.toThrow();
});
it("omitting queryPath preserves the existing broad-map result shape", async () => {
  const root = await fixture({ "src/a.ts": "export function target() {}\n" });
  const map = (await createRepoMapTool().execute({ query: "target" }, context(root))).output!.relevantCode!;
  expect(map).not.toHaveProperty("scope"); expect(map.filesIndexed).toBe(1); expect(map.files[0]?.path).toBe("src/a.ts");
});
