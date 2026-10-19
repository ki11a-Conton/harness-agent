import { DataDirLeaseError } from '@ar/cli';

type Close = () => Promise<void>;

/** Allocate the complete lease-dependent setup before business assertions.
 * A unique path need not have free deterministic TCP anchors. Retry only a
 * genuine busy lease, drain only this attempt's resources, and never change
 * the production lease protocol or retry arbitrary test failures. */
export async function allocateAvailableLeaseFixture<T>(prepare: () => Promise<T>, cleanup: Close[]): Promise<T> {
  let last: DataDirLeaseError | undefined;
  for (let attempt = 0; attempt < 16; attempt++) {
    const mark = cleanup.length;
    try { return await prepare(); }
    catch (error) {
      const failures: unknown[] = [];
      for (const close of cleanup.splice(mark).reverse()) {
        try { await close(); } catch (failure) { failures.push(failure); }
      }
      if (failures.length) throw new AggregateError([error, ...failures], 'Lease fixture cleanup failed; allocation cannot continue');
      if (!(error instanceof DataDirLeaseError) || error.code !== 'HARNESS_DATA_DIR_IN_USE') throw error;
      last = error;
    }
  }
  throw new Error('Unable to allocate a complete owner fixture after 16 busy lease refusals', { cause: last });
}
