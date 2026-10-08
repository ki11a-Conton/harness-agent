#!/usr/bin/env node
// Inspired by pi local-release and DeepSeek verify-packed-install: rebuild one
// fixed source commit, then verify the actual bytes outside the workspace.
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { digest, extractArchive, filesIn, makeArchive, safePath, verifyPortable } from './portable-lib.mjs';

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, windowsHide: true, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status ?? 'spawn'}): ${result.error?.message ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  return result.stdout;
}
function pnpm(args, cwd, options = {}) {
  // Windows .cmd cannot be execFile'd. Resolve pnpm's JS entry and run plain Node
  // rather than a shell, keeping user-supplied directory paths as literal args.
  if (process.platform !== 'win32') return run('pnpm', args, { cwd, ...options });
  const candidates = [process.env.npm_execpath, ...((process.env.PATH ?? '').split(delimiter).flatMap(path =>
    [join(path, 'node_modules/pnpm/bin/pnpm.cjs'), join(path, '../pnpm/bin/pnpm.cjs'), join(path, '../pnpm/bin/pnpm.js')]))].filter(Boolean);
  for (const entry of candidates) {
    if (!/pnpm\.(?:c?js)$/i.test(entry)) continue;
    const test = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8', windowsHide: true });
    if (test.status === 0 && /^\d+\./.test(test.stdout)) return run(process.execPath, [entry, ...args], { cwd, ...options });
  }
  throw new Error('cannot resolve pnpm JS entry on Windows; run through pnpm exec node');
}

export async function sourceSnapshot(repo, sourceSha, target) {
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: repo }).trim();
  if (head !== sourceSha || !/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('source SHA must equal the full current HEAD');
  if (run('git', ['status', '--porcelain'], { cwd: repo }).trim()) throw new Error('portable build requires a clean source commit');
  const paths = ['packages', 'apps', 'tsconfig.json', 'tsconfig.base.json', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'third_party', 'scripts/release', 'LICENSE', 'NOTICE'];
  const records = run('git', ['ls-tree', '-r', '-z', sourceSha, '--', ...paths], { cwd: repo }).split('\0').filter(Boolean).map(record => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(record);
    if (!match) throw new Error('release source contains a symlink or unsupported Git object');
    return { oid: match[2], path: safePath(match[3]) };
  });
  const input = records.map(record => record.oid).join('\n') + '\n';
  const batch = spawnSync('git', ['cat-file', '--batch'], { cwd: repo, input, maxBuffer: 128 * 1024 * 1024, windowsHide: true });
  if (batch.error || batch.status !== 0) throw new Error('cannot read pinned source objects');
  let offset = 0;
  for (const record of records) {
    const newline = batch.stdout.indexOf(10, offset);
    const header = batch.stdout.subarray(offset, newline).toString('ascii');
    const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(header);
    if (!match || match[1] !== record.oid) throw new Error('invalid Git blob batch');
    const size = Number(match[2]); offset = newline + 1;
    const path = join(target, ...record.path.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, batch.stdout.subarray(offset, offset + size)); offset += size + 1;
  }
  return run('git', ['rev-parse', `${sourceSha}^{tree}`], { cwd: repo }).trim();
}

function productionFile(path) {
  return !/(?:\.test|\.perf|\.soak)\.(?:js|d\.ts)$/.test(path)
    && !path.endsWith('.map') && /\.(?:js|json|d\.ts)$/.test(path);
}
async function copyFiles(from, to, filter = () => true) {
  for (const path of await filesIn(from)) {
    if (!filter(path)) continue;
    const target = join(to, ...path.split('/')); await mkdir(dirname(target), { recursive: true });
    await cp(join(from, ...path.split('/')), target);
  }
}
export async function copyPackageNotices(directory, target) {
  await mkdir(target, { recursive: true });
  try { await copyFiles(join(directory, 'licenses'), join(target, 'licenses')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!/^(?:licen[sc]e|notice)(?:\.[A-Za-z0-9_-]+)?$/i.test(entry.name)) continue;
    if (!entry.isFile()) throw new Error(`package notice must be a regular file: ${entry.name}`);
    await cp(join(directory, entry.name), join(target, entry.name));
  }
}
export async function workspacePackages(snapshot) {
  // TypeScript's root references are a build entry list, not the workspace
  // inventory: indirect @ar/store and unlisted @ar/orchestration still need
  // complete manifests and freshly compiled distribution files.
  const root = await realpath(snapshot);
  const inventory = JSON.parse(pnpm(['-r', 'list', '--depth', '-1', '--json'], root));
  if (!Array.isArray(inventory)) throw new Error('invalid pnpm workspace inventory');
  const packages = (await Promise.all(inventory.map(async pkg => {
    const directory = await realpath(pkg.path);
    const inside = relative(root, directory);
    // pnpm and Node can expand a Windows short pathname independently. Exclude
    // the workspace root only after both paths identify their physical directory.
    if (!inside) return undefined;
    const outside = path => path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(path);
    if (outside(inside)) throw new Error('workspace package is outside pinned source');
    // A caller's root alias is legitimate; links below that physical root are
    // not release input. Check every package ancestor before reading metadata.
    for (let current = resolve(pkg.path);; current = dirname(current)) {
      const relativePath = relative(root, current);
      if (outside(relativePath)) throw new Error('workspace package is outside pinned source');
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`workspace package symlink: ${pkg.path}`);
      if (!relativePath) break;
    }
    for (const file of ['package.json', 'tsconfig.json']) {
      const info = await lstat(join(directory, file));
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`workspace metadata must be a regular file: ${file}`);
    }
    const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    safePath(metadata.name);
    if (typeof metadata.version !== 'string' || !metadata.version) throw new Error(`workspace package version missing: ${metadata.name}`);
    await readFile(join(directory, 'tsconfig.json'));
    return { directory, metadata };
  }))).filter(Boolean);
  const names = new Set();
  for (const { metadata } of packages) {
    if (names.has(metadata.name)) throw new Error(`duplicate workspace package: ${metadata.name}`);
    names.add(metadata.name);
  }
  for (const { metadata } of packages) {
    for (const [name, range] of Object.entries(metadata.dependencies ?? {})) {
      if ((name.startsWith('@ar/') || String(range).startsWith('workspace:')) && !names.has(name)) throw new Error(`unresolved workspace dependency for ${metadata.name}: ${name}`);
    }
  }
  return packages.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name, 'en'));
}

export async function buildPortable({ repo, out, version, sourceSha, offline = false, storeDir }) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version ?? '')) throw new Error('a valid explicit --version is required');
  if (!sourceSha) throw new Error('explicit --source-sha is required');
  // Windows TEMP often uses an 8.3 alias. Keep strict extraction checks and
  // normalize our trusted temporary directory at the creation boundary.
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'harness-portable-build-')));
  try {
    const snapshot = join(temp, 'source'); const payload = join(temp, `harness-agent-${version}`);
    const sourceTree = await sourceSnapshot(repo, sourceSha, snapshot);
    // No dist or node_modules is read from the caller's checkout. Git snapshot
    // and a fresh frozen-lockfile install make stale build output impossible.
    const installLog = pnpm(['install', '--frozen-lockfile', '--ignore-scripts', ...(offline ? ['--offline'] : []), ...(storeDir ? ['--store-dir', storeDir] : [])], snapshot);
    const packages = await workspacePackages(snapshot);
    const buildLog = pnpm(['exec', 'tsc', '-b', '--force', ...packages.map(pkg => pkg.directory)], snapshot);
    const versions = Object.fromEntries(packages.map(pkg => [pkg.metadata.name, pkg.metadata.version]));
    const external = new Map();
    async function copyExternal(name, from) {
      if (name.startsWith('@ar/')) return;
      let resolved = dirname(await realpath(createRequire(join(from, 'package.json')).resolve(name)));
      while (true) {
        try { if (JSON.parse(await readFile(join(resolved, 'package.json'), 'utf8')).name === name) break; } catch {}
        const parent = dirname(resolved); if (parent === resolved) throw new Error(`cannot resolve dependency package: ${name}`); resolved = parent;
      }
      const metadata = JSON.parse(await readFile(join(resolved, 'package.json'), 'utf8'));
      if (metadata.name !== name) throw new Error(`dependency name mismatch: ${name}`);
      if (external.has(name)) {
        if (external.get(name).version !== metadata.version) throw new Error(`portable flattening cannot resolve multiple ${name} versions`);
        return;
      }
      external.set(name, { version: metadata.version, license: metadata.license ?? 'UNKNOWN' });
      await copyFiles(resolved, join(payload, 'node_modules', ...name.split('/')), path => !path.startsWith('node_modules/'));
      for (const dependency of Object.keys(metadata.dependencies ?? {})) await copyExternal(dependency, resolved);
      // zod-to-json-schema's required peer must resolve from the same layout.
      for (const [dependency, range] of Object.entries(metadata.peerDependencies ?? {})) {
        if (metadata.peerDependenciesMeta?.[dependency]?.optional) continue;
        void range; await copyExternal(dependency, resolved);
      }
      if (!Object.keys(metadata).some(key => /license/i.test(key)) || !(await filesIn(resolved)).some(path => /(?:^|\/)licen[sc]e(?:\.|$)/i.test(path))) throw new Error(`external license missing: ${name}`);
    }
    for (const { directory, metadata } of packages) {
      const target = join(payload, 'node_modules', ...metadata.name.split('/'));
      await copyFiles(join(directory, 'dist'), join(target, 'dist'), productionFile);
      const dependencies = Object.fromEntries(Object.entries(metadata.dependencies ?? {}).map(([name, range]) => [name, name.startsWith('@ar/') ? versions[name] : range]));
      if (Object.values(dependencies).some(value => value === undefined)) throw new Error(`unresolved workspace dependency for ${metadata.name}`);
      await writeFile(join(target, 'package.json'), JSON.stringify({ ...metadata, main: './dist/index.js', types: './dist/index.d.ts', exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } }, dependencies, devDependencies: undefined, scripts: undefined }, null, 2) + '\n');
      await copyPackageNotices(directory, target);
      for (const name of Object.keys(dependencies)) await copyExternal(name, directory);
    }
    await copyFiles(join(snapshot, 'apps/web/public'), join(payload, 'node_modules/@ar/web/public'));
    await copyFiles(join(snapshot, 'third_party'), join(payload, 'third_party'));
    await cp(join(snapshot, 'scripts/release/portable-lib.mjs'), join(payload, 'portable-lib.mjs'));
    const launcher = `#!/usr/bin/env node\nimport { dirname, join } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nimport { verifyPortable } from './portable-lib.mjs';\nconst root = dirname(fileURLToPath(import.meta.url));\ntry {\n  const [major, minor] = process.versions.node.split('.').map(Number);\n  if (major < 22 || (major === 22 && minor < 19)) throw new Error('Harness Agent requires Node >=22.19.0');\n  const manifest = await verifyPortable(root);\n  if (process.argv[2] === '--version') console.log('harness-agent ' + manifest.version + ' source=' + manifest.sourceSha);\n  else if (process.argv[2] === 'web') await (await import('./node_modules/@ar/web/dist/main.js')).main();\n  else process.exitCode = await (await import('./node_modules/@ar/cli/dist/main.js')).main(process.argv);\n} catch (error) { console.error(error.message); process.exitCode = 1; }\n`;
    await writeFile(join(payload, 'agent.mjs'), launcher);
    await writeFile(join(payload, 'agent.sh'), '#!/bin/sh\nexec node "$(dirname "$0")/agent.mjs" "$@"\n', { mode: 0o755 });
    await writeFile(join(payload, 'agent.cmd'), '@ECHO off\r\nnode "%~dp0agent.mjs" %*\r\n');
    await writeFile(join(payload, 'agent.ps1'), '& node "$PSScriptRoot/agent.mjs" @args\nexit $LASTEXITCODE\n');
    await writeFile(join(payload, 'package.json'), JSON.stringify({ name: 'harness-agent-portable', version, private: true, type: 'module', engines: { node: '>=22.19.0' } }, null, 2) + '\n');
    await writeFile(join(payload, 'PROJECT-LICENSE-NOTICE.txt'), 'Harness Agent source repository does not declare a project-wide license. This portable build does not grant additional rights to that source. Preserve existing source copyright and third-party notices. Third-party licenses are under third_party/ and installed dependency directories; DeepSeek UI attribution is under node_modules/@ar/web/public/vendor/deepseek/.\n');
    await writeFile(join(payload, 'README.txt'), `Harness Agent ${version}\nSource ${sourceSha}\nRequires Node >=22.19.0; no npm/pnpm/Git/install step is needed to start. Project tasks can still require Git or project-specific tools.\nFrom your project directory: node <unpacked-dir>/agent.mjs doctor\nContinuous CLI: node <unpacked-dir>/agent.mjs chat <project-dir> [--verify "project check command"]\nChat commands: /help /status /new /quit. Approvals accept exactly allow or deny for one call. Ctrl-C cancels the current turn and keeps the conversation.\nResume: node <unpacked-dir>/agent.mjs chat <same-project-dir> --resume <session-id> [--verify "same check command"]\nList saved conversations: node <unpacked-dir>/agent.mjs --data-dir <same-chat-data-dir> sessions\nSingle task: node <unpacked-dir>/agent.mjs run <project-dir> "task" [--verify "project check command"]\nWeb: from the project directory, node <unpacked-dir>/agent.mjs web (default http://127.0.0.1:8787). Set HARNESS_VERIFY_COMMAND for the Web project check.\nConfigure OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL for your provider. Keyless startup uses a stub and does not prove coding quality.\nSet HARNESS_DATA_DIR to a stable absolute directory outside your project before CLI/Web startup for persistent sessions. Keep that directory and the same model/policy/check configuration when resuming; incompatible configurations fail visibly instead of replacing the session.\nOne CLI/Web host may own each data directory at a time; simultaneous hosts must use separate directories. Local ownership uses a fixed localhost listener and requires one machine/network namespace. Shared NFS directories across machines are unsupported.\nHARNESS_AGENT_PROMPT=coding-v1 opts into the engineering-verified challenger; chat selects this strategy by default. Real model quality remains NOT_PROVEN.\nDeveloper research/release gate commands require the original source repository and are not portable product functions.\nEvery startup verifies payload hashes; retain PORTABLE-MANIFEST.json and published SHA256SUMS.\n`);
    const fileRecords = await Promise.all((await filesIn(payload)).map(async path => { const bytes = await readFile(join(payload, ...path.split('/'))); return { path, bytes: bytes.length, sha256: digest(bytes) }; }));
    const manifest = { schemaVersion: 1, kind: 'harness-agent-portable', version, sourceSha, sourceTree, nodeMinimum: '22.19.0', build: { node: process.version, pnpm: pnpm(['--version'], snapshot).trim(), freshPinnedSnapshot: true }, sourcePackageVersions: versions, externalDependencies: Object.fromEntries(external), realModelQuality: 'NOT_PROVEN', files: fileRecords };
    await writeFile(join(payload, 'PORTABLE-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
    await verifyPortable(payload, { version, sourceSha });
    await mkdir(out, { recursive: true });
    const filename = `harness-agent-${version}-portable.tar.gz`;
    const archive = makeArchive(await Promise.all((await filesIn(payload)).map(async path => ({ path: `harness-agent-${version}/${path}`, bytes: await readFile(join(payload, ...path.split('/'))), executable: path === 'agent.sh' }))));
    await writeFile(join(out, filename), archive, { flag: 'wx' });
    await writeFile(join(out, 'SHA256SUMS'), `${digest(archive)}  ${filename}\n`, { flag: 'wx' });
    await writeFile(join(out, 'BUILD-RECEIPT.json'), JSON.stringify({ version, sourceSha, sourceTree, filename, sha256: digest(archive), files: fileRecords.length, sourcePackageVersions: versions, realModelQuality: 'NOT_PROVEN' }, null, 2) + '\n', { flag: 'wx' });
    await writeFile(join(out, 'build.log'), installLog + '\n' + buildLog);
    return { archive: join(out, filename), manifest };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export async function verifyArchive({ archive, out, version, sourceSha }) {
  const bytes = await readFile(archive);
  const root = await extractArchive(bytes, out);
  const manifest = await verifyPortable(root, { version, sourceSha });
  if (root.split(/[\\/]/).pop() !== `harness-agent-${manifest.version}`) throw new Error('archive root and manifest version differ');
  return { root, manifest, sha256: digest(bytes) };
}

async function main() {
  const { values, positionals } = parseArgs({ options: { repo: { type: 'string' }, out: { type: 'string' }, version: { type: 'string' }, 'source-sha': { type: 'string' }, archive: { type: 'string' }, offline: { type: 'boolean' }, 'store-dir': { type: 'string' } }, allowPositionals: true });
  const [command] = positionals;
  if (positionals.length !== 1 || !values.out) throw new Error('usage: portable.mjs build --out DIR --version V --source-sha SHA [--offline --store-dir DIR] | verify --archive FILE --out EMPTY_DIR --version V --source-sha SHA');
  const shared = { out: resolve(values.out), version: values.version, sourceSha: values['source-sha'] };
  let result;
  if (command === 'build') result = await buildPortable({ ...shared, repo: resolve(values.repo ?? process.cwd()), offline: values.offline, storeDir: values['store-dir'] });
  else if (command === 'verify' && values.archive && shared.version && shared.sourceSha) result = await verifyArchive({ ...shared, archive: resolve(values.archive) });
  else throw new Error('invalid portable command or missing --archive/--version/--source-sha');
  console.log(JSON.stringify({ status: 'PASS', archive: result.archive, root: result.root, version: result.manifest.version, sourceSha: result.manifest.sourceSha, files: result.manifest.files.length, sha256: result.sha256 }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
