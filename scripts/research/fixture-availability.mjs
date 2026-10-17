import { readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

function fixtureSlot(root, directory) {
  const slot = relative(resolve(root), resolve(directory)) || '.';
  if (slot !== '.' && !/^availability-[A-Za-z0-9]{6,32}$/.test(slot)) throw new Error('Invalid fixture directory record');
  return slot;
}
export async function readFixtureDirectory(root) {
  let value;
  try { value = JSON.parse(await readFile(resolve(root, 'evidence/fixture-root.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // An older fixture already exposed to a browser owns history too. It must
    // keep its original directory rather than qualify for fresh allocation.
    try { await readFile(resolve(root, 'evidence/launch.json')); return resolve(root); }
    catch (previous) { if (previous.code !== 'ENOENT') throw previous; return undefined; }
  }
  if (value?.schemaVersion !== 1 || typeof value.directory !== 'string') throw new Error('Invalid fixture directory record');
  const directory = resolve(root, value.directory);
  if (fixtureSlot(root, directory) !== value.directory) throw new Error('Invalid fixture directory record');
  const inside = relative(await realpath(root), await realpath(directory));
  if (inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) throw new Error('Fixture directory escapes its allocation root');
  return directory;
}
export async function rememberFixtureDirectory(root, directory) {
  await writeFile(resolve(root, 'evidence/fixture-root.json'), JSON.stringify({ schemaVersion: 1, directory: fixtureSlot(root, directory) }) + '\n');
}

/** Choose a fresh acceptance fixture before any browser/business assertions.
 * Ownership must be drained before trying another candidate; other failures
 * retain their original meaning and are never retried. No ports are changed. */
export async function prepareFreshFixture({ create, prepare, dispose, attempts = 16 }) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 16) throw new RangeError('Invalid fixture allocation bound');
  const rejected = [];
  for (let index = 0; index < attempts; index++) {
    const candidate = await create(index);
    try {
      const origin = await candidate.ready;
      await prepare(candidate, origin);
      return { candidate, origin, rejected };
    } catch (primary) {
      try { await dispose(candidate); }
      catch (cleanup) { throw new AggregateError([primary, cleanup], 'Fixture preparation and disposal both failed'); }
      if (!/^HARNESS_DATA_DIR_IN_USE:/.test(primary?.message ?? '')) throw primary;
      rejected.push({ index, root: candidate.root, error: primary.message });
      if (index + 1 === attempts) throw new Error('Unable to allocate a fresh available acceptance fixture', { cause: primary });
    }
  }
}
