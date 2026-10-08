import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const repository='/workspace/harness-agent-gen1-20261008';
const project=await mkdtemp(join(tmpdir(),'gen1-real-host-lease-'));
const data=join(project,'durable-data');
const alias=join(project,'data-alias');
const hash=b=>createHash('sha256').update(b).digest('hex');
const environment={...process.env,OPENAI_API_KEY:'',OPENAI_MODEL:'',OPENAI_BASE_URL:'',HARNESS_DATA_DIR:data,HARNESS_WEB_PORT:'0',HARNESS_MEMORY:'0',HARNESS_AGENT_PROMPT:'coding-v1'};
delete environment.NODE_PATH;delete environment.NODE_OPTIONS;
function host(app,args=[],dataDir=data){
 const child=spawn(process.execPath,[join(repository,`apps/${app}/dist/main.js`),...args],{cwd:project,env:{...environment,HARNESS_DATA_DIR:dataDir},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';let readyResolve,readyReject;
 const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});void ready.catch(()=>{});
 const timer=setTimeout(()=>{child.kill('SIGKILL');readyReject(new Error('host startup timed out'));},20000);
 child.stdout.on('data',b=>{stdout+=b; if(stdout.includes('[web] listening on')){clearTimeout(timer);readyResolve();}});
 child.stderr.on('data',b=>{stderr+=b;});
 const done=new Promise((resolve,reject)=>{
  child.on('error',error=>{clearTimeout(timer);readyReject(error);reject(error);});
  child.on('close',(code,signal)=>{clearTimeout(timer);if(!stdout.includes('[web] listening on'))readyReject(new Error(stderr));resolve({code,signal,stdout,stderr});});
 });
 return {child,ready,done};
}
async function snapshot(root,prefix=''){
 const result={};for(const entry of await readdir(join(root,prefix),{withFileTypes:true})){
  const path=prefix?`${prefix}/${entry.name}`:entry.name;
  if(entry.isDirectory())Object.assign(result,await snapshot(root,path));else result[path]=hash(await readFile(join(root,path)));
 }return result;
}
let owner;
try{
 const {DurableApprovalStore}=await import(join(repository,'packages/security/dist/index.js'));
 const {newApprovalId,newSessionId,newAgentId}=await import(join(repository,'packages/contracts/dist/index.js'));
 await mkdir(data,{recursive:true});
 const approval={id:newApprovalId(),sessionId:newSessionId(),agentId:newAgentId(),action:'edit',target:'fixture.ts',reason:'preserve existing user approval',createdAt:Date.now(),expiresAt:Date.now()+600000,scope:'one_call'};
 new DurableApprovalStore(join(data,'approval-store.json')).create(approval);
 owner=host('web');await owner.ready;
 const before=await snapshot(data);assert.ok(Object.keys(before).length>0);assert.equal(JSON.parse(await readFile(join(data,'approval-store.json'),'utf8')).pending[0].id,approval.id);
 const contender=await host('cli',['doctor']).done;
 assert.equal(contender.code,1);assert.match(contender.stderr,/HARNESS_DATA_DIR_IN_USE/);
 const after=await snapshot(data);assert.deepEqual(after,before,'blocked CLI performs no persistent file mutation');
 await symlink(data,alias,process.platform==='win32'?'junction':'dir');
 const aliasContender=await host('cli',['doctor'],alias).done;
 assert.equal(aliasContender.code,1);assert.match(aliasContender.stderr,/HARNESS_DATA_DIR_IN_USE/);
 assert.deepEqual(await snapshot(data),before,'alias contender performs no persistent mutation');
 owner.child.kill('SIGKILL');const ownerExit=await owner.done;owner=undefined;
 const successor=await host('cli',['doctor']).done;assert.equal(successor.code,0);assert.match(successor.stdout,/0 error\(s\)/);
 assert.equal(JSON.parse(await readFile(join(data,'approval-store.json'),'utf8')).pending[0].id,approval.id);
 const digestFiles=['apps/cli/dist/main.js','apps/web/dist/main.js','apps/cli/dist/data-dir-lease.js'];
 const sourceFiles=Object.fromEntries(await Promise.all(digestFiles.map(async path=>[path,hash(await readFile(join(repository,path)))])));
 const result={status:'PASS',platform:process.platform,node:process.version,actualProductEntrypoints:true,sourceFiles,blockedCliExit:contender.code,blockedAliasExit:aliasContender.code,persistentFilesUnchanged:Object.keys(before).length,seededDurableApprovalPreserved:true,ownerExit,successor,contender,aliasContender,paidModelCalls:0,realModelQuality:'NOT_PROVEN'};
 await writeFile('/tmp/gen1-data-dir-real-hosts-green.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({...result,ownerExit:ownerExit.signal,successor:successor.code,contender:contender.code,aliasContender:aliasContender.code}));
}finally{if(owner){owner.child.kill('SIGKILL');await owner.done;}await rm(project,{recursive:true,force:true});}
