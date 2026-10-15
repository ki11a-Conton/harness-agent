#!/usr/bin/env python3
"""Check archived bytes and source-bound receipts, without replaying tests or models."""
import hashlib
import json
import re
from pathlib import Path, PurePosixPath

root = Path(__file__).resolve().parent
manifest = json.loads((root / 'inventory.json').read_text())
source = manifest['sourceSha']
assert re.fullmatch(r'[a-f0-9]{40}', source)
paths = set()
for item in manifest['files']:
    name = PurePosixPath(item['path'])
    assert not name.is_absolute() and '..' not in name.parts and str(name) == item['path']
    assert str(name) not in paths
    paths.add(str(name))
    path = root / name
    assert path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(root)
    data = path.read_bytes()
    assert len(data) == item['bytes'] and hashlib.sha256(data).hexdigest() == item['sha256'], name
actual = {str(path.relative_to(root)) for path in root.rglob('*') if path.is_file() and path.name != 'inventory.json'}
assert actual == paths, (actual - paths, paths - actual)

def load(name):
    return json.loads((root / name).read_text())

for name in ['installed-ui/result.json', 'installed-cli/result.json', 'coding-v2-hosts/result.json',
             'coding-evolution-installed-tools-4ee21776.json']:
    receipt = load(name)
    assert receipt['sourceSha'] == source and receipt['status'] == 'PASS' and receipt['paidModelCalls'] == 0, name
cli, ui, hosts = [load(name + '/result.json') for name in ['installed-cli', 'installed-ui', 'coding-v2-hosts']]
assert cli['codingAssertions'] == 50 and cli['requests'] == 19 and cli['workspaceLinks'] == 0
assert cli['tamperRejected'] and cli['tamperedStartupRejected']
assert ui['cases'] == 30 and ui['assertions'] == 75 and ui['connectionAssertions'] == 10
assert hosts['policy'] == 'coding-v2' and len(hosts['assertions']) == 8 and hosts['sourceTreeClean']
assert hosts['inheritedCodingAssertions'] == 50 and hosts['requests'] == 19
assert cli['archiveSha256'] == ui['archiveSha256'] == manifest['portableArchiveSha256']
panel, launch, exit_receipt = [load(name) for name in [
    'installed-panel/browser.json', 'installed-live/launch.json', 'installed-live/host-exit.json']]
assert panel['verdict'] == 'PASS' and panel['paidCalls'] == 0 and len(panel['checks']) == 12
assert all(check['status'] == 'PASS' for check in panel['checks'])
assert launch['sourceSha'] == source and launch['installed'] and launch['paidModelCalls'] == 0
assert panel['compiledDigest'] == launch['compiledDigest']
assert exit_receipt['launchId'] == launch['launchId'] and exit_receipt['code'] == 0 and exit_receipt['paidModelCalls'] == 0
measurement = load('retrieval/measurement.json')
assert measurement['sourceSha'] == source and measurement['sourceClean'] and measurement['corpus']['queries'] == 30
assert len(measurement['families']) == 3 and all(row['exactDefinitions'] == 10 and row['relevantRecallAt5'] == 1 for row in measurement['families'])
test_log = (root / 'coding-evolution-final-4ee21776-tests.log').read_text()
security_log = (root / 'coding-evolution-security-4ee21776.log').read_text()
assert re.search(r'Tests\s+9794 passed\s*\|\s*15 skipped\s*\(9809\)', test_log)
assert re.search(r'Tests\s+2146 passed\s*\(2146\)', security_log)
python = load('python-upstream/summary.json')
assert python['paidModelCalls'] == 0 and len(python['results']) == 4
assert all(row['exit'] == (0 if row['side'] == 'fixed' else 1) for row in python['results'])
ci = load('ci/latest.json')
names = {run['name'] for run in ci['runs']}
assert {'ci', 'genuine Windows acceptance', 'first-generation installed acceptance',
        'official DeepSeek UI installed acceptance'} <= names
assert all(run['head_sha'] == source and run['status'] == 'completed' and run['conclusion'] == 'success' for run in ci['runs'])
assert all(job['head_sha'] == source and job['status'] == 'completed' and job['conclusion'] in ['success', 'skipped'] for job in ci['jobs'])
print(json.dumps({'archivedBytes': 'PASS', 'sourceBoundReceipts': 'PASS', 'files': len(paths),
                  'sourceSha': source, 'limits': 'Integrity and receipt verification only; not a test suite or paid model replay.'}))
