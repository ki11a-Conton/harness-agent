import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { canonicalPayloadModes, rebuildReviewedNativeDependencies, REVIEWED_NODE_PTY, run } from './portable.mjs';
import { digest, extractArchive, filesIn, makeArchive, verifyPortable } from './portable-lib.mjs';

// Explicit integration command; cached npm package bytes may be supplied by
// HARNESS_PORTABLE_STORE_DIR, but no built workspace files enter this fixture.
test('fresh ignore-scripts install rebuilds only reviewed node-pty and its identical archive bytes execute across selected Node versions', { timeout: 180000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-portable-native-')));
  try {
    const source = join(root, 'source'); const web = join(source, 'apps/web'); const canary = join(source, 'packages/canary');
    await mkdir(web, { recursive: true }); await mkdir(canary, { recursive: true });
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'portable-native-fixture', private: true, version: '1.0.0' }));
    await writeFile(join(source, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\nallowBuilds:\n  node-pty: true\n  portable-lifecycle-canary: true\n');
    const marker = join(root, 'unrelated-lifecycle-ran');
    const forbiddenScript = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'); process.exitCode = 23;`;
    await writeFile(join(canary, 'install.cjs'), forbiddenScript);
    await writeFile(join(canary, 'package.json'), JSON.stringify({ name: 'portable-lifecycle-canary', version: '1.0.0', scripts: { install: 'node install.cjs', postinstall: 'node install.cjs' } }));
    await writeFile(join(web, 'install.cjs'), forbiddenScript);
    await writeFile(join(web, 'package.json'), JSON.stringify({ name: 'portable-web-fixture', version: '1.0.0', dependencies: { 'node-pty': REVIEWED_NODE_PTY.version, 'portable-lifecycle-canary': 'workspace:*' }, scripts: { install: 'node install.cjs', postinstall: 'node install.cjs' } }));
    await writeFile(join(source, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  .: {}
  apps/web:
    dependencies:
      node-pty:
        specifier: 1.1.0
        version: 1.1.0
      portable-lifecycle-canary:
        specifier: workspace:*
        version: link:../../packages/canary
  packages/canary: {}
packages:
  node-addon-api@7.1.1:
    resolution: {integrity: sha512-5m3bsyrjFWE1xf7nz7YXdN4udnVtXK6/Yfgn5qnahL6bCkf2yKt4k3nuTKAtT4r3IG8JNR2ncsIMdZuAzJjHQQ==}
  node-pty@1.1.0:
    resolution: {integrity: ${REVIEWED_NODE_PTY.integrity}}
snapshots:
  node-addon-api@7.1.1: {}
  node-pty@1.1.0:
    dependencies:
      node-addon-api: 7.1.1
`);
    const storeDir = process.env.HARNESS_PORTABLE_STORE_DIR;
    run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', '--side-effects-cache=false', ...(storeDir ? ['--store-dir', storeDir] : []), ...(process.env.HARNESS_PORTABLE_OFFLINE === '1' ? ['--offline'] : [])], { cwd: source });
    await assert.rejects(lstat(marker), /ENOENT/);
    // Delete no files and copy no old native binaries: the fresh dependency
    // installation must actually build its own Linux addon.
    const before = spawnSync(process.execPath, ['-e', 'require("node-pty")'], { cwd: web, encoding: 'utf8' });
    if (process.platform === 'linux') assert.notEqual(before.status, 0, 'published node-pty has no Linux prebuild');
    if (process.platform === 'linux' && !process.env.npm_config_nodedir) {
      let hooks = 0;
      await assert.rejects(rebuildReviewedNativeDependencies(source, { storeDir, offline: true, runPnpm: () => { hooks++; return ''; } }), /requires local Node headers/);
      assert.equal(hooks, 0, 'offline mode refuses a network-dependent native build before invoking install scripts');
    }
    const native = await rebuildReviewedNativeDependencies(source, { storeDir, devDir: join(root, 'headers') });
    assert.equal(native.receipt[0].nativeImportVerified, true);
    assert.ok(native.receipt[0].retainedPrebuilds.some(item => item.path === 'win32-x64/conpty.node'));
    assert.ok(native.receipt[0].retainedPrebuilds.some(item => item.path === 'win32-arm64/conpty.node'));
    await assert.rejects(lstat(marker), /ENOENT/);
    if (process.platform === 'linux') {
      const offline = await rebuildReviewedNativeDependencies(source, { storeDir, offline: true, headersDir: join(root, 'headers', process.versions.node) });
      assert.equal(offline.receipt[0].nativeImportVerified, true);
      assert.ok(!/gyp http/i.test(offline.log), 'explicit local SDK prevents node-gyp header downloads');
      await assert.rejects(lstat(marker), /ENOENT/);
    }
    const payload = join(root, 'payload'); await mkdir(payload);
    const require = createRequire(join(web, 'package.json'));
    const nodePty = await realpath(require.resolve('node-pty/package.json'));
    await cp(join(nodePty, '..'), join(payload, 'node_modules/node-pty'), { recursive: true });
    const addonPackage = createRequire(nodePty).resolve('node-addon-api/package.json');
    await cp(join(addonPackage, '..'), join(payload, 'node_modules/node-addon-api'), { recursive: true });
    const required = ['agent.mjs', 'node_modules/@ar/cli/dist/main.js', 'node_modules/@ar/web/dist/main.js', 'node_modules/@ar/web/public/index.html', 'PROJECT-LICENSE-NOTICE.txt'];
    for (const path of required) { await mkdir(join(payload, path, '..'), { recursive: true }); await writeFile(join(payload, path), 'fixture'); }
    const modes = await canonicalPayloadModes(payload);
    const files = await Promise.all((await filesIn(payload)).map(async path => { const bytes = await readFile(join(payload, path)); return { path, bytes: bytes.length, sha256: digest(bytes), mode: modes.get(path) }; }));
    const manifest = { schemaVersion: 2, kind: 'harness-agent-portable', version: '1.9.1-test', sourceSha: 'a'.repeat(40), sourceTree: 'b'.repeat(40), files };
    await writeFile(join(payload, 'PORTABLE-MANIFEST.json'), JSON.stringify(manifest));
    const entries = await Promise.all(files.map(async item => ({ path: `harness-agent-1.9.1-test/${item.path}`, bytes: await readFile(join(payload, item.path)), mode: item.mode })));
    entries.push({ path: 'harness-agent-1.9.1-test/PORTABLE-MANIFEST.json', bytes: await readFile(join(payload, 'PORTABLE-MANIFEST.json')), mode: 0o644 });
    const archive = makeArchive(entries); const extracted = await extractArchive(archive, join(root, 'consumer')); await verifyPortable(extracted);
    const probe = `const pty = require('node-pty'); const term = pty.spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/d','/s','/c','echo portable-native-ok'] : ['-c','printf portable-native-ok'], {cwd: process.cwd(), env: process.env}); let text=''; term.onData(chunk => {text+=chunk;}); const timer=setTimeout(()=>{term.kill();process.exit(2);},5000); term.onExit(event=>{clearTimeout(timer);if(event.exitCode!==0||!text.includes('portable-native-ok'))process.exitCode=3;else console.log(JSON.stringify({node:process.version,abi:process.versions.modules,napi:process.versions.napi,output:text.trim()}));});`;
    const nodes = [...new Set([process.execPath, ...(process.env.HARNESS_PORTABLE_NODE_BINARIES ?? '').split(',').filter(Boolean)])];
    const results = [];
    for (const node of nodes) results.push(JSON.parse(run(node, ['-e', probe], { cwd: extracted, timeout: 10000 }).trim()));
    if (process.env.HARNESS_PORTABLE_REQUIRE_NODE_MAJORS) for (const major of process.env.HARNESS_PORTABLE_REQUIRE_NODE_MAJORS.split(',')) assert.ok(results.some(item => item.node.startsWith(`v${major}.`)), `Node ${major} did not actually consume the archive`);
    console.log(JSON.stringify({ status: 'PASS', fixtureArchiveSha256: digest(archive), files: files.length, archiveBytes: archive.length, retainedPrebuilds: native.receipt[0].retainedPrebuilds.length, unrelatedLifecycleCalls: 0, nodes: results }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
