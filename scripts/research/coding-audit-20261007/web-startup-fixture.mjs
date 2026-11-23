export class HostStartupExit extends Error {
  constructor(surface, result) {
    super(`${surface} exited before startup (code ${result.code}, signal ${result.signal}): ${result.stderr.slice(-4000) || '(no stderr)'}`);
    this.result = result;
  }
}

export class WebStartupExit extends HostStartupExit {
  constructor(result) { super('Web', result); }
}

/** A fresh fixture may change its directory only on a pre-start lease refusal. */
export async function allocateHostStartupFixture(launch, initial, next, allowFresh = false) {
  let dataDir = initial;
  for (let attempt = 0; attempt < (allowFresh ? 16 : 1); attempt++) {
    try { return { dataDir, value: await launch(dataDir) }; }
    catch (error) {
      const result = error instanceof HostStartupExit ? error.result : undefined;
      if (!allowFresh || !result || result.code !== 1 || result.signal !== null ||
          result.stdout.includes('listening on') || !result.stderr.split(/\r?\n/).some(line => line.startsWith('HARNESS_DATA_DIR_IN_USE:'))) throw error;
      if (attempt === 15) throw new Error('Unable to allocate an initial host fixture after 16 busy lease refusals', { cause: error });
      dataDir = next(attempt + 1);
    }
  }
}

export async function allocateWebStartupFixture(launch, initial, next, allowFresh = false) {
  const { dataDir, value: address } = await allocateHostStartupFixture(launch, initial, next, allowFresh);
  return { dataDir, address };
}
