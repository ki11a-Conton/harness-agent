import { createServer, type Server } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acquireDataDirLease, type DataDirLease } from './data-dir-lease.js';

type Candidate = { root: string; ready: Promise<string>; server: Server; lease?: DataDirLease };
const { prepareFreshFixture, readFixtureDirectory, rememberFixtureDirectory } = await import(new URL('../../../scripts/research/fixture-availability.mjs', import.meta.url).href) as {
  prepareFreshFixture(options: { create(index: number): Promise<Candidate>; prepare(candidate: Candidate, origin: string): Promise<void>; dispose(candidate: Candidate): Promise<void>; attempts?: number }): Promise<{ candidate: Candidate; rejected: unknown[] }>;
  readFixtureDirectory(root: string): Promise<string | undefined>;
  rememberFixtureDirectory(root: string, directory: string): Promise<void>;
};
const close = (server: Server) => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
async function heldDirectory() {
  for (let index = 0; index < 16; index++) {
    const root = await mkdtemp(join(tmpdir(), 'installed-fixture-holder-'));
    try { return { root, lease: (await acquireDataDirLease(root))! }; }
    catch (error) {
      await rm(root, { recursive: true, force: true });
      if (!/^HARNESS_DATA_DIR_(IN_USE|LEASE_FAILED):/.test((error as Error).message)) throw error;
    }
  }
  throw new Error('Unable to allocate the controlled lease holder');
}

it('a real busy directory is rejected and the first fixture listener closes before a fresh owner is allocated', async () => {
  const held = await heldDirectory(), roots: string[] = [], created: Candidate[] = [];
  let selected: Candidate | undefined;
  try {
    const result = await prepareFreshFixture({
      create: async index => {
        if (index > 0) expect(created.at(-1)!.server.listening).toBe(false);
        const root = index === 0 ? held.root : await mkdtemp(join(tmpdir(), 'installed-fixture-free-'));
        if (index > 0) roots.push(root);
        const server = createServer(socket => socket.destroy());
        const ready = new Promise<string>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => done('ready')); });
        const candidate = { root, server, ready }; created.push(candidate); return candidate;
      },
      prepare: async candidate => { candidate.lease = await acquireDataDirLease(candidate.root); },
      dispose: async candidate => { await candidate.lease?.release(); await close(candidate.server); },
    });
    selected = result.candidate;
    expect(selected.root).not.toBe(held.root); expect(selected.server.listening).toBe(true);
    expect(result.rejected.length).toBeGreaterThanOrEqual(1);
    await expect(acquireDataDirLease(held.root)).rejects.toMatchObject({ code: 'HARNESS_DATA_DIR_IN_USE' });
  } finally {
    if (selected) { await selected.lease?.release(); await close(selected.server); }
    await held.lease.release();
    await Promise.all([held.root, ...roots].map(root => rm(root, { recursive: true, force: true })));
  }
});

it('a non-lease preparation failure is never retried and retains a simultaneous disposal failure', async () => {
  const server = createServer(), primary = new Error('session protocol is invalid'), secondary = new Error('cleanup failed');
  let count = 0;
  const result = await prepareFreshFixture({ create: async () => { count++; return { root: '', ready: Promise.resolve('ready'), server }; },
    prepare: async () => { throw primary; }, dispose: async () => { throw secondary; },
  }).catch(error => error);
  expect(result).toBeInstanceOf(AggregateError); expect(result.errors).toEqual([primary, secondary]); expect(count).toBe(1);
});

it('an ordinary RPC error is returned unchanged after disposal, without retrying assertions', async () => {
  const server = createServer(), primary = new Error('gateway/internal: unrelated command failed'); let count = 0, disposed = false;
  await expect(prepareFreshFixture({ create: async () => { count++; return { root: '', ready: Promise.resolve('ready'), server }; },
    prepare: async () => { throw primary; }, dispose: async () => { disposed = true; },
  })).rejects.toBe(primary);
  expect(count).toBe(1); expect(disposed).toBe(true);
});

it('the selected fresh directory remains authoritative on restart and malformed records never reset history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fixture-root-record-'));
  try {
    await mkdir(join(root, 'evidence')); const directory = await mkdtemp(join(root, 'availability-'));
    expect(await readFixtureDirectory(root)).toBeUndefined();
    await rememberFixtureDirectory(root, directory);
    expect(await readFixtureDirectory(root)).toBe(directory);
    await writeFile(join(root, 'evidence/fixture-root.json'), JSON.stringify({ schemaVersion: 1, directory: '../other' }));
    await expect(readFixtureDirectory(root)).rejects.toThrow(/Invalid fixture directory record/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
