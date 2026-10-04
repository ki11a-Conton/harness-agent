from pathlib import Path
from hashlib import sha256
import json,datetime
repo=Path('/workspace/harness-agent-agent-round2'); root=Path('/workspace/harness-agent/.ci/agent-round2-20261004/verification-target'); out=root.parent/'independent-review'
read=lambda p:json.loads(p.read_text()); idx=read(root/'artifact-index.json'); files=idx.get('files',idx.get('artifacts'));count=0
for f in files:
 data=(root/f['path']).read_bytes();assert len(data)==f['bytes'] and sha256(data).hexdigest()==f['sha256'],f['path'];count+=1
manifest=read(root/'t1-final-manifest.json')
for f in manifest['files']:
 data=(repo/f['path']).read_bytes();assert len(data)==f['bytes'] and sha256(data).hexdigest()==f['sha256'],f['path']
b=root/'portable-candidate-final';r=read(b/'verification-measurement.json');assert r['verificationIntegrityPass'];cases=[]
for c in r['receipts']:
 assert c['passed'];h=c.get('harness');events=[]
 if h:
  f=h['eventArtifact'];data=(b/f['path']).read_bytes();assert len(data)==f['bytes'] and sha256(data).hexdigest()==f['sha256'];events=json.loads(data)
  assert h['toolRequests']==0
 if c['name'] in ['quoted-required-failure','compound-required-failure','discovery-root-truncated','legacy-cache-upgrade','explicit-argv-failure','empty-verification']:
  assert h['outcome']['terminationReason']=='verification_failed' and h['outcome']['status']=='failed'
  assert any(e['type']=='verification.failed' for e in events)
  if c['name']!='empty-verification':assert any(e['type']=='verification.step_completed' and e['payload']['passed'] is False for e in events)
 if c['name'] in ['quoted-required-failure','compound-required-failure']:
  assert c['rawOutcome']['exitCode']==(7 if c['name']=='quoted-required-failure' else 9);assert c['convertedResult']['passed'] is False
  assert all(s['command']==c['originalRecipe'] and 'args' not in s for s in c['specs'])
 if c['name']=='discovery-root-truncated': assert c['rawOutcome']['exitCode']==11 and len(c['discovery']['discovered'])==60 and c['canonicalRetained']
 if c['name']=='legacy-cache-upgrade':assert c['rediscoveredHints']['discoveryVersion']=='root-entrypoints-v1' and c['rediscoveredHints']['commands']['test']=='node required-fail.cjs'
 if c['name']=='current-cache-warm-control':assert c['warmHints']==c['rediscoveredHints']
 cases.append({'name':c['name'],'passed':c['passed'],'rawExit':c.get('rawOutcome',{}).get('exitCode'),'harnessTermination':h['outcome']['terminationReason'] if h else None,'scriptedStopCalls':h['scriptedCalls'] if h else 0,'failedEventVerified':any(e['type']=='verification.failed' for e in events)})
t=read(root/'target-complete.json');assert t['success'] and t['numPassedTests']==89 and t['numFailedTests']==0 and t['numPendingTests']==3
result={'schema':'agent-round2-independent-verification-v1','observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'stage':'T1 source/target/probe evidence independently reviewed while dirty source frozen; clean full/CI acceptance remains root responsibility.','reviewedHead':manifest['sourceSha'],'sourceFingerprints':manifest['files'],'originalArtifactsChecked':count,'ownerTargetTests':{'passed':89,'failed':0,'skipped':3},'cases':cases,'status':'PASS','paidCalls':0,'realModelQuality':'NOT_RUN','promotion':'NOT_RUN'}
(out/'verification-review.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'status':'PASS','originalArtifactsChecked':count,'cases':len(cases),'targetTests':result['ownerTargetTests']},ensure_ascii=False))
