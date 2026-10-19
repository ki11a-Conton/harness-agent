import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { acquireDataDirLease, type DataDirLease } from '@ar/cli';
import { allocateAvailableLeaseFixture } from './test-support/lease-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function directory() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owner-admission-')));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 8 : 0, retryDelay: 50 }));
  return root;
}
async function heldOwner() {
  return allocateAvailableLeaseFixture(async () => {
    const root = await directory(); const path = join(root, 'data', 'deepseek', 'owners', 'child');
    const held = await acquireDataDirLease(path); if (!held) throw new Error('Expected a persistent child lease');
    cleanup.push(() => held.release()); return { root, path, held };
  }, cleanup);
}

it('a busy derived owner replaces the complete fixture before assertions and leaves the genuine blocker locked', async () => {
  const blocker = await heldOwner(); const marker = join(blocker.path, 'existing-store.json'); await writeFile(marker, 'retained');
  let allocations = 0; const probes: ReturnType<typeof createServer>[] = []; let admitted: DataDirLease | undefined;
  const fresh = await allocateAvailableLeaseFixture(async () => {
    allocations++;
    const probe = createServer(); await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    probes.push(probe); cleanup.push(() => new Promise<void>((resolve, reject) => probe.close(e => e ? reject(e) : resolve())));
    const root = allocations === 1 ? blocker.root : await directory();
    const path = join(root, 'data', 'deepseek', 'owners', 'child');
    admitted = await acquireDataDirLease(path); if (!admitted) throw new Error('Expected child lease');
    const own = admitted; cleanup.push(() => own.release()); return { root, path };
  }, cleanup);
  expect(allocations).toBeGreaterThanOrEqual(2); expect(fresh.root).not.toBe(blocker.root);
  expect(probes.slice(0, -1).every(probe => !probe.listening)).toBe(true); expect(probes.at(-1)!.listening).toBe(true);
  await expect(acquireDataDirLease(blocker.path)).rejects.toMatchObject({ code: 'HARNESS_DATA_DIR_IN_USE' });
  await expect(acquireDataDirLease(fresh.path)).rejects.toMatchObject({ code: 'HARNESS_DATA_DIR_IN_USE' });
  expect(await readFile(marker, 'utf8')).toBe('retained');
});

it('complete owner fixture admission remains bounded when every derived lease is occupied', async () => {
  const blocker = await heldOwner(); let attempts = 0; let closed = 0;
  const result = allocateAvailableLeaseFixture(async () => {
    attempts++; cleanup.push(async () => { closed++; }); await acquireDataDirLease(blocker.path);
  }, cleanup);
  await expect(result).rejects.toThrow('after 16 busy lease refusals');
  expect(attempts).toBe(16); expect(closed).toBe(16);
  await expect(acquireDataDirLease(blocker.path)).rejects.toMatchObject({ code: 'HARNESS_DATA_DIR_IN_USE' });
});

it('non-busy owner preparation failures propagate after cleanup without reallocating', async () => {
  const root = await directory(); const file = join(root, 'ordinary-file'); await writeFile(file, 'unchanged'); let attempts = 0; let closed = 0;
  await expect(allocateAvailableLeaseFixture(async () => {
    attempts++; cleanup.push(async () => { closed++; }); await mkdir(join(file, 'not-a-directory'));
  }, cleanup)).rejects.toThrow();
  expect(attempts).toBe(1); expect(closed).toBe(1); expect(await readFile(file, 'utf8')).toBe('unchanged');
});

it('an assertion-shaped error with a copied busy code is never retried as lease contention', async () => {
  const failure = Object.assign(new Error('business assertion failed'), { code: 'HARNESS_DATA_DIR_IN_USE' }); let attempts = 0;
  await expect(allocateAvailableLeaseFixture(async () => { attempts++; throw failure; }, cleanup)).rejects.toBe(failure);
  expect(attempts).toBe(1);
});

it('failed owner fixture cleanup drains all resources and prevents another allocation', async () => {
  const blocker = await heldOwner(); const failure = new Error('cleanup failed'); let attempts = 0; let drained = 0;
  await expect(allocateAvailableLeaseFixture(async () => {
    attempts++; cleanup.push(async () => { drained++; }); cleanup.push(async () => { throw failure; }); await acquireDataDirLease(blocker.path);
  }, cleanup)).rejects.toThrow('cleanup failed');
  expect(attempts).toBe(1); expect(drained).toBe(1);
  await expect(acquireDataDirLease(blocker.path)).rejects.toMatchObject({ code: 'HARNESS_DATA_DIR_IN_USE' });
});
