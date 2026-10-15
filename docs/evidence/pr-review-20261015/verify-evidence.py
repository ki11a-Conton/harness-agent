#!/usr/bin/env python3
"""Check the archived review bytes and recorded conclusions; not a test replay."""
import hashlib
import json
import re
from pathlib import Path, PurePosixPath

root = Path(__file__).resolve().parent
manifest = json.loads((root / 'inventory.json').read_text())
expected = set()
for item in manifest['files']:
    name = PurePosixPath(item['path'])
    assert not name.is_absolute() and '..' not in name.parts and str(name) not in expected
    expected.add(str(name))
    path = root / name
    assert path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(root)
    assert len('docs/evidence/pr-review-20261015/' + str(name)) <= 190
    data = path.read_bytes()
    assert len(data) == item['bytes'] and hashlib.sha256(data).hexdigest() == item['sha256'], str(name)
actual = {path.relative_to(root).as_posix() for path in root.rglob('*') if path.is_file() and path.name != 'inventory.json'}
assert actual == expected
result = json.loads((root / 'review-result.json').read_text())
assert result['combinedTests'] == {'passed': 9795, 'skipped': 15, 'failed': 0}
assert result['securityTests']['passed'] == 2146 and result['paidModelCalls'] == 0
assert re.search(r'Tests\s+9795 passed\s*\|\s*15 skipped', (root / 'combined-full-tests.log').read_text())
assert re.search(r'Tests\s+2146 passed', (root / 'combined-security.log').read_text())
assert 'Tests  1 failed' in (root / 'pr10-executor-reproducer.log').read_text()
assert 'Tests  1 passed' in (root / 'pr10-executor-exact-main-baseline.log').read_text()
assert 'Tests  36 passed' in (root / 'pr10-proposed-fix-tests.log').read_text()
original = json.loads((root / 'archive-runs.json').read_text())
assert len(original) == 4 and all(run['conclusion'] == 'failure' for run in original)
latest = json.loads((root / 'archive-fix-runs.json').read_text())
assert all(run['head_sha'] == result['archiveFixSha'] for run in latest)
ui = next(run for run in latest if run['name'] == 'official DeepSeek UI installed acceptance')
assert ui['conclusion'] == 'failure' and ui['run_attempt'] == 2
print(json.dumps({'archivedBytes': 'PASS', 'recordedReview': 'PASS', 'files': len(expected),
                  'ciOverall': 'NOT_GREEN', 'pr9': 'no blocking finding', 'pr10': 'P2 fix required',
                  'limits': 'Receipt integrity only. CI failures remain failures; this does not rerun tests.'}))
