import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { HierarchicalInstructionDiscovery, PathScopedInstructionDiscovery } from '../../../packages/context/dist/index.js';

const artifacts = new URL('./', import.meta.url);
const reportName = process.argv[2] ?? 'baseline-v3.json';
try { await fs.access(new URL(reportName, artifacts)); throw new Error(`Refusing existing report ${reportName}`); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
const roots = [];
const results = [];
async function fixture(bytes) {
  const root = await fs.mkdtemp(join(tmpdir(), 'ar-path-read-audit-'));
  roots.push(root);
  await fs.writeFile(join(root, 'AGENTS.md'), bytes);
  await fs.mkdir(join(root, 'nested'));
  await fs.writeFile(join(root, 'nested/AGENTS.md'), 'nested regular control');
  await fs.writeFile(join(root, 'nested/file.txt'), 'target');
  return root;
}
function ctor(root, mode) {
  return mode === 'default' ? new HierarchicalInstructionDiscovery() : new PathScopedInstructionDiscovery({ workspaceRoot: root, targets: () => ['nested/file.txt'] });
}
async function observe(id, bytes, cap, decorate) {
  const modes = {};
  for (const mode of ['default', 'path-scoped']) {
    const root = await fixture(bytes);
    const original = fs.open;
    const flags = [];
    let closes = 0;
    let reads = 0;
    let guardedBlockingOpen = false;
    let nativeFifoOpened = false;
    fs.open = async (path, ...args) => {
      if (String(path) === join(root, 'AGENTS.md') && decorate === 'fifo-race') {
        flags.push(args[0]);
        await fs.rm(path);
        execFileSync('mkfifo', [String(path)]);
        if ((args[0] & constants.O_NONBLOCK) === 0) {
          guardedBlockingOpen = true;
          throw Object.assign(new Error('audit prevented a blocking read-only FIFO open without a writer'), { code: 'AUDIT_BLOCKING_OPEN_GUARD' });
        }
      }
      const handle = await original(path, ...args);
      if (String(path) === join(root, 'AGENTS.md')) {
        if (decorate !== 'fifo-race') flags.push(args[0]);
        else nativeFifoOpened = !(await handle.stat()).isFile();
        if (decorate === 'close-error') {
          const close = handle.close.bind(handle);
          handle.close = async () => { await close(); closes++; throw Object.assign(new Error('injected cleanup EIO after actual close'), { code: 'EIO' }); };
        } else if (decorate === 'zero-read') {
          handle.read = async buffer => { reads++; return { bytesRead: 0, buffer }; };
        }
      }
      return handle;
    };
    syncBuiltinESMExports();
    try {
      const adapter = ctor(root, mode);
      const docs = await adapter.discover(root, { maxBytesPerFile: cap });
      const repeated = decorate === 'zero-read' ? await adapter.discover(root, { maxBytesPerFile: cap }) : undefined;
      modes[mode] = { status: 'resolved', docs: docs.map(doc => ({ path: doc.path.replace(root, '<root>'), content: doc.content, contentBytes: Buffer.byteLength(doc.content), sourceBytes: doc.sizeBytes, truncated: doc.truncated })), flags, nonblocking: flags.every(value => (value & constants.O_NONBLOCK) !== 0), closes, reads, guardedBlockingOpen, nativeFifoOpened, ...(repeated !== undefined ? { repeatedDocs: repeated.map(doc => ({ path: doc.path.replace(root, '<root>'), content: doc.content })), cacheHits: adapter.metrics?.cacheHits } : {}) };
    } catch (err) {
      modes[mode] = { status: 'rejected', error: String(err), code: err?.code, flags, closes, reads };
    } finally {
      fs.open = original;
      syncBuiltinESMExports();
    }
  }
  results.push({ id, inputHex: bytes.toString('hex'), cap, decorate, modes });
}

try {
  await observe('single-invalid-byte-cap1', Buffer.from([0xff]), 1);
  await observe('invalid-three-byte-cap3', Buffer.from([0xe2, 0x28, 0xa1]), 3);
  await observe('truncated-invalid-prefix-cap1', Buffer.alloc(100, 0xff), 1);
  await observe('invalid-root-control-cap100', Buffer.from([0xff]), 100);
  await observe('close-error-isolation', Buffer.from('root regular control'), 100, 'close-error');
  await observe('zero-read-incomplete-capture', Buffer.from('root regular control'), 100, 'zero-read');
  await observe('regular-positive-control', Buffer.from('root regular control'), 100);
  await observe('regular-to-fifo-race-with-native-open-guard', Buffer.from('root regular control'), 100, 'fifo-race');
  const report = {
    sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceFileSha256: createHash('sha256').update(await fs.readFile('packages/context/src/path-scoped-discovery.ts')).digest('hex'),
    node: process.version,
    productionRoute: 'HarnessConfig.instructionDiscovery -> composeContext -> PathScopedContextPipeline -> PathScopedInstructionDiscovery; absent by default',
    results,
    expected: {
      malformed: 'Malformed UTF-8 must never expand content beyond maxBytesPerFile; fail-closed omit malformed document and keep readable controls.',
      cleanup: 'A real descriptor cleanup failure must not suppress unrelated readable instruction documents.',
      incompleteCapture: 'A zero-byte incomplete capture must be omitted rather than admitted under original source metadata.',
    },
    summary: {
      pathScopedCap1Expansion: results[0].modes['path-scoped'].docs[0].contentBytes,
      pathScopedCloseRejects: results[4].modes['path-scoped'].status === 'rejected',
      pathScopedAdmitsIncompleteCapture: results[5].modes['path-scoped'].docs.some(doc => doc.path === '<root>/AGENTS.md' && doc.content === '' && doc.sourceBytes > 0),
      defaultControlsPass: results[3].modes.default.docs.some(doc => doc.content === 'nested regular control') && results[4].modes.default.docs.some(doc => doc.content === 'nested regular control') && results[5].modes.default.docs.every(doc => doc.path !== '<root>/AGENTS.md'),
    },
    limits: 'FIFO control uses a real regular-to-FIFO replacement, but native open is guarded before invocation whenever O_NONBLOCK is missing. Default safely performs a native nonblocking FIFO open and rejects the type. No baseline process allowed to hang; no runtime or tracked files modified.',
  };
  await fs.writeFile(new URL(reportName, artifacts), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify(report.summary) + '\n');
} finally {
  await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
}
