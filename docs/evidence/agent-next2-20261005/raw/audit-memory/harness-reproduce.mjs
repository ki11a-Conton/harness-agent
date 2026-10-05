import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(process.argv[2] ?? '.');
const out = resolve(process.argv[3]);
const { createHarness } = await import(pathToFileURL(join(root,'packages/harness/dist/index.js')));
const result={sourceSha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),cases:[],paidRequests:0};
for(const backend of ['jsonl','sqlite']){
 const cwd=await mkdtemp(join(tmpdir(),'memory-feedback-harness-'));
 const requests=[];
 const provider={id:'offline-memory-feedback',listModels:async()=>[{id:'offline',name:'Offline',capabilities:{contextWindowTokens:128000}}],createClient:()=>({generate:async function*(request){requests.push(structuredClone(request));yield{type:'started',timestamp:1};yield{type:'completed',timestamp:1,result:{text:'audit completed',finishReason:'stop'}};}})};
 await writeFile(join(cwd,'AGENTS.md'),'# Offline feedback audit workspace\n');
 const harness=await createHarness({cwd,dataDir:join(cwd,'data'),profile:'test',modelProvider:provider,model:{providerId:provider.id,modelId:'offline'},memory:{enabled:true,scope:'workspace',...(backend==='sqlite'?{dbPath:join(cwd,'memory-db')}:{})},featureFlags:{skills:false,mcp:false,delegation:false,learning:false}});
 try{
  const sessions=await Promise.all(Array.from({length:4},()=>harness.runtime.createSession({agent:harness.agents[0],cwd})));
  const now=Date.now();
  await harness.memoryStore.write({id:'memory_harness_audit',content:'auditneedle requires checking actual persisted memory feedback',type:'procedural',sourceSession:sessions[0].id,scope:'workspace',importance:.9,confidence:.9,novelty:.9,stability:.9,createdAt:now,updatedAt:now,deleted:false});
  const outcomes=await Promise.all(sessions.map(async(session)=>{const turn=await harness.runtime.startTurn(session.id,'auditneedle');return await harness.runtime.runTurn(session.id,turn.id,new AbortController().signal);}));
  const events=(await Promise.all(sessions.map(session=>harness.events.list(session.id)))).flat();
  result.cases.push({backend,expected:{completedTurns:4,modelRequests:4,retrievedCount:4,injectedCount:4,usedCount:4,taskSuccessCount:4},actual:{outcomes:outcomes.map(x=>x.status),modelRequests:requests.length,requestMemoryRefs:requests.map(request=>(request.system??'').includes('auditneedle')),memory:(await harness.memoryStore.get('memory_harness_audit')),retrievedEvents:events.filter(event=>event.type==='memory.retrieved').map(event=>event.payload)}});
 }finally{await harness.close();await rm(cwd,{recursive:true,force:true});}
}
await writeFile(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result.cases.map(x=>({backend:x.backend,expected:x.expected,actual:{outcomes:x.actual.outcomes,modelRequests:x.actual.modelRequests,requestMemoryRefs:x.actual.requestMemoryRefs,usefulness:x.actual.memory.usefulness,retrievedEvents:x.actual.retrievedEvents.length}})),null,2));
