#!/usr/bin/env python3
"""Verify archived receipt bytes, not a test replay."""
from pathlib import Path,PurePosixPath
import hashlib,json,re
root=Path(__file__).resolve().parent
manifest=json.loads((root/'inventory.json').read_text()); expected=set()
for item in manifest['files']:
 name=PurePosixPath(item['path']);assert not name.is_absolute() and '..' not in name.parts and str(name) not in expected
 expected.add(str(name));p=root/name
 assert p.is_file() and not p.is_symlink() and p.resolve().is_relative_to(root)
 assert len('docs/evidence/web-running-20261015/'+str(name))<=190
 data=p.read_bytes();assert len(data)==item['bytes'] and hashlib.sha256(data).hexdigest()==item['sha256'],str(name)
assert {p.name for p in root.iterdir() if p.is_file() and p.name!='inventory.json'}==expected
r=json.loads((root/'result.json').read_text())
assert r['fullSuite']=={'exitCode':0,'passed':9799,'skipped':15,'failed':0}
for name,pattern in [('full-tests-fixed.log',r'Tests\s+9799 passed\s*\|\s*15 skipped'),('security-fixed.log',r'Tests\s+2146 passed'),('regression-before.log',r'Tests\s+1 failed'),('focused-fixed.log',r'Tests\s+35 passed')]:
 assert re.search(pattern,(root/name).read_text()),name
p=json.loads((root/'browser-result.json').read_text())
assert p['status']=='PASS' and p['rpcMocks'] is False and [a['stuckAfterDurableCompletion'] for a in p['records']]==[True,False]
assert p['records'][1]['sourceSha']==r['sourceSha']
assert all(j['conclusion']=='success' for j in json.loads((root/'branch-ui-jobs.json').read_text())['jobs'])
print(json.dumps({'archiveBytes':'PASS','counterexampleAndFixReceipts':'PASS','files':len(expected),'sourceSha':r['sourceSha'],'limits':'Receipt integrity only; no test replay or assertion about a later main CI run.'}))
