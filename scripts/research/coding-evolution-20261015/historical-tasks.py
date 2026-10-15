#!/usr/bin/env python3
"""Validate/prepare/verify pinned real-repository tasks; never calls a model."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[3]
catalog = json.loads((root / 'benchmarks/coding-repositories-v1/catalog.json').read_text())
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('action', choices=['validate', 'prepare', 'verify'])
parser.add_argument('--task')
parser.add_argument('--workspace', type=Path)
parser.add_argument('--revision', choices=['base', 'fixed'], default='base')
args = parser.parse_args()

def git(*arguments):
    return subprocess.check_output(['git', *arguments], cwd=root)

tasks = catalog['tasks']
assert len(tasks) >= 24 and len({task['id'] for task in tasks}) == len(tasks)
for task in tasks:
    assert git('rev-parse', task['fixedSha'] + '^').decode().strip() == task['baseSha']
    assert task['verification']['command'] == 'pnpm'
    assert task['verification']['args'] == ['exec', 'vitest', 'run', *[item['path'] for item in task['oracleFiles']]]
    for oracle in task['oracleFiles']:
        relative = Path(oracle['path'])
        assert not relative.is_absolute() and '..' not in relative.parts
        data = git('show', task['fixedSha'] + ':' + oracle['path'])
        assert hashlib.sha256(data).hexdigest() == oracle['sha256'] and len(data) == oracle['bytes']

if args.action == 'validate':
    print(json.dumps({'verdict': 'PASS', 'tasks': len(tasks), 'categories': sorted({task['category'] for task in tasks}),
                      'oracleIntegrity': 'PASS', 'modelCalls': 0, 'redGreenQualification': {task['id']: task['qualification'] for task in tasks}}))
    sys.exit(0)

task = next((task for task in tasks if task['id'] == args.task), None)
if task is None or args.workspace is None:
    parser.error('--task and --workspace are required')
workspace = args.workspace.resolve()
if args.action == 'prepare':
    if workspace.exists():
        parser.error('workspace must not exist; existing files are never replaced')
    revision = task['baseSha'] if args.revision == 'base' else task['fixedSha']
    subprocess.run(['git', '-c', 'core.longpaths=true', 'worktree', 'add', '--detach', str(workspace), revision], cwd=root, check=True)
    for oracle in task['oracleFiles']:
        path = workspace / oracle['path']
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(git('show', task['fixedSha'] + ':' + oracle['path']))
    print(json.dumps({'task': task['id'], 'workspace': str(workspace), 'revision': revision,
                      'next': 'Install frozen dependencies and build here, then verify. No model or package commands were run.'}))
else:
    def intact():
        return all((workspace / item['path']).is_file() and not (workspace / item['path']).is_symlink()
                   and hashlib.sha256((workspace / item['path']).read_bytes()).hexdigest() == item['sha256'] for item in task['oracleFiles'])
    if not intact():
        raise SystemExit('ORACLE_INTEGRITY: missing, replaced or changed fixed tests')
    result = subprocess.run([task['verification']['command'], *task['verification']['args']], cwd=workspace)
    if not intact():
        raise SystemExit('ORACLE_INTEGRITY: tests changed during verification')
    sys.exit(result.returncode)
