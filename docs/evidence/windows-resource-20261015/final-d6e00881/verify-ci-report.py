import argparse,hashlib,json,re,shutil
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--sha',required=True);ap.add_argument('--evidence-dir',type=Path,required=True);ap.add_argument('--out',type=Path,required=True);ap.add_argument('--require-green',action='store_true');ap.add_argument('--require-main',action='store_true');a=ap.parse_args()
assert re.fullmatch('[a-f0-9]{40}',a.sha)
required={'ci':'主 CI','genuine Windows acceptance':'原生 Windows','first-generation installed acceptance':'安装包验收','official DeepSeek UI installed acceptance':'Web UI 安装验收'}
records={}
for f in a.evidence_dir.glob('run-*.json'):
 r=json.loads(f.read_text())
 if r.get('head_sha')==a.sha and r.get('name') in required:records[r['name']]=(f,r)
if len(records)<4:
 f=a.evidence_dir/'runs.json'
 if f.exists():
  for r in json.loads(f.read_text()).get('workflow_runs',[]):
   if r.get('head_sha')==a.sha and r.get('name') in required and r['name'] not in records:records[r['name']]=(None,r)
assert len(records)==4,'Four exact-source workflow records are required'
issues=[];rows=[];raw={};details=[]
for name in required:
 f,r=records[name];raw[f'run-{r["id"]}.json']=json.dumps(r,ensure_ascii=False,indent=2).encode()+b'\n'
 jfile=a.evidence_dir/f'jobs-{r["id"]}.json';j=json.loads(jfile.read_text());jobs=j['jobs'];raw[jfile.name]=jfile.read_bytes()
 if r['status']!='completed' or r['conclusion']!='success':issues.append(f'{name}: {r["status"]}/{r["conclusion"]}')
 if name=='ci' and len(jobs)<10:issues.append('main CI lacks a complete ten-job acceptance unit')
 if not jobs:issues.append(f'{name}: no jobs')
 for x in jobs:
  if x['head_sha']!=a.sha or x['run_attempt']!=r['run_attempt']:issues.append(f'job {x["id"]}: source or attempt mismatch')
  optional=(name=='first-generation installed acceptance' and x['name']=='export-existing-draft' and x['conclusion']=='skipped')
  if not optional and (x['status']!='completed' or x['conclusion']!='success'):issues.append(f'job {x["id"]}: {x["name"]}: {x["status"]}/{x["conclusion"]}')
 counts={s:sum(x['conclusion']==s for x in jobs) for s in ['success','failure','skipped']};rows.append(f'| {required[name]} | [{r["id"]}]({r["html_url"]}) | {r["status"]}/{r["conclusion"]} | {counts["success"]}/{counts["failure"]}/{counts["skipped"]} |')
 details.extend(f'- {x["name"]}: {x["status"]}/{x["conclusion"]} (job {x["id"]})' for x in jobs if name=='ci')
mainref=a.evidence_dir/'remote-main-latest.json'
if a.require_main:
 assert mainref.exists(),'fresh remote-main-latest.json required';v=json.loads(mainref.read_text());raw[mainref.name]=mainref.read_bytes()
 if v['object']['sha']!=a.sha:issues.append('remote main differs from accepted SHA')
verdict='PASS' if not issues else 'NOT_GREEN';a.out.mkdir(parents=True,exist_ok=True);(a.out/'raw').mkdir(exist_ok=True)
for name,b in raw.items():
 assert not re.search(rb'gh[pousr]_[A-Za-z0-9]{20,}',b);(a.out/'raw'/name).write_bytes(b)
text=f'# 精确源码 CI 复核\n\n源码 `{a.sha}`；结论 **{verdict}**。所有 workflow/job 的 SHA 和 attempt 已逐项核对。任务计数依次为成功/失败/跳过。\n\n| 验收 | 运行 | 状态 | 任务计数 |\n| --- | --- | --- | --- |\n'+'\n'.join(rows)+'\n\n主 CI 任务：\n\n'+'\n'.join(details)+'\n\n仅安装包流程的可选 export-existing-draft 允许跳过；主 CI 不接受跳过的发布证明或双平台汇总。CI 证明离线工程验收，不证明付费模型质量。\n'
if issues:text+='\n未满足条件：\n\n'+'\n'.join('- '+s for s in issues)+'\n'
(a.out/'README.md').write_text(text)
(a.out/'verdict.json').write_text(json.dumps({'sourceSha':a.sha,'verdict':verdict,'issues':issues,'remoteMainRequired':a.require_main},ensure_ascii=False,indent=2)+'\n')
inventory=[{'path':str(f.relative_to(a.out)),'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()} for f in sorted(a.out.rglob('*')) if f.is_file() and f.name!='inventory.json'];(a.out/'inventory.json').write_text(json.dumps(inventory,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'sha':a.sha,'verdict':verdict,'issues':len(issues),'report':str(a.out/'README.md')},ensure_ascii=False))
raise SystemExit(2 if a.require_green and issues else 0)
