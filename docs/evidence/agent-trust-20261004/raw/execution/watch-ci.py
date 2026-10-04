import json, os, subprocess, sys, time
from pathlib import Path
sha=sys.argv[1];out=Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
helper='/workspace/harness-agent/.ci/source-optimization/native-github.py'
previous=None
started=time.monotonic()
def api(path,file):
 result=subprocess.run(['python3',helper,'api',path,str(file)],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
 if result.returncode:raise RuntimeError(result.stdout[:2000])
 return json.loads(file.read_text())
run_id=None
while time.monotonic()-started<3900:
 if run_id is None:
  data=api('repos/ki11a-Conton/harness-agent/actions/runs?head_sha='+sha+'&per_page=5',out/'runs-discovery.json')
  runs=[r for r in data['workflow_runs'] if r['head_sha']==sha and r['name']=='ci']
  if runs:run_id=runs[0]['id']
 else:
  run=api('repos/ki11a-Conton/harness-agent/actions/runs/'+str(run_id),out/'run.json')
  assert run['head_sha']==sha
  jobs=api('repos/ki11a-Conton/harness-agent/actions/runs/'+str(run_id)+'/jobs?per_page=100',out/'jobs.json')
  summary={'runId':run_id,'sha':sha,'status':run['status'],'conclusion':run['conclusion'],'jobs':[{'id':j['id'],'name':j['name'],'status':j['status'],'conclusion':j['conclusion']} for j in jobs['jobs']]}
  if summary!=previous: print(json.dumps(summary,ensure_ascii=False),flush=True);previous=summary
  if run['status']=='completed':
   if run['conclusion']!='success' or len(jobs['jobs'])!=10 or any(j['conclusion']!='success' for j in jobs['jobs']):sys.exit(1)
   sys.exit(0)
 time.sleep(45)
raise RuntimeError('CI wait deadline exceeded; retain actual status')
