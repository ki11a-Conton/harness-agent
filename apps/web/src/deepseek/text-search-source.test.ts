import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

it("the browser search is reproducible from retained MIT source and locked dependency bytes", async () => {
  const root = new URL("../../../../", import.meta.url), directory = new URL("third_party/deepseek-text-search/", root);
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/research/generate-text-search.mjs", "--check"], { cwd: fileURLToPath(root), timeout: 15000 });
  expect(stdout).toContain("TEXT_SEARCH_GENERATED_SOURCE_MATCH");
  const recorded = JSON.parse(await readFile(new URL("PROVENANCE.json", directory), "utf8"));
  const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  expect(hash(await readFile(new URL("index.ts", directory)))).toBe(recorded.sourceSha256);
  expect(hash(await readFile(new URL("fuzzysort.js", directory)))).toBe(recorded.dependencySourceSha256);
  for (const name of ["LICENSE", "FUZZYSORT-LICENSE", "PROVENANCE.json"]) {
    expect(await readFile(new URL(name, directory))).toEqual(await readFile(new URL(`apps/web/public/deepseek/licenses/harness-text-search/${name}`, root)));
  }
}, 20000);

it("the actual browser factory keeps Unicode matching, ranking, and immutable index updates", async () => {
  const source = await readFile(new URL("../../../../scripts/research/web-text-search-runtime.mjs", import.meta.url), "utf8");
  const { TextSearchIndex, localizedValues } = vm.runInNewContext(source.replace(/^export /gm, "") + "\ncreateBrowserTextSearch()");
  const rows = [{ id: "compact", title: { en: "Compact", zh: "压缩上下文" } }, { id: "model-list", title: "Résumé" }, { id: "other", title: "𠀀x-b" }];
  const index = new TextSearchIndex(rows, (row: typeof rows[number]) => ({ fuzzy: [row.id, ...localizedValues(row.title)] }));
  for (const q of ["ｃｐｔ", "压缩", "compact 上下文"]) expect(index.search(q).map((row: { id: string }) => row.id)).toEqual(["compact"]);
  expect(index.search("resm").map((row: { id: string }) => row.id)).toEqual(["model-list"]);
  expect(index.search("𠀀b").map((row: { id: string }) => row.id)).toEqual(["other"]);
  expect(index.search("文上")).toEqual([]);
  const next = index.update([{ id: "shrink", title: "Shrink" }], (row: { id: string; title: string }) => ({ fuzzy: [row.id, row.title] }));
  expect(next.search("cpt")).toEqual([]); expect(index.search("cpt")).toHaveLength(1); expect(next.search("shrnk")).toHaveLength(1);
  expect(index.search("")).toEqual(rows);
});
