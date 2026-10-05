import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newMemoryId, newSessionId, type MemoryEntry, type MemoryStore, type MemoryScope, type MemoryType } from "@ar/contracts";
import { JsonlMemoryStore } from "./memory-store.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import { matchesMemoryQuery } from "./search-text.js";
const dirs: string[] = [], stores: SqliteMemoryStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const s of stores.splice(0)) s.close(); await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
function oldMatch(query: string, content: string) {
  const q = query.toLowerCase(); if (q.trim() === "") return false;
  const c = content.toLowerCase(); if (c.includes(q)) return true;
  const tokens = q.split(/\s+/).filter(t => t !== ""); const words = new Set(c.split(/[^a-z0-9]+/).filter(t => t !== ""));
  return tokens.every(t => words.has(t));
}
function oldText(e: MemoryEntry) {
  const parts = [e.content]; const value: unknown = e.structured;
  if (value !== null && typeof value === "object") for (const key of ["when", "do", "avoid"]) { const part = (value as Record<string, unknown>)[key]; if (typeof part === "string") parts.push(part); }
  return parts.join("\n");
}
function entry(content: string, patch: Partial<MemoryEntry> = {}): MemoryEntry {
  return { id: newMemoryId(), content, sourceSession: newSessionId(), type: "procedural", scope: "workspace", importance: .8, confidence: .8, novelty: .8, stability: .8, createdAt: 1, updatedAt: 1, deleted: false, ...patch };
}
async function fixture(backend: "jsonl" | "sqlite") {
  const dir = await mkdtemp(join(tmpdir(), "ar-query-prepare-")); dirs.push(dir);
  const store = backend === "jsonl" ? new JsonlMemoryStore({ dataDir: dir }) : new SqliteMemoryStore({ dataDir: dir }); if (store instanceof SqliteMemoryStore) stores.push(store);
  return store;
}
async function oldSearch(store: MemoryStore, query: string, opts: { type?: MemoryType; scope?: MemoryScope } = {}) {
  if (query.trim() === "") return [];
  if (!(store instanceof SqliteMemoryStore)) return (await store.list()).filter(e => (opts.type === undefined || e.type === opts.type) && (opts.scope === undefined || e.scope === opts.scope) && oldMatch(query, oldText(e)));
  const q = query.trim(), parameters: string[] = []; let where = "m.deleted = 0";
  if (opts.type !== undefined) { where += " AND m.type = ?"; parameters.push(opts.type); }
  if (opts.scope !== undefined) { where += " AND m.scope = ?"; parameters.push(opts.scope); }
  const ids: string[] = [];
  try { const fts = q.split(/\s+/).filter(t => t !== "").map(t => `"${t.replace(/"/g, "")}"`).join(" OR "); if (!fts) throw Error(); const rows = store.database.prepare(`SELECT m.id, bm25(memories_fts) AS score FROM memories_fts f JOIN memories m ON m.id = f.id WHERE memories_fts MATCH ? AND ${where} ORDER BY score`).all(fts, ...parameters) as { id: string }[]; for (const row of rows) if (!ids.includes(row.id)) ids.push(row.id); } catch { /* Independent old fallback contract. */ }
  for (const row of store.database.prepare(`SELECT m.id FROM memories m WHERE ${where} ORDER BY m.rowid`).all(...parameters) as { id: string }[]) { const e = (await store.get(row.id as MemoryEntry["id"]))!; if (!ids.includes(row.id) && oldMatch(q, oldText(e))) ids.push(row.id); }
  return Promise.all(ids.map(id => store.get(id as MemoryEntry["id"])));
}
const queries = ["", " \t\n ", "ALPHA", "alpha beta", "beta alpha", "alpha alpha", "端口", "端口 alpha", "%", "_", '"', "ÉTÉ", " absent ", "  alpha beta  ", "Do:"];
it("preserves the public single-match wrapper for all frozen lexical combinations", () => {
  for (const query of queries) for (const body of ["", "ALPHA beta", "beta then alpha", "alphabets", "调试端口配置", "alpha 端口", "retain % _ character", "ÉTÉ décision", " a quote \"", "absent", "Do: "]) expect(matchesMemoryQuery(query, body)).toBe(oldMatch(query, body));
});
describe.each(["jsonl", "sqlite"] as const)("%s request-local query preparation", backend => {
  it("lowers and tokenizes an invariant miss query at most once per search", async () => {
    const store = await fixture(backend), query = "QUERY_WORK_MARKER missing", normalized = query.toLowerCase();
    for (let i = 0; i < 32; i++) await store.write(entry(`safe unrelated guidance ${i}`));
    const lower = vi.spyOn(String.prototype, "toLowerCase"), split = vi.spyOn(String.prototype, "split");
    let results: MemoryEntry[], lowered: number, tokens: number;
    try { results = await store.search(query); lowered = lower.mock.contexts.filter(c => String(c) === query).length; tokens = split.mock.calls.filter((a, i) => String(split.mock.contexts[i]) === normalized && a[0] instanceof RegExp && a[0].source === "\\s+").length; } finally { lower.mockRestore(); split.mockRestore(); }
    expect(results).toEqual([]); expect(lowered).toBeLessThanOrEqual(1); expect(tokens).toBeLessThanOrEqual(1);
  });
  it.each(queries)("preserves complete objects and order for query %j", async query => {
    const store = await fixture(backend);
    for (const e of [entry("alpha beta beta"), entry("beta then alpha"), entry("alpha alphabets"), entry("调试端口配置"), entry("retain % _ and \""), entry("ÉTÉ décision"), entry("absent"), entry("distinct", { structured: { when: "端口配置 alpha", do: "check portlint", avoid: "blind retry", rootCause: "metadata-only", outcome: "failure", evidenceRefs: [] } })]) await store.write(e);
    expect(await store.search(query)).toEqual(await oldSearch(store, query));
  });
  it.each([{ type: "procedural" as const }, { scope: "workspace" as const }, { type: "explicit" as const, scope: "session" as const }])("preserves deleted/type/scope filters %j", async opts => {
    const store = await fixture(backend);
    for (const e of [entry("alpha"), entry("alpha", { deleted: true }), entry("alpha", { type: "explicit" }), entry("alpha", { scope: "session", type: "explicit" })]) await store.write(e);
    expect(await store.search("alpha", opts)).toEqual(await oldSearch(store, "alpha", opts));
  });
  it("does not cache queries or content across subsequent searches and edits", async () => {
    const store = await fixture(backend), e = entry("alpha"); await store.write(e);
    expect(await store.search("alpha")).toHaveLength(1); expect(await store.search("beta")).toEqual([]);
    await store.update({ ...e, content: "beta" }); expect(await store.search("alpha")).toEqual([]); expect(await store.search("beta")).toEqual(await oldSearch(store, "beta")); await store.remove(e.id); expect(await store.search("beta")).toEqual([]);
  });
  it("keeps provenance metadata out of searchable strategy text", async () => {
    const store = await fixture(backend); await store.write(entry("safe distinct", { structured: { when: "condition", do: "check logs", avoid: "blind retry", rootCause: "metadata-only", outcome: "failure", evidenceRefs: ["evidence-only"] } }));
    for (const q of ["metadata-only", "evidence-only", "When:"]) expect(await store.search(q)).toEqual(await oldSearch(store, q));
  });
  it("preserves literal fallback when FTS is unavailable", async () => {
    const store = await fixture(backend); await store.write(entry("检查端口配置"));
    if (store instanceof SqliteMemoryStore) { store.database.exec("DROP TABLE memories_fts"); vi.spyOn(process.stderr, "write").mockImplementation(() => true); }
    expect(await store.search("端口")).toEqual(await oldSearch(store, "端口"));
  });
});
