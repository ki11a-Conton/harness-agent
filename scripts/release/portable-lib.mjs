import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function safePath(path) {
  if (typeof path !== 'string' || !path || !/^[A-Za-z0-9@._/-]+$/.test(path)
    || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..'
      || part.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`unsafe portable path: ${JSON.stringify(path)}`);
  }
  return path;
}
export async function filesIn(root, prefix = '') {
  const files = [];
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    safePath(path);
    if (entry.isSymbolicLink()) throw new Error(`portable payload cannot contain symlinks: ${path}`);
    if (entry.isDirectory()) files.push(...await filesIn(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`portable payload requires regular files: ${path}`);
  }
  return files;
}
export async function verifyPortable(root, expected = {}) {
  const manifest = JSON.parse(await readFile(join(root, 'PORTABLE-MANIFEST.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'harness-agent-portable'
    || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version ?? '')
    || !/^[a-f0-9]{40}$/.test(manifest.sourceSha ?? '') || !/^[a-f0-9]{40}$/.test(manifest.sourceTree ?? '')
    || !Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('invalid portable manifest');
  for (const key of ['version', 'sourceSha']) {
    if (expected[key] !== undefined && manifest[key] !== expected[key]) throw new Error(`portable ${key} mismatch`);
  }
  const paths = new Set();
  const casePaths = new Set();
  for (const item of manifest.files) {
    const path = safePath(item.path);
    if (path === 'PORTABLE-MANIFEST.json' || paths.has(path) || casePaths.has(path.toLowerCase())) throw new Error(`duplicate manifest path: ${path}`);
    paths.add(path); casePaths.add(path.toLowerCase());
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')) throw new Error(`invalid digest record: ${path}`);
    // lstat each parent too: a replaced directory must not escape the trusted payload.
    let current = resolve(root);
    for (const component of path.split('/')) {
      current = join(current, component);
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`payload symlink: ${path}`);
    }
    const bytes = await readFile(current);
    if (bytes.length !== item.bytes || digest(bytes) !== item.sha256) throw new Error(`portable digest mismatch: ${path}`);
  }
  const actual = await filesIn(root);
  if (actual.length !== paths.size + 1 || actual.some(path => path !== 'PORTABLE-MANIFEST.json' && !paths.has(path))) throw new Error('portable contains undeclared files');
  for (const path of ['agent.mjs', 'node_modules/@ar/cli/dist/main.js', 'node_modules/@ar/web/dist/main.js',
    'node_modules/@ar/web/public/index.html', 'PROJECT-LICENSE-NOTICE.txt']) if (!paths.has(path)) throw new Error(`missing portable entry: ${path}`);
  return manifest;
}

function octal(header, offset, width, value) {
  const text = value.toString(8).padStart(width - 1, '0') + '\0';
  if (text.length !== width) throw new Error('tar field overflow');
  header.write(text, offset, width, 'ascii');
}
export function makeArchive(entries) {
  const chunks = [];
  const seen = new Set(); const directories = new Set();
  for (const entry of entries) {
    const path = safePath(entry.path);
    const lower = path.toLowerCase();
    if (seen.has(lower)) throw new Error(`duplicate archive path: ${path}`);
    if (directories.has(lower)) throw new Error(`archive file/directory collision: ${path}`);
    const parts = lower.split('/');
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/');
      if (seen.has(parent)) throw new Error(`archive file/directory collision: ${path}`);
      directories.add(parent);
    }
    seen.add(lower);
    let name = path; let prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const slash = path.lastIndexOf('/'); prefix = path.slice(0, slash); name = path.slice(slash + 1);
      if (slash < 1 || Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`tar path too long: ${path}`);
    }
    const header = Buffer.alloc(512);
    header.write(name, 0, 100); octal(header, 100, 8, entry.executable ? 0o755 : 0o644);
    octal(header, 108, 8, 0); octal(header, 116, 8, 0); octal(header, 124, 12, entry.bytes.length); octal(header, 136, 12, 0);
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263); header.write(prefix, 345, 155);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, entry.bytes, Buffer.alloc((512 - entry.bytes.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}
export async function extractArchive(archive, destination) {
  // Extract only into an empty destination; validate the entire archive before any writes.
  await mkdir(destination, { recursive: true });
  if ((await readdir(destination)).length !== 0 || (await lstat(destination)).isSymbolicLink()
    || await realpath(destination) !== resolve(destination)) throw new Error('archive destination must be an empty real directory');
  const raw = gunzipSync(archive, { maxOutputLength: 256 * 1024 * 1024 });
  const entries = []; const seen = new Set(); const directories = new Set(); let offset = 0; let top; let terminated = false;
  const text = (buffer, start, length) => buffer.subarray(start, start + length).toString('ascii').replace(/\0.*$/s, '');
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) {
      if (raw.length - offset < 512 || raw.subarray(offset).some(byte => byte !== 0)) throw new Error('invalid tar termination');
      terminated = true;
      break;
    }
    const supplied = parseInt(text(header, 148, 8).trim(), 8);
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (supplied !== actual || text(header, 257, 6) !== 'ustar' || text(header, 156, 1) !== '0') throw new Error('unsupported or corrupt tar header');
    const prefix = text(header, 345, 155); const name = text(header, 0, 100);
    const path = safePath(prefix ? `${prefix}/${name}` : name);
    const [root, ...rest] = path.split('/');
    if (!/^harness-agent-\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(root) || rest.length === 0 || (top !== undefined && top !== root)) throw new Error('invalid portable archive root');
    top = root;
    const lower = path.toLowerCase();
    if (seen.has(lower)) throw new Error(`duplicate tar path: ${path}`);
    if (directories.has(lower)) throw new Error(`tar file/directory collision: ${path}`);
    const parts = lower.split('/');
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/');
      if (seen.has(parent)) throw new Error(`tar file/directory collision: ${path}`);
      directories.add(parent);
    }
    seen.add(lower);
    const sizeText = text(header, 124, 12).trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error('invalid tar size');
    const size = parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || offset + size > raw.length) throw new Error('truncated portable archive');
    entries.push({ path, bytes: raw.subarray(offset, offset + size) });
    offset += Math.ceil(size / 512) * 512;
  }
  if (entries.length === 0 || offset > raw.length || !top || !terminated) throw new Error('empty or truncated portable archive');
  const target = resolve(destination);
  for (const entry of entries) {
    const path = resolve(target, ...entry.path.split('/'));
    if (!path.startsWith(target + sep)) throw new Error('archive path escapes destination');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, entry.bytes, { flag: 'wx', mode: entry.path.endsWith('/agent.sh') ? 0o755 : 0o644 });
  }
  return join(target, top);
}
