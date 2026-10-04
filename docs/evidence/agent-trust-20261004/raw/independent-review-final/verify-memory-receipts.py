from pathlib import Path
from hashlib import sha256
import json,datetime
repo=Path('/workspace/harness-agent-agent-round2'); root=Path('/workspace/harness-agent/.ci/agent-round2-20261004/memory-target'); out=root.parent/'independent-review'
read=lambda p: json.loads(p.read_text()); hashed=[]
for f in read(root/'memory-artifact-index.json')['files']:
 data=(root/f['path']).read_bytes(); assert len(data)==f['bytes'] and sha256(data).hexdigest()==f['sha256'];hashed.append(f)
manifest=read(root/'memory-implementation-manifest.json')
for f in manifest['files']:
 data=(repo/f['path']).read_bytes(); assert len(data)==f['bytes'] and sha256(data).hexdigest()==f['sha256'],f['path']
trials=[]
for label in ['portable-baseline','portable-candidate']:
 b=root/label;report=read(b/'report.json');items=[]
 for f in report['receiptFiles']:
  data=(b/f['path']).read_bytes();assert len(data)==f['bytes'] and sha256(data).hexdigest()==f['sha256']
  if not f['path'].endswith('-request.json'):continue
  d=json.loads(data);assert len(d['requests'])==1
  forbidden=any(f['path'].endswith('-'+mode+'-request.json') for mode in ['session-mismatch','deprecated','superseded','stale','conflicting'])
  marker=d['entry']['content'];seen=marker in d['requests'][0]['system'];refs=d['outcome']['memoryRefs'];assert d['outcome']['status']=='completed'
  if label=='portable-candidate':
   assert seen != forbidden
   assert ((d['entry']['id'] in refs) != forbidden)
   if forbidden:assert d.get('usefulness') is None
   else:assert d['usefulness']['injectedCount']==1
  else:assert seen
  items.append({'path':f['path'],'forbidden':forbidden,'seen':seen,'memoryRefs':refs,'scriptedRequests':len(d['requests'])})
 assert len(items)==18
 for p,h in report['sourceHashes'].items():
  if label=='portable-candidate': assert sha256((repo/p).read_bytes()).hexdigest()==h,p
 trials.append({'label':label,'requestCount':len(items),'forbiddenRequestCount':sum(x['forbidden'] for x in items),'forbiddenBodiesSeen':sum(x['seen'] for x in items if x['forbidden']),'allowedBodiesSeen':sum(x['seen'] for x in items if not x['forbidden']),'allReportChecks':len(report['checks']),'reportChecksPassing':sum(c['pass'] for c in report['checks']),'requests':items})
target=read(root/'memory-target-green.json');assert target['success'] and target['numPassedTests']==209 and target['numFailedTests']==0
r={'schema':'agent-round2-independent-memory-v1','observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'stage':'Independent review of T2 frozen dirty-stage source and owner original target/request receipts; no clean/full/CI acceptance claim.','reviewedHead':manifest['sourceHead'],'sourceFingerprints':manifest['files'],'originalArtifactsChecked':len(hashed),'requestEvidence':trials,'ownerTargetTests':{'passed':209,'failed':0},'status':'PASS','paidCalls':0,'realModelQuality':'NOT_RUN','promotion':'NOT_RUN'}
(out/'memory-review.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'status':r['status'],'originalArtifactsChecked':len(hashed),'trials':[{k:v for k,v in t.items() if k!='requests'} for t in trials]},ensure_ascii=False))
