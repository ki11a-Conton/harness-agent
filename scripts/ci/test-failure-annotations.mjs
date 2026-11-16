import { inspect } from 'node:util';

// Pair with the normal spec reporter. Preserve Node's actual exit status and
// full log while exposing bounded failures through the Checks API as well.
export default async function* failureAnnotations(events) {
  let published = 0;
  const escape = text => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  for await (const event of events) {
    if (event.type === 'test:summary' && event.data.file === undefined) {
      yield `::notice title=Native preflight result::${escape(JSON.stringify({
        sourceSha: process.env.GITHUB_SHA ?? null, platform: process.platform, nodeVersion: process.version,
        counts: event.data.counts, success: event.data.success,
      }))}\n`;
      continue;
    }
    if (event.type !== 'test:fail' || published >= 6) continue;
    const error = event.data.details?.error;
    if (error?.failureType === 'subtestsFailed') continue;
    const detail = {
      name: String(event.data.name ?? ''), file: String(event.data.file ?? ''),
      failure: inspect(error?.cause ?? error, { depth: 6, colors: false, maxStringLength: 12000 }),
    };
    while (Buffer.byteLength(escape(JSON.stringify(detail)), 'utf8') >= 3500) {
      const field = ['name', 'file', 'failure'].reduce((a, b) => detail[a].length >= detail[b].length ? a : b);
      detail[field] = detail[field].slice(0, Math.floor(detail[field].length * 0.75));
      detail.truncated = true;
    }
    published++;
    yield `::error title=Native preflight failure ${published}::${escape(JSON.stringify(detail))}\n`;
  }
}
