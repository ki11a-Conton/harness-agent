#!/usr/bin/env python3
"""Offline integrity, final-test and genuine-Windows receipt verification."""
import base64, gzip, hashlib, json, re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
def load(name):
    p = root / name
    return json.loads(gzip.decompress(p.read_bytes()) if p.suffix == '.gz' else p.read_bytes())
manifest = load('RAW-MANIFEST.json')
seen = set()
for entry in manifest['files']:
    path = Path(entry['path'])
    assert not path.is_absolute() and '..' not in path.parts and entry['path'] not in seen
    seen.add(entry['path']); p = root / path
    assert not p.is_symlink() and root in p.resolve().parents
    data = p.read_bytes()
    assert len(data) == entry['bytes'] and hashlib.sha256(data).hexdigest() == entry['sha256'], entry['path']
summary = load('acceptance-summary.json'); sha = summary['testedSourceSha']
full = load('raw/round2-final-full-suite.json.gz')
assert full['success'] is True and full['numFailedTests'] == 0
assert full['numPassedTests'] == summary['linux']['passed']
sub = load('raw/subreaper-run-receipt.json')
assert sub['sourceSha'] == sha and sub['sourceUnchanged'] is True and sub['exitCode'] == 0
browser = load('browser/browser-result.json')
assert browser['source']['sourceSha'] == sha and browser['status'] == 'PASS'
assert browser['failed'] == browser['browserErrorCount'] == 0
assert browser['caseCount'] == 27 and browser['assertCount'] == 77
assert browser['cleanup']['finalSourceSha'] == sha and browser['cleanup']['changedFingerprints'] == []
assert browser['cleanup']['graceful'] is True and browser['cleanup']['exitCode'] == 0
jobs = load('raw/round2-final-windows-jobs.json')['jobs']
assert len(jobs) == 1
job = jobs[0]
assert job['name'] == 'native-windows' and job['conclusion'] == 'success'
assert job['labels'] == ['windows-latest'] and job['runner_group_name'] == 'GitHub Actions'
annotations = load('raw/round2-final-windows-annotations.json')
receipts = [a for a in annotations if a['title'] == 'Windows acceptance receipt']
assert len(receipts) == 1
receipt = json.loads(receipts[0]['message'])
assert receipt == load('raw/round2-final-windows-receipt.json')
assert receipt['platform'] == 'win32' and receipt['osType'] == 'Windows_NT'
assert receipt['sourceSha'] == receipt['workflowSha'] == job['head_sha'] == sha
assert receipt['treeClean'] is True and receipt['outcome'] == 'PASS' and receipt['issues'] == []
assert receipt['runId'] == str(job['run_id']) and receipt['runAttempt'] == str(job['run_attempt'])
assert receipt['paidModelExperiment'] == 'NOT_RUN'
packet_annotations = [a for a in annotations if a['title'].startswith('Windows case records chunk ')]
packets = [json.loads(a['message']) for a in packet_annotations]
assert packets and all(p['encoding'] == 'gzip+base64' for p in packets)
total = packets[0]['total']
assert 1 <= total <= 9 and len(packets) == total
assert all(p['total'] == total for p in packets) and sorted(p['index'] for p in packets) == list(range(total))
for a in receipts + packet_annotations:
    assert '/' + sha + '/' in a['blob_href'] and a['annotation_level'] == 'notice'
raw = gzip.decompress(base64.b64decode(''.join(p['data'] for p in sorted(packets, key=lambda p: p['index'])), validate=True))
assert hashlib.sha256(raw).hexdigest() == receipt['caseRecordsSha256']
assert raw == (root / 'raw/round2-final-windows-case-records.json').read_bytes()
files = json.loads(raw); assertions = [a for f in files for a in f['assertions']]
assert len(files) == receipt['files'] == 13
assert sum(t['status'] == 'passed' for t in assertions) == receipt['passed'] == 179
assert sum(t['status'] == 'failed' for t in assertions) == receipt['failed'] == 0
assert sum(t['status'] not in ['passed', 'failed'] for t in assertions) == receipt['skipped'] == 1
assert len(receipt['required']) == 12 and len({t['name'] for t in receipt['required']}) == 12
for required in receipt['required']:
    assert [t['status'] for t in assertions if t['name'] == required['name']] == required['observed'] == ['passed']
ci = load('raw/round2-final-ci-jobs.json')['jobs']
assert len(ci) == 10 and all(j['head_sha'] == sha and j['conclusion'] == 'success' for j in ci)
ci_run = load('raw/round2-final-ci-run.json')
assert ci_run['head_sha'] == sha and ci_run['conclusion'] == 'success'
forensics = load('raw/round2-original-formal-failure.json')
assert hashlib.sha256(forensics['excerpt'].encode()).hexdigest() == forensics['excerptSha256']
assert forensics['originalSourceSha'] == summary['baselineSha']
assert forensics['failedPhase'] == 'test' and 'Hook timed out in 10000ms.' in forensics['excerpt']
fa = load('raw/round2-forensics-annotations.json')
fp = [json.loads(a['message']) for a in fa if a['title'].startswith('Original formal failure ')]
assert fp and len(fp) == fp[0]['total'] and all(p['total'] == fp[0]['total'] and p['encoding'] == 'gzip+base64' for p in fp)
assert sorted(p['index'] for p in fp) == list(range(len(fp)))
fr = gzip.decompress(base64.b64decode(''.join(p['data'] for p in sorted(fp, key=lambda p: p['index'])), validate=True))
assert json.loads(fr) == forensics
mutation = load('raw/round2-duration-mutation.json')
assert mutation['totalMutations'] == mutation['caught'] == 1
assert all(m['applied'] and m['restored'] and m['failedTestNamed'] for m in mutation['mutations'])
print(json.dumps({'outcome': 'PASS', 'testedSourceSha': sha, 'filesVerified': len(seen), 'linuxPassed': full['numPassedTests'], 'windowsPassed': receipt['passed'], 'requiredNativeTestsPassed': 12, 'ciJobsSuccess': len(ci), 'rawWindowsVitestAndZip': 'RUNNER_METADATA_ONLY_NOT_DOWNLOADED'}, indent=2))
