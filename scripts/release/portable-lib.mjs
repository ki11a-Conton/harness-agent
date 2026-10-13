import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const MAX_PORTABLE_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
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
export function portableMode(mode) {
  if (!Number.isInteger(mode) || ![0o644, 0o755].includes(mode)) throw new Error('invalid portable file mode');
  return mode;
}
function manifestPaths(manifest, expected = {}) {
  if (![1, 2].includes(manifest.schemaVersion) || manifest.kind !== 'harness-agent-portable'
    || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version ?? '')
    || !/^[a-f0-9]{40}$/.test(manifest.sourceSha ?? '') || !/^[a-f0-9]{40}$/.test(manifest.sourceTree ?? '')
    || !Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('invalid portable manifest');
  for (const key of ['version', 'sourceSha']) {
    if (expected[key] !== undefined && manifest[key] !== expected[key]) throw new Error(`portable ${key} mismatch`);
  }
  const paths = new Map();
  const casePaths = new Set();
  for (const item of manifest.files) {
    const path = safePath(item.path);
    if (path === 'PORTABLE-MANIFEST.json' || paths.has(path) || casePaths.has(path.toLowerCase())) throw new Error(`duplicate manifest path: ${path}`);
    paths.set(path, item); casePaths.add(path.toLowerCase());
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')) throw new Error(`invalid digest record: ${path}`);
    if (manifest.schemaVersion === 2) portableMode(item.mode);
  }
  for (const path of ['agent.mjs', 'node_modules/@ar/cli/dist/main.js', 'node_modules/@ar/web/dist/main.js',
    'node_modules/@ar/web/public/index.html', 'PROJECT-LICENSE-NOTICE.txt']) if (!paths.has(path)) throw new Error(`missing portable entry: ${path}`);
  return paths;
}
export async function verifyPortable(root, expected = {}) {
  const manifestPath = join(root, 'PORTABLE-MANIFEST.json');
  const manifestInfo = await lstat(manifestPath);
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) throw new Error('portable manifest must be a regular file');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const paths = manifestPaths(manifest, expected);
  if (manifest.schemaVersion === 2 && process.platform !== 'win32' && (manifestInfo.mode & 0o7777) !== 0o644) throw new Error('portable mode mismatch: PORTABLE-MANIFEST.json');
  for (const [path, item] of paths) {
    // lstat each parent too: a replaced directory must not escape the trusted payload.
    let current = resolve(root);
    const components = path.split('/');
    let info;
    for (const [index, component] of components.entries()) {
      current = join(current, component);
      info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`payload symlink: ${path}`);
      if (index < components.length - 1 ? !info.isDirectory() : !info.isFile()) throw new Error(`payload requires regular files and directories: ${path}`);
    }
    // Windows does not represent POSIX execute bits. The archive reader binds
    // its mode fields to schema 2 before extraction on every platform; here
    // POSIX also detects permission changes made after extraction.
    if (manifest.schemaVersion === 2 && process.platform !== 'win32' && (info.mode & 0o7777) !== item.mode) throw new Error(`portable mode mismatch: ${path}`);
    const bytes = await readFile(current);
    if (bytes.length !== item.bytes || digest(bytes) !== item.sha256) throw new Error(`portable digest mismatch: ${path}`);
  }
  const actual = await filesIn(root);
  if (actual.length !== paths.size + 1 || actual.some(path => path !== 'PORTABLE-MANIFEST.json' && !paths.has(path))) throw new Error('portable contains undeclared files');
  return manifest;
}

function octal(header, offset, width, value) {
  const text = value.toString(8).padStart(width - 1, '0') + '\0';
  if (text.length !== width) throw new Error('tar field overflow');
  header.write(text, offset, width, 'ascii');
}
export function makeArchive(entries) {
  const chunks = [];
  let uncompressedBytes = 1024;
  const seen = new Set(); const directories = new Set();
  for (const entry of entries) {
    const path = safePath(entry.path);
    if (!(entry.bytes instanceof Uint8Array)) throw new Error('archive bytes must be binary data');
    uncompressedBytes += 512 + Math.ceil(entry.bytes.length / 512) * 512;
    if (uncompressedBytes > MAX_PORTABLE_UNCOMPRESSED_BYTES) throw new Error('portable archive exceeds the extraction size limit');
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
      // A ustar name may contain slashes. Deeply nested notices can fit its
      // two fields even when splitting at the final slash overflows prefix.
      let slash = path.lastIndexOf('/');
      while (slash > 0) {
        const candidatePrefix = path.slice(0, slash); const candidateName = path.slice(slash + 1);
        if (Buffer.byteLength(candidatePrefix) <= 155 && Buffer.byteLength(candidateName) <= 100) {
          prefix = candidatePrefix; name = candidateName; break;
        }
        slash = path.lastIndexOf('/', slash - 1);
      }
      if (slash < 1) throw new Error(`tar path too long: ${path}`);
    }
    const mode = portableMode(entry.mode ?? (entry.executable ? 0o755 : 0o644));
    if (entry.executable !== undefined && Boolean(entry.executable) !== (mode === 0o755)) throw new Error('conflicting archive executable mode');
    const header = Buffer.alloc(512);
    header.write(name, 0, 100); octal(header, 100, 8, mode);
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
  const raw = gunzipSync(archive, { maxOutputLength: MAX_PORTABLE_UNCOMPRESSED_BYTES });
  const entries = []; const seen = new Set(); const directories = new Set(); let offset = 0; let top; let terminated = false;
  const text = (buffer, start, length) => buffer.subarray(start, start + length).toString('latin1').replace(/\0.*$/s, '');
  const number = (header, start, width, label) => {
    const field = header.subarray(start, start + width).toString('latin1');
    if (!/^[0-7]+\0 ?$/.test(field)) throw new Error(`invalid tar ${label}`);
    const value = Number.parseInt(field, 8);
    if (!Number.isSafeInteger(value)) throw new Error(`invalid tar ${label}`);
    return value;
  };
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) {
      if (raw.length - offset < 512 || raw.subarray(offset).some(byte => byte !== 0)) throw new Error('invalid tar termination');
      terminated = true;
      break;
    }
    const supplied = number(header, 148, 8, 'checksum');
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (supplied !== actual || text(header, 257, 6) !== 'ustar' || text(header, 263, 2) !== '00' || text(header, 156, 1) !== '0') throw new Error('unsupported or corrupt tar header');
    const mode = number(header, 100, 8, 'mode');
    if (![0o644, 0o755].includes(mode)) throw new Error('invalid tar mode');
    if (number(header, 108, 8, 'owner') !== 0) throw new Error('invalid tar owner');
    if (number(header, 116, 8, 'group') !== 0) throw new Error('invalid tar group');
    if (number(header, 136, 12, 'timestamp') !== 0) throw new Error('invalid tar timestamp');
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
    const size = number(header, 124, 12, 'size');
    if (!Number.isSafeInteger(size) || offset + size > raw.length) throw new Error('truncated portable archive');
    entries.push({ path, bytes: raw.subarray(offset, offset + size), mode });
    const end = offset + Math.ceil(size / 512) * 512;
    if (end > raw.length || raw.subarray(offset + size, end).some(byte => byte !== 0)) throw new Error('invalid tar padding');
    offset += Math.ceil(size / 512) * 512;
  }
  if (entries.length === 0 || offset > raw.length || !top || !terminated) throw new Error('empty or truncated portable archive');
  const manifestEntry = entries.find(entry => entry.path === `${top}/PORTABLE-MANIFEST.json`);
  if (manifestEntry) {
    const manifest = JSON.parse(manifestEntry.bytes.toString('utf8'));
    const paths = manifestPaths(manifest);
    if (`harness-agent-${manifest.version}` !== top) throw new Error('archive root and manifest version differ');
    if (manifest.schemaVersion === 2) {
      if (manifestEntry.mode !== 0o644) throw new Error('portable mode mismatch: PORTABLE-MANIFEST.json');
      for (const entry of entries) {
        if (entry === manifestEntry) continue;
        const path = entry.path.slice(top.length + 1); const item = paths.get(path);
        if (!item) throw new Error(`portable contains undeclared file: ${path}`);
        if (entry.mode !== item.mode) throw new Error(`portable mode mismatch: ${path}`);
        if (entry.bytes.length !== item.bytes || digest(entry.bytes) !== item.sha256) throw new Error(`portable digest mismatch: ${path}`);
      }
      if (entries.length !== paths.size + 1) throw new Error('portable contains missing declared files');
    }
  }
  const target = resolve(destination);
  for (const entry of entries) {
    const path = resolve(target, ...entry.path.split('/'));
    if (!path.startsWith(target + sep)) throw new Error('archive path escapes destination');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, entry.bytes, { flag: 'wx', mode: entry.mode });
    await chmod(path, entry.mode); // Explicit chmod prevents a restrictive umask dropping execute/read bits.
  }
  return join(target, top);
}
