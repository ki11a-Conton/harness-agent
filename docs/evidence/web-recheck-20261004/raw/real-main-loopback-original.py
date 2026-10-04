from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from playwright.sync_api import sync_playwright
import os,json,subprocess,threading,time,re,signal,hashlib,traceback,urllib.request
root=Path('/workspace/harness-agent');out=root/'.ci/web-recheck-20261004/real-main-loopback';out.mkdir(parents=True,exist_ok=True)
workspace=out/'workspace';workspace.mkdir(exist_ok=True);data=out/'runtime-data';data.mkdir(exist_ok=True)
requests=[];logs=[];errors=[];browserrequests=[];frames=[];cases=[]
class ModelHandler(BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*args): pass
 def do_POST(self):
  if self.path != '/v1/chat/completions':self.send_error(404);return
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  messages=body.get('messages',[]);ix=max((i for i,m in enumerate(messages) if m['role']=='user'),default=-1)
  prompt=messages[ix]['content'] if ix>=0 else ''
  after=messages[ix+1:];already=any(m['role']=='tool' or m.get('tool_calls') for m in after)
  index=len(requests);requests.append({'index':index,'path':self.path,'model':body.get('model'),'stream':body.get('stream'),'toolNames':[t.get('function',{}).get('name') for t in body.get('tools',[])],'messages':messages,'prompt':prompt,'afterTool':already,'authorizationPresent':bool(self.headers.get('Authorization'))})
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Connection','close');self.end_headers()
  def emit(obj):self.wfile.write(('data: '+json.dumps(obj,ensure_ascii=False)+'\n\n').encode());self.wfile.flush()
  try:
   if not already and prompt in ['LOOPBACK_ALLOW','LOOPBACK_DENY']:
    path='allowed-real-main.txt' if prompt=='LOOPBACK_ALLOW' else 'denied-real-main.txt'
    args=json.dumps({'path':path,'content':'ACTUAL_MAIN_HTTP_PROVIDER_WRITE\n'})
    emit({'choices':[{'index':0,'delta':{'tool_calls':[{'index':0,'id':f'loopback-call-{index}','type':'function','function':{'name':'write_file','arguments':args}}]},'finish_reason':None}]})
    emit({'choices':[{'index':0,'delta':{},'finish_reason':'tool_calls'}]})
   else:
    emit({'choices':[{'index':0,'delta':{'content':'LOOPBACK_REPLY:'+str(prompt)},'finish_reason':None}]})
    emit({'choices':[{'index':0,'delta':{},'finish_reason':'stop'}]})
   emit({'choices':[],'usage':{'prompt_tokens':10,'completion_tokens':6,'total_tokens':16}})
   self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
  except (BrokenPipeError,ConnectionResetError):pass
  self.close_connection=True
server=ThreadingHTTPServer(('127.0.0.1',0),ModelHandler);threading.Thread(target=server.serve_forever,daemon=True).start()
env=os.environ.copy()
for k in list(env):
 if k.startswith('OPENAI_'):env.pop(k,None)
env.update(OPENAI_API_KEY='local-test-placeholder-key',OPENAI_BASE_URL=f'http://127.0.0.1:{server.server_port}/v1',OPENAI_MODEL='loopback-test-model',OPENAI_MAX_RETRIES='0',HARNESS_WEB_PORT='0',HARNESS_WEB_HOST='127.0.0.1',HARNESS_DATA_DIR=str(data))
p=subprocess.Popen(['node',str(root/'apps/web/dist/main.js')],cwd=workspace,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
def readlogs():
 for line in p.stdout:logs.append(line.rstrip('\n'))
threading.Thread(target=readlogs,daemon=True).start()
result={'sourceSha':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'trackedDirty':bool(subprocess.check_output(['git','status','--porcelain','--untracked-files=no'],cwd=root,text=True).strip()),'entrypoint':'apps/web/dist/main.js','provider':'production OpenAICompatibleProvider HTTP/SSE','modelServer':'local deterministic OpenAI-compatible server','paidCalls':0,'externalModelQuality':'NOT_RUN','cases':cases}
try:
 deadline=time.monotonic()+20;base=None
 while time.monotonic()<deadline:
  found=next((re.search(r'http://127\.0\.0\.1:\d+',s) for s in logs if 'listening' in s),None)
  if found:base=found.group(0);break
  if p.poll() is not None:break
  time.sleep(.05)
 if not base:raise RuntimeError('main startup did not listen')
 with sync_playwright() as pw:
  browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
  context=browser.new_context(viewport={'width':1440,'height':900})
  page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('request',lambda r:browserrequests.append({'method':r.method,'url':r.url,'postData':r.post_data if '/api/' in r.url else None}))
  page.add_init_script("""window.__mainFrames=[];const Native=window.EventSource;window.EventSource=class extends Native{constructor(...args){super(...args);this.addEventListener('message',e=>{try{window.__mainFrames.push(JSON.parse(e.data))}catch{}})}};""")
  page.goto(base,wait_until='domcontentloaded');page.wait_for_function("document.getElementById('conn-label').textContent === '已连接' && document.getElementById('messages').getAttribute('aria-busy')==='false'",timeout=15000)
  def send(text):
   page.locator('#input').fill(text);page.locator('#send-btn').click()
  def reply(prompt):
   page.locator('.assistant-bubble').filter(has_text='LOOPBACK_REPLY:'+prompt).wait_for(timeout=20000)
   page.wait_for_function("document.getElementById('cancel-btn').disabled",timeout=15000)
  send('LOOPBACK_TEXT');reply('LOOPBACK_TEXT')
  cases.append({'name':'normal-main-http-model-reply','status':'PASS','modelRequests':len(requests),'actualModel':'loopback-test-model'})
  send('LOOPBACK_ALLOW');page.locator('.approval-card:not(.resolved) .allow-btn').wait_for(timeout=20000)
  assert not (workspace/'allowed-real-main.txt').exists(),'write before approval'
  page.locator('.approval-card:not(.resolved) .allow-btn').click();reply('LOOPBACK_ALLOW')
  assert (workspace/'allowed-real-main.txt').read_text()=='ACTUAL_MAIN_HTTP_PROVIDER_WRITE\n'
  cases.append({'name':'normal-main-http-tool-approval-allow-write','status':'PASS','beforeApprovalFileAbsent':True,'afterApprovalContent':'ACTUAL_MAIN_HTTP_PROVIDER_WRITE\n','actualTool':'write_file'})
  send('LOOPBACK_DENY');page.locator('.approval-card:not(.resolved) .deny-btn').wait_for(timeout=20000)
  page.locator('.approval-card:not(.resolved) .deny-btn').click();reply('LOOPBACK_DENY')
  assert not (workspace/'denied-real-main.txt').exists(),'deny wrote file'
  cases.append({'name':'normal-main-http-tool-approval-deny-no-write','status':'PASS','fileAbsent':True})
  page.reload(wait_until='domcontentloaded');reply('LOOPBACK_TEXT');reply('LOOPBACK_ALLOW');reply('LOOPBACK_DENY')
  assert page.locator('.assistant-bubble').count()==3
  cases.append({'name':'normal-main-refresh-history','status':'PASS','assistantBubbles':3})
  frames=page.evaluate('window.__mainFrames');page.screenshot(path=str(out/'real-main-desktop.png'));result['browserVersion']=browser.version
  browser.close()
 assert len(requests)==5,requests
 assert all(r['model']=='loopback-test-model' and r['stream'] and r['path']=='/v1/chat/completions' for r in requests)
 assert any(r['afterTool'] and any(m['role']=='tool' for m in r['messages']) for r in requests)
 result['status']='PASS'
except Exception as e:
 result['status']='FAILED';result['error']=str(e);result['traceback']=traceback.format_exc()
finally:
 if p.poll() is None:p.send_signal(signal.SIGTERM)
 try:p.wait(timeout=8)
 except subprocess.TimeoutExpired:p.kill();p.wait();result['forcedKill']=True
 server.shutdown();server.server_close()
 result.update(processExit=p.returncode,stdout=logs,pageErrors=errors,modelRequestsCount=len(requests),postApiRequestsCount=sum(r['method']=='POST' for r in browserrequests))
 (out/'model-requests.json').write_text(json.dumps(requests,ensure_ascii=False,indent=2)+'\n')
 (out/'browser-requests.json').write_text(json.dumps(browserrequests,ensure_ascii=False,indent=2)+'\n')
 (out/'browser-frames-after-reload.json').write_text(json.dumps(frames,ensure_ascii=False,indent=2)+'\n')
 (out/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
 (out/'startup.log').write_text('\n'.join(logs)+'\n')
print(json.dumps(result,ensure_ascii=False))
if result['status']!='PASS':raise SystemExit(1)
