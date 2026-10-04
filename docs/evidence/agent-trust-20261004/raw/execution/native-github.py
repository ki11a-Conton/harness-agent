import base64, json, os, subprocess, sys, time
from pathlib import Path
pat=os.environ["HARNESS_PUBLISH_PAT"]
encoded=base64.b64encode(("x-access-token:"+pat).encode()).decode()
def redact(value):
    return value.replace(pat,"[credential]").replace(encoded,"[credential]")
operation=sys.argv[1]
if operation=="push":
    workspace,sha,ref,receipt=sys.argv[2:]
    env=os.environ.copy()
    env.pop("HARNESS_PUBLISH_PAT",None)
    for key in list(env):
        if key.startswith("GIT_TRACE") or key=="GIT_CURL_VERBOSE": env.pop(key,None)
    count=int(env.get("GIT_CONFIG_COUNT","0"))
    for key,value in [("http.https://github.com/.extraheader","Authorization: Basic "+encoded),
     ("http.https://github.com/.extraheader","Cache-Control: no-cache"),
     ("http.https://github.com/.extraheader","Pragma: no-cache"),("credential.helper","")]:
        env["GIT_CONFIG_KEY_"+str(count)]=key
        env["GIT_CONFIG_VALUE_"+str(count)]=value
        count+=1
    env["GIT_CONFIG_COUNT"]=str(count)
    env["GIT_TERMINAL_PROMPT"]="0"
    env["GIT_TRACE_REDACT"]="1"
    result=subprocess.run(["/usr/bin/git","push","--porcelain","origin",sha+":"+ref],cwd=workspace,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
    row={"method":"native /usr/bin/git; ephemeral Basic auth; no-cache proxy headers", "sourceSha":sha,
     "ref":ref,"exitCode":result.returncode,"output":redact(result.stdout),"timestamp":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime())}
    Path(receipt).write_text(json.dumps(row,indent=2)+"\n")
    print(json.dumps(row,ensure_ascii=False))
    sys.exit(result.returncode)
if operation=="api":
    path=sys.argv[2]
    separator="&" if "?" in path else "?"
    url="https://api.github.com/"+path+separator+"fresh="+str(time.time_ns())
    config='url = "'+url+'"\nheader = "Authorization: Bearer '+pat+'"\nheader = "Cache-Control: no-cache"\nheader = "Pragma: no-cache"\nheader = "Accept: application/vnd.github+json"\n'
    result=subprocess.run(["/usr/bin/curl","--silent","--show-error","--fail-with-body","--max-time","45","--config","-"],input=config,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if result.returncode:
        print(redact(result.stderr+result.stdout)[:2000])
        sys.exit(result.returncode)
    body=json.loads(result.stdout)
    if len(sys.argv)>3: Path(sys.argv[3]).write_text(json.dumps(body,indent=2)+"\n")
    if "workflow_runs" in body:
        print(json.dumps([{key:run.get(key) for key in ["id","name","head_sha","status","conclusion","html_url","created_at"]} for run in body["workflow_runs"]],ensure_ascii=False))
    elif "jobs" in body:
        print(json.dumps([{key:job.get(key) for key in ["id","name","status","conclusion","html_url","started_at","completed_at"]} for job in body["jobs"]],ensure_ascii=False))
    else:
        print(json.dumps({"records":len(body)},ensure_ascii=False) if isinstance(body,list) else json.dumps({key:body.get(key) for key in ["id","name","head_sha","status","conclusion","html_url"]},ensure_ascii=False))
