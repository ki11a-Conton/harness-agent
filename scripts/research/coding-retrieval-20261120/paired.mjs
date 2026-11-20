import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const baselineModule = process.argv[2];
if (!baselineModule) throw new Error("Pass the compiled baseline relevant-code-map.js path.");
const buildMap = {
  baseline: (await import(pathToFileURL(resolve(baselineModule)).href)).buildRelevantCodeMap,
  candidate: (await import("../../../packages/tools/dist/relevant-code-map.js")).buildRelevantCodeMap,
};
const goldBytes = await readFile(new URL("../../../packages/tools/test-fixtures/coding-retrieval-gold.json", import.meta.url));
const { cases } = JSON.parse(goldBytes);
const challengers = cases.filter((_, index) => index % 5 === 0 || index % 5 === 2);
const declaration = {
  ".ts": name => `export function ${name}() { return 0; }\n`,
  ".py": name => `def ${name}():\n    return 0\n`,
  ".rs": name => `pub fn ${name}() -> usize { 0 }\n`,
  ".go": name => `func ${name}() int { return 0 }\n`,
};
const files = new Map(cases.flatMap(task => Object.entries(task.files)));

function withDecoys() {
  const stressed = new Map(files);
  for (const task of challengers) {
    const extension = extname(task.goldFile);
    for (let file = 0; file < 6; file++) {
      const declarations = Array.from({ length: 8 }, (_, symbol) =>
        declaration[extension](`${task.symbol}_legacy_${file}_${symbol}`)).join("\n");
      stressed.set(`decoys/${task.id}/old${file}${extension}`,
        (extension === ".go" ? "package decoys\n\n" : "") + declarations);
    }
  }
  return stressed;
}

async function measure(documents, queries) {
  const root = await mkdtemp(join(tmpdir(), "harness-paired-retrieval-"));
  try {
    for (const [path, content] of documents) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const input = task => ({ root, query: task.query, maxTokens: 1600 });
    for (const run of Object.values(buildMap)) await run(input(queries[0]));
    const rows = [];
    for (let repetition = 0; repetition < 3; repetition++) {
      for (const [index, task] of queries.entries()) {
        const order = (index + repetition) % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
        const row = { id: task.id, repetition };
        for (const arm of order) {
          const start = performance.now();
          const output = await buildMap[arm](input(task));
          const ms = performance.now() - start;
          const top = output.files.slice(0, 5).map(({ path }) => path);
          const bytes = Buffer.byteLength(JSON.stringify(output));
          assert(bytes <= 6400, `${arm} ${task.id} returned ${bytes} bytes`);
          row[arm] = { ms, bytes, gold: top.includes(task.goldFile),
            caller: top.includes(task.callerFile), first: top[0] === task.goldFile };
        }
        rows.push(row);
      }
    }
    return rows;
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
}

function summarize(rows) {
  return Object.fromEntries(Object.keys(buildMap).map(arm => {
    const samples = rows.filter(row => row.repetition === 0).map(row => row[arm]);
    const timings = rows.map(row => row[arm].ms).sort((a, b) => a - b);
    return [arm, { queries: samples.length, recallAt5: samples.filter(row => row.gold).length,
      goldAndCallerAt5: samples.filter(row => row.gold && row.caller).length,
      definitionAt1: samples.filter(row => row.first).length,
      maxBytes: Math.max(...samples.map(row => row.bytes)),
      warmP95Ms: timings[Math.ceil(timings.length * 0.95) - 1] }];
  }));
}

const original = await measure(files, cases);
const challenged = await measure(withDecoys(), challengers);
console.log(JSON.stringify({ fixtureSha256: createHash("sha256").update(goldBytes).digest("hex"),
  original: summarize(original), challenged: summarize(challenged), originalRows: original, challengedRows: challenged }, null, 2));
