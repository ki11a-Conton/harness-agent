from pathlib import Path
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
import os,json,subprocess,threading,time,re,signal,urllib.request,hashlib
root=Path('/workspace/harness-agent');out=Path(__file__).resolve().parent
sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
requests=[]
class Handler(BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*args):pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  requests.append({'path':self.path,'body':body})
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Connection','close');self.end_headers()
  for row in [{'choices':[{'index':0,'delta':{'content':'LOCAL_CONFIG_PROBE_DONE'},'finish_reason':None}]},{'choices':[{'index':0,'delta':{},'finish_reason':'stop'}]},{'choices':[],'usage':{'prompt_tokens':10,'completion_tokens':6,'total_tokens':16}}]:
   self.wfile.write(('data: '+json.dumps(row)+'\n\n').encode())
  self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush();self.close_connection=True
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
# Deliberately construct a minimal environment rather than reading inherited credential values.
def env(memory=True,data=None):
 result={'PATH':os.environ['PATH'],'OPENAI_API_KEY':'local-non-secret-placeholder','OPENAI_BASE_URL':f'http://127.0.0.1:{server.server_port}/v1','OPENAI_MODEL':'local-config-probe','OPENAI_MAX_RETRIES':'0','HARNESS_WEB_HOST':'127.0.0.1','HARNESS_WEB_PORT':'0'}
 if memory:result['HARNESS_MEMORY']='1'
 if data is not None:result['HARNESS_DATA_DIR']=str(data)
 return result
paths=['apps/web/src/main.ts','apps/web/dist/main.js','apps/cli/src/main.ts','apps/cli/dist/main.js','apps/cli/src/champion-application.ts','apps/cli/dist/champion-application.js','packages/harness/src/create-harness.ts','packages/harness/dist/create-harness.js']
def fp():return {p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in paths}
fps=fp();cases=[]
marker='RecallProbe user preference: concise review notes in numbered steps.'
seed="""import {JsonlMemoryStore} from '/workspace/harness-agent/packages/memory/dist/memory-store.js';
import {newMemoryId,newSessionId} from '/workspace/harness-agent/packages/contracts/dist/index.js';
const now=Date.now();const store=new JsonlMemoryStore({dataDir:process.argv[2]});
await store.write({id:newMemoryId(),sourceSession:newSessionId(),content:'RecallProbe user preference: concise review notes in numbered steps.',type:'explicit',scope:'global',importance:0.9,confidence:0.9,novelty:0.9,stability:0.9,createdAt:now,updatedAt:now,deleted:false});
"""
(out/'seed.mjs').write_text(seed)
def start(name,host,memory=True,data=False,send=False):
 caseout=out/name;caseout.mkdir();workspace=caseout/'workspace';workspace.mkdir();datadir=caseout/'data' if data else None
 if datadir is not None:
  datadir.mkdir();subprocess.run(['node',str(out/'seed.mjs'),str(datadir)],env={'PATH':os.environ['PATH']},check=True,capture_output=True,text=True)
 before=len(requests);logs=[];e=env(memory,datadir)
 argv=['node',str(root/f'apps/{host}/dist/main.js')]
 if host=='cli':argv+=['run',str(workspace),'RecallProbe']
 p=subprocess.Popen(argv,cwd=workspace,env=e,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
 def reader():
  for line in p.stdout:logs.append(line.rstrip('\n'))
 thread=threading.Thread(target=reader,daemon=True);thread.start();listened=False;terminal=False;deadline=time.monotonic()+20
 try:
  if host=='web':
   base=None
   while time.monotonic()<deadline:
    match=next((re.search(r'http://127\.0\.0\.1:\d+',x) for x in logs if 'listening' in x),None)
    if match:base=match.group(0);listened=True;break
    if p.poll() is not None:break
    time.sleep(.025)
   if send:
    assert base,'web did not start'
    req=urllib.request.Request(base+'/api/messages',data=json.dumps({'from':'config-probe-user','text':'RecallProbe'}).encode(),headers={'Content-Type':'application/json'},method='POST')
    with urllib.request.urlopen(req) as response:assert response.status==200
    while time.monotonic()<deadline:
     events=[]
     for path in datadir.glob('session_*.jsonl'):
      events.extend(json.loads(line) for line in path.read_text().splitlines() if line)
     if any(event.get('type')=='turn.completed' or event.get('event',{}).get('type')=='turn.completed' for event in events):terminal=True;break
     time.sleep(.025)
  else:
   p.wait(timeout=20);thread.join(timeout=2);terminal=any('status: completed' in x for x in logs)
 finally:
  if p.poll() is None:p.send_signal(signal.SIGTERM)
  try:p.wait(timeout=8)
  except subprocess.TimeoutExpired:p.kill();p.wait()
  thread.join(timeout=2)
 owned=requests[before:]
 injected=any(marker in json.dumps(request['body'].get('messages',[]),ensure_ascii=False) for request in owned)
 result={'name':name,'host':host,'HARNESS_MEMORY': '1' if memory else 'unset','dataDirConfigured':data,'listened':listened,'processExit':p.returncode,'terminalCompleted':terminal,'modelRequests':len(owned),'seedMarkerInjected':injected,'stdout':logs}
 cases.append(result);(caseout/'result.json').write_text(json.dumps(result,indent=2)+'\n');(caseout/'model-requests.json').write_text(json.dumps(owned,indent=2)+'\n')
 return result
try:
 a=start('cli-optin-no-data','cli');b=start('web-optin-no-data','web')
 c=start('web-default-data','web',memory=False,data=True,send=True)
 d=start('web-optin-data','web',memory=True,data=True,send=True)
 e=start('cli-optin-data','cli',memory=True,data=True)
 assert a['processExit']==1 and any('memory is enabled but no dataDir' in x for x in a['stdout'])
 assert b['listened'] and b['processExit']==0
 assert c['terminalCompleted'] and c['modelRequests']==1 and not c['seedMarkerInjected']
 assert d['terminalCompleted'] and d['modelRequests']==1 and not d['seedMarkerInjected']
 assert e['terminalCompleted'] and e['modelRequests']==1 and e['seedMarkerInjected']
 assert fp()==fps
 result={'status':'BASELINE_MISMATCH_OBSERVED','sourceSha':sha,'paidCalls':0,'externalModelQuality':'NOT_RUN','credentialPolicy':'minimal child environment; synthetic local placeholder key; only loopback model endpoint','classification':'Web opt-in feature gap / CLI-Web explicit configuration inconsistency; no documented Web HARNESS_MEMORY contract and default disabled is intended','sourceFingerprints':fps,'cases':cases,'probeSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
 (out/'baseline.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'status':result['status'],'sourceSha':sha,'cases':[{k:v for k,v in case.items() if k!='stdout'} for case in cases]}))
finally:server.shutdown();server.server_close()
