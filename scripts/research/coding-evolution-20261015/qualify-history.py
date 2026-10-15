#!/usr/bin/env python3
"""Qualify fixed historical test oracles on actual parent/fixed checkouts; no model."""
import argparse,json,os,subprocess,tempfile,time,hashlib
from pathlib import Path
root=Path(__file__).resolve().parents[3]
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',type=Path,required=True);p.add_argument('--tasks',default='');args=p.parse_args()
output=args.output.resolve();output.mkdir(parents=True,exist_ok=False)
catalog=json.loads((root/'benchmarks/coding-repositories-v1/catalog.json').read_text())
selected=set(args.tasks.split(',')) if args.tasks else None
results=[]
env=os.environ.copy();env.update({'XDG_CACHE_HOME':'/workspace/.cache','XDG_STATE_HOME':'/workspace/.state','npm_config_devdir':'/workspace/.cache/node-gyp','CI':'1'})
def run(command,cwd,log,timeout=300):
 with log.open('wb') as target:
  try:return subprocess.run(command,cwd=cwd,env=env,stdout=target,stderr=subprocess.STDOUT,timeout=timeout).returncode
  except subprocess.TimeoutExpired:return 124
for task in catalog['tasks']:
 if selected and task['id'] not in selected:continue
 row={'task':task['id'],'paidModelCalls':0,'sides':{}};results.append(row)
 for side,revision in [('fixed',task['fixedSha']),('base',task['baseSha'])]:
  side_dir=output/(task['id']+'-'+side);side_dir.mkdir()
  container=Path(tempfile.mkdtemp(prefix='coding-historical-'));workspace=container/'source'
  result={'revision':revision,'oracleIdentity':task['oracleFiles']};row['sides'][side]=result
  try:
   result['prepareExit']=run(['git','-c','core.longpaths=true','worktree','add','--detach',str(workspace),revision],root,side_dir/'prepare.log')
   if result['prepareExit']:continue
   for oracle in task['oracleFiles']:
    path=workspace/oracle['path'];path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(subprocess.check_output(['git','show',task['fixedSha']+':'+oracle['path']],cwd=root))
   result['installExit']=run(['pnpm','install','--frozen-lockfile','--store-dir','/workspace/.pnpm-store','--config.manage-package-manager-versions=false','--config.package-manager-strict=false'],workspace,side_dir/'install.log')
   if result['installExit']:continue
   result['buildExit']=run(['pnpm','build'],workspace,side_dir/'build.log')
   if result['buildExit']:
    result['verdict']='FIXED_BUILD_FAILURE' if side=='fixed' else 'BASE_BUILD_FAILURE_REQUIRES_REVIEW';continue
   report=side_dir/'vitest.json'
   result['testExit']=run([*([task['verification']['command']]+task['verification']['args']),'--reporter=json','--outputFile='+str(report)],workspace,side_dir/'test.log')
   if report.is_file():
    data=json.loads(report.read_text());result.update({'passed':data.get('numPassedTests',0),'failed':data.get('numFailedTests',0),'skipped':data.get('numPendingTests',0)})
    result['verdict']='GREEN' if result['testExit']==0 and result['passed']>0 and result['failed']==0 else 'RED' if result['failed']>0 else 'UNQUALIFIED'
   else:result['verdict']='NO_TEST_REPORT'
   result['oraclesIntact']=all(hashlib.sha256((workspace/item['path']).read_bytes()).hexdigest()==item['sha256'] for item in task['oracleFiles'])
  except Exception as error:result['error']=type(error).__name__+': '+str(error)[:500]
  finally:
   # This path was uniquely created by this process; never remove an existing user checkout.
   if workspace.exists():run(['git','worktree','remove','--force',str(workspace)],root,side_dir/'cleanup.log')
   try:container.rmdir()
   except OSError:pass
   (output/'qualification.json').write_text(json.dumps({'sourceCatalog':'benchmarks/coding-repositories-v1/catalog.json','paidModelCalls':0,'results':results},indent=2)+'\n')
  print(json.dumps({'task':task['id'],'side':side,**result}),flush=True)
print(json.dumps({'complete':True,'tasks':len(results),'qualified':sum(r['sides'].get('fixed',{}).get('verdict')=='GREEN' and r['sides'].get('base',{}).get('verdict')=='RED' for r in results)}),flush=True)
