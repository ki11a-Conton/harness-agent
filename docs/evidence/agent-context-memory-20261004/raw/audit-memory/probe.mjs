import { mkdir, writeFile, readFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const repo='/workspace/harness-agent';
const out=join(repo,'.ci/agent-context-memory-20261004/audit-memory');
await mkdir(out,{recursive:true});
const fixtureRoot=await mkdtemp(join(out,'fixtures-'));
const {JsonlMemoryStore,SqliteMemoryStore,retrieveMemories}=await import(pathToFileURL(join(repo,'packages/memory/dist/index.js')));
const {createHarness}=await import(pathToFileURL(join(repo,'packages/harness/dist/index.js')));
const now=Date.now();
const base={content:'historical guidance',type:'procedural',sourceSession:'session-owner',scope:'workspace',importance:.9,confidence:.9,novelty:.9,stability:.9,createdAt:now,updatedAt:now,deleted:false};
const lesson={when:'遇到端口配置错误时',do:'执行 portlint 然后重启',avoid:'重复 blindretry',rootCause:'tool',outcome:'failure',evidenceRefs:['event-observed']};
const spec=[
 {name:'english-token',query:'retry',entry:{content:'Inspect retry failures before repeating commands'},want:true},
 {name:'english-substring',query:'portconfig',entry:{content:'Read the portconfiguration guidance'},want:true},
 {name:'chinese-substring',query:'端口配置',entry:{content:'调试端口配置时先检查环境变量。'},want:true},
 {name:'mixed-substring',query:'EADDRINUSE 端口',entry:{content:'如果EADDRINUSE 端口冲突先停服务。'},want:true},
 {name:'structured-when',query:'端口配置',entry:{content:'lesson summary unrelated words',structured:lesson},want:true},
 {name:'structured-do',query:'portlint',entry:{content:'lesson summary unrelated words',structured:lesson},want:true},
 {name:'structured-avoid',query:'blindretry',entry:{content:'lesson summary unrelated words',structured:lesson},want:true},
 {name:'english-miss',query:'absentenglishmarker',entry:{content:'safe distinct engineering advice'},want:false},
 {name:'chinese-miss',query:'绝不匹配量子词',entry:{content:'调试端口配置时先检查环境变量。'},want:false},
 {name:'deleted',query:'deletedmarker',entry:{content:'deletedmarker guidance',deleted:true},want:false},
 {name:'type-filter',query:'typemarker',entry:{content:'typemarker guidance',type:'explicit'},opts:{type:'procedural'},want:false},
 {name:'scope-filter',query:'scopemarker',entry:{content:'scopemarker guidance',scope:'session'},opts:{scope:'workspace'},want:false},
 {name:'owned-session',query:'sessionmarker',entry:{content:'sessionmarker guidance',scope:'session'},queryScope:'session',want:true},
 {name:'foreign-session',query:'sessionmarker',entry:{content:'sessionmarker guidance',scope:'session',sourceSession:'session-foreign'},queryScope:'session',want:false},
 {name:'inactive',query:'retiredmarker',entry:{content:'retiredmarker guidance',state:{kind:'deprecated',at:now}},want:false},
];
const sourcePaths=['packages/memory/src/memory-store.ts','packages/memory/src/sqlite-memory-store.ts','packages/memory/src/retrieval.ts','packages/memory/src/security-gate.ts','packages/harness/src/memory-runtime-bridge.ts','packages/harness/src/create-harness.ts','packages/memory/dist/memory-store.js','packages/memory/dist/sqlite-memory-store.js','packages/memory/dist/retrieval.js','packages/harness/dist/memory-runtime-bridge.js','packages/harness/dist/create-harness.js'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const report={observedAt:new Date().toISOString(),sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),sourceStatus:execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}).trim(),sourceHashes:Object.fromEntries(await Promise.all(sourcePaths.map(async p=>[p,hash(await readFile(join(repo,p)))]))),probeSha256:hash(await readFile(fileURLToPath(import.meta.url))),realProviderCalls:0,paidCalls:0,realModelQuality:'NOT_RUN',cases:[],harnessCases:[],supplementCase:[]};
for(const backend of ['jsonl','sqlite']){
 for(const c of spec){
  const dataDir=join(fixtureRoot,backend,c.name);
  const store=backend==='jsonl'?new JsonlMemoryStore({dataDir}):new SqliteMemoryStore({dataDir});
  try {
   const entry={...base,id:`${backend}-${c.name}`,...c.entry};await store.write(entry);
   const raw=await store.search(c.query,c.opts);
   const result=await retrieveMemories(store,c.query,c.queryScope??'workspace',{sessionId:'session-owner',now,...c.opts});
   const actual=c.opts?.scope?raw.some(x=>x.id===entry.id):result.items.some(x=>x.memory.id===entry.id);
   const fts=backend==='sqlite'?store.database.prepare('SELECT content, id FROM memories_fts WHERE memories_fts MATCH ?').all(c.query.split(/\s+/).map(x=>`"${x.replaceAll('"','')}"`).join(' OR ')):undefined;
   report.cases.push({backend,name:c.name,query:c.query,entry,opts:c.opts,expected:c.want,actual,pass:actual===c.want,rawIds:raw.map(x=>x.id),retrievedIds:result.items.map(x=>x.memory.id),suppressed:result.suppressed.map(x=>({id:x.memory.id,reason:x.reason})),fts});
  }finally{store.close?.();}
 }
 {
  const dataDir=join(fixtureRoot,backend,'positive-fts-needs-supplement');
  const store=backend==='jsonl'?new JsonlMemoryStore({dataDir}):new SqliteMemoryStore({dataDir});
  try{
   await store.write({...base,id:'exact-chinese-token',content:'端口配置'});
   await store.write({...base,id:'chinese-substring-also-required',content:'调试端口配置时先检查环境变量。'});
   const hits=await store.search('端口配置');
   report.supplementCase.push({backend,query:'端口配置',expectedIds:['exact-chinese-token','chinese-substring-also-required'],actualIds:hits.map(x=>x.id),pass:hits.length===2});
  }finally{store.close?.();}
 }
 for(const name of ['english-token','chinese-substring','mixed-substring','structured-when','structured-do','chinese-miss']){
  const c=spec.find(x=>x.name===name);const dir=join(fixtureRoot,'harness',backend,name),cwd=join(dir,'workspace'),dataDir=join(dir,'data');
  await mkdir(cwd,{recursive:true});await writeFile(join(cwd,'AGENTS.md'),'# Synthetic memory contract workspace\n');
  const requests=[];
  const provider={id:'memory-contract-offline',listModels:async()=>[{id:'offline',name:'Offline scripted probe',capabilities:{contextWindowTokens:128000}}],createClient:()=>({generate:async function*(request){requests.push(structuredClone(request));yield{type:'started',timestamp:0};yield{type:'completed',timestamp:0,result:{finishReason:'stop',text:'engineering probe completed'}};}})};
  const harness=await createHarness({cwd,dataDir,profile:'test',modelProvider:provider,model:{providerId:provider.id,modelId:'offline'},memory:{enabled:true,scope:'workspace',...(backend==='sqlite'?{dbPath:join(dir,'memory-db')}:{})},featureFlags:{skills:false,mcp:false,delegation:false,learning:false}});
  try{
   const session=await harness.runtime.createSession({agent:harness.agents[0],cwd});const entry={...base,id:`harness-${backend}-${name}`,sourceSession:session.id,...c.entry};await harness.memoryStore.write(entry);
   const turn=await harness.runtime.startTurn(session.id,c.query);const outcome=await harness.runtime.runTurn(session.id,turn.id,new AbortController().signal);const events=await harness.events.list(session.id);
   const uniqueBody=entry.structured?`When: ${entry.structured.when}`:entry.content;
   const bodySeen=requests.some(x=>(x.system??'').includes(uniqueBody));
   const memoryRefs=outcome.state?.memoryRefs??[];const file=`request-${backend}-${name}.json`;
   await writeFile(join(out,file),JSON.stringify({entry,query:c.query,requests,outcome:{status:outcome.status,memoryRefs},retrievalEvents:events.filter(x=>x.type==='memory.retrieved').map(x=>x.payload)},null,2)+'\n');
   report.harnessCases.push({backend,name,query:c.query,expected:c.want,bodySeen,memoryRefs,requestCount:requests.length,outcome:outcome.status,pass:bodySeen===c.want,requestFile:file,usefulness:(await harness.memoryStore.get(entry.id))?.usefulness});
  }finally{await harness.close();}
 }
}
report.storeSummary={total:report.cases.length,passed:report.cases.filter(x=>x.pass).length,failed:report.cases.filter(x=>!x.pass).map(x=>`${x.backend}:${x.name}`)};
report.harnessSummary={total:report.harnessCases.length,passed:report.harnessCases.filter(x=>x.pass).length,failed:report.harnessCases.filter(x=>!x.pass).map(x=>`${x.backend}:${x.name}`),scriptedGenerateCalls:report.harnessCases.reduce((n,x)=>n+x.requestCount,0)};
await writeFile(join(out,'baseline.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({head:report.sourceHead,store:report.storeSummary,harness:report.harnessSummary,paidCalls:0},null,2));
