from pathlib import Path
from hashlib import sha256
import json,subprocess,datetime
repo=Path('/workspace/harness-agent-agent-round2'); base=Path('/workspace/harness-agent'); ev=repo/'docs/evidence/agent-trust-20261004'; raw=ev/'raw/baseline'; out=base/'.ci/agent-round2-20261004/independent-review'
read=lambda p:json.loads(p.read_text())
idx=read(ev/'artifact-index.json'); entries=[]
for f in idx['files']:
 p=ev/f['path']; data=p.read_bytes(); assert len(data)==f['bytes']; assert sha256(data).hexdigest()==f['sha256']; entries.append({'path':f['path'],'bytes':len(data),'sha256':f['sha256']})
t=read(raw/'tools-audit/verification-defects.json'); tools=[]
for c in t['receipts'][:3]:
 outcome=c['harness']['outcome']; assert outcome['terminationReason']=='verified_complete' and outcome['status']=='completed'; assert c['rawOutcome']['status']=='failed'; assert c['rawOutcome']['exitCode'] in (7,9,11)
 tools.append({'name':c['name'],'rawExitCode':c['rawOutcome']['exitCode'],'harnessGrade':outcome['grade'],'scriptedCalls':c['harness']['scriptedCalls']})
m=read(raw/'memory-audit/baseline.json'); hm=read(raw/'memory-audit/harness-baseline.json'); assert len(hm['cases'])==10; assert sum(x['actualMarkerInSystem'] for x in hm['cases'])==10
migrations=[{'case':x['case'],'backend':x.get('backend'),'lostKeys':x['lostKeys']} for x in m['cases'] if x.get('lostKeys')]
assert any(len(x['lostKeys'])==6 for x in migrations); assert any(set(x['lostKeys'])=={'state','evidence','usefulness'} for x in migrations)
reflection=[]
for label in ['tagged','legacy']:
 f=read(raw/f'reflection-audit/old-mcp-new-clean-{label}.json'); old,new=f['candidates']; assert old['sourceCandidate']['promotionState']=='quarantined'; assert old['sourceCandidate']['sourceTurn']==f['oldTurn']; assert new['sourceCandidate']['sourceTurn']==f['newTurn']; assert old['sourceCandidate']['structured']['evidenceRefs']==new['sourceCandidate']['structured']['evidenceRefs']; assert f['newResult']=={'outputs':1,'candidates':1}
 reflection.append({'label':label,'oldState':old['sourceCandidate']['promotionState'],'newState':new['sourceCandidate']['promotionState'],'sameOldEvidence':True,'newRelabeledTurn':f['newTurn']})
rounds=[read(raw/f'reflection-audit/concurrent-journal-{i}.json') for i in range(10)]; assert sum(x['expected'] for x in rounds)==200; assert sum(x['announcedOutputs'] for x in rounds)==200; assert sum(x['candidateCount'] for x in rounds)==200; assert sum(x['journalCount'] for x in rounds)==10
fingerprints=[]
for p,h in t['fingerprints'].items():
 actual=sha256((base/p).read_bytes()).hexdigest(); assert actual==h,(p,h,actual); fingerprints.append({'path':p,'sha256':h})
for p,h in m['sourceHashes'].items():
 actual=sha256((base/p).read_bytes()).hexdigest(); assert actual==h,(p,h,actual); fingerprints.append({'path':p,'sha256':h})
for f in read(raw/'reflection-audit/summary.json')['sources']:
 actual=sha256((base/f['path']).read_bytes()).hexdigest(); assert actual==f['sha256']; fingerprints.append(f)
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=base,text=True).strip(); assert head==idx['baselineSourceSha']
result={'schema':'agent-round2-independent-baseline-v1','observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'baselineHead':head,'baselineTrackedStatus':subprocess.check_output(['git','status','--porcelain','--untracked-files=no'],cwd=base,text=True),'scope':'Independent hash and inner-record semantic checks of original receipts; no new model or runtime trial claimed. Source and built fingerprints separately verified against baseline workspace.','originalArtifactsChecked':len(entries),'toolsFalseCompletion':tools,'forbiddenMemoryRequests':10,'migrationLosses':migrations,'oldTurnReflection':reflection,'concurrentJournal':{'expected':200,'announced':200,'candidates':200,'persisted':10},'sourceFingerprintsChecked':fingerprints,'paidCalls':0,'modelQuality':'NOT_RUN','promotion':'NOT_RUN','status':'PASS'}
(out/'baseline-review.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n'); print(json.dumps({k:v for k,v in result.items() if k not in ['sourceFingerprintsChecked']},ensure_ascii=False))
