#!/usr/bin/env python3
"""Independent controlled mutations; never write source archive or repository."""
import copy, gzip, hashlib, json, shutil, subprocess, tempfile, time
from pathlib import Path
SOURCE=Path('/tmp/gen1-final-evidence-stage')
HELPER=Path('/tmp/gen1-final-evidence-verify.mjs')
PORTABLE=Path('/tmp/gen1-release-final-c5bbe61/harness-agent-1.9.0-portable.tar.gz')
OUT=Path('/tmp/gen1-final-evidence-independent-review')
OUT.mkdir(exist_ok=True)
SHA='c5bbe61fef101a8c9eb10edab673be8b2e0935e3'
start=time.time()
records=[]
def dump(p,j): p.write_text(json.dumps(j,indent=2)+'\n')
def hashed(p): b=p.read_bytes(); return {'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def update_manifest(root,path):
 m=json.loads((root/'manifest.json').read_text())
 e=next(x for x in m['files'] if x['path']==path)
 e.update(hashed(root/path)); dump(root/'manifest.json',m)
def json_mut(root,path,fn):
 p=root/path; j=json.loads(p.read_text()); fn(j); dump(p,j); update_manifest(root,path)
def manifest_mut(root,fn):
 p=root/'manifest.json'; j=json.loads(p.read_text()); fn(j); dump(p,j)
def main_job(j,name): return next(x for x in j['jobs'] if x['name']==name)
def main_step(j,job,name): return next(x for x in main_job(j,job)['steps'] if x['name']==name)
def run(case,mutate=None,expected=None,external=None):
 with tempfile.TemporaryDirectory(prefix='gen1-negative-') as tmp:
  root=Path(tmp)/'archive'; shutil.copytree(SOURCE,root)
  if mutate: mutate(root)
  package=PORTABLE if external is None else external(Path(tmp))
  cmd=['node',str(HELPER),str(root),str(package)]
  result=subprocess.run(cmd,text=True,capture_output=True,timeout=30)
  wanted=0 if case=='positive-actual-final-source' else 1
  accepted=result.returncode==wanted and (expected is None or expected in result.stderr)
  entry={'case':case,'expectedExit':wanted,'actualExit':result.returncode,'passed':accepted,
   'outerManifestRebound':bool(mutate and case.startswith(('semantic-','source-','ci-','job-'))),
   'stdout':result.stdout,'stderr':result.stderr}
  records.append(entry)
  print(case, 'PASS' if accepted else 'FAIL', result.returncode, result.stderr.strip())
  if not accepted: raise RuntimeError(case)
def raw_tamper(r):
 p=r/'local/docs/run.log'; p.write_bytes(p.read_bytes()+b'controlled-tamper\n')
def hash_tamper(r):
 manifest_mut(r,lambda j:j['files'][0].update(sha256='0'*64))
def symlink(r):
 p=r/'local/docs/run.log'; p.unlink(); p.symlink_to('/etc/hosts')
def extra(r): (r/'not-in-manifest.txt').write_text('controlled extra\n')
def unsafe(r): manifest_mut(r,lambda j:j['files'][0].update(path='../outside'))
def case_duplicate(r): manifest_mut(r,lambda j:j['files'].append(dict(j['files'][0],path=j['files'][0]['path'].upper())))
def failed_job(r): json_mut(r,'ci/main-jobs.json',lambda j:main_job(j,'dual-platform acceptance (same SHA)').update(conclusion='failure'))
def skipped_step(r,job,step): json_mut(r,'ci/main-jobs.json',lambda j:main_step(j,job,step).update(conclusion='skipped'))
def optional_mut(tmp):
 p=tmp/'tampered-portable.tar.gz'; p.write_bytes(PORTABLE.read_bytes()+b'controlled-tamper'); return p
run('positive-actual-final-source')
run('manifest-unknown-schema',lambda r:manifest_mut(r,lambda j:j.update(schema='unknown-v999')),'unknown final evidence schema')
run('manifest-wrong-hash',hash_tamper,'file hash/length mismatch')
run('raw-file-tamper',raw_tamper,'file hash/length mismatch')
run('path-traversal',unsafe,'invalid manifest entry')
run('path-case-duplicate',case_duplicate,'invalid manifest entry')
run('file-symlink',symlink,'archive symlink')
run('unregistered-extra-file',extra,'unmanifested/nonregular file')
run('source-wrong-ci-sha',lambda r:json_mut(r,'ci/main-run.json',lambda j:j.update(head_sha='0'*40)),'CI_main_NOT_COMPLETED_SUCCESS')
run('source-wrong-ci-tree',lambda r:json_mut(r,'ci/main-run.json',lambda j:j['head_commit'].update(tree_id='0'*40)),'CI_main_NOT_COMPLETED_SUCCESS')
run('source-wrong-ci-repository',lambda r:json_mut(r,'ci/main-run.json',lambda j:j['repository'].update(full_name='foreign/repository')),'CI_main_NOT_COMPLETED_SUCCESS')
run('ci-unfinished-run',lambda r:json_mut(r,'ci/main-run.json',lambda j:j.update(status='in_progress',conclusion=None)),'CI_main_NOT_COMPLETED_SUCCESS')
run('ci-failed-run',lambda r:json_mut(r,'ci/main-run.json',lambda j:j.update(conclusion='failure')),'CI_main_NOT_COMPLETED_SUCCESS')
run('ci-cancelled-run',lambda r:json_mut(r,'ci/main-run.json',lambda j:j.update(conclusion='cancelled')),'CI_main_NOT_COMPLETED_SUCCESS')
run('ci-missing-job',lambda r:json_mut(r,'ci/main-jobs.json',lambda j:(j['jobs'].pop(),j.update(total_count=9))),'CI_main_JOB_SET_INCOMPLETE')
run('job-failed',failed_job,'CI_main_JOB_NOT_SUCCESS')
run('job-foreign-run',lambda r:json_mut(r,'ci/main-jobs.json',lambda j:j['jobs'][0].update(run_id=1)),'CI_main_JOB_NOT_SUCCESS')
run('job-foreign-attempt',lambda r:json_mut(r,'ci/main-jobs.json',lambda j:j['jobs'][0].update(run_attempt=99)),'CI_main_JOB_NOT_SUCCESS')
run('job-replace-required-dual',lambda r:json_mut(r,'ci/main-jobs.json',lambda j:main_job(j,'dual-platform acceptance (same SHA)').update(name='unrelated success job')),'main CI required job set differs')
run('job-skipped-dual-reducer',lambda r:skipped_step(r,'dual-platform acceptance (same SHA)','Reduce both legs to one same-SHA verdict'),'mandatory main workflow step absent/skipped')
run('job-skipped-release-attestation-reducer',lambda r:skipped_step(r,'release attestation (P38-12)','Verify evidence SHA and derive release verdict (P38.2-13 / P38.3-7)'),'mandatory main workflow step absent/skipped')
run('job-skipped-native-boundary',lambda r:json_mut(r,'ci/native-windows-jobs.json',lambda j:next(x for x in j['jobs'][0]['steps'] if x['name']=='Execute native process and production boundary regressions').update(conclusion='skipped')),'native Windows mandatory boundary gate absent/skipped')
run('manifest-false-paid-quality',lambda r:manifest_mut(r,lambda j:j.update(realModelQuality='PROVEN')),'wrong final source/distribution/quality identity')
run('optional-portable-tamper',external=optional_mut,expected='optional portable archive differs')
report={'schema':'harness-gen1-final-independent-evidence-review-v1','status':'PASS','testedSourceSha':SHA,
 'sourceArchive':str(SOURCE),'helper':str(HELPER),'helperDigest':hashed(HELPER),'officialPortableDigest':hashed(PORTABLE),
 'controls':len(records),'positiveControls':1,'negativeControls':len(records)-1,'durationSeconds':round(time.time()-start,3),
 'writeScope':'temporary directories only; source archive and tracked repository unchanged',
 'sourceAndCiMutationsReboundManifestHashes':True,'paidModelCalls':0,'realModelQuality':'NOT_PROVEN',
 'limitations':['Offline supplied API snapshots are hash-consistent evidence, not remote cryptographic signatures.',
 'Engineering acceptance does not establish real paid-model coding quality or parity with reference agents.',
 'This review executes the read-only archive verifier and controlled mutations; it does not rerun product test suites.'],
 'cases':records}
dump(OUT/'result.json',report)
print('RESULT',str(OUT/'result.json'))
