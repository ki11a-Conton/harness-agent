#!/usr/bin/env python3
"""Prepare/verify pinned external repository tasks, without calling a model."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[3]
CATALOG = json.loads((ROOT / 'benchmarks/coding-repositories-v1/upstream-seeded.json').read_text())
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('action', choices=['prepare', 'verify'])
parser.add_argument('--task', required=True)
parser.add_argument('--source-repo', type=Path)
parser.add_argument('--workspace', type=Path, required=True)
parser.add_argument('--receipt', type=Path, required=True, help='Host-controlled path outside the model workspace')
parser.add_argument('--revision', choices=['seeded', 'fixed'], default='seeded')
parser.add_argument('--python', type=Path, help='Python with the task bootstrap requirements installed')
args = parser.parse_args()
task = next((item for item in CATALOG['tasks'] if item['id'] == args.task), None)
if task is None:
    parser.error('unknown task')
workspace = args.workspace.resolve()
receipt = args.receipt.resolve()
if receipt.is_relative_to(workspace):
    parser.error('receipt must be outside the model workspace')

def sha(data):
    return hashlib.sha256(data).hexdigest()

def integrity(files):
    for item in files:
        path = workspace / item['path']
        if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(workspace):
            return False
        if sha(path.read_bytes()) != item['sha256']:
            return False
    return True

if args.action == 'prepare':
    if workspace.exists() or receipt.exists() or args.source_repo is None:
        parser.error('source repo required; workspace and receipt must not exist')
    source = task['source']
    workspace.mkdir(parents=True)
    archive = subprocess.Popen(['git', 'archive', source['snapshotSha'] + ':' + source['subdirectory']], cwd=args.source_repo, stdout=subprocess.PIPE)
    with tarfile.open(fileobj=archive.stdout, mode='r|') as stream:
        stream.extractall(workspace, filter='data')
    if archive.wait() != 0:
        raise SystemExit('SOURCE_ARCHIVE_FAILED')
    seed = task['seed']
    path = workspace / seed['path']
    original = path.read_bytes()
    if sha(original) != seed['originalSha256'] or not integrity(task['oracleFiles']):
        raise SystemExit('SOURCE_OR_ORACLE_IDENTITY_MISMATCH')
    if args.revision == 'seeded':
        mutated = original.decode().replace(seed['before'], seed['after'], 1).encode()
        if sha(mutated) != seed['seededSha256']:
            raise SystemExit('SEED_IDENTITY_MISMATCH')
        path.write_bytes(mutated)
    git = ['git', '-c', 'user.name=Harness Benchmark', '-c', 'user.email=benchmark@localhost']
    env = {**os.environ, 'GIT_AUTHOR_DATE': '2026-10-15T00:00:00Z', 'GIT_COMMITTER_DATE': '2026-10-15T00:00:00Z'}
    for command in [['init', '-q'], ['add', '.'], ['commit', '-qm', 'Prepared benchmark snapshot; seeded defect is not upstream history']]:
        subprocess.run(git + command, cwd=workspace, env=env, check=True)
    user = task['initialUserChanges']
    tracked = workspace / user['trackedPath']
    tracked.write_bytes(tracked.read_bytes() + user['append'].encode())
    (workspace / user['untrackedPath']).write_text(user['content'])
    guards = [{'path': name, 'sha256': sha((workspace / name).read_bytes())} for name in [user['trackedPath'], user['untrackedPath']]]
    data = {'task': task['id'], 'catalogSha256': sha((ROOT / 'benchmarks/coding-repositories-v1/upstream-seeded.json').read_bytes()), 'source': source, 'revision': args.revision,
            'preparedGitSha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=workspace).decode().strip(), 'oracleFiles': task['oracleFiles'], 'userGuards': guards, 'paidModelCalls': 0}
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_text(json.dumps(data, indent=2) + '\n')
    print(json.dumps(data))
else:
    data = json.loads(receipt.read_text())
    if data['task'] != task['id'] or data['source'] != task['source'] or data['oracleFiles'] != task['oracleFiles']:
        raise SystemExit('RECEIPT_IDENTITY_MISMATCH')
    protected = [*task['oracleFiles'], *data['userGuards']]
    if not integrity(protected) or args.python is None:
        raise SystemExit('ORACLE_OR_USER_CHANGE_INTEGRITY_FAILED_OR_PYTHON_MISSING')
    env = {**os.environ, 'HERMES_PYTHON': str(args.python.absolute())}
    result = subprocess.run([task['verification']['command'], *task['verification']['args']], cwd=workspace, env=env)
    if not integrity(protected):
        raise SystemExit('ORACLE_OR_USER_CHANGES_MODIFIED')
    raise SystemExit(result.returncode)
