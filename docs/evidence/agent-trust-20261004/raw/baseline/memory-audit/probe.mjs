import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const root='/workspace/harness-agent';
const out=join(root,'.ci/agent-round2-20261004/memory-audit');
const {JsonlMemoryStore,SqliteMemoryStore,retrieveMemories,migrateJsonlToSqlite}=await import(pathToFileURL(join(root,'packages/memory/dist/index.js')));
const {MemoryRuntimeBridge}=await import(pathToFileURL(join(root,'packages/harness/dist/memory-runtime-bridge.js')));
const now=1791000000000;
const base={id:'mem-1',content:'memorymarker useful retry guidance',type:'procedural',sourceSession:'session-A',importance:.9,confidence:.9,novelty:.9,stability:.9,createdAt:now,updatedAt:now,deleted:false,scope:'workspace'};
const sources=['packages/contracts/src/memory.ts','packages/memory/src/memory-store.ts','packages/memory/src/sqlite-memory-store.ts','packages/memory/src/retrieval.ts','packages/harness/src/memory-runtime-bridge.ts','packages/memory/dist/sqlite-memory-store.js','packages/memory/dist/retrieval.js','packages/harness/dist/memory-runtime-bridge.js'];
const sourceHashes=Object.fromEntries(await Promise.all(sources.map(async p=>[p,createHash('sha256').update(await readFile(join(root,p))).digest('hex')])));
const report={observedAt:new Date().toISOString(),head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),gitStatus:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),sourceHashes,providerCalls:0,paidCalls:0,realModelQuality:'NOT_RUN',cases:[]};
let n=0;
async function storeOf(kind,label){const dataDir=join(out,'fixtures',`${++n}-${kind}-${label}`);await mkdir(dataDir,{recursive:true});return kind==='jsonl'?new JsonlMemoryStore({dataDir}):new SqliteMemoryStore({dataDir});}
for (const kind of ['jsonl','sqlite']) {
  {
    const store=await storeOf(kind,'lifecycle');
    const byState=[];
    for(const stateKind of ['active','deprecated','superseded','stale','conflicting']) {
      const entry={...base,id:`life-${stateKind}`,content:`statekey-${stateKind} independent`,state:stateKind==='active'?{kind:'active'}:{kind:stateKind,at:now,byId:'replacement',withId:'other',reason:'reviewed retirement'}};
      await store.write(entry);
      const result=await retrieveMemories(store,`statekey-${stateKind}`,'workspace',{now});
      byState.push({state:stateKind,expectedRetrievable:stateKind==='active',actualIds:result.items.map(x=>x.memory.id),suppressed:result.suppressed.map(x=>({id:x.memory.id,reason:x.reason}))});
    }
    report.cases.push({case:'retired-memory-retrieval',backend:kind,byState}); store.close?.();
  }
  {
    const store=await storeOf(kind,'session-scope');
    await store.write({...base,scope:'session',content:'privateMarkerA coding preference exclusive to session A'});
    const bridge=new MemoryRuntimeBridge({store,scope:'session',now:()=>now});
    const own=await bridge.retrieve({sessionId:'session-A',goal:'privateMarkerA',cwd:'/w',recordFeedback:false});
    const other=await bridge.retrieve({sessionId:'session-B',goal:'privateMarkerA',cwd:'/w',recordFeedback:false});
    report.cases.push({case:'session-scope-isolation',backend:kind,expectedOtherCount:0,ownIds:own.items.map(x=>x.memory.id),otherIds:other.items.map(x=>x.memory.id),otherBlockContent:other.blocks.map(x=>x.content)});store.close?.();
  }
  {
    const store=await storeOf(kind,'chinese');await store.write({...base,content:'调试端口配置时先检查环境变量。'});
    const hits=await store.search('端口配置');
    report.cases.push({case:'chinese-substring-search',backend:kind,query:'端口配置',expectedContains:base.id,actualIds:hits.map(x=>x.id)});store.close?.();
  }
  {
    const store=await storeOf(kind,'feedback');await store.write(base);
    const bridge=new MemoryRuntimeBridge({store,scope:'workspace',now:()=>now});
    await Promise.all(Array.from({length:20},()=>bridge.recordInjected([base.id])));
    const entry=await store.get(base.id);
    report.cases.push({case:'concurrent-feedback',backend:kind,operations:20,expectedInjectedCount:20,actualUsefulness:entry.usefulness});store.close?.();
  }
  {
    const store=await storeOf(kind,'roundtrip');
    const rich={...base,sourceTurn:'turn-A',structured:{when:'retry guidance',do:'inspect error first',avoid:'blind retries',rootCause:'tool',outcome:'failure',evidenceRefs:['ev-1']},derivability:{verdict:'non-derivable',reason:'observed environment'},promotionState:'quarantined',securityScan:{checked:true,passed:true,at:now},pollutionSources:['tool:read_file#fixture']};
    await store.write(rich);const got=await store.get(base.id);
    const optionalFields=['sourceTurn','structured','derivability','promotionState','securityScan','pollutionSources'];
    const lost=optionalFields.filter(k=>JSON.stringify(got[k])!==JSON.stringify(rich[k]));
    report.cases.push({case:'entry-roundtrip',backend:kind,expectedKeys:optionalFields,lostKeys:lost,returned:got});store.close?.();
  }
}
{
 const store=await storeOf('sqlite','migration');
 const entry={...base,state:{kind:'deprecated',at:now,reason:'reviewed'},evidence:{sourceSessions:['session-A'],sourceEvents:['ev-1'],successCount:4,failureCount:2,lastValidated:now},usefulness:{retrievedCount:9,injectedCount:8,usedCount:7,taskSuccessCount:6,verificationPassedCount:5,score:.7}};
 const result=await migrateJsonlToSqlite(store,[entry]);const got=await store.get(entry.id);
 report.cases.push({case:'migration-preserves-metadata',result,lostKeys:['state','evidence','usefulness'].filter(k=>JSON.stringify(got[k])!==JSON.stringify(entry[k])),returned:got});store.close();
}
{
 const store=await storeOf('sqlite','bridge-close');const bridge=new MemoryRuntimeBridge({store,scope:'workspace'});
 let error=null;try{await bridge.close();}catch(e){error={name:e.name,message:e.message};}
 report.cases.push({case:'bridge-close-sqlite',expectedError:null,actualError:error});store.close();
}
await writeFile(join(out,'baseline.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({head:report.head,cases:report.cases.map(({returned,...rest})=>rest)},null,2));
