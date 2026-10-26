import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root=process.argv[2], output=process.argv[3];
const load=p=>import(pathToFileURL(join(root,p)));
const {createHarness}=await load('packages/harness/dist/index.js');
const {ScriptedModelProvider}=await load('packages/model/dist/index.js');
const cwd=await mkdtemp(join(tmpdir(),'paired-overlap-cause-'));
let release,connected;
const ready=new Promise(r=>connected=r);
const server=createServer((req,res)=>{req.resume();release=()=>res.end('release');connected();});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/hold`;
const code=`const fs=require('node:fs');fs.writeFileSync('starts.json',JSON.stringify({pid:process.pid,at:Date.now()}));require('node:http').get(${JSON.stringify(url)},res=>{res.resume();res.on('end',()=>{fs.writeFileSync('exits.json',JSON.stringify({code:0,at:Date.now()}));fs.writeFileSync('complete','1')})}).on('error',e=>{console.error(e);process.exitCode=1})`;
const timeline=[];let stage='start',jobId,pollToken=0,state,h;
const waitExit=async()=>{const deadline=Date.now()+4000;for(;;){try{return JSON.parse(await readFile(join(cwd,'exits.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;if(Date.now()>deadline)throw Error('original command budget elapsed');await new Promise(r=>setTimeout(r,5));}}};
const provider={id:'overlap-causal',listModels:async()=>[{id:'scripted',capabilities:{contextWindowTokens:128000}}],createClient:()=>({async *generate(request){
  for(const m of request.messages.filter(m=>m.role==='tool')){let v;try{v=JSON.parse(m.content);}catch{v=null;}if(v?.jobId){jobId=v.jobId;pollToken=v.pollToken;state=v.state;}}
  if(stage==='observe'){release();await waitExit();}
  timeline.push({stage,at:Date.now()});
  const call=(name,args)=>ScriptedModelProvider.toolCall(name,args);
  if(stage==='start'){stage='ready';yield*call('exec_start',{command:process.execPath,args:['-e',code],yieldMs:0});return;}
  if(stage==='ready'){await ready;stage='observe';yield*call('read_file',{path:'related'});return;}
  if(stage==='observe'){stage='poll';yield*call('exec_poll',{jobId,pollToken,waitMs:1000});return;}
  if(stage==='poll'&&state==='running'){yield*call('exec_poll',{jobId,pollToken,waitMs:1000});return;}
  if(stage==='poll'){stage='after';yield*call('read_file',{path:'after'});return;}
  yield*ScriptedModelProvider.text('Actual reads and command verified.');
}})};
try{
 await writeFile(join(cwd,'related'),'RELATED');await writeFile(join(cwd,'after'),'AFTER');
 h=await createHarness({cwd,dataDir:join(cwd,'state'),profile:'test',modelProvider:provider,model:{providerId:provider.id,modelId:'scripted'},featureFlags:{skills:false,mcp:false,memory:false,delegation:false,learning:false},managedCommands:{enabled:true,maxJobMs:5000},limits:{maxDurationMs:10000,maxToolCalls:15},sandboxPolicy:{filesystem:{mode:'workspace-write',allowedPaths:[cwd]},network:{mode:'allowlist',hosts:['127.0.0.1']},process:{timeoutMs:5000,maxOutputBytes:65536}},task:{id:'overlap',goal:'Run actual command and inspect related code',completionPolicy:{requiresVerification:true},verification:[{kind:'command',command:process.execPath,args:['-e',"if(require('node:fs').readFileSync('complete','utf8')!=='1')process.exit(1)"]}]}});
 const s=await h.runtime.createSession({agent:h.agents[0],cwd});const t=await h.runtime.startTurn(s.id,'Run check and read related code');const outcome=await h.runtime.runTurn(s.id,t.id,new AbortController().signal);
 const events=await h.events.list(s.id), start=JSON.parse(await readFile(join(cwd,'starts.json'),'utf8')), exit=await waitExit();
 const times=path=>events.filter(e=>e.type==='tool.completed'&&e.payload.tool==='read_file'&&e.payload.status==='success').flatMap(e=>e.payload.evidence??[]).filter(e=>e.type==='file'&&e.source===join(cwd,path)).map(e=>e.timestamp);
 const readAt=times('related')[0], afterAt=times('after')[0], modelAt=timeline.find(e=>e.stage==='observe').at;
 const {observeReadOverlap}=await import(new URL('./observe-read-overlap.mjs', import.meta.url));
 const helperDuring=observeReadOverlap({events,starts:[start],exits:[exit],sourcePath:join(cwd,'related')});
 const helperAfter=observeReadOverlap({events,starts:[start],exits:[exit],sourcePath:join(cwd,'after')});
 const report={sourceSha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceDirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()!=='',platform:process.platform,paidModelCalls:0,helperDuring,helperAfter,status:outcome.status,grade:outcome.grade,start,exit,readAt,afterAt,modelAt,oldModelTimestampMetric:start.at<modelAt&&exit.at>modelAt,actualReadDuringCommand:start.at<readAt&&exit.at>readAt,actualReadAfterCompletion:start.at<afterAt&&exit.at>afterAt};
 await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 assert.equal(helperDuring.overlapObserved,true);assert.equal(helperAfter.overlapObserved,false);assert.equal(report.status,'completed');assert.equal(report.grade,'verified_complete');assert.equal(report.oldModelTimestampMetric,false);assert.equal(report.actualReadDuringCommand,true);assert.equal(report.actualReadAfterCompletion,false);
}finally{await h?.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(cwd,{recursive:true,force:true});}
