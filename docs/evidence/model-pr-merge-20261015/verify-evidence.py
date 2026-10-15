#!/usr/bin/env python3
"""Validate archived bytes and source-bound receipts; does not rerun tests."""
from pathlib import Path, PurePosixPath
import hashlib,json,re,subprocess
root=Path(__file__).resolve().parent
manifest=json.loads((root/'inventory.json').read_text())
expected=set()
for item in manifest['files']:
 name=PurePosixPath(item['path'])
 assert not name.is_absolute() and '..' not in name.parts and str(name) not in expected
 expected.add(str(name)); path=root/name
 assert path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(root)
 assert len('docs/evidence/model-pr-merge-20261015/'+str(name))<=190
 data=path.read_bytes()
 assert len(data)==item['bytes'] and hashlib.sha256(data).hexdigest()==item['sha256'],str(name)
assert {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file() and p.name!='inventory.json'}==expected
result=json.loads((root/'result.json').read_text())
assert result['sourceSha']=='e3233deb03fa4039c0565d32302edebde994b556'
assert result['fullSuite']=={'command':'pnpm test','exitCode':0,'passed':9798,'skipped':15,'failed':0}
assert re.search(r'Tests\s+9798 passed\s*\|\s*15 skipped',(root/'combined-full-tests.log').read_text())
assert re.search(r'Tests\s+2146 passed',(root/'combined-security.log').read_text())
assert re.search(r'Tests\s+36 passed',(root/'pr10-fix-regressions.log').read_text())
http=json.loads((root/'coding-v2-hosts.json').read_text())
assert http['sourceSha']==result['sourceSha'] and http['sourceTreeClean'] and http['status']=='PASS'
assert http['paidModelCalls']==result['paidModelCalls']==0
assert result['localCapabilityAudit']['exitCode']==1 and result['localCapabilityAudit']['evidenceFresh']=='FAIL'
print(json.dumps({'archiveBytes':'PASS','sourceBoundReceipts':'PASS','files':len(expected),'fullSuitePassed':9798,'fullSuiteSkipped':15,'securityPassed':2146,'localCapabilityAudit':'MISSING_CURRENT_HEAD_GATE_EVIDENCE','limits':'Receipt integrity only; no test replay, no assertion that remote CI passed.'}))
