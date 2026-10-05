import fs from 'node:fs/promises';
import { readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve,dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const repo=resolve(process.argv[2]),out=resolve(process.argv[3]);mkdirSync(dirname(out),{recursive:true});mkdirSync(out);
const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim(), hash=data=>createHash('sha256').update(data).digest('hex');
const paths=['packages/memory/src/search-text.ts','packages/memory/src/memory-store.ts','packages/memory/src/sqlite-memory-store.ts','packages/memory/dist/search-text.js','packages/memory/dist/memory-store.js','packages/memory/dist/sqlite-memory-store.js','scripts/research/agent-next4-20261005/query-work-probe.mjs'];
const fingerprints=()=>Object.fromEntries(paths.map(p=>[p,hash(readFileSync(join(repo,p)))]));
const report={schemaVersion:'memory-query-work-v1',sourceSha:git('rev-parse','HEAD'),sourceTrackedDirtyAtStart:!!git('status','--porcelain','--untracked-files=no'),sourceFingerprintsBefore:fingerprints(),paidProviderCalls:0,realModelQuality:'NOT_RUN',windows:'NOT_RUN',cases:[]};
const root=await fs.mkdtemp(join(tmpdir(),'memory-prepared-native-'));
const {JsonlMemoryStore}=await import(repo+'/packages/memory/dist/memory-store.js');const {SqliteMemoryStore}=await import(repo+'/packages/memory/dist/sqlite-memory-store.js');
const query=Array.from({length:128},(_,i)=>'AbsentQueryMarker'+i).join(' '), normalized=query.toLowerCase();
const items=Array.from({length:1500},(_,i)=>({id:'query-'+i,content:'safe unrelated guidance '+i,type:'procedural',scope:'workspace',sourceSession:'query-owner',importance:.8,confidence:.8,novelty:.8,stability:.8,createdAt:1,updatedAt:1,deleted:false}));
function match(q,body){q=q.toLowerCase();if(!q.trim())return false;body=body.toLowerCase();if(body.includes(q))return true;const words=new Set(body.split(/[^a-z0-9]+/).filter(Boolean));return q.split(/\s+/).filter(Boolean).every(t=>words.has(t));}
function text(e){const parts=[e.content];if(e.structured&&typeof e.structured==='object')for(const k of ['when','do','avoid'])if(typeof e.structured[k]==='string')parts.push(e.structured[k]);return parts.join('\n');}
async function oldSearch(store,q){if(!q.trim())return[];if(store instanceof JsonlMemoryStore)return(await store.list()).filter(e=>match(q,text(e)));q=q.trim();const ids=[];try{const fts=q.split(/\s+/).filter(Boolean).map(t=>'"'+t.replace(/"/g,'')+'"').join(' OR ');if(!fts)throw Error();for(const r of store.database.prepare('SELECT m.id,bm25(memories_fts) AS score FROM memories_fts f JOIN memories m ON m.id=f.id WHERE memories_fts MATCH ? AND m.deleted=0 ORDER BY score').all(fts))if(!ids.includes(r.id))ids.push(r.id);}catch{}for(const r of store.database.prepare('SELECT id FROM memories WHERE deleted=0 ORDER BY rowid').all()){const e=await store.get(r.id);if(!ids.includes(r.id)&&match(q,text(e)))ids.push(r.id);}return Promise.all(ids.map(id=>store.get(id)));}
async function check(name,fn){try{report.cases.push({name,status:'PASS',observed:await fn()});}catch(error){report.cases.push({name,status:'FAIL',error:error.stack});}}
try{
 for(const backend of ['jsonl','sqlite']){
 const dir=join(root,backend);await fs.mkdir(dir);const store=backend==='jsonl'?new JsonlMemoryStore({dataDir:dir}):new SqliteMemoryStore({dataDir:dir});
 try{
 if(backend==='jsonl')await fs.writeFile(join(dir,'memories.jsonl'),items.map(e=>JSON.stringify(e)).join('\n')+'\n');else for(const e of items)await store.write(e);
 await check(backend+'-1500-row-query-work',async()=>{const lower=String.prototype.toLowerCase,split=String.prototype.split;let lowered=0,lexical=0,fts=0;String.prototype.toLowerCase=function(){if(String(this)===query)lowered++;return lower.call(this)};String.prototype.split=function(...args){if(String(this)===normalized)lexical++;if(String(this)===query)fts++;return split.apply(this,args)};let hits,elapsedMs;try{const start=performance.now();hits=await store.search(query);elapsedMs=performance.now()-start;}finally{String.prototype.toLowerCase=lower;String.prototype.split=split;}assert.deepEqual(hits,[]);assert(lowered<=1);assert(lexical<=1);assert.equal(fts,backend==='sqlite'?1:0);return{rows:1500,queryCharacters:query.length,hits:0,queryLowerCalls:lowered,lexicalTokenizationCalls:lexical,ftsTokenizationCalls:fts,elapsedMs};});
 const samples=[{...items[0],id:backend+'-sample-a',content:'ALPHA beta beta 中文端口'},{...items[0],id:backend+'-sample-b',content:'beta then alpha'},{...items[0],id:backend+'-sample-c',content:'unrelated distinct',structured:{when:'端口配置',do:'check portlint',avoid:'blind retry',rootCause:'metadata-only',outcome:'failure',evidenceRefs:[]}}];for(const e of samples)await store.write(e);
 for(const [label,q] of [['multiword','beta alpha'],['unicode','端口'],['strategy','portlint'],['punctuation','%'],['outer-space','  ALPHA beta  '],['metadata','metadata-only']])await check(backend+'-'+label+'-full-old-result',async()=>{const actual=await store.search(q),expected=await oldSearch(store,q);assert.deepEqual(actual,expected);return{query:q,ids:actual.map(e=>e.id),completeObjectsAndOrderEqual:true};});
 await check(backend+'-fresh-call-after-update-delete',async()=>{const e=samples[0];await store.update({...e,content:'UPDATED_MARKER'});assert.deepEqual(await store.search('UPDATED_MARKER'),await oldSearch(store,'UPDATED_MARKER'));await store.remove(e.id);assert.deepEqual(await store.search('UPDATED_MARKER'),[]);return{updatedAndDeleted:true,noCrossCallCache:true};});
 if(backend==='sqlite'){store.database.exec('DROP TABLE memories_fts');await check('sqlite-fts-fallback-full-old-result',async()=>{const actual=await store.search('端口'),expected=await oldSearch(store,'端口');assert.deepEqual(actual,expected);return{ids:actual.map(e=>e.id),completeObjectsAndOrderEqual:true};});}
 }finally{store.close?.();}
 }
}finally{await fs.rm(root,{recursive:true,force:true});report.sourceShaAtEnd=git('rev-parse','HEAD');report.sourceTrackedDirtyAtEnd=!!git('status','--porcelain','--untracked-files=no');report.sourceFingerprintsAfter=fingerprints();report.status=report.cases.every(c=>c.status==='PASS')?'PASS':'FAIL';await fs.writeFile(join(out,'result.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:report.status,cases:report.cases.length,failures:report.cases.filter(c=>c.status==='FAIL')}));}
if(report.status!=='PASS')process.exitCode=1;
