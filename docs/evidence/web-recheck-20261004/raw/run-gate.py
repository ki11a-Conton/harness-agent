import sys,json,subprocess,hashlib,time
from pathlib import Path
from datetime import datetime,timezone
repo=Path('/workspace/harness-agent');base=repo/'.ci/web-recheck-20261004/gates-3adbebe';base.mkdir(exist_ok=True)
name=sys.argv[1];argv=sys.argv[2:];sha='3adbebe8af87a8490e63365a077840b6765296ea'
def state():
 return {'sha':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),'clean':not subprocess.check_output(['git','status','--porcelain'],cwd=repo)}
before=state();assert before=={'sha':sha,'clean':True}
start=time.monotonic();log=base/(name+'.log')
with log.open('wb') as f:r=subprocess.run(argv,cwd=repo,stdout=f,stderr=subprocess.STDOUT)
after=state();body={'status':'PASS' if r.returncode==0 and after==before else 'FAIL','sourceSha':sha,'argv':argv,'before':before,'after':after,'exitCode':r.returncode,'durationSeconds':round(time.monotonic()-start,3),'log':log.name,'logSha256':hashlib.sha256(log.read_bytes()).hexdigest(),'observedAt':datetime.now(timezone.utc).isoformat()}
(base/(name+'.json')).write_text(json.dumps(body,indent=2)+'\n');print(json.dumps(body));print(log.read_text()[-1300:]);sys.exit(0 if body['status']=='PASS' else 1)
