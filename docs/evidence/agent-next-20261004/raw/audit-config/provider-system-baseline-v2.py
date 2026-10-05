from pathlib import Path
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
import os,json,subprocess,threading,hashlib
root=Path('/workspace/harness-agent');out=Path(__file__).resolve().parent;requests=[]
class Handler(BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*args):pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));requests.append(body)
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Connection','close');self.end_headers()
  for row in [{'choices':[{'index':0,'delta':{'content':'LOCAL_DONE'},'finish_reason':None}]},{'choices':[{'index':0,'delta':{},'finish_reason':'stop'}]}]:self.wfile.write(('data: '+json.dumps(row)+'\n\n').encode())
  self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush();self.close_connection=True
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
probe="""import {OpenAICompatibleProvider} from '/workspace/harness-agent/packages/model/dist/openai.js';
const provider=new OpenAICompatibleProvider({apiKey:'local-placeholder',baseUrl:process.argv[2],modelId:'system-serialization-probe',requestPolicy:{maxProviderRetries:0,retryDelayMs:0,requestTimeoutMs:5000}});
const client=provider.createClient({providerId:'openai',modelId:'system-serialization-probe'},{});
const msg=(role,content)=>({id:'message_fixture',sessionId:'session_fixture',role,content,createdAt:0});
const outputs=[];
for(const req of [{system:'TOPLEVEL_SYSTEM_中文marker',messages:[msg('user','USER_MARKER')]},{system:'TOPLEVEL_SYSTEM_中文marker',messages:[msg('system','HISTORY_SYSTEM_MARKER'),msg('user','USER_MARKER')]},{messages:[msg('system','HISTORY_SYSTEM_MARKER'),msg('user','USER_MARKER')]},{system:'',messages:[msg('user','USER_MARKER')]},{messages:[msg('user','USER_MARKER')]}]){
 const events=[];for await(const event of client.generate(req,new AbortController().signal))events.push(event);
 outputs.push({request:req,events});
}
console.log(JSON.stringify(outputs));
"""
(out/'provider-system-baseline-v2.mjs').write_text(probe)
try:
 process=subprocess.run(['node',str(out/'provider-system-baseline-v2.mjs'),f'http://127.0.0.1:{server.server_port}/v1'],env={'PATH':os.environ['PATH']},capture_output=True,text=True,check=True,timeout=20)
 outputs=json.loads(process.stdout);assert len(requests)==5
 cases=[]
 for ix,(input_,wire) in enumerate(zip(outputs,requests)):
  assert any(event['type']=='completed' and event['result']['finishReason']=='stop' for event in input_['events'])
  system='TOPLEVEL_SYSTEM_中文marker' in json.dumps(wire['messages']);history='HISTORY_SYSTEM_MARKER' in json.dumps(wire['messages'])
  cases.append({'index':ix,'requestSystemProvided':'system' in input_['request'],'requestSystemOnWire':system,'historySystemOnWire':history,'completed':True})
 assert not cases[0]['requestSystemOnWire'] and not cases[1]['requestSystemOnWire']
 assert cases[1]['historySystemOnWire'] and cases[2]['historySystemOnWire']
 sourcepaths=['packages/model/src/openai.ts','packages/model/dist/openai.js','packages/contracts/src/model.ts']
 result={'status':'DETERMINISTIC_SYSTEM_FIELD_DROP_OBSERVED','sourceSha':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'paidCalls':0,'externalModelQuality':'NOT_RUN','minimalEnvironment':True,'endpoint':'loopback-only','cases':cases,'sourceFingerprints':{p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in sourcepaths},'probeSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'nodeProbeSha256':hashlib.sha256((out/'provider-system-baseline-v2.mjs').read_bytes()).hexdigest()}
 (out/'provider-system-baseline-v2-input-events.json').write_text(json.dumps(outputs,indent=2)+'\n');(out/'provider-system-baseline-v2-wire.json').write_text(json.dumps(requests,indent=2)+'\n');(out/'provider-system-baseline-v2.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result))
finally:server.shutdown();server.server_close()
