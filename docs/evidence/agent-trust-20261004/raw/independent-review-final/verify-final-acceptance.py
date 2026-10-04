from pathlib import Path
from hashlib import sha256
import json,subprocess,datetime,re
root=Path('/workspace/harness-agent/.ci/agent-round2-20261004');repo=Path('/workspace/harness-agent-agent-round2-acceptance');dev=Path('/workspace/harness-agent-agent-round2');out=root/'independent-review';source='d01df59f31b156f7c8622ae6c926ce99bc751400'
read=lambda p:json.loads(p.read_text());digest=lambda p:sha256(p.read_bytes()).hexdigest()
git=lambda args,cwd=repo:subprocess.check_output(['git',*args],cwd=cwd,text=True).strip()
assert git(['rev-parse','HEAD'])==source and git(['status','--porcelain'])==''
freeze=read(out/'source-freeze-review.json');assert freeze['status']=='SCOPED_REVIEW_PASS'
for f in freeze['files']:
 data=(repo/f['path']).read_bytes();assert len(data)==f['bytes'] and sha256(data).hexdigest()==f['sha256'],f['path']
 assert sha256(subprocess.check_output(['git','show',f"{source}:{f['path']}"],cwd=repo)).hexdigest()==f['sha256']
assert git(['diff',source,'--','packages','apps','scripts','.github','package.json','pnpm-lock.yaml'],cwd=dev)==''
local=root/'frozen-acceptance-resumed';m=read(local/'manifest.json');assert m['testedSourceSha']==source and m['status']=='PASS' and len(m['commands'])==8
logs=[]
for c in m['commands']:
 assert c['status']=='PASS' and c['exitCode']==0 and c['cleanBefore'] and c['cleanAfter'] and c['cwd']==str(repo)
 p=local/c['log'];assert digest(p)==c['logSha256'],c['name'];logs.append({'name':c['name'],'path':str(p.relative_to(root)),'bytes':p.stat().st_size,'sha256':digest(p),'exitCode':0})
full=(local/'full.log').read_text();assert 'Tests  8295 passed | 12 skipped (8307)' in full and 'Test Files  451 passed | 1 skipped (452)' in full and '[review supervisor] command exit=0; reaped orphan descendants=70' in full
assert '2135 passed (2135)' in (local/'security.log').read_text()
assert 'usage audit: PASS (all key capabilities observed)' in (local/'usage-audit.log').read_text()
original=root/'frozen-acceptance';old=read(original/'manifest.json');interrupt=read(root/'local-interruption.json');assert old['testedSourceSha']==source and old['status']=='RUNNING' and 'finishedAt' not in old and old['commands'][-1]['status']=='RUNNING'
assert digest(original/'manifest.json')==interrupt['originalManifestSha256'];assert interrupt['status']=='INTERRUPTED' and interrupt['full']=='NOT_COMPLETED'
assert old['commands'][:4]==m['commands'][:4]
for c in old['commands'][:4]:assert digest(original/c['log'])==c['logSha256']==digest(local/c['log'])
identity=read(root/'runtime-identity.json');assert identity['testedSourceSha']==source and identity['sourceClean'] and identity['commandPnpm']=='11.21.0' and identity['launcherPnpmRecordedInResumedManifest']==m['pnpm']=='12.9.1'
assert read(repo/'package.json')['packageManager']==identity['declaredPackageManager']=='pnpm@11.21.0'
runid=m['observationRunId'];assert runid!=old['observationRunId'];obs=[]
for suffix in ['.jsonl','.candidates.jsonl']:
 p=local/'observations'/f'{runid}{suffix}';rows=[json.loads(x) for x in p.read_text().splitlines()];assert len(rows)==7 and all(x['runId']==runid and x['testedSourceSha']==source for x in rows)
 if suffix=='.jsonl':assert all(x['runStatus']=='passed' and x['runner']=='vitest' and re.fullmatch('[a-f0-9]{64}',x['resultDigest']) for x in rows)
 obs.append({'path':str(p.relative_to(root)),'rows':7,'bytes':p.stat().st_size,'sha256':digest(p)})
probe_indexes=[]
for group in ['frozen-verification','frozen-memory','frozen-reflection']:
 b=root/group;idx=read(b/'artifact-index.json');items=idx.get('files',idx.get('artifacts'))
 for f in items:
  data=(b/f['path']).read_bytes();assert len(data)==f['bytes'] and sha256(data).hexdigest()==f['sha256'],(group,f['path'])
 probe_indexes.append({'group':group,'artifactsChecked':len(items),'indexSha256':digest(b/'artifact-index.json')})
v=root/'frozen-verification';vr=read(v/'verification-measurement.json');assert vr['sourceSha']==source and not vr['dirty'] and vr['verificationIntegrityPass'] and len(vr['receipts'])==12
for p,h in vr['fingerprints'].items():assert digest(repo/p)==h,p
assert digest(repo/'scripts/research/agent-trust-20261004/verification.mjs')==vr['probeSha256']
for c in vr['receipts']:
 assert c['passed']
 h=c.get('harness')
 if h:
  f=h['eventArtifact'];data=(v/f['path']).read_bytes();assert len(data)==f['bytes'] and sha256(data).hexdigest()==f['sha256'];ev=json.loads(data);assert h['toolRequests']==0
  if c['name'] in ['quoted-required-failure','compound-required-failure','discovery-root-truncated','legacy-cache-upgrade','explicit-argv-failure','empty-verification']:
   assert h['outcome']['terminationReason']=='verification_failed' and any(x['type']=='verification.failed' for x in ev)
   if c['name']!='empty-verification':assert any(x['type']=='verification.step_completed' and x['payload']['passed'] is False for x in ev)
b=root/'frozen-memory';mr=read(b/'report.json');assert mr['sourceHead']==source and mr['sourceStatus']=='' and mr['status']=='PASS' and len(mr['checks'])==32 and all(x['pass'] for x in mr['checks'])
for p,h in mr['sourceHashes'].items():assert digest(repo/p)==h,p
assert digest(repo/'scripts/research/agent-trust-20261004/memory.mjs')==mr['probeSha256']
forbidden=allowed=0
for f in mr['receiptFiles']:
 if not f['path'].endswith('-request.json'):continue
 d=read(b/f['path']);deny=any(f['path'].endswith('-'+k+'-request.json') for k in ['session-mismatch','deprecated','superseded','stale','conflicting']);assert len(d['requests'])==1 and d['outcome']['status']=='completed';seen=d['entry']['content'] in d['requests'][0]['system'];assert seen!=deny;assert (d['entry']['id'] in d['outcome']['memoryRefs'])!=deny
 if deny:forbidden+=1;assert d.get('usefulness') is None
 else:allowed+=1;assert d['usefulness']['injectedCount']==1
assert forbidden==10 and allowed==8
b=root/'frozen-reflection';rr=read(b/'report.json');assert rr['head']==source and rr['trackedStatus']=='' and rr['summary']['checks']==rr['summary']['passed']==23 and not rr['summary']['failed']
for f in rr['sources']:assert digest(repo/f['path'])==f['sha256'],f['path']
for label in ['tagged','legacy']:
 d=read(b/f'old-mcp-new-clean-{label}.json');assert d['newResult']=={'outputs':0,'candidates':0} and len(d['candidates'])==len(d['journal'])==1 and d['candidates'][0]['sourceCandidate']['sourceTurn']==d['oldTurn'] and d['candidates'][0]['sourceCandidate']['promotionState']=='quarantined'
concurrent=[]
for label in [f'concurrent-journal-{i}' for i in range(10)]+['multi-instance-journal']:
 d=read(b/f'{label}.json');assert d['pass'] and d['journalCount']==d['candidateCount']==20 and d['uniqueJournalTurns']==20
 p=b/'fixtures'/label;cb=(p/'learning-candidates.jsonl').read_bytes();cs=[json.loads(x)['candidate']['sourceCandidate'] for x in cb.splitlines()];inputs={x['turnId']:x['sessionId'] for x in d['inputs']};assert set(inputs)=={x['sourceTurn'] for x in cs}=={x['turnId'] for x in d['journal']};assert len(cs)==20
 for c in cs:assert c['sourceSession']==inputs[c['sourceTurn']]
 concurrent.append({'label':label,'matchingCandidateJournalTurns':20,'candidateSha256':sha256(cb).hexdigest()})
f=read(b/'candidate-store-write-fault.json');assert f['result']=={'outputs':1,'candidates':0} and len(f['journalAfterFault'])==1 and f['sameInstanceAfterFault']==f['freshInstanceAfterRecovery']=={'count':0,'get':None} and f['freshInstanceAfterRetry']['count']==1
ci=read(root/'ci/run.json');jobs=read(root/'ci/jobs.json');assert ci['id']==37167480007 and ci['head_sha']==source and ci['status']=='completed' and ci['conclusion']=='success';assert jobs['total_count']==len(jobs['jobs'])==10
jrows=[]
for j in jobs['jobs']:
 assert j['head_sha']==source and j['status']=='completed' and j['conclusion']=='success';assert all(s['conclusion'] in ['success','skipped'] for s in j['steps'])
 jrows.append({'id':j['id'],'name':j['name'],'status':j['status'],'conclusion':j['conclusion'],'headSha':j['head_sha'],'steps':len(j['steps'])})
assert any('windows' in j['name'].lower() for j in jrows) and any('ubuntu' in j['name'].lower() for j in jrows)
assert git(['rev-parse','HEAD'])==source and git(['status','--porcelain'])==''
result={'schema':'agent-round2-independent-final-acceptance-v1','observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'ACCEPTANCE_PASS_PUBLICATION_PENDING','testedSourceSha':source,'acceptanceWorkspace':str(repo),'sourceCleanBeforeAndAfterReview':True,'frozenSourceTestProbeFilesVerified':22,'scope':'Read-only verification of frozen source, original complete local acceptance receipts, probe traces and GitHub-native REST CI receipts. No tests/build/probes/CI were rerun by this final verifier. Existing reviews and original interrupted files were preserved.','local':{'commandsPassing':8,'logs':logs,'fullTests':{'passed':8295,'skipped':12,'filesPassed':451,'filesSkipped':1,'supervisorExit':0,'reapedOrphanDescendants':70},'securityTestsPassed':2135,'interruptionPolicy':'Original partial manifest remains RUNNING, full NOT_COMPLETED; first four exact same-source command rows and log hashes reused verbatim. Only resumed full and subsequent checks provide completed verdict.','originalManifestSha256':digest(original/'manifest.json'),'resumedManifestSha256':digest(local/'manifest.json'),'runtimeIdentity':identity,'observationRunId':runid,'observationFiles':obs},'frozenProbes':{'verification':12,'memory':32,'reflection':23,'sourceClean':True,'allTestedSourceSha':source,'forbiddenMemoryBodies':0,'forbiddenMemoryCases':10,'allowedMemoryControls':8,'matchingConcurrentJournalCandidates':200,'multiReflectorJournalCandidates':20,'ghostQueueSameInstance':0,'ghostQueueFreshInstance':0,'indexes':probe_indexes,'candidateCorrespondence':concurrent},'ci':{'runId':ci['id'],'url':ci['html_url'],'headSha':ci['head_sha'],'conclusion':ci['conclusion'],'jobsSucceeded':10,'jobs':jrows,'runSha256':digest(root/'ci/run.json'),'jobsSha256':digest(root/'ci/jobs.json'),'scope':'GitHub-native API confirms actual completed jobs/steps on this source; no CI log-content claim beyond recorded API status.'},'publication':'NOT_YET_ATTESTED','paidCalls':0,'realModelQuality':'NOT_RUN','promotion':'NOT_RUN','remainingLimits':['No model-quality improvement or promotion inferred from offline engineering/CI evidence','No independent candidate-store cache freshness or cross-process writer coordination claim','Main publication must be independently checked by root after final docs commit/push']}
(out/'final-acceptance-review.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'status':result['status'],'source':source,'localCommandsPassing':8,'fullPassed':8295,'portableChecks':[12,32,23],'ciRun':ci['id'],'ciJobsSucceeded':10,'publication':result['publication']}))
