#!/usr/bin/env node
// Verify immutable development evidence without npm packages or network access.
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = (message) => { throw new Error(message); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safePath = (path) => typeof path === 'string' && path.startsWith('regressions/')
  && !path.includes('\\') && !path.includes('\0') && !path.split('/').some((part) => !part || part === '.' || part === '..');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function pointer(value, path) {
  if (typeof path !== 'string' || !path.startsWith('/')) fail(`Invalid JSON pointer: ${path}`);
  for (const token of path.slice(1).split('/')) {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!object(value) && !Array.isArray(value)) fail(`Missing JSON pointer: ${path}`);
    if (!Object.hasOwn(value, key)) fail(`Missing JSON pointer: ${path}`);
    value = value[key];
  }
  return value;
}
function validateSourceManifest(data, path) {
  if (!object(data)) fail(`Invalid source manifest: ${path}`);
  if (Object.hasOwn(data, 'schemaVersion') && data.schemaVersion !== 1) fail(`Unknown source schema: ${path}`);
  let records;
  if (Array.isArray(data.projects)) {
    records = data.projects.flatMap((project) => {
      if (!object(project) || !Array.isArray(project.files) || !/^[a-f0-9]{40}$/.test(project.checkoutHead)) {
        fail(`Invalid project source reference: ${path}`);
      }
      return project.files;
    });
  } else if (Array.isArray(data.sources)) {
    records = data.sources;
  } else if (Array.isArray(data.files)) {
    records = data.files;
  } else fail(`Unknown source manifest shape: ${path}`);
  if (records.length === 0) fail(`Empty source references: ${path}`);
  for (const record of records) {
    if (!object(record) || !/^[a-f0-9]{64}$/.test(record.sha256)
      || typeof (record.path ?? record.snapshotPath) !== 'string') fail(`Invalid source file reference: ${path}`);
    for (const key of ['sourceSHA', 'snapshotRepositorySha']) {
      if (Object.hasOwn(record, key) && !/^[a-f0-9]{40}$/.test(record[key])) fail(`Invalid source SHA: ${path}`);
    }
  }
}

async function main() {
  if (process.argv.length > 3) fail('Usage: node verify-evidence.mjs [archive-directory]');
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/evidence/gen1-20261008');
  const root = await realpath(resolve(process.argv[2] ?? defaultRoot));
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  if (!object(manifest) || manifest.schema !== 'harness-gen1-regression-evidence-v1') fail('Unknown evidence manifest schema');
  if (manifest.evidenceClass !== 'development-regressions' || manifest.fixedSource !== null) {
    fail('Development evidence cannot claim a fixed release source');
  }
  if (!/^[a-f0-9]{40}$/.test(manifest.baselineContext)) fail('Invalid baseline context SHA');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail('Missing evidence files');
  const entries = new Map();
  const documents = new Map();
  const kinds = new Set(['vitest-json', 'native-probe-json', 'probe-source', 'log', 'report-snapshot', 'source-manifest', 'session-index']);
  const statuses = new Set(['RED', 'GREEN', 'SOURCE', 'OBSERVED', 'UNVERIFIED']);
  let total = 0;
  for (const entry of manifest.files) {
    if (!object(entry) || !safePath(entry.path) || entries.has(entry.path)) fail(`Unsafe or duplicate evidence path: ${entry?.path}`);
    if (!kinds.has(entry.kind) || !statuses.has(entry.status) || !object(entry.statusSource)
      || typeof entry.scope !== 'string' || !entry.scope || typeof entry.originalPath !== 'string'
      || !entry.originalPath || !Array.isArray(entry.sourceRefs)) fail(`Invalid evidence metadata: ${entry.path}`);
    if (entry.fixedSource !== null || entry.phase !== 'development-working-tree') fail(`False fixed-source claim: ${entry.path}`);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) fail(`Invalid hash or byte count: ${entry.path}`);
    const target = resolve(root, entry.path);
    const physical = await realpath(target);
    const within = relative(root, physical);
    if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`)
      || !(await lstat(target)).isFile()) fail(`Evidence escapes archive or is not regular: ${entry.path}`);
    const bytes = await readFile(target);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) fail(`Hash/size mismatch: ${entry.path}`);
    total += bytes.length;
    entries.set(entry.path, entry);
    if (entry.path.endsWith('.json')) documents.set(entry.path, JSON.parse(bytes.toString('utf8')));
  }
  if (total !== manifest.totalBytes || total >= 5_000_000) fail('Invalid archive total or size limit exceeded');
  for (const entry of entries.values()) {
    for (const ref of entry.sourceRefs) {
      if (!safePath(ref) || !entries.has(ref) || ref === entry.path
        || !['report-snapshot', 'source-manifest', 'probe-source'].includes(entries.get(ref).kind)) {
        fail(`Missing or invalid source reference: ${entry.path} -> ${ref}`);
      }
    }
    const status = entry.statusSource;
    const data = documents.get(entry.path);
    if (status.kind === 'vitest-summary') {
      if (entry.kind !== 'vitest-json' || !object(data) || !object(status.summary)) fail(`Invalid Vitest evidence: ${entry.path}`);
      const keys = ['success', 'numTotalTestSuites', 'numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests'];
      for (const key of keys) {
        if (!Object.hasOwn(status.summary, key) || !equal(data[key], status.summary[key])) fail(`Vitest summary mismatch: ${entry.path}`);
      }
      if (typeof data.success !== 'boolean' || keys.slice(1).some((key) => !Number.isSafeInteger(data[key]) || data[key] < 0)
        || data.numTotalTests !== data.numPassedTests + data.numFailedTests + data.numPendingTests + (data.numTodoTests ?? 0)) {
        fail(`Invalid Vitest counters: ${entry.path}`);
      }
      const derived = !data.success || data.numFailedTests > 0 ? 'RED' : 'GREEN';
      if (entry.status !== derived) fail(`False Vitest status: ${entry.path}`);
    } else if (status.kind === 'json-fields') {
      if (entry.kind !== 'native-probe-json' || !Array.isArray(status.checks) || status.checks.length === 0) fail(`Invalid probe status source: ${entry.path}`);
      for (const check of status.checks) {
        if (!object(check) || !Object.hasOwn(check, 'equals') || !equal(pointer(data, check.pointer), check.equals)) fail(`Probe observation mismatch: ${entry.path}`);
      }
    } else if (status.kind === 'paired-result') {
      const paired = entries.get(status.artifact);
      if (entry.kind !== 'log' || !paired || paired.kind !== 'vitest-json' || entry.status !== paired.status) fail(`Invalid paired log reference: ${entry.path}`);
    } else if (status.kind === 'record-only') {
      if (!['SOURCE', 'OBSERVED', 'UNVERIFIED'].includes(entry.status)) fail(`Unproven PASS/FAIL claim: ${entry.path}`);
    } else fail(`Unknown status-source schema: ${entry.path}`);
    if (entry.kind === 'source-manifest') validateSourceManifest(data, entry.path);
    if (entry.kind === 'session-index') {
      if (!object(data) || data.schemaVersion !== 1 || !Array.isArray(data.results)) fail(`Unknown session index schema: ${entry.path}`);
      for (const record of data.results) {
        if (!object(record) || typeof record.file !== 'string' || record.file.includes('/') || record.file.includes('\\')) fail(`Invalid session result path: ${entry.path}`);
        const path = `${entry.path.slice(0, entry.path.lastIndexOf('/') + 1)}${record.file}`;
        const referenced = entries.get(path);
        const result = documents.get(path);
        if (!referenced || referenced.sha256 !== record.sha256 || result?.numPassedTests !== record.passed
          || result?.numFailedTests !== record.failed || result?.success !== record.success) fail(`Session index reference mismatch: ${path}`);
      }
    }
  }
  async function walk(path) {
    for (const item of await readdir(resolve(root, path), { withFileTypes: true })) {
      const child = `${path}/${item.name}`;
      if (item.isDirectory()) await walk(child);
      else if (!entries.has(child)) fail(`Unmanifested artifact: ${child}`);
    }
  }
  await walk('regressions');
  process.stdout.write(`PASS: ${entries.size} development evidence files, ${total} bytes; hashes, source references, schemas and result summaries verified. No fixed-source acceptance claimed.\n`);
}

main().catch((error) => {
  process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
