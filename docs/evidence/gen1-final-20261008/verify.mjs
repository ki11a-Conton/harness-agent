#!/usr/bin/env node
// Offline, read-only evidence verifier. Hash consistency is not a remote
// signature: raw API snapshots remain supplied evidence; no network is used.
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const SHA = 'c5bbe61fef101a8c9eb10edab673be8b2e0935e3';
const TREE = '603f7cc88a3ac8b3897c296b70eef4df1133132b';
const HASH = 'f7006e6c22655d35576bbb800870bda792cfb0df4834fc9405dd55f30e9a278b';
const REPO = 'ki11a-Conton/harness-agent';
const ARCHIVE = 'harness-agent-1.9.0-portable.tar.gz';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const must = (condition, message) => { if (!condition) throw new Error(message); };
const safe = path => typeof path === 'string' && path && !path.includes('\\') && !path.includes('\0')
  && !path.includes(':') && !path.startsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..'
    && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
const norm = path => String(path).replace(/\\/g, '/');
const parse = bytes => JSON.parse(bytes.toString('utf8'));

// Parse validated regular-file ustar entries in memory; never extract or execute.
function tar(gzip) {
  const raw = gunzipSync(gzip, { maxOutputLength: 128 * 1024 * 1024 });
  const files = new Map(); const cases = new Set(); const directories = new Set();
  const text = (header, from, size) => header.subarray(from, from + size).toString('ascii').replace(/\0.*$/s, '');
  let offset = 0; let ended = false;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) {
      must(raw.length - offset >= 512 && raw.subarray(offset).every(byte => byte === 0), 'invalid tar termination'); ended = true; break;
    }
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    must(checksum === parseInt(text(header, 148, 8).trim(), 8) && text(header, 257, 6) === 'ustar'
      && text(header, 156, 1) === '0', 'unsafe/corrupt/nonregular tar entry');
    const prefix = text(header, 345, 155); const name = text(header, 0, 100);
    const path = prefix ? `${prefix}/${name}` : name; const lower = path.toLowerCase();
    must(safe(path) && !cases.has(lower) && !directories.has(lower), 'unsafe/duplicate tar path');
    const parts = lower.split('/');
    for (let i = 1; i < parts.length; i++) { const parent = parts.slice(0, i).join('/'); must(!cases.has(parent), 'tar file/directory collision'); directories.add(parent); }
    cases.add(lower);
    const octal = text(header, 124, 12).trim(); must(/^[0-7]+$/.test(octal), 'invalid tar size');
    const size = parseInt(octal, 8); const padded = Math.ceil(size / 512) * 512;
    must(Number.isSafeInteger(size) && size >= 0 && offset + padded <= raw.length && files.size < 10000, 'truncated/oversized tar');
    files.set(path, raw.subarray(offset, offset + size)); offset += padded;
  }
  must(ended && files.size > 0, 'empty/unterminated tar'); return files;
}

async function main() {
  must(process.argv.length <= 4, 'usage: node verify.mjs [archiveRoot] [portableArchive]');
  const root = resolve(process.argv[2] ?? dirname(fileURLToPath(import.meta.url)));
  must(!(await lstat(root)).isSymbolicLink() && await realpath(root) === root, 'archive root must be a real directory');
  async function regular(path) {
    must(safe(path), `unsafe archive path: ${path}`);
    let current = root;
    for (const part of path.split('/')) { current = resolve(current, part); must(!(await lstat(current)).isSymbolicLink(), `archive symlink: ${path}`); }
    const stat = await lstat(current); must(stat.isFile() && stat.size <= 64 * 1024 * 1024, `nonregular/oversized archive file: ${path}`);
    return readFile(current);
  }
  const manifest = parse(await regular('manifest.json'));
  must(manifest.schema === 'harness-gen1-final-acceptance-v1', 'unknown final evidence schema');
  must(manifest.testedSourceSha === SHA && manifest.testedSourceTree === TREE && manifest.archiveSha256 === HASH
    && manifest.releaseVersion === '1.9.0' && manifest.paidModelCalls === 0 && manifest.realModelQuality === 'NOT_PROVEN', 'wrong final source/distribution/quality identity');
  must(['STAGED_NOT_RELEASED', 'ACCEPTED_NOT_RELEASED', 'RELEASED'].includes(manifest.status), 'unknown release evidence status');
  must(Array.isArray(manifest.files) && manifest.files.length > 0, 'missing manifest files');
  const records = new Map(); const raw = new Map(); const decoded = new Map(); const originals = new Map(); const casePaths = new Set();
  for (const entry of manifest.files) {
    must(object(entry) && safe(entry.path) && !records.has(entry.path) && !casePaths.has(entry.path.toLowerCase())
      && /^[a-f0-9]{64}$/.test(entry.sha256) && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0
      && typeof entry.originalPath === 'string' && entry.originalPath, `invalid manifest entry: ${entry?.path}`);
    must(['fixed-source', 'ci-source', 'api-source', 'history', 'archive-tool'].includes(entry.provenance)
      && (!entry.path.startsWith('history/') || entry.provenance === 'history'), `incorrect history/provenance: ${entry.path}`);
    const bytes = await regular(entry.path); must(bytes.length === entry.bytes && hash(bytes) === entry.sha256, `file hash/length mismatch: ${entry.path}`);
    let content = bytes;
    if (entry.compression !== undefined) {
      must(entry.compression === 'gzip' && Number.isSafeInteger(entry.uncompressedBytes) && entry.uncompressedBytes <= 64 * 1024 * 1024
        && /^[a-f0-9]{64}$/.test(entry.uncompressedSha256), `unknown/unsafe compression metadata: ${entry.path}`);
      content = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 });
      must(content.length === entry.uncompressedBytes && hash(content) === entry.uncompressedSha256, `uncompressed hash mismatch: ${entry.path}`);
    }
    records.set(entry.path, entry); raw.set(entry.path, bytes); decoded.set(entry.path, content); casePaths.add(entry.path.toLowerCase());
    const original = norm(entry.originalPath); const matches = originals.get(original) ?? []; matches.push(entry.path); originals.set(original, matches);
  }
  async function walk(prefix = '') {
    for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      must(safe(path) && !entry.isSymbolicLink(), `unsafe extra archive path: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else must(entry.isFile() && (path === 'manifest.json' || records.has(path)), `unmanifested/nonregular file: ${path}`);
    }
  }
  await walk();
  const bytes = path => { must(decoded.has(path), `missing required evidence: ${path}`); return decoded.get(path); };
  const json = path => parse(bytes(path));
  const verifyRecord = (record, content, label) => must(object(record) && record.bytes === content.length
    && record.sha256 === hash(content), `receipt artifact digest mismatch: ${label}`);
  function referenced(record, parent) {
    must(object(record) && typeof record.path === 'string', `invalid receipt file reference: ${parent}`);
    const ref = norm(record.path);
    const directory = parent.slice(0, parent.lastIndexOf('/') + 1);
    for (const candidate of [directory + ref, directory + ref + '.gz']) {
      if (safe(candidate) && decoded.has(candidate)) { verifyRecord(record, bytes(candidate), candidate); return candidate; }
    }
    let candidates = [...originals].filter(([original]) => original === ref || original.endsWith(`/${ref}`)).flatMap(([, paths]) => paths);
    if (candidates.length > 1) candidates = candidates.filter(path => path.startsWith(directory));
    must(candidates.length === 1, `unresolved/ambiguous original receipt path: ${parent} -> ${ref}`);
    verifyRecord(record, bytes(candidates[0]), candidates[0]); return candidates[0];
  }
  function cleanCommand(path) {
    const receipt = json(path);
    must(receipt.schemaVersion === 1 && receipt.kind === 'fixed-source-command-result' && receipt.exitCode === 0
      && (receipt.cleanSource ?? receipt.sourceSha) === SHA && receipt.headBefore === SHA && receipt.headAfter === SHA
      && receipt.workingTreeBefore === '' && receipt.workingTreeAfter === '' && receipt.sourceVerifiedClean === true, `command source/exit/clean failed: ${path}`);
    must(Array.isArray(receipt.outputFiles) && receipt.outputFiles.length > 0, `missing raw command outputs: ${path}`);
    for (const output of receipt.outputFiles) referenced(output, path);
    return receipt;
  }
  for (const [scope, expectedPassed, expectedPending] of [['full', 9284, 14], ['security', 2143, 0], ['protocol', 52, 0]]) {
    const receipt = cleanCommand(`local/${scope}/result.json`); const result = json(`local/${scope}/vitest.json.gz`);
    must(result.success === true && result.numFailedTests === 0 && result.numPassedTests === expectedPassed
      && result.numPendingTests === expectedPending && result.numTotalTests === expectedPassed + expectedPending, `Vitest gate failed: ${scope}`);
    for (const key of ['success', 'numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests']) must(receipt.vitestSummary?.[key] === result[key], `Vitest receipt summary mismatch: ${scope}`);
    const assertions = result.testResults.flatMap(file => file.assertionResults);
    must(assertions.filter(test => test.status === 'passed').length === expectedPassed
      && assertions.filter(test => ['skipped', 'pending'].includes(test.status)).length === expectedPending
      && assertions.every(test => ['passed', 'skipped', 'pending'].includes(test.status)), `Vitest raw assertions mismatch: ${scope}`);
  }
  cleanCommand('local/docs/result.json'); cleanCommand('local/evidence/result.json');
  must(bytes('local/docs/run.log').toString('utf8').includes('ALL CHECKS PASS'), 'docs raw result did not pass');
  const product = json('local/product-commands.json');
  must(product.sourceSha === SHA && product.trackedDirtyAtEnd === false && product.paidModelCalls === 0
    && product.realModelQuality === 'NOT_PROVEN' && product.commands.length === 3, 'product command receipt invalid');
  const productReceipts = new Set();
  for (const command of product.commands) {
    must(command.exitCode === 0 && typeof command.command === 'string', 'product command failed');
    const candidates = [...records.values()].filter(entry => norm(entry.originalPath).endsWith('/' + norm(command.receipt)));
    must(candidates.length === 1, 'product receipt not uniquely archived');
    const path = candidates[0].path;
    must(!productReceipts.has(path) && ['local/interaction/result.json', 'local/host-lease/result.json', 'local/browser/browser-result.json'].includes(path), 'wrong/duplicate actual product command');
    productReceipts.add(path); must(hash(bytes(path)) === command.sha256, 'actual product command receipt hash mismatch');
  }
  function actual(path, count) {
    const result = json(path); must(result.status === 'PASS' && result.sourceSha === SHA && result.paidModelCalls === 0
      && result.realModelQuality === 'NOT_PROVEN' && result.cases.length === count && result.cases.every(item => item.passed === true), `actual product acceptance failed: ${path}`);
    if (result.assertionCount !== undefined) must(result.assertionCount === count, `actual assertion count differs: ${path}`);
    if (path.endsWith('/interaction/result.json')) {
      const prefix = path.slice(0, -'result.json'.length); const turns = json(prefix + 'web-turns.json'); const frames = json(prefix + 'web-frames.json');
      must(object(turns.first) && object(turns.restarted) && turns.first.sessionId === turns.restarted.sessionId
        && turns.first.turnId !== turns.restarted.turnId && turns.first.completionEventId !== turns.restarted.completionEventId, 'Web restart reused old terminal/session');
      for (const [tab, turn, reply] of [['firstTab', turns.first, 'Web first task completed.'], ['secondTab', turns.first, 'Web first task completed.'],
        ['restarted', turns.restarted, 'Web resumed task completed.']]) {
        must(typeof turn.turnId === 'string' && turn.turnId && typeof turn.sessionId === 'string' && turn.sessionId
          && typeof turn.completionEventId === 'string' && turn.completionEventId && Array.isArray(frames[tab])
          && frames[tab].some(frame => frame.type === 'assistant_text' && frame.turnId === turn.turnId && frame.text === reply)
          && frames[tab].some(frame => frame.event?.type === 'turn.completed' && frame.event.id === turn.completionEventId
            && frame.event.turnId === turn.turnId && frame.event.sessionId === turn.sessionId
            && frame.event.payload?.turnId === turn.turnId && frame.event.payload?.status === 'completed'), `raw SSE correlation failed: ${path}/${tab}`);
      }
    }
    return result;
  }
  actual('local/interaction/result.json', 24); actual('local/host-lease/result.json', 3);
  const browser = json('local/browser/browser-result.json');
  // browser.py counts four global checks outside the per-case 78 assertions:
  // clean startup, graceful shutdown, readable records, unchanged final source.
  must(browser.schema === 'web-dsh-browser.v1' && browser.status === 'PASS' && browser.requireCleanSource === true
    && browser.source?.sourceSha === SHA && browser.source?.trackedDirty === false && browser.cleanup?.finalSourceSha === SHA
    && browser.cleanup?.changedFingerprints?.length === 0 && browser.cleanup?.exitCode === 0 && browser.cleanup?.forcedKill === false
    && browser.caseCount === 29 && browser.assertCount === 82 && browser.passed === 29 && browser.failed === 0
    && browser.browserErrorCount === 0 && browser.paidCalls === 0 && browser.receipts.length === 29
    && browser.receipts.every(test => test.passed === true) && browser.receipts.reduce((sum, test) => sum + test.assertCount, 0) + 4 === 82, 'browser actual acceptance failed');
  const index = json('local/browser/artifact-index.json');
  must(index.schema === 'web-dsh-browser-artifacts.v1' && Array.isArray(index.artifacts) && index.artifacts.length > 0, 'unknown/empty browser artifact index');
  const browserPaths = new Set();
  for (const artifact of index.artifacts) { must(safe(artifact.path) && !browserPaths.has(artifact.path), 'unsafe/duplicate browser index'); browserPaths.add(artifact.path); verifyRecord(artifact, bytes('local/browser/' + artifact.path), artifact.path); }
  const node = json('local/node/result.json');
  must(node.sourceSha === SHA && node.sourceVerifiedClean === true && node.exitCode === 0 && node.status === 'PASS'
    && node.tests === 30 && node.passed === 30 && node.failed === 0, 'portable/exporter Node gate failed');
  referenced(node.log, 'local/node/result.json');
  const tap = bytes('local/node/run.tap').toString('utf8');
  for (const [key, value] of [['tests', 30], ['pass', 30], ['fail', 0], ['cancelled', 0], ['skipped', 0], ['todo', 0]])
    must(new RegExp(`^(?:#|ℹ) ${key} ${value}\\s*$`, 'm').test(tap), `Node raw TAP mismatch: ${key}`);

  const bundle = tar(bytes(`release/gen1-ci-bundle-${SHA}.tar.gz`));
  const bundleFile = path => { must(safe(path) && bundle.has('gen1-ci-bundle/' + path), `bundle file missing: ${path}`); return bundle.get('gen1-ci-bundle/' + path); };
  const exported = json('ci-data/export-receipt.json');
  must(bundleFile('export-receipt.json').equals(bytes('ci-data/export-receipt.json')), 'archived export receipt differs from source bundle');
  must(exported.schemaVersion === 1 && exported.kind === 'harness-agent-gen1-draft-ci-export' && exported.sourceSha === SHA
    && exported.repository === REPO && exported.status === 'PASS' && exported.formalAssetsEligible === true && exported.reasons.length === 0
    && exported.releaseDraft === true && exported.releaseId === 406478808 && exported.archiveSha256 === HASH
    && exported.realModelQuality === 'NOT_PROVEN' && exported.runAttempt === '3' && exported.files.length === 116, 'export source/attempt/eligibility failed');
  const exportPaths = new Set();
  for (const record of exported.files) {
    must(safe(record.path) && !exportPaths.has(record.path), 'duplicate/unsafe exported path'); exportPaths.add(record.path);
    const content = bundleFile(record.path); verifyRecord(record, content, record.path);
    if (decoded.has('ci-data/' + record.path)) must(bytes('ci-data/' + record.path).equals(content), `ci-data differs from original bundle: ${record.path}`);
    else must(['ubuntu', 'windows'].some(origin => record.path === `${origin}/assets/${ARCHIVE}`), `exported raw file not independently archived: ${record.path}`);
  }
  must(bundle.size === exported.files.length + 1, 'undeclared original bundle entries');
  const portableBytes = bundleFile('ubuntu/assets/' + ARCHIVE);
  must(hash(portableBytes) === HASH, 'formal Ubuntu archive hash mismatch');
  if (process.argv[3]) {
    const path = resolve(process.argv[3]); must(!(await lstat(path)).isSymbolicLink() && (await lstat(path)).isFile() && await realpath(path) === path
      && (await lstat(path)).size <= 64 * 1024 * 1024, 'optional portable archive not regular/physical/bounded');
    const external = await readFile(path); must(external.equals(portableBytes), 'optional portable archive differs from published candidate bytes');
  }
  const build = json('release/BUILD-RECEIPT.json');
  must(bytes('release/BUILD-RECEIPT.json').equals(bundleFile('ubuntu/assets/BUILD-RECEIPT.json'))
    && build.sourceSha === SHA && build.sourceTree === TREE && build.version === '1.9.0' && build.sha256 === HASH
    && build.filename === ARCHIVE && bytes('release/SHA256SUMS').toString('utf8') === `${HASH}  ${ARCHIVE}\n`, 'release build/checksum identity mismatch');
  const portable = tar(portableBytes); const prefix = 'harness-agent-1.9.0/';
  const portableManifest = parse(portable.get(prefix + 'PORTABLE-MANIFEST.json'));
  must(portableManifest.schemaVersion === 1 && portableManifest.kind === 'harness-agent-portable' && portableManifest.sourceSha === SHA
    && portableManifest.sourceTree === TREE && portableManifest.version === '1.9.0' && portableManifest.files.length === 1621, 'portable internal identity failed');
  const portablePaths = new Set();
  for (const record of portableManifest.files) { must(safe(record.path) && !portablePaths.has(record.path), 'invalid portable manifest path'); portablePaths.add(record.path); must(portable.has(prefix + record.path), 'missing portable payload'); verifyRecord(record, portable.get(prefix + record.path), record.path); }
  must(portable.size === portableManifest.files.length + 1, 'undeclared portable payload');
  function distributed(path, platform, archiveHash) {
    const receipt = json(path);
    must(receipt.schemaVersion === 1 && receipt.kind === 'harness-agent-portable-cleanroom' && receipt.status === 'PASS'
      && receipt.sourceSha === SHA && receipt.sourceTree === TREE && receipt.archiveSha256 === archiveHash && receipt.version === '1.9.0'
      && receipt.platform === platform && receipt.cleanroomOutsideRepository === true && receipt.workspaceLinks === 0 && receipt.doctorErrors === 0
      && receipt.tamperRejected === true && receipt.tamperedStartupRejected === true && receipt.paidModelCalls === 0
      && receipt.realModelQuality === 'NOT_PROVEN' && receipt.codingAssertions === (platform === 'linux' ? 50 : 49), `distributed consumer failed: ${path}`);
  }
  distributed('local/distributed/result.json', 'linux', HASH);
  distributed('ci-data/ubuntu/installed/result.json', 'linux', HASH);
  distributed('ci-data/same-archive-windows/result.json', 'win32', HASH);
  const windowsHash = hash(bundleFile('windows/assets/' + ARCHIVE));
  distributed('ci-data/windows/installed/result.json', 'win32', windowsHash);
  const stages = ['portable unit/security', 'real multi-turn interaction', 'actual product host ownership', 'fixed-source portable build', 'installed coding and tamper controls'];
  for (const [origin, platform, count] of [['ubuntu', 'linux', 24], ['windows', 'win32', 23]]) {
    const result = json(`ci-data/${origin}/result.json`);
    must(result.status === 'PASS' && result.sourceSha === SHA && result.platform === platform && result.paidModelCalls === 0
      && result.realModelQuality === 'NOT_PROVEN' && result.steps.length === 5, `installed CI stages invalid: ${origin}`);
    for (const [i, step] of result.steps.entries()) {
      must(step.name === stages[i] && step.exitCode === 0 && step.error === null, `installed real stage failed: ${origin}`);
      for (const record of [step.stdoutLog, step.stderrLog]) { must(record.path.startsWith('.ci/gen1/') && safe(record.path), 'unsafe CI log path'); verifyRecord(record, bytes(`ci-data/${origin}/${record.path.slice('.ci/gen1/'.length)}`), record.path); }
    }
    actual(`ci-data/${origin}/interaction/result.json`, count); actual(`ci-data/${origin}/host-lease/result.json`, 3);
  }

  // This independent final gate intentionally refuses partial CI, even when
  // local tests or the separate installed workflow have already passed.
  function ci(name, workflow, expectedJobs) {
    const run = json(`ci/${name}-run.json`);
    must(run.head_sha === SHA && run.head_commit?.id === SHA && run.head_commit?.tree_id === TREE
      && run.repository?.full_name === REPO && run.path === `.github/workflows/${workflow}`
      && run.status === 'completed' && run.conclusion === 'success', `CI_${name}_NOT_COMPLETED_SUCCESS`);
    const listing = json(`ci/${name}-jobs.json`);
    must(listing.total_count === expectedJobs && listing.jobs.length === expectedJobs, `CI_${name}_JOB_SET_INCOMPLETE`);
    const ids = new Set(); const names = new Set();
    for (const job of listing.jobs) {
      must(!ids.has(job.id) && !names.has(job.name), `duplicate CI job: ${name}`); ids.add(job.id); names.add(job.name);
      must(job.run_id === run.id && job.run_attempt === run.run_attempt && job.head_sha === SHA
        && job.status === 'completed' && job.conclusion === 'success' && job.steps.length > 0
        && job.steps.every(step => step.status === 'completed' && ['success', 'skipped'].includes(step.conclusion)), `CI_${name}_JOB_NOT_SUCCESS`);
    }
    return { run, jobs: listing.jobs };
  }
  const main = ci('main', 'ci.yml', 10);
  const installed = ci('installed', 'gen1-acceptance.yml', 4);
  const native = ci('native-windows', 'windows-acceptance.yml', 1);
  // Counting successful jobs alone cannot prove that the required reducers
  // actually ran. Bind this archive to all ten jobs of the tested workflow,
  // including the two dependent final verdict gates, and refuse skipped work.
  const mainRequired = new Map([
    ['offline cold-start (ubuntu)', ['Assert the tested HEAD is the workflow SHA', 'Assert this is a genuine cold start (no node_modules, no dist)',
      'README step 1 — install (frozen lockfile)', 'README step 2 — build', 'README step 3 — doctor',
      'Machine-check the artifacts (not just exit codes)', 'Linux oracle — the REAL TaskVerifier on the frozen baseline']],
    ['coverage gate (ubuntu)', ['Coverage gate (thresholds fail the job)', 'Generate coverage gate evidence (P38-12, E4-R09 V2)']],
    ['dual-platform acceptance (same SHA)', ['Download ubuntu readiness leg', 'Download windows readiness leg',
      'Reduce both legs to one same-SHA verdict', 'Upload dual-platform verdict (always)']],
    ['release attestation (P38-12)', ['Download linux gate evidence', 'Download windows gate evidence', 'Download coverage gate evidence',
      'Verify evidence SHA and derive release verdict (P38.2-13 / P38.3-7)', 'Upload release attestation (P38.2-13)']],
  ]);
  for (const platform of ['ubuntu', 'windows']) {
    mainRequired.set(`install · typecheck · test · build · benchmark-smoke · audit (${platform}-latest, ${platform})`,
      ['Typecheck', 'Real CLI and Web coding acceptance (scripted local HTTP, no paid calls)',
        'Opt-in coding prompt on actual CLI and Web HTTP requests', 'Unit and integration tests', 'Build',
        'Generate gate execution evidence (P38.2-4/10, E4-R09 unified V2)', 'Generate capability matrix (P12-5, P38.2-11 real wiring evidence)']);
    mainRequired.set(`r97-r98 closed loop (${platform}-latest)`, ['Build the tested revision',
      'Run the offline closed loop (setup -> acceptance -> suite -> matrix -> identity)',
      'N5 — run the offline pre-registration closed loop (0 provider calls)', 'N7 — separated readiness levels (no single overall PASS)',
      "Prove the suite CATCHES the thirty anti-cheat mutations (T6's five + A7's fourteen + N2's one + N5's five + S0's two + S7's three)"]);
    mainRequired.set(`real formal offline (${platform})`, ['Build the driver', 'Real formal + release CLI + measured readiness (zero paid requests)']);
  }
  must(mainRequired.size === main.jobs.length && main.jobs.every(job => mainRequired.has(job.name)), 'main CI required job set differs from tested workflow');
  for (const [name, required] of mainRequired) {
    const job = main.jobs.find(item => item.name === name);
    must(job && required.every(name => job.steps.filter(step => step.name === name).length === 1
      && job.steps.some(step => step.name === name && step.conclusion === 'success')), `mandatory main workflow step absent/skipped: ${name}`);
  }
  // These dedicated assertion steps run only on a negative reducer verdict.
  // Their skip is required by the positive path of the pinned workflow;
  // unlike skipped reducers, it is not a missing acceptance operation.
  for (const [jobName, stepName] of [['dual-platform acceptance (same SHA)', 'Fail job when the two legs are not one acceptance unit (S7)'],
    ['release attestation (P38-12)', 'Fail job when release not ready (P38.3-7)']]) {
    const matches = main.jobs.find(job => job.name === jobName).steps.filter(step => step.name === stepName);
    must(matches.length === 1 && matches[0].conclusion === 'skipped', `main negative-verdict assertion missing/ran: ${jobName}`);
  }
  must(native.jobs[0].labels?.includes('windows-latest') && native.jobs[0].steps.some(step => step.name === 'Execute native process and production boundary regressions' && step.conclusion === 'success'), 'native Windows mandatory boundary gate absent/skipped');
  must(String(installed.run.id) === exported.runId && String(installed.run.run_attempt) === exported.runAttempt, 'export/API run attempt mismatch');
  for (const platform of ['ubuntu', 'windows']) {
    const job = main.jobs.find(item => item.name.startsWith('install · typecheck') && item.name.includes(`${platform}-latest`));
    must(job && ['Typecheck', 'Unit and integration tests', 'Build'].every(name => job.steps.some(step => step.name === name && step.conclusion === 'success')), `main ${platform} mandatory test/build skipped`);
  }
  must(main.jobs.some(job => job.name === 'coverage gate (ubuntu)' && job.steps.some(step => step.name === 'Coverage gate (thresholds fail the job)' && step.conclusion === 'success')), 'coverage gate absent/skipped');
  for (const [name, required] of [['installed (ubuntu-latest)', ['Frozen install', 'Build application entries', 'Real interaction and independent installed coding']],
    ['installed (windows-latest)', ['Frozen install', 'Build application entries', 'Real interaction and independent installed coding']],
    ['Linux-built portable bytes on native Windows', ['Run the identical distributed bytes without pnpm or a build']],
    ['export-existing-draft', ['Verify bounded draft exporter controls without network', 'Download exact-source Ubuntu evidence', 'Download exact-source Windows evidence', 'Download identical-byte native Windows evidence', 'Export evidence to the existing exact-source draft only']]]) {
    const job = installed.jobs.find(item => item.name === name);
    must(job && required.every(name => job.steps.some(step => step.name === name && step.conclusion === 'success')), `mandatory installed workflow step absent/skipped: ${name}`);
  }
  console.log(JSON.stringify({ status: 'PASS', scope: 'fixed-source engineering acceptance; no paid-model quality claim', testedSourceSha: SHA,
    testedSourceTree: TREE, archiveSha256: HASH, releaseStatus: manifest.status, files: records.size, localFull: { passed: 9284, pending: 14 },
    security: 2143, protocol: 52, browser: { cases: 29, assertions: 82 }, ci: { mainJobs: 10, installedJobs: 4, nativeWindowsJobs: 1,
    installedRun: installed.run.id, installedAttempt: installed.run.run_attempt }, paidModelCalls: 0, realModelQuality: 'NOT_PROVEN' }, null, 2));
}
main().catch(error => { console.error(`FAIL: ${error.message}`); process.exitCode = 1; });
