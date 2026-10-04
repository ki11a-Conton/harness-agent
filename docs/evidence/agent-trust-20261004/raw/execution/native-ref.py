import base64,json,os,subprocess,sys,time
from pathlib import Path
pat=os.environ['HARNESS_PUBLISH_PAT'];encoded=base64.b64encode(('x-access-token:'+pat).encode()).decode();env=os.environ.copy();env.pop('HARNESS_PUBLISH_PAT',None)
for key in list(env):
 if key.startswith('GIT_TRACE') or key=='GIT_CURL_VERBOSE':env.pop(key,None)
count=int(env.get('GIT_CONFIG_COUNT','0'))
for key,value in [('http.https://github.com/.extraheader','Authorization: Basic '+encoded),('http.https://github.com/.extraheader','Cache-Control: no-cache'),('http.https://github.com/.extraheader','Pragma: no-cache'),('credential.helper','')]:
 env['GIT_CONFIG_KEY_'+str(count)]=key;env['GIT_CONFIG_VALUE_'+str(count)]=value;count+=1
env['GIT_CONFIG_COUNT']=str(count);env['GIT_TERMINAL_PROMPT']='0';env['GIT_TRACE_REDACT']='1'
workspace,ref,out=sys.argv[1:];r=subprocess.run(['/usr/bin/git','ls-remote','origin',ref],cwd=workspace,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
def redact(s):return s.replace(pat,'[credential]').replace(encoded,'[credential]')
record={'method':'native /usr/bin/git ls-remote; ephemeral auth/no-cache','ref':ref,'exitCode':r.returncode,'stdout':redact(r.stdout),'stderr':redact(r.stderr),'observedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
Path(out).write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record,ensure_ascii=False));sys.exit(r.returncode)
