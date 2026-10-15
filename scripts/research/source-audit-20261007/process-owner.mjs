import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireDataDirLease } from '../../../apps/cli/dist/data-dir-lease.js';

/** A process can exit before its inherited pipes close. Register before any
 * signal, and retain ownership until both the process and stdio are closed. */
export function ownChildProcess(child) {
  let closed = false, stopping;
  const done = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
  // The startup caller reports spawn errors; cleanup must still observe close.
  child.on('error', () => {});
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  async function waitClose(milliseconds) {
    let timer;
    try {
      return await Promise.race([done.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]);
    } finally { clearTimeout(timer); }
  }
  return { child, done, get closed() { return closed; },
    stop({ force = false, timeoutMs = 5000 } = {}) {
      if (closed) return Promise.resolve();
      return stopping ??= (async () => {
        if (!exited()) child.kill(force ? 'SIGKILL' : 'SIGTERM');
        if (await waitClose(timeoutMs)) return;
        if (!exited()) child.kill('SIGKILL');
        if (!await waitClose(timeoutMs)) throw new Error('Child process or inherited stdio did not close after forced shutdown');
        if (!force) throw new Error('Graceful shutdown timed out; child closed after SIGKILL');
      })();
    },
  };
}

/** Select a fresh fixture directory before any application state/input exists.
 * The actual fixed-port lease is acquired and released; its policy is intact. */
export async function createAuditWorkspace({ prefix = 'harness-web-audit-', makeRoot = () => mkdtemp(join(tmpdir(), prefix)), attempts = 16 } = {}) {
  let last;
  for (let index = 0; index < attempts; index++) {
    const root = await makeRoot();
    try {
      const lease = await acquireDataDirLease(join(root, 'data'));
      if (lease === undefined) throw new Error('Fixture directory has no ownership lease');
      await lease.release(); return root;
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      const conflict = error?.code === 'HARNESS_DATA_DIR_IN_USE'
        || (error?.code === 'HARNESS_DATA_DIR_LEASE_FAILED' && ['EACCES', 'EADDRINUSE'].includes(error?.cause?.code));
      if (!conflict) throw error;
      last = error;
    }
  }
  throw new Error('Unable to allocate an unused Web acceptance directory', { cause: last });
}

export async function finishAudit(processes, root, primaryError) {
  let cleanupError;
  try {
    const results = await Promise.allSettled(processes.map(owner => owner.stop({ force: true })));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Web acceptance processes did not close');
    await rm(root, { recursive: true, force: true });
  } catch (error) { cleanupError = error; }
  if (primaryError !== undefined && cleanupError !== undefined) throw new AggregateError([primaryError, cleanupError], 'Web acceptance and cleanup both failed');
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
}
