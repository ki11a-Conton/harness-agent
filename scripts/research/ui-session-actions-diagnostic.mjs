#!/usr/bin/env node
// Diagnostic tooling only. Runs the original 54cd archive once; never a release gate.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync, gunzipSync } from 'node:zlib';

const SOURCE = '54cd148eae82c2d9b9f4ab00ee7e0c2eb5ce2d5e';
const TREE = 'f6218a0245550ef660626df32840d238e8e4adc7';
const VERSION = '1.12.0';
const ORIGINAL_RUN = '39978722387';
const BROWSER_CASES = 'settings-general,models-editor,workspace-directory-picker,workspace-files,session-lifecycle,markdown-stream-reload,read-tool,write-approval,write-rejection,ask-reload-answer';
const TOOL_HASHES = {
  'scripts/research/deepseek-browser-interactions.mjs': '7ac8c81891f1008326e49ec66d179be4666bfb3a88709fddaafa84d3ff936593',
  'scripts/research/deepseek-browser-observe.mjs': '7e0fae01c9ed35ba4808e8cceb47d69c46361d1cd19c357f21b297e9fcd24f0b',
  'scripts/research/deepseek-live-host.mjs': '06660c6cf8809b61b0df911d8efd7addbf85f259208ee1e6b4f49d136ecec206',
  'scripts/research/fixture-availability.mjs': '31ed9895a625309468b32991180c803b49d2e70b45a911fdba99e2bbad257188',
  'scripts/release/portable.mjs': '1071d517c4835886cb29b3506ab163d809531fc0c850913c851c3a25ab80e719',
  'scripts/release/portable-lib.mjs': '8f7a4681a079773524d520711c33b0137c090a59199437621607a0ac289be96e',
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const START = '/* HARNESS_UI_DIAGNOSTIC_BEGIN */';
const END = '/* HARNESS_UI_DIAGNOSTIC_END */';
const block = text => `\n${START}\n${text}\n${END}\n`;
const PACKET_NOTICE_BUDGET = 7;
// At most7 packet notices plus one aggregate overflow/observer notice for the
// whole sequence. An oversized packet is explicitly refused, never cut.
export function packetProjection(gzip, used = 0) {
  const chunks = gzip.toString('base64').match(/.{1,36000}/g) ?? [];
  return chunks.length <= PACKET_NOTICE_BUDGET - used
    ? { status: 'COMPLETE', chunks, used: used + chunks.length }
    : { status: 'BUDGET_EXCEEDED', chunks: [], required: chunks.length, remaining: PACKET_NOTICE_BUDGET - used, used };
}
export function stripInstrumentation(text) {
  return text.replace(/\n\/\* HARNESS_UI_DIAGNOSTIC_BEGIN \*\/[\s\S]*?\/\* HARNESS_UI_DIAGNOSTIC_END \*\/\n/g, '');
}

// Executed in each fresh document. No DOM writes, network, synthetic input or
// animation changes. All fields are geometry, fixture identity and style state.
function browserObserver() {
  try {
  const audit = { document: performance.timeOrigin, phase: 'document-init', target: null,
    frames: [], longFrames: [], events: [], errors: [], frameNumber: 0, pointer: null };
  const bounded = (list, item, cap) => { list.push(item); if (list.length > cap) list.splice(0, list.length - cap); };
  const rect = node => { if (!node) return null; const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const describe = node => node instanceof Element ? { tag: node.tagName, role: node.getAttribute('role'),
    ariaLabel: node.getAttribute('aria-label')?.slice(0, 160) ?? null,
    className: typeof node.className === 'string' ? node.className.slice(0, 220) : null,
    rowKey: node.closest('[data-row-key]')?.getAttribute('data-row-key') ?? null } : null;
  const style = node => { if (!node) return null; const s = getComputedStyle(node);
    return { display: s.display, visibility: s.visibility, opacity: s.opacity, overflowX: s.overflowX,
      overflowY: s.overflowY, transform: s.transform, pointerEvents: s.pointerEvents }; };
  const animations = node => (node?.getAnimations({ subtree: false }) ?? []).slice(0, 8).map(a => ({
    playState: a.playState, currentTime: typeof a.currentTime === 'number' ? a.currentTime : null,
    transitionProperty: a.transitionProperty ?? null, animationName: a.animationName ?? null,
    timing: { duration: a.effect?.getTiming().duration, fill: a.effect?.getTiming().fill },
  }));
  const error = reason => { try { bounded(audit.errors, String(reason).slice(0, 400), 16); } catch {} };
  const observed = callback => event => { try { callback(event); } catch (reason) { error(reason); } };
  const snapshot = () => {
    const rows = [...document.querySelectorAll('[data-row-key^="session:"]')];
    const row = rows.find(n => n.getAttribute('data-row-key') === audit.target)
      ?? rows.find(n => n.getAttribute('aria-selected') === 'true');
    const button = [...(row?.querySelectorAll('button') ?? [])].find(n => /^Session actions for /.test(n.getAttribute('aria-label') ?? ''));
    const frame = document.querySelector('.pI_x6G_frame');
    const sidebar = document.querySelector('.pI_x6G_sidebarCol');
    const buttonRect = rect(button);
    const hit = buttonRect && document.elementFromPoint(buttonRect.x + buttonRect.width / 2, buttonRect.y + buttonRect.height / 2);
    const ancestors = [];
    for (let node = button ?? row; node && ancestors.length < 18; node = node.parentElement) {
      const s = style(node); ancestors.push({ node: describe(node), rect: rect(node), style: s,
        scrollLeft: node.scrollLeft, scrollTop: node.scrollTop, clientWidth: node.clientWidth,
        clientHeight: node.clientHeight, scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight });
    }
    return { t: performance.now(), document: audit.document, frameNumber: audit.frameNumber, phase: audit.phase,
      pointer: audit.pointer, target: audit.target, row: { node: describe(row), rect: rect(row),
        label: row?.querySelector('.YDXeBa_title')?.textContent?.slice(0, 160) ?? null,
        connected: row?.isConnected ?? false, hover: row?.matches(':hover') ?? false, style: style(row), animations: animations(row) },
      button: { node: describe(button), rect: buttonRect, connected: button?.isConnected ?? false,
        style: style(button), hit: !!button && (button === hit || button.contains(hit)), centerHit: describe(hit), animations: animations(button) },
      sidebar: { rect: rect(sidebar), scrollLeft: sidebar?.scrollLeft ?? null, style: style(sidebar) },
      frame: { rect: rect(frame), columns: frame ? getComputedStyle(frame).gridTemplateColumns : null,
        collapsed: frame?.hasAttribute('data-sidebar-collapsed') ?? null,
        animating: frame?.hasAttribute('data-animating') ?? null, animations: animations(frame) },
      selectedRows: rows.filter(n => n.getAttribute('aria-selected') === 'true').slice(0, 8).map(n => n.getAttribute('data-row-key')),
      rowOrder: rows.slice(0, 16).map(n => ({ key: n.getAttribute('data-row-key'), rect: rect(n) })),
      visibleOwners: [...document.querySelectorAll('[data-conversation-content]')].filter(n => n.getClientRects().length > 0)
        .slice(0, 4).map(n => ({ session: n.getAttribute('data-conversation-session'), rect: rect(n) })), ancestors };
  };
  audit.capture = (phase, target) => { try { audit.phase = phase; if (target) audit.target = target; return snapshot(); }
    catch (reason) { error(reason); return null; } };
  audit.read = () => ({ document: audit.document, frames: audit.frames, longFrames: audit.longFrames,
    events: audit.events, errors: audit.errors });
  window.__HARNESS_SESSION_ACTIONS_DIAGNOSTIC__ = audit;
  for (const type of ['pointermove', 'pointerover', 'pointerout', 'pointerdown', 'pointerup']) {
    document.addEventListener(type, observed(event => { audit.pointer = { x: event.clientX, y: event.clientY, type };
      if (type !== 'pointermove') bounded(audit.events, { t: performance.now(), type, node: describe(event.target) }, 64); }), true);
  }
  for (const type of ['scroll', 'transitionstart', 'transitionend', 'animationstart', 'animationend']) {
    document.addEventListener(type, observed(event => bounded(audit.events, { t: performance.now(), type,
      node: describe(event.target), property: event.propertyName ?? null }, 64)), true);
  }
  const tick = () => { try { audit.frameNumber++; const entry = snapshot(); bounded(audit.frames, entry, 150);
      if (audit.frameNumber % 3 === 0) bounded(audit.longFrames, entry, 150); } catch (reason) { error(reason); }
    try { requestAnimationFrame(tick); } catch (reason) { error(reason); } };
  requestAnimationFrame(tick);
  } catch (reason) {
    // Init failures are diagnostics, never original acceptance pageerror events.
    try { const message = String(reason).slice(0, 400); window.__HARNESS_SESSION_ACTIONS_DIAGNOSTIC__ = {
      capture: () => null, read: () => ({ document: 0, frames: [], longFrames: [], events: [], errors: [message] }) }; } catch {}
  }
}

function browserRuntime(observerSource) {
  return `
import { gzipSync as __diagGzip } from 'node:zlib';
import { createHash as __diagHash } from 'node:crypto';
const __diagStates = new WeakMap();
let __diagNoticesUsed = 0;
const __diagIssues = [];
let __diagSummarySent = false;
const PACKET_NOTICE_BUDGET = ${PACKET_NOTICE_BUDGET};
const __diagProjection = ${packetProjection.toString()};
const __diagDigest = bytes => __diagHash('sha256').update(bytes).digest('hex');
function __diagSummary() {
  if (__diagSummarySent || __diagIssues.length === 0) return; __diagSummarySent = true;
  try { console.log('::notice title=Session actions diagnostic summary::'+JSON.stringify({
    status:'CHECKS_PROOF_INCOMPLETE',dataNoticesUsed:__diagNoticesUsed,dataNoticeBudget:PACKET_NOTICE_BUDGET,
    issues:__diagIssues.slice(0,6),businessVerdictUnchanged:true,consultCompleteRawArtifact:true})); } catch {}
}
process.once('exit',__diagSummary);
async function __diagInstall(page, name, viewport) {
  if (name !== 'session-lifecycle') return;
  const state = { name, viewport, phases: [], documents: [], errors: [] }; __diagStates.set(page, state);
  try { await page.addInitScript({content: '(' + ${JSON.stringify(observerSource)} + ')()'}); }
  catch (error) { state.errors.push({ phase: 'install', error: String(error) }); }
}
async function __diagMark(page, phase, target) {
  const state = __diagStates.get(page); if (!state) return;
  try {
    const sample = await page.evaluate(({phase,target}) => {
      const audit = window.__HARNESS_SESSION_ACTIONS_DIAGNOSTIC__;
      return audit ? { phase, snapshot: audit.capture(phase, target), audit: audit.read() } : {phase, missingObserver:true};
    }, {phase,target});
    state.phases.push({ phase, snapshot: sample.snapshot ?? null, missingObserver: sample.missingObserver === true });
    if (state.phases.length > 64) state.phases.shift();
    if (sample.audit) { const index = state.documents.findIndex(x => x.document === sample.audit.document);
      if (index < 0) state.documents.push(sample.audit); else state.documents[index] = sample.audit;
      if (state.documents.length > 2) state.documents.shift(); }
  } catch (error) { state.errors.push({phase,error:String(error).slice(0,400)}); if(state.errors.length>16)state.errors.shift(); }
}
async function __diagFinish(page, name, viewport, status, failure) {
  const state = __diagStates.get(page); if (!state) return;
  await __diagMark(page, 'case-finish');
  try {
    const packet = { schemaVersion:1, kind:'session-actions-passive-diagnostic', sourceSha:${JSON.stringify(SOURCE)},
      originalRunId:${JSON.stringify(ORIGINAL_RUN)}, releaseAcceptance:false, name, viewport, status,
      failure:failure??null, observerErrors:state.errors, phases:state.phases, documents:state.documents,
      limits:{phases:64,documents:2,framesPerDocument:150,longFramesPerDocument:150,longFrameStride:3,eventsPerDocument:64,ancestorsPerFrame:18,ancestorStart:'button-or-row'} };
    const raw = Buffer.from(JSON.stringify(packet)); const gzip = __diagGzip(raw);
    const stem = path.join(output,viewport+'-'+name+'-diagnostic');
    await writeFile(stem+'.json',raw); await writeFile(stem+'.json.gz',gzip);
    const observerErrors=[...state.errors,...state.documents.flatMap(document=>document.errors)];
    if(observerErrors.length||state.phases.some(phase=>phase.missingObserver)) __diagIssues.push({name,viewport,
      reason:'OBSERVER_INCOMPLETE',errorCount:observerErrors.length,errors:observerErrors.slice(0,3)});
    if(status!=='PASS') { const projection=__diagProjection(gzip,__diagNoticesUsed); __diagNoticesUsed=projection.used;
      await writeFile(stem+'-checks-projection.json',JSON.stringify({...projection,chunks:undefined,
        rawSha256:__diagDigest(raw),gzipSha256:__diagDigest(gzip)}));
      if(projection.status!=='COMPLETE') __diagIssues.push({name,viewport,reason:'BUDGET_EXCEEDED',
        required:projection.required,remaining:projection.remaining,rawSha256:__diagDigest(raw),
        gzipSha256:__diagDigest(gzip),completeRawArtifact:true});
      const chunks=projection.chunks;
      for(let i=0;i<chunks.length;i++) console.log('::notice title=Session actions diagnostic packet::'+JSON.stringify({
        schemaVersion:1,sourceSha:${JSON.stringify(SOURCE)},name,viewport,encoding:'gzip+base64',part:i+1,parts:chunks.length,
        rawBytes:raw.length,gzipBytes:gzip.length,rawSha256:__diagDigest(raw),gzipSha256:__diagDigest(gzip),data:chunks[i]})); }
  } catch(error) { __diagIssues.push({name,viewport,phase:'serialize',error:String(error).replace(/[%\\r\\n]/g,' ').slice(0,400)}); }
}
`;
}

export function instrumentBrowser(original) {
  assert(!original.includes(START), 'Original already contains diagnostic markers');
  let text = original;
  const once = (needle, replacement) => { assert.equal(text.split(needle).length, 2, `Unique instrumentation anchor: ${needle.slice(0, 90)}`); text = text.replace(needle, replacement); };
  once('const cases = {', block(browserRuntime(browserObserver.toString())) + 'const cases = {');
  once('      const page = await context.newPage(); page.setDefaultTimeout(4000);',
    '      const page = await context.newPage(); page.setDefaultTimeout(4000);' + block('await __diagInstall(page, name, viewportName);'));
  const beginning = text.indexOf('  "session-lifecycle": async (page, checks) => {');
  const end = text.indexOf('  "markdown-stream-reload":', beginning);
  assert(beginning > 0 && end > beginning);
  let operation = text.slice(beginning, end);
  const insert = (needle, before, after = '') => { assert.equal(operation.split(needle).length, 2, `Unique case anchor ${needle}`);
    operation = operation.replace(needle, (before ? block(before) : '') + needle + (after ? block(after) : '')); };
  insert('await page.reload({ waitUntil: "domcontentloaded" });', "await __diagMark(page, 'reload-start', oldKey);", "await __diagMark(page, 'reload-return', oldKey);");
  for (const [index, row, key] of [[1, 'selected', 'oldKey'], [2, 'renamed', 'oldKey'], [3, 'forked', 'forkKey']]) {
    insert(`await ${row}.hover();`, `await __diagMark(page, 'actions-${index}-hover-start', ${key});`, `await __diagMark(page, 'actions-${index}-hover-return', ${key});`);
    insert(`await ${row}.getByRole("button", { name: /^Session actions for / }).click();`,
      `await __diagMark(page, 'actions-${index}-click-start', ${key}); try {`,
      `await __diagMark(page, 'actions-${index}-click-return', ${key}); } catch (__diagOriginalError) { await __diagMark(page, 'actions-${index}-click-fail', ${key}); throw __diagOriginalError; }`);
  }
  text = text.slice(0, beginning) + operation + text.slice(end);
  once('      const observation = await surface(page);', block('await __diagFinish(page, name, viewportName, status, failure);') + '      const observation = await surface(page);');
  once('const report = { origin, scope:', block('__diagSummary();') + 'const report = { origin, scope:');
  assert.equal(stripInstrumentation(text), original, 'Diagnostics must remove to exact original bytes');
  return text;
}

const deadline = (promise, ms, label) => new Promise((done, reject) => {
  const timer = setTimeout(() => reject(new Error(label)), ms);
  promise.then(value => { clearTimeout(timer); done(value); }, error => { clearTimeout(timer); reject(error); });
});
async function stopChild(child, closed, ipc, errors) {
  if (!child) return undefined;
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (ipc && child.connected) child.send({ type: 'fixture-stop' }, error => { if (error) errors.push(`IPC stop: ${String(error)}`); });
      else child.kill('SIGTERM');
    } catch (error) { errors.push(`Initial stop: ${String(error)}`); }
  }
  try { return { closed: true, exit: await deadline(closed, ipc ? 15000 : 5000, 'Child graceful close deadline') }; }
  catch (error) { errors.push(String(error)); }
  try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  catch (error) { errors.push(`Forced stop: ${String(error)}`); }
  try { return { closed: true, exit: await deadline(closed, 5000, 'Child forced close deadline') }; }
  catch (error) { errors.push(String(error)); return { closed: false }; }
}
async function validateTools(baseline) {
  for (const [name, expected] of Object.entries(TOOL_HASHES)) assert.equal(sha(await readFile(join(baseline, name))), expected, `Pinned original tool ${name}`);
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: baseline, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), SOURCE, 'Original tooling checkout SHA');
}
async function selfCheck(baseline, output) {
  await validateTools(baseline);
  const original = await readFile(join(baseline, 'scripts/research/deepseek-browser-interactions.mjs'), 'utf8');
  const instrumented = instrumentBrowser(original), stripped = stripInstrumentation(instrumented);
  assert.equal(stripped, original);
  const tampered = instrumented.replace('assert.equal(forkResponse.result.ok, true);', 'assert.equal(forkResponse.result.ok, false);');
  assert.notEqual(stripInstrumentation(tampered), original, 'Changed business assertion is detected');
  const payload = Buffer.concat(Array.from({ length: 4096 }, (_, index) => createHash('sha256').update(`packet-control-${index}`).digest()));
  const gzip = gzipSync(payload), projection = packetProjection(gzip), chunks = projection.chunks;
  assert.equal(projection.status, 'COMPLETE'); assert(chunks.length > 1, 'Incompressible control must exercise multiple chunks');
  for (const chunk of chunks) assert(Buffer.byteLength(JSON.stringify({ part: 1, parts: chunks.length, data: chunk })) < 40000);
  assert.deepEqual(gunzipSync(Buffer.from(chunks.join(''), 'base64')), payload);
  const overflow = packetProjection(gzip, PACKET_NOTICE_BUDGET - 1);
  assert.equal(overflow.status, 'BUDGET_EXCEEDED'); assert.deepEqual(overflow.chunks, []);
  assert.equal(overflow.used, PACKET_NOTICE_BUDGET - 1, 'Overflow emits no partial packet');
  const { runInNewContext } = await import('node:vm');
  for (const failAt of ['init', 'frame', 'event', 'schedule']) {
    const handlers = new Map(), frames = [], window = {};
    const sandbox = { window, Element: class {}, performance: { timeOrigin: 1, now: () => 2 },
      document: { addEventListener: (name, callback) => { if (failAt === 'init') throw new Error('controlled init observer failure'); handlers.set(name, callback); },
        querySelectorAll: () => { throw new Error('controlled frame observer failure'); } },
      requestAnimationFrame: callback => { if (failAt === 'schedule') throw new Error('controlled scheduling failure'); frames.push(callback); } };
    assert.doesNotThrow(() => runInNewContext(`(${browserObserver.toString()})()`, sandbox));
    if (failAt === 'frame') assert.doesNotThrow(() => frames.shift()());
    if (failAt === 'event') assert.doesNotThrow(() => handlers.get('pointerover')({ get clientX() { throw new Error('controlled event failure'); } }));
    assert(window.__HARNESS_SESSION_ACTIONS_DIAGNOSTIC__.read().errors.length > 0);
  }
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'instrumented-browser.mjs'), instrumented);
  const syntax = spawnSync(process.execPath, ['--check', join(output, 'instrumented-browser.mjs')], { encoding: 'utf8', windowsHide: true });
  assert.equal(syntax.status, 0, syntax.stderr);
  const result = { schemaVersion: 1, status: 'PASS', kind: 'offline-additive-instrumentation-check', sourceSha: SOURCE,
    originalSha256: sha(original), strippedSha256: sha(stripped), instrumentedSha256: sha(instrumented),
    originalAssertionsTamperDetected: true, gzipBase64RoundTrip: true, multiChunkControl: chunks.length,
    annotationOverflowRefusedWithoutTruncation: true, packetNoticeBudgetPerSequence: PACKET_NOTICE_BUDGET, noticeChunkLimitBytes: 40000,
    observerInitFrameEventSchedulingExceptionsContained: true,
    originalActionTimeoutMs: 4000, browserDeadlineMs: 600000, productionOrBrowserExecuted: false };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

async function main() {
  const { values } = parseArgs({ options: { baseline: { type: 'string' }, archive: { type: 'string' }, out: { type: 'string' },
    'playwright-module': { type: 'string' }, 'self-check': { type: 'boolean', default: false } } });
  assert(values.baseline && values.out, 'Use --baseline ROOT --out NEW_DIR [--self-check | --archive FILE --playwright-module FILE]');
  const baseline = resolve(values.baseline), output = resolve(values.out);
  await selfCheck(baseline, join(output, 'instrumentation'));
  if (values['self-check']) { console.log(JSON.stringify({ status: 'PASS', kind: 'offline-only', sourceSha: SOURCE })); return; }
  assert.equal(process.platform, 'win32', 'This diagnostic requires a genuine Windows runner');
  assert.equal(Number(process.versions.node.split('.')[0]), 22, 'Use formal Node22');
  assert(values.archive && values['playwright-module'], 'Archive and Playwright module required');
  const archive = resolve(values.archive), playwrightModule = resolve(values['playwright-module']);
  const playwrightMetadata = JSON.parse(await readFile(join(dirname(playwrightModule), 'package.json'), 'utf8'));
  assert.equal(playwrightMetadata.version, '1.55.1');
  const checksums = await readFile(join(dirname(archive), 'SHA256SUMS'), 'utf8');
  const archiveSha256 = sha(await readFile(archive));
  assert.equal(checksums.split(/\r?\n/).filter(line => line === `${archiveSha256}  ${basename(archive)}`).length, 1, 'Actual archive SHA256SUMS');
  const { verifyArchive } = await import(pathToFileURL(join(baseline, 'scripts/release/portable.mjs')).href);
  const { verifyPortable } = await import(pathToFileURL(join(baseline, 'scripts/release/portable-lib.mjs')).href);
  const cleanroom = await realpath(await mkdtemp(join(tmpdir(), 'harness-session-actions-diagnostic-')));
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|BASE_URL|OPENAI_MODEL|ANTHROPIC|RUN_PAID|NODE_OPTIONS|NODE_PATH/i.test(key)));
  let host, hostExit, runner, runnerExit, portableRoot, jsBefore, hostStdout = '', hostStderr = '', browserLog = '', receipt, originalError;
  try {
    const verified = await verifyArchive({ archive, out: join(cleanroom, 'extracted'), version: VERSION, sourceSha: SOURCE });
    const { root, manifest } = verified; assert.equal(manifest.sourceTree, TREE); assert.equal(verified.sha256, archiveSha256);
    const js = manifest.files.filter(item => item.path.endsWith('.js')).map(item => ({ path: item.path, sha256: item.sha256 }));
    assert(js.some(item => item.path.endsWith('harness-brand/plugins/dsh-client-ui-workspace/client.js')), 'Actual branded workspace JS present');
    const productionJsSha256 = sha(JSON.stringify(js));
    portableRoot = root; jsBefore = productionJsSha256;
    receipt = { schemaVersion: 1, kind: 'native-windows-passive-session-actions-diagnostic', releaseAcceptance: false,
      sourceSha: SOURCE, sourceTree: TREE, version: VERSION, originalRunId: ORIGINAL_RUN,
      originalArtifact: `deepseek-portable-${SOURCE}-${ORIGINAL_RUN}`, archiveSha256,
      manifestSha256: sha(await readFile(join(root, 'PORTABLE-MANIFEST.json'))), productionJsSha256,
      productionJsFiles: js.length, platform: process.platform, node: process.version, playwright: playwrightMetadata.version,
      sequenceExecutions: 1, expectedCases: 30, paidModelCalls: 0, status: 'RUNNING' };
    await writeFile(join(output, 'archive-identity.json'), JSON.stringify(receipt, null, 2) + '\n');
    const playwright = await import(pathToFileURL(playwrightModule).href);
    const chromium = playwright.chromium.executablePath();
    const probe = await playwright.chromium.launch({ executablePath: chromium, headless: true, args: ['--no-sandbox'] });
    try { receipt.chromium = probe.version(); assert(/^140\./.test(receipt.chromium), 'Use formal Chromium140'); } finally { await probe.close(); }
    const tools = join(cleanroom, 'tools'); await mkdir(tools);
    const instrumented = await readFile(join(output, 'instrumentation/instrumented-browser.mjs'));
    await writeFile(join(tools, 'deepseek-browser-interactions.mjs'), instrumented);
    await cp(join(baseline, 'scripts/research/deepseek-browser-observe.mjs'), join(tools, 'deepseek-browser-observe.mjs'));
    const fixture = join(cleanroom, 'fixture');
    host = spawn(process.execPath, [join(baseline, 'scripts/research/deepseek-live-host.mjs'), '--root', fixture,
      '--portable-root', root, '--ipc-control', '--preflight-owner'], { cwd: cleanroom, windowsHide: true,
      env: { ...childEnv, HARNESS_VERIFY_COMMAND: '' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    hostExit = new Promise((done, reject) => { host.once('error', reject); host.once('close', (code, signal) => done({ code, signal })); });
    const ready = new Promise((done, reject) => {
      host.stdout.on('data', bytes => { hostStdout += bytes; const match = hostStdout.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) done(match[0]); });
      host.stderr.on('data', bytes => { hostStderr += bytes; });
      hostExit.then(exit => reject(new Error(`Fixture exited before readiness ${JSON.stringify(exit)}`)), reject);
    });
    const origin = await deadline(ready, 60000, 'Original installed host readiness deadline');
    runner = spawn(process.execPath, [join(tools, 'deepseek-browser-interactions.mjs'), '--url', origin,
      '--output', join(output, 'browser'), '--playwright-module', playwrightModule, '--chromium', chromium,
      '--models', '--fixture-evidence', join(fixture, 'evidence'), '--cases', BROWSER_CASES,
      '--viewports', 'desktop,mobile,narrow-tall'], { cwd: cleanroom, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    runnerExit = new Promise((done, reject) => { runner.once('error', reject); runner.once('close', (code, signal) => done({ code, signal })); });
    runner.stdout.on('data', bytes => { browserLog += bytes; process.stdout.write(bytes); });
    runner.stderr.on('data', bytes => { browserLog += bytes; process.stderr.write(bytes); });
    const exit = await deadline(runnerExit, 10 * 60000, 'Original browser body exceeded its10minute deadline');
    receipt.browserExit = exit;
    let browser;
    try { browser = JSON.parse(await readFile(join(output, 'browser/result.json'), 'utf8'));
      receipt.cases = browser.results.length; receipt.failed = browser.results.filter(item => item.status !== 'PASS').map(item => ({ name: item.name, viewport: item.viewport, status: item.status, failure: item.failure })); }
    catch (error) { receipt.browserReportError = String(error); }
    receipt.diagnosticProblems = [];
    receipt.lifecyclePackets = [];
    for (const viewport of ['desktop', 'mobile', 'narrow-tall']) {
      try {
        const packet = JSON.parse(await readFile(join(output, 'browser', `${viewport}-session-lifecycle-diagnostic.json`), 'utf8'));
        const problems = [...packet.observerErrors, ...packet.documents.flatMap(document => document.errors)];
        if (packet.phases.some(phase => phase.missingObserver)) problems.push('Missing document observer');
        if (packet.status !== 'PASS') {
          const projection = JSON.parse(await readFile(join(output, 'browser', `${viewport}-session-lifecycle-diagnostic-checks-projection.json`), 'utf8'));
          if (projection.status !== 'COMPLETE') problems.push('CHECKS_PROOF_INCOMPLETE: packet projection refused its full-budget admission');
        }
        if (packet.status === 'PASS') for (const required of ['reload-start', 'reload-return', ...[1, 2, 3].flatMap(index =>
          [`actions-${index}-hover-start`, `actions-${index}-hover-return`, `actions-${index}-click-start`, `actions-${index}-click-return`])]) {
          if (!packet.phases.some(phase => phase.phase === required && phase.snapshot)) problems.push(`Missing snapshot ${required}`);
        }
        if (problems.length) receipt.diagnosticProblems.push({ viewport, problems });
        receipt.lifecyclePackets.push({ viewport, status: packet.status, phases: packet.phases.length,
          documentCount: packet.documents.length, completeObservation: problems.length === 0 });
      } catch (error) { receipt.diagnosticProblems.push({ viewport, error: String(error) }); }
    }
    receipt.diagnosticComplete = receipt.diagnosticProblems.length === 0;
    receipt.browserStatus = browser?.complete && exit.code === 0 ? 'PASS' : 'FAIL';
    assert.equal(exit.code, 0, 'Original browser sequence returned failure; evidence retained');
    assert(browser, 'Original browser report must be present');
    assert.equal(browser.results.length, 30); assert(browser.complete);
    assert(receipt.diagnosticComplete, 'Original browser passed but passive diagnostics were incomplete; see diagnosticProblems');
    receipt.status = 'PASS_DIAGNOSTIC_NOT_REPRODUCED';
  } catch (error) { originalError = error; if (receipt) { receipt.status = 'FAIL_DIAGNOSTIC'; receipt.error = String(error); } }
  finally {
    const cleanupErrors = [];
    const collect = async (label, operation) => { try { return await operation(); } catch (error) { cleanupErrors.push(`${label}: ${String(error)}`); return undefined; } };
    const browserClosed = await collect('browser cleanup', () => stopChild(runner, runnerExit, false, cleanupErrors));
    const hostClosed = await collect('fixture cleanup', () => stopChild(host, hostExit, true, cleanupErrors));
    if (receipt && hostClosed?.closed) { receipt.hostExit = hostClosed.exit; if (hostClosed.exit.code !== 0) cleanupErrors.push('Original fixture shutdown exit was not zero'); }
    if (portableRoot) {
      try {
        const after = await verifyPortable(portableRoot, { version: VERSION, sourceSha: SOURCE, sourceTree: TREE });
        assert.equal(sha(await readFile(join(portableRoot, 'PORTABLE-MANIFEST.json'))), receipt.manifestSha256, 'Manifest bytes remain exact');
        assert.equal(sha(JSON.stringify(after.files.filter(item => item.path.endsWith('.js')).map(item => ({ path: item.path, sha256: item.sha256 })))), jsBefore);
        receipt.productionBytesVerifiedAfter = true; receipt.integrityStatus = 'PASS';
      } catch (error) { if (receipt) { receipt.integrityStatus = 'FAIL'; receipt.integrityError = String(error); }
        if (!originalError) originalError = error; }
    }
    await collect('host stdout', () => writeFile(join(output, 'host-stdout.log'), hostStdout));
    await collect('host stderr', () => writeFile(join(output, 'host-stderr.log'), hostStderr));
    await collect('browser log', () => writeFile(join(output, 'browser.log'), browserLog));
    await collect('fixture evidence', async () => { try { await cp(join(cleanroom, 'fixture/evidence'), join(output, 'fixture'), { recursive: true }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; } });
    const missingClose = (runner && !browserClosed?.closed) || (host && !hostClosed?.closed);
    if (missingClose) cleanupErrors.push('Child has no close observation; cleanroom retained');
    else await collect('cleanroom removal', () => rm(cleanroom, { recursive: true, force: true }));
    if (cleanupErrors.length && !originalError) originalError = new Error('Diagnostic cleanup/integrity failed; see result.json');
    if (receipt) { receipt.cleanupErrors = cleanupErrors; if (originalError && receipt.status === 'PASS_DIAGNOSTIC_NOT_REPRODUCED') receipt.status = 'FAIL_DIAGNOSTIC_CLEANUP_OR_INTEGRITY';
      await collect('final receipt', () => writeFile(join(output, 'result.json'), JSON.stringify(receipt, null, 2) + '\n')); }
    if (cleanupErrors.length && !originalError) originalError = new Error('Diagnostic evidence persistence failed');
  }
  if (originalError) throw originalError;
  console.log(JSON.stringify(receipt));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(String(error)); process.exitCode = 1; });
}
