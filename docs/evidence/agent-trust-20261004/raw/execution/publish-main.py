import hashlib,json,os,subprocess,sys,time
from pathlib import Path
root=Path('/workspace/harness-agent/.ci/agent-round2-20261004')
dev=Path('/workspace/harness-agent-agent-round2');primary=Path('/workspace/harness-agent');source='d01df59f31b156f7c8622ae6c926ce99bc751400';final=sys.argv[1]
helper='/workspace/harness-agent/.ci/source-optimization/native-github.py'
safe_env=os.environ.copy();safe_env.pop('HARNESS_PUBLISH_PAT',None)
def git(cwd,*args):return subprocess.check_output(['/usr/bin/git',*args],cwd=cwd,text=True,env=safe_env).strip()
assert git(dev,'rev-parse','HEAD')==final and git(dev,'status','--porcelain')==''
assert git(primary,'branch','--show-current')=='main' and git(primary,'status','--porcelain')==''
changed=git(dev,'diff','--name-only',source,final).splitlines()
assert changed and all(p=='plan.md' or p=='tasks/AGENT-TRUST-20261004.md' or p.startswith('docs/evidence/agent-trust-20261004') for p in changed),changed
local=json.loads((root/'frozen-acceptance-resumed/manifest.json').read_text());assert local['status']=='PASS' and local['testedSourceSha']==source and len(local['commands'])==8
assert all(r['exitCode']==0 and r['cleanBefore'] and r['cleanAfter'] for r in local['commands'])
run=json.loads((root/'ci/run.json').read_text());jobs=json.loads((root/'ci/jobs.json').read_text())['jobs']
assert run['head_sha']==source and run['status']=='completed' and run['conclusion']=='success'
assert len(jobs)==10 and all(j['status']=='completed' and j['conclusion']=='success' for j in jobs)
subprocess.run(['python3',helper,'push',str(dev),final,'refs/heads/main',str(root/'main-push.json')],check=True)
subprocess.run(['python3',helper,'api','repos/ki11a-Conton/harness-agent/git/ref/heads/main',str(root/'main-after-api.json')],check=True)
api=json.loads((root/'main-after-api.json').read_text());assert api['object']['sha']==final
subprocess.run(['python3',str(root/'native-ref.py'),str(dev),'refs/heads/main',str(root/'main-after-ls-remote.json')],check=True)
remote=json.loads((root/'main-after-ls-remote.json').read_text());assert remote['stdout'].split()[0]==final
subprocess.run(['/usr/bin/git','merge','--ff-only',final],cwd=primary,check=True,stdout=subprocess.DEVNULL,env=safe_env)
with (root/'primary-build.log').open('w') as log:subprocess.run(['corepack','pnpm','build'],cwd=primary,stdout=log,stderr=subprocess.STDOUT,check=True,env=safe_env)
with (root/'primary-artifact-integrity.log').open('w') as log:subprocess.run(['node','scripts/research/agent-trust-20261004/verify-artifacts.mjs'],cwd=primary,stdout=log,stderr=subprocess.STDOUT,check=True,env=safe_env)
assert git(primary,'rev-parse','HEAD')==final and git(primary,'status','--porcelain')==''
assert subprocess.check_output(['/usr/bin/git','diff',source,final,'--','packages','apps','scripts','.github','package.json','pnpm-lock.yaml'],cwd=primary,env=safe_env)==b''
index=json.loads((primary/'docs/evidence/agent-trust-20261004/artifact-index.json').read_text());tracked=set(git(primary,'ls-files').splitlines())
assert all('docs/evidence/agent-trust-20261004/'+r['path'] in tracked for r in index['files'])
assert hashlib.sha256((primary/'plan(20261004-previous-engineering-round).md').read_bytes()).hexdigest()=='47190050efc8e3f74e663ddb58d983c353259545b914140408cee4cc4e8f827b'
record={'status':'PASS','testedSourceSha':source,'finalMainDocumentationSha':final,'apiMainSha':api['object']['sha'],'nativeLsRemoteSha':remote['stdout'].split()[0],'primaryLocalMainSha':git(primary,'rev-parse','HEAD'),'sourceTestScriptsUnchanged':True,'primaryClean':True,'allArtifactsTracked':True,'artifactCount':len(index['files']),'sourceCiRunId':run['id'],'sourceCiJobs':10,'sourceCiConclusion':'success','paidModelCalls':0,'realModelQuality':'NOT_RUN','promotion':'NOT_RUN','observedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
(root/'publication-verification.json').write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record,ensure_ascii=False))
