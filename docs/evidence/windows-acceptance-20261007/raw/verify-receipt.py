#!/usr/bin/env python3
"""Verify the archived genuine-Windows public receipt, offline (no token needed)."""
import base64
import gzip
import hashlib
import json
from pathlib import Path
import re
import sys

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent
load = lambda name: json.loads((root / name).read_text(encoding='utf-8'))
jobs = load('final-native-jobs.json')['jobs']
assert len(jobs) == 1, 'expected exactly one native acceptance job'
job = jobs[0]
assert job['name'] == 'native-windows' and job['conclusion'] == 'success'
assert job['labels'] == ['windows-latest'] and job['runner_group_name'] == 'GitHub Actions'
assert job['check_run_url'].endswith('/check-runs/' + str(job['id']))
annotations = load('final-native-annotations.json')
receipts = [a for a in annotations if a['title'] == 'Windows acceptance receipt']
assert len(receipts) == 1
receipt = json.loads(receipts[0]['message'])
assert receipt['platform'] == 'win32' and receipt['osType'] == 'Windows_NT'
assert receipt['sourceSha'] == receipt['workflowSha'] == job['head_sha']
assert re.fullmatch('[a-f0-9]{40}', receipt['sourceSha'])
assert receipt['treeClean'] is True and receipt['outcome'] == 'PASS' and receipt['issues'] == []
assert receipt['runId'] == str(job['run_id']) and receipt['runAttempt'] == str(job['run_attempt'])
assert receipt['job'] == job['name'] and receipt['paidModelExperiment'] == 'NOT_RUN'
packet_annotations = [a for a in annotations if a['title'].startswith('Windows case records chunk ')]
packets = [json.loads(a['message']) for a in packet_annotations]
assert packets and all(p['encoding'] == 'gzip+base64' for p in packets)
total = packets[0]['total']
assert 1 <= total <= 9 and len(packets) == total
assert all(p['total'] == total for p in packets)
assert sorted(p['index'] for p in packets) == list(range(total))
for a in receipts + packet_annotations:
    assert '/' + receipt['sourceSha'] + '/' in a['blob_href'], 'foreign-source annotation'
    assert a['annotation_level'] == 'notice'
raw = gzip.decompress(base64.b64decode(''.join(p['data'] for p in sorted(packets, key=lambda p: p['index'])), validate=True))
assert hashlib.sha256(raw).hexdigest() == receipt['caseRecordsSha256']
files = json.loads(raw)
assert len(files) == receipt['files']
assert len({f['file'] for f in files}) == len(files)
assertions = [test for f in files for test in f['assertions']]
assert sum(t['status'] == 'passed' for t in assertions) == receipt['passed']
assert sum(t['status'] == 'failed' for t in assertions) == receipt['failed'] == 0
assert sum(t['status'] not in ['passed', 'failed'] for t in assertions) == receipt['skipped']
assert len(receipt['required']) == 12
assert len({t['name'] for t in receipt['required']}) == 12
for required in receipt['required']:
    observed = [t['status'] for t in assertions if t['name'] == required['name']]
    assert observed == required['observed'] == ['passed'], 'required test missing or not passed'
for mode in ['cancel', 'timeout']:
    name = f'Windows native process-tree completion boundary {mode} waits for both the child and its real grandchild to terminate'
    assert name in {t['name'] for t in receipt['required']}
assert load('final-native-receipt.json') == dict(receipt, caseRecords=files), 'derived archive does not match public packets'
artifacts = load('final-native-artifacts.json')['artifacts']
assert len(artifacts) == 1
artifact = artifacts[0]
assert artifact['workflow_run']['id'] == job['run_id']
assert artifact['workflow_run']['head_sha'] == receipt['sourceSha']
assert re.fullmatch('sha256:[a-f0-9]{64}', artifact['digest'])
print(json.dumps({'outcome': 'PASS', 'sourceSha': receipt['sourceSha'], 'runId': receipt['runId'], 'jobId': job['id'], 'caseRecordsSha256': receipt['caseRecordsSha256'], 'files': receipt['files'], 'passed': receipt['passed'], 'failed': receipt['failed'], 'skipped': receipt['skipped'], 'requiredNativeTestsPassed': len(receipt['required']), 'artifactDigest': artifact['digest'], 'artifactDigestVerification': 'GITHUB_METADATA_ONLY_NOT_DOWNLOADED'}, indent=2))
