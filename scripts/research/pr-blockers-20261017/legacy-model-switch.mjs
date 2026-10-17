import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo=fileURLToPath(new URL('../../../', import.meta.url));
const { createHarness }=await import(pathToFileURL(join(repo,'packages/harness/dist/index.js')).href);
const { ScriptedModelProvider }=await import(pathToFileURL(join(repo,'packages/model/dist/index.js')).href);
const { createDeepseekComposition }=await import(pathToFileURL(join(repo,'apps/web/dist/deepseek/composition.js')).href);
const output=process.argv[2];
assert.ok(output,'An output directory is required');await mkdir(output,{recursive:true});
const source=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
const sourceClean=execFileSync('git',['status','--porcelain=v1'],{cwd:repo,encoding:'utf8'})==='';
if(process.argv.includes('--require-clean'))assert.ok(sourceClean,'Exact-source acceptance requires a clean worktree');
const root=await realpath(await mkdtemp(join(tmpdir(),'pr-upgrade-'))), cwd=join(root,'project'), dataDir=join(root,'data');
await mkdir(cwd);
const requests=[];
const server=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;const value=JSON.parse(body);requests.push({model:value.model});res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content:'answer-'+value.model},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
let base,composition,follow,followController;
const signal=()=>new AbortController().signal;
async function open(){const provider=new ScriptedModelProvider([]);base=await createHarness({cwd,dataDir,profile:'interactive',modelProvider:provider,model:{providerId:provider.id,modelId:'scripted-model'}});composition=await createDeepseekComposition(base,dataDir);}
async function close(){if(follow){followController.abort();await follow.return?.();follow=undefined;}if(composition){await composition.close();composition=undefined;}if(base){await base.close();base=undefined;}}
async function snapshot(id){const controller=new AbortController();const stream=composition.sessions.stream('session/follow',{request:{address:{kind:'session',sessionId:id},assistantStream:true}},controller.signal)[Symbol.asyncIterator]();try{return(await stream.next()).value;}finally{controller.abort();await stream.return?.();}}
try{
 await open();
 await composition.catalog.call('credentials/set',{ref:'LEGACY_LOCAL_KEY',value:'local-synthetic-key'},signal());
 await composition.catalog.call('settings/update',{ns:'llm-pi-ai',patch:{providers:{legacy:{api:'openai-completions',baseURL:`http://127.0.0.1:${server.address().port}/v1`,apiKeyEnv:'LEGACY_LOCAL_KEY',models:[{id:'model-a'},{id:'model-b'}]}}}},signal());
 const session=await composition.owners.createSession(undefined,signal(),{providerKey:'legacy',modelId:'model-a'});
 const id=session.id, owner=await composition.owners.ownerOf(id);
 const actor=await composition.harness.sessions.load(id), turn=await actor.createTurn({sessionId:id,text:'first task'});
 assert.equal((await actor.runTurn(turn.id)).status,'completed');
 const path=join(owner.config.dataDir,'messages',`${composition.owners.nativeSessionId(id)}.jsonl`);
 await close();
 const original=(await readFile(path,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(original.filter(row=>row.message.role==='assistant').length,1);
 for(const row of original)delete row.message.model;
 await writeFile(path,original.map(row=>JSON.stringify(row)).join('\n')+'\n');
 await open();
 assert.equal((await composition.harness.store.listMessages(id)).find(message=>message.role==='assistant').model,undefined);
 followController=new AbortController();follow=composition.sessions.stream('session/follow',{request:{address:{kind:'session',sessionId:id},assistantStream:true}},followController.signal)[Symbol.asyncIterator]();
 const before=(await follow.next()).value;
 await composition.catalog.call('session/selectModel',{request:{sessionId:id,provider:'legacy',model:'model-b'}},signal());
 let timer;const frame=await Promise.race([follow.next(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('old-tab follow did not observe selection')),5000);})]).finally(()=>clearTimeout(timer));
 assert.equal(frame.value.type,'event');assert.equal(frame.value.event.type,'model/selection');
 const after=await snapshot(id);
 assert.deepEqual(after.records.slice(0,before.records.length),before.records);
 assert.deepEqual(after.projections.values.modelSelection,{lastUsed:{provider:'legacy',model:'model-a'},next:{provider:'legacy',model:'model-b'}});
 const durableRecords=after.records;
 await close();await open();
 const restored=await snapshot(id);assert.deepEqual(restored.records.slice(0,durableRecords.length),durableRecords);
 assert.deepEqual((await composition.harness.runtime.getSessionAgent(id)).model,{providerId:'legacy',modelId:'model-b'});
 await composition.sessions.call('session/prompt',{request:{sessionId:id,requestId:'legacy-second',mode:'queue',content:[{type:'text',text:'second task'}]}},signal());
 const deadline=Date.now()+15000;
 while((await composition.harness.store.listTurns(id)).filter(t=>t.status==='completed').length<2){assert.ok(Date.now()<deadline,'second turn failed');await new Promise(done=>setTimeout(done,20));}
 assert.deepEqual(requests,[{model:'model-a'},{model:'model-b'}]);
 const branch=await composition.sessions.call('session/fork',{request:{sessionId:id}},signal());
 assert.deepEqual((await composition.harness.runtime.getSessionAgent(branch.sessionId)).model,{providerId:'legacy',modelId:'model-b'});
 const answers=(await composition.harness.store.listMessages(branch.sessionId)).filter(m=>m.role==='assistant');
 assert.deepEqual(answers.map(m=>m.model),[{providerId:'legacy',modelId:'model-a'},{providerId:'legacy',modelId:'model-b'}]);
 const result={status:'PASS',source,sourceClean,providerCalls:requests.length,externalPaidCalls:0,requests,legacyMessages:original.length,immutablePrefixRecords:before.records.length,selectionObservedByOldFollow:true,restartPrefixIdentical:true,branchAnswerModels:answers.map(m=>m.model),scenarios:['legacy-format','old-follow-selection','immutable-prefix','restart-reload','actual-selected-http-model','branch-provenance']};
 await writeFile(join(output,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await close();await new Promise(done=>server.close(done));await rm(root,{recursive:true,force:true});}
