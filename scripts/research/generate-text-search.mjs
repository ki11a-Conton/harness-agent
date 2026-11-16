#!/usr/bin/env node
/** Compile retained MIT sources to a dependency-free, factory-scoped browser module. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = new URL('../../', import.meta.url);
const directory = new URL('third_party/deepseek-text-search/', root);
const original = await readFile(new URL('index.ts', directory));
const dependency = await readFile(new URL('fuzzysort.js', directory));
const recorded = JSON.parse(await readFile(new URL('PROVENANCE.json', directory), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(original), recorded.sourceSha256);
assert.equal(hash(dependency), recorded.dependencySourceSha256);
const temporary = await mkdtemp(join(tmpdir(), 'harness-text-search-'));
let body;
try {
  const source = fileURLToPath(new URL('index.ts', directory));
  const config = join(temporary, 'tsconfig.json');
  await writeFile(config, JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
    noCheck: true, types: [], skipLibCheck: true, removeComments: false, newLine: 'lf',
    rootDir: dirname(source), outDir: join(temporary, 'output') }, files: [source] }));
  const built = spawnSync(process.execPath, [fileURLToPath(new URL('node_modules/typescript/bin/tsc', root)), '--project', config], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  body = (await readFile(join(temporary, 'output/index.js'), 'utf8'))
    .replace(/^import[^;]*;\r?\n/gm, '').replace(/^export (?=(?:function|class) )/gm, '');
  assert(!/^import\b|^export\b/m.test(body), 'Review changed upstream module exports');
} finally { await rm(temporary, { recursive: true, force: true }); }
let fuzzy = dependency.toString('utf8').replaceAll('\r\n', '\n');
const exported = [...fuzzy.matchAll(/^export function (\w+)/gm)].map(match => match[1]);
assert.deepEqual(exported, ['single', 'go', 'highlight', 'score', 'remap', 'prepare', 'snapshot', 'cleanup']);
const ending = 'export default {single, go, highlight, score, remap, prepare, snapshot, cleanup}';
assert.equal(fuzzy.split(ending).length, 2);
fuzzy = fuzzy.replace(ending, 'return {single, go, highlight, score, remap, prepare, snapshot, cleanup}')
  .replace(/^export (?=function )/gm, '');
assert(!/^import\b|^export\b/m.test(fuzzy));
const output = `// Generated from retained MIT sources; see third_party/deepseek-text-search/PROVENANCE.json.\n// Regenerate: node scripts/research/generate-text-search.mjs\nexport function createBrowserTextSearch() {\nconst fuzzysort = (() => {\n${fuzzy}\n})();\n${body}\nreturn { TextSearchIndex, localizedValues };\n}\n`;
const destination = new URL('scripts/research/web-text-search-runtime.mjs', root);
if (process.argv.includes('--check')) {
  assert.equal(await readFile(destination, 'utf8'), output, 'Regenerate retained multilingual search');
  console.log('TEXT_SEARCH_GENERATED_SOURCE_MATCH');
} else {
  assert.equal(process.argv.length, 2, 'Use --check or no arguments');
  await writeFile(destination, output); console.log('TEXT_SEARCH_GENERATED');
}
