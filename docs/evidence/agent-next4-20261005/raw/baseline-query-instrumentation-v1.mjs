import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const repo=process.cwd(), root=await fs.mkdtemp(join(tmpdir(),'memory-query-work-'));
const {JsonlMemoryStore}=await import(repo+'/packages/memory/dist/memory-store.js');
const {SqliteMemoryStore}=await import(repo+'/packages/memory/dist/sqlite-memory-store.js');
const query=Array.from({length:128},(_,i)=>'AbsentQueryMarker'+i).join(' ');
const items=Array.from({length:1500},(_,i)=>({id:'query-'+i,content:'safe unrelated guidance '+i,type:'procedural',scope:'workspace',sourceSession:'query-owner',importance:0.8,confidence:0.8,novelty:0.8,stability:0.8,createdAt:1,updatedAt:1,deleted:false}));
const report={sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),trackedDirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),queryCharacters:query.length,rows:items.length,cases:[]};
for(const backend of ['jsonl','sqlite']){
 const dir=join(root,backend);await fs.mkdir(dir);const store=backend==='jsonl'?new JsonlMemoryStore({dataDir:dir}):new SqliteMemoryStore({dataDir:dir});
 if(backend==='jsonl')await fs.writeFile(join(dir,'memories.jsonl'),items.map(x=>JSON.stringify(x)).join('\n')+'\n');else for(const e of items)await store.write(e);
 const lower=String.prototype.toLowerCase,split=String.prototype.split;let lowered=0,tokenized=0;String.prototype.toLowerCase=function(){if(String(this)===query)lowered++;return lower.call(this)};String.prototype.split=function(...args){if(String(this)===query.toLowerCase())tokenized++;return split.apply(this,args)};
 try{const start=performance.now();const hits=await store.search(query);report.cases.push({backend,hits:hits.length,elapsedMs:performance.now()-start,queryLowerCalls:lowered,queryTokenizationCalls:tokenized,status:lowered>1||tokenized>2?'REPRODUCED_REDUNDANT_QUERY_WORK':'CONTROL'});}finally{String.prototype.toLowerCase=lower;String.prototype.split=split;store.close?.();}
}
await fs.rm(root,{recursive:true,force:true});await fs.writeFile('.ci/agent-next4-20261005/baseline-result.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
