#!/usr/bin/env node
/** Regenerate reviewed branding derivatives. Follow with vendor --seal and --verify. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedBrandFiles, applyBrandGraph } from './web-branding-lib.mjs';
const root = fileURLToPath(new URL('../../apps/web/public/deepseek/', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'provenance.json'), 'utf8'));
const published = new Map();
for (const artifact of manifest.releaseArtifacts) for (const file of artifact.files) {
  published.set(file.path, await readFile(path.join(root, file.path)));
}
const files = expectedBrandFiles(published);
for (const [name, bytes] of files) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), bytes);
}
const graph = applyBrandGraph(JSON.parse(await readFile(path.join(root, 'boot-manifest.json'), 'utf8')), published, files);
await writeFile(path.join(root, 'boot-manifest.json'), JSON.stringify(graph, null, 2) + '\n');
await writeFile(path.join(root, 'boot-manifest.js'), 'window.__DSH_BOOT__=' + JSON.stringify(graph) + ';\n');
console.log(JSON.stringify({ status: 'GENERATED', brand: 'Harness Agent', derivedFiles: files.size }));
