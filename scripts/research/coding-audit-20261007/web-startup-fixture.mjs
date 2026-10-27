/** Only a real pre-listening process exit can trigger fresh fixture allocation.
 * Once a Web host has started, its persistence restart keeps the same data. */
export class WebStartupExit extends Error {
  constructor(result) {
    super(`Web exited before startup (code ${result.code}, signal ${result.signal}): ${result.stderr.slice(-4000) || '(no stderr)'}`);
    this.result = result;
  }
}

export async function allocateWebStartupFixture(launch, initial, next, allowFresh = false) {
  let dataDir = initial;
  for (let attempt = 0; attempt < (allowFresh ? 16 : 1); attempt++) {
    try { return { dataDir, address: await launch(dataDir) }; }
    catch (error) {
      const result = error instanceof WebStartupExit ? error.result : undefined;
      if (!allowFresh || !result || result.code !== 1 || result.signal !== null ||
          result.stdout.includes('listening on') || !result.stderr.split(/\r?\n/).some(line => line.startsWith('HARNESS_DATA_DIR_IN_USE:'))) throw error;
      if (attempt === 15) throw new Error('Unable to allocate an initial Web fixture after 16 busy lease refusals', { cause: error });
      dataDir = next(attempt + 1);
    }
  }
}
