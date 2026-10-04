import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root='/workspace/harness-agent',out=join(root,'.ci/agent-round2-20261004/memory-audit');
const {createHarness}=await import(pathToFileURL(join(root,'packages/harness/dist/index.js')));
const cases=[];let n=0;
for(const backend of ['jsonl','sqlite']) {
 for(const mode of ['session-scope','deprecated','superseded','stale','conflicting']) {
  const dir=join(out,'harness-fixtures',`${++n}-${backend}-${mode}`),cwd=join(dir,'workspace'),dataDir=join(dir,'data');
  await mkdir(cwd,{recursive:true});await writeFile(join(cwd,'AGENTS.md'),'# Local test workspace\n');
  const requests=[];
  const provider={id:'memory-audit-offline',listModels:async()=>[{id:'offline',name:'Offline audit',capabilities:{contextWindowTokens:128000}}],createClient:()=>({generate:async function*(request){requests.push(structuredClone(request));yield {type:'started',timestamp:0};yield {type:'completed',timestamp:0,result:{finishReason:'stop',text:'engineering fixture done'}};}})};
  const harness=await createHarness({cwd,dataDir,profile:'test',modelProvider:provider,model:{providerId:provider.id,modelId:'offline'},memory:{enabled:true,scope:mode==='session-scope'?'session':'workspace',...(backend==='sqlite'?{dbPath:join(dir,'memory-db')}:{})},featureFlags:{skills:false,mcp:false,delegation:false,learning:false}});
  try {
   const sessionA=await harness.runtime.createSession({agent:harness.agents[0],cwd});
   const sessionB=mode==='session-scope'?await harness.runtime.createSession({agent:harness.agents[0],cwd}):sessionA;
   const now=Date.now(),marker=`memoryaudit${n}marker`;
   const entry={id:`audit-memory-${n}`,content:`${marker} historical coding preference from original session`,type:'procedural',sourceSession:sessionA.id,scope:mode==='session-scope'?'session':'workspace',importance:.9,confidence:.9,novelty:.9,stability:.9,createdAt:now,updatedAt:now,deleted:false,...(mode==='session-scope'?{}:{state:{kind:mode,at:now,byId:'replacement',withId:'other',reason:'reviewed retirement'}})};
   await harness.memoryStore.write(entry);
   const turn=await harness.runtime.startTurn(sessionB.id,marker);
   const outcome=await harness.runtime.runTurn(sessionB.id,turn.id,new AbortController().signal);
   const events=await harness.events.list(sessionB.id);
   const requestFile=`harness-${backend}-${mode}-requests.json`;
   await writeFile(join(out,requestFile),JSON.stringify(requests,null,2)+'\n');
   cases.push({backend,mode,sourceSession:sessionA.id,querySession:sessionB.id,marker,expectedMarkerInSystem:false,actualMarkerInSystem:requests.some(x=>(x.system??'').includes(entry.content)),requestFile,scriptedGenerateCalls:requests.length,outcome:{status:outcome.status,memoryRefs:outcome.state?.memoryRefs},memoryRetrievalEvents:events.filter(x=>x.type==='memory.retrieved').map(x=>x.payload),usefulness:(await harness.memoryStore.get(entry.id))?.usefulness});
  } finally { await harness.close(); }
 }
}
const paths=['packages/harness/src/create-harness.ts','packages/harness/dist/create-harness.js','packages/core/dist/runtime/context-controller.js'];
const sourceHashes=Object.fromEntries(await Promise.all(paths.map(async p=>[p,createHash('sha256').update(await readFile(join(root,p))).digest('hex')])));
const report={head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),gitStatus:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),sourceHashes,observedAt:new Date().toISOString(),realProviderCalls:0,paidCalls:0,realModelQuality:'NOT_RUN',scriptedGenerateCalls:cases.reduce((sum,x)=>sum+x.scriptedGenerateCalls,0),cases};
await writeFile(join(out,'harness-baseline.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
