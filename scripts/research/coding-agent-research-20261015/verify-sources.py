#!/usr/bin/env python3
"""Verify selected working-tree bytes AND pinned Git objects; no network."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--workspace', type=Path, default=Path('/workspace'))
parser.add_argument('--root', action='append', default=[], metavar='ID=PATH',
                    help='Override a repository checkout location (repeatable).')
args = parser.parse_args()
repo_root = Path(__file__).resolve().parents[3]
manifest = json.loads((repo_root / 'docs/evidence/coding-agent-research-20261015/sources.json').read_text())
overrides = dict(value.split('=', 1) for value in args.root)
repositories = {repo['id']: repo for repo in manifest['repositories']}
assert set(overrides) <= set(repositories), 'unknown repository override'
for item in manifest['files']:
    repo = repositories[item['repository']]
    root = Path(overrides.get(repo['id'], args.workspace / repo['checkoutDirectory']))
    relative = Path(item['path'])
    assert not relative.is_absolute() and '..' not in relative.parts, 'invalid source path'
    working = (root / relative).read_bytes()
    pinned = subprocess.check_output(['git', 'show', f"{repo['revision']}:{relative.as_posix()}"], cwd=root)
    assert working == pinned, f"{item['id']}: working bytes differ from pinned Git object"
    assert len(working) == item['bytes'], f"{item['id']}: length mismatch"
    assert hashlib.sha256(working).hexdigest() == item['sha256'], f"{item['id']}: digest mismatch"
print(json.dumps({'verdict': 'PASS', 'files': len(manifest['files']),
                  'repositories': len(repositories), 'networkRequests': 0}))
