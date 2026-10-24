#!/usr/bin/env node
/** Development-only compilation of the retained MIT upstream component. */
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = new URL('../../', import.meta.url);
const source = fileURLToPath(new URL('third_party/deepseek-model-reasoning/ModelReasoningEfforts.tsx', root));
const css = await readFile(new URL('third_party/deepseek-model-reasoning/reasoning.css', root), 'utf8');
const locales = JSON.parse(await readFile(new URL('third_party/deepseek-model-reasoning/locales.json', root), 'utf8'));
// TypeScript 7 ships its native CLI, rather than the old JS compiler API.
// Erase the retained component's types without importing its upstream project.
const temporary = await mkdtemp(join(tmpdir(), 'harness-reasoning-build-'));
let body;
try {
  const config = join(temporary, 'tsconfig.json');
  await writeFile(config, JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
    jsx: 'react-jsx', noCheck: true, types: [], skipLibCheck: true, removeComments: false, newLine: 'lf',
    rootDir: dirname(source), outDir: join(temporary, 'output') }, files: [source] }));
  const compiled = spawnSync(process.execPath, [fileURLToPath(new URL('node_modules/typescript/bin/tsc', root)), '--project', config], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const emitted = await readFile(join(temporary, 'output/ModelReasoningEfforts.js'), 'utf8');
  body = emitted.replace(/^import[^;]*;\r?\n/gm, '').replace(/^export (?=function )/gm, '').replace(/[\t ]+$/gm, '');
  assert(!/^import\b|^export\b/m.test(body), 'Review changed upstream imports/exports');
} finally { await rm(temporary, { recursive: true, force: true }); }
const output = `// Generated from the retained upstream MIT component at 22ddee3792402c3e70ec5f86a63c3e3e895a2f60.
// See third_party/deepseek-model-reasoning/{LICENSE,PROVENANCE.json}.
// Regenerate: node scripts/research/generate-model-reasoning.mjs
// This runtime module requires no TypeScript, filesystem, or development package.
export function createModelReasoningEditor(react, jsx, primitives, modelDrafts, styles) {
  // Copyright (c) 2026 DeepSeek; MIT, retained in /deepseek/licenses/upstream-source-reference/LICENSE.
  const { useState } = react;
  const { jsx: _jsx, jsxs: _jsxs, Fragment: _Fragment } = jsx;
  const { IconPlusOutlineRegular, IconTrashOutlineRegular, Switch, Tooltip } = primitives;
${body}
  return { Editor: ModelReasoningEfforts, validate: validateReasoningEfforts };
}
export const modelReasoningCss = ${JSON.stringify(css)};
export const modelReasoningLocales = ${JSON.stringify(locales, null, 2)};
`;
const destination = new URL('scripts/research/web-model-reasoning-component.mjs', root);
if (process.argv.includes('--check')) {
  assert.equal(await readFile(destination, 'utf8'), output, 'Regenerate the reviewed model reasoning component');
  console.log('MODEL_REASONING_GENERATED_SOURCE_MATCH');
} else {
  assert.equal(process.argv.length, 2, 'Use --check or no arguments');
  await writeFile(destination, output); console.log('MODEL_REASONING_COMPONENT_GENERATED');
}
