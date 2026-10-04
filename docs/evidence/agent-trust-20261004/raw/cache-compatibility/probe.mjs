import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const repo = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const { CommandDiscoveryService } = await import(join(repo, 'packages/harness/dist/command-discovery-service.js'));
const root = await mkdtemp(join(tmpdir(), 'verification-cache-'));
try {
  const dataDir = join(root, '.agent-data');
  await mkdir(dataDir);
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(11)"' } }));
  for (let n = 0; n < 61; n++) {
    const dir = join(root, 'packages', `p${String(n).padStart(2, '0')}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  }
  const first = new CommandDiscoveryService({ dataDir, now: () => 1000 });
  const discovered = await first.maybeDiscover(root);
  const second = new CommandDiscoveryService({ dataDir, now: () => 2000 });
  await second.loadPersisted();
  const reloaded = await second.maybeDiscover(root);
  const record = { repo, sourceSha: (await import('node:child_process')).execFileSync('git', ['rev-parse','HEAD'], { cwd: repo, encoding:'utf8' }).trim(), rootManifestTest: 'node -e "process.exit(11)"', discovered, reloaded, persistedLine: await readFile(join(dataDir, 'command-hints.jsonl'), 'utf8'), selectedRootTest: reloaded.commands.test === 'node -e "process.exit(11)"' };
  await writeFile(output, JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ selectedRootTest: record.selectedRootTest, discoveredTest: discovered.commands.test, reloadedTest: reloaded.commands.test, discoveredAt: reloaded.discoveredAt }));
} finally { await rm(root, { recursive: true, force: true }); }
