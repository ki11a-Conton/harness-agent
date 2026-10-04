from pathlib import Path
from hashlib import sha256
import json,datetime
repo=Path('/workspace/harness-agent-agent-round2');root=Path('/workspace/harness-agent/.ci/agent-round2-20261004/reflection-persistence-target');out=root.parent/'independent-review'
read=lambda p:json.loads(p.read_text());manifest=read(root/'final-manifest.json');checked=[]
for group in [root,root.parent/'reflection-target']:
 idx=read(group/'artifact-index.json')
 for f in idx.get('files',idx.get('artifacts')):
  data=(group/f['path']).read_bytes();assert len(data)==f['bytes'] and sha256(data).hexdigest()==f['sha256'],(group.name,f['path']);checked.append({'group':group.name,**f})
for f in manifest['ownedFiles']:
 data=(repo/f['path']).read_bytes();assert len(data)==f['bytes'] and sha256(data).hexdigest()==f['sha256'],f['path']
b=root/'candidate-portable';report=read(b/'report.json');assert report['summary']['checks']==23 and report['summary']['passed']==23
for f in report['sources']:assert sha256((repo/f['path']).read_bytes()).hexdigest()==f['sha256'],f['path']
for label in ['tagged','legacy']:
 d=read(b/f'old-mcp-new-clean-{label}.json');assert d['newResult']=={'outputs':0,'candidates':0};assert len(d['journal'])==len(d['candidates'])==1;sc=d['candidates'][0]['sourceCandidate'];assert sc['sourceTurn']==d['oldTurn'] and sc['promotionState']=='quarantined'
f=read(b/'old-legacy-pollution-new-failure.json');sc=next(c for c in f['candidates'] if c['sourceCandidate']['sourceTurn']==f['newTurn'])['sourceCandidate'];assert sc['promotionState']=='pending' and f['newFailureId'] in sc['structured']['evidenceRefs'] and f['oldFailureId'] not in sc['structured']['evidenceRefs']
concurrency=[]
for label in [f'concurrent-journal-{i}' for i in range(10)]+['multi-instance-journal']:
 d=read(b/f'{label}.json');assert d['pass'];p=b/'fixtures'/label
 journal=(p/'reflection-outputs.jsonl').read_bytes();assert len(journal)==d['journalBytes'] and sha256(journal).hexdigest()==d['journalSha256'];records=[json.loads(x) for x in journal.splitlines()];assert records==d['journal']
 cb=(p/'learning-candidates.jsonl').read_bytes();candidates=[json.loads(x)['candidate'] for x in cb.splitlines()];inputs={x['turnId']:x['sessionId'] for x in d['inputs']};assert len(inputs)==len(records)==len(candidates)==20
 assert set(inputs)=={x['turnId'] for x in records}=={x['sourceCandidate']['sourceTurn'] for x in candidates}
 for c in candidates:
  sc=c['sourceCandidate'];turn=sc['sourceTurn'];assert sc['sourceSession']==inputs[turn]
  wrappers=[json.loads(x) for x in (p/'events'/f'{inputs[turn]}.jsonl').read_text().splitlines()];assert all(x['schemaVersion']==1 for x in wrappers);evs=[x['event'] for x in wrappers]
  ids={x['id'] for x in evs if x.get('turnId')==turn};assert set(sc['structured']['evidenceRefs'])<=ids
 concurrency.append({'label':label,'rows':20,'matchingInputJournalCandidateTurns':20,'candidateBytes':len(cb),'candidateSha256':sha256(cb).hexdigest(),'journalSha256':sha256(journal).hexdigest(),'sameTurnEvidenceVerified':True})
f=read(b/'candidate-store-write-fault.json');assert f['result']=={'outputs':1,'candidates':0};assert len(f['journalAfterFault'])==1;assert f['sameInstanceAfterFault']==f['freshInstanceAfterRecovery']=={'count':0,'get':None};assert f['retryResult']=={'outputs':1,'candidates':1} and f['freshInstanceAfterRetry']['count']==1
assert read(b/'journal-fault-and-recovery.json')['failedResult']=={'outputs':0,'candidates':0}
assert read(b/'event-read-fault-audit-append-fault.json')['auditAppendError']
fixed=read(out/'candidate-failure-fixed-review.json');assert fixed['passed'] and fixed['sameInstanceQueueRows']==fixed['freshQueueRows']==0
for p,h in fixed['sourceFingerprints'].items():assert sha256((repo/p).read_bytes()).hexdigest()==h,p
newtarget=read(root/'store-candidate.json');assert newtarget['success'] and newtarget['numPassedTests']==14 and newtarget['numFailedTests']==0
previous=read(root.parent/'reflection-target/candidate-final-green.json');assert previous['success'] and previous['numPassedTests']==45
result={'schema':'agent-round2-independent-reflection-v1','observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'stage':'Final T3 dirty-stage source freeze, original target evidence and actual fixture journal/candidate files independently checked. Prior45 turn tests preceded store extension; final combined full/CI still root responsibility.','reviewedHead':manifest['head'],'sourceFingerprints':manifest['ownedFiles'],'originalArtifactGroups':{'reflection-target':61,'reflection-persistence-target':64},'originalArtifactsChecked':len(checked),'ownerStoreTargetTests':14,'priorTurnTargetTests':45,'portableChecks':23,'concurrentCorrespondence':concurrency,'ghostFixIndependentProbe':{'sameInstanceQueueRows':0,'freshQueueRows':0,'journalRows':1,'returnCounts':fixed['result']},'status':'PASS','remainingScope':'No independent-instance candidate-cache freshness or cross-process coordination; no model quality/promotion evidence.','paidCalls':0,'realModelQuality':'NOT_RUN','promotion':'NOT_RUN'}
(out/'reflection-review.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'status':'PASS','originalArtifactsChecked':len(checked),'correspondingConcurrentRows':sum(x['rows'] for x in concurrency[:10]),'multiInstanceRows':concurrency[-1]['rows'],'independentGhostFix':'PASS'}))
