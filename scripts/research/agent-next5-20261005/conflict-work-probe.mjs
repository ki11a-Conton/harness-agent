import fs from 'node:fs/promises';
import { readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const repo=resolve(process.argv[2]),out=resolve(process.argv[3]);mkdirSync(dirname(out),{recursive:true});mkdirSync(out);
const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();
const paths=['packages/memory/src/retrieval.ts','packages/memory/dist/retrieval.js','scripts/research/agent-next5-20261005/conflict-work-probe.mjs'];
const fingerprints=()=>Object.fromEntries(paths.map(p=>[p,createHash('sha256').update(readFileSync(join(repo,p))).digest('hex')]));
const report={schemaVersion:'memory-conflict-work-v1',sourceSha:git('rev-parse','HEAD'),sourceTrackedDirtyAtStart:!!git('status','--porcelain','--untracked-files=no'),sourceFingerprintsBefore:fingerprints(),paidProviderCalls:0,realModelQuality:'NOT_RUN',windows:'NOT_RUN',cases:[]};
const root=await fs.mkdtemp(join(tmpdir(),'memory-conflict-native-'));
const {JsonlMemoryStore}=await import(repo+'/packages/memory/dist/memory-store.js');
const {SqliteMemoryStore}=await import(repo+'/packages/memory/dist/sqlite-memory-store.js');
const {retrieveMemories,contentTokens,tokenSimilarity,computeMemoryScore,scopeDepth,scopeVisibleForQuery,CONFLICT_SIMILARITY_THRESHOLD}=await import(repo+'/packages/memory/dist/retrieval.js');
const {checkUnsafeMemoryEntry}=await import(repo+'/packages/memory/dist/security-gate.js');
const {isRetrievable}=await import(repo+'/packages/memory/dist/lifecycle.js');
const NOW=1791200000000,OWNER='conflict-owner';
const entry=(i,content,patch={})=>({id:'conflict-'+i,content:'主题 '+content,type:'procedural',scope:'workspace',sourceSession:OWNER,importance:.8,confidence:.8,novelty:.8,stability:.8,createdAt:NOW,updatedAt:NOW,deleted:false,...patch});
// Frozen pre-index full scan: keep the same search ranking, gates, scores,
// token sets and survivor order, but deliberately inspect every prior survivor.
async function oldRetrieve(store,scope,opts){
 const hits=await store.search('主题',{type:opts.type}),scored=[],suppressed=[];
 for(let i=0;i<hits.length;i++){
  const memory=hits[i];
  if(memory.deleted){suppressed.push({memory,reason:'duplicate'});continue;}
  if(!scopeVisibleForQuery(memory.scope,scope))continue;
  if(memory.scope==='session'&&(typeof opts.sessionId!=='string'||!opts.sessionId.length||typeof memory.sourceSession!=='string'||!memory.sourceSession.length||memory.sourceSession!==opts.sessionId)){suppressed.push({memory,reason:'session-mismatch'});continue;}
  if(!isRetrievable(memory)){suppressed.push({memory,reason:'inactive'});continue;}
  if(checkUnsafeMemoryEntry(memory,'retrieval')!==null){suppressed.push({memory,reason:'unsafe'});continue;}
  const score=computeMemoryScore(memory,{index:i,total:hits.length},scopeDepth(scope),opts.now);
  if(score.total<(opts.minScore??0))continue;scored.push({memory,score});
 }
 scored.sort((a,b)=>b.score.total-a.score.total);
 const kept=[];
 for(const item of scored){const tokens=contentTokens(item.memory.content);if(kept.find(other=>tokenSimilarity(tokens,other.tokens)>=CONFLICT_SIMILARITY_THRESHOLD)!==undefined)suppressed.push({memory:item.memory,reason:'conflict'});else kept.push({item,tokens});}
 return{items:kept.slice(0,opts.k??5).map(k=>k.item),suppressed};
}
async function observe(fn){const has=Set.prototype.has;let checks=0;Set.prototype.has=function(value){if(typeof value==='string'&&value.startsWith('benchmarktoken'))checks++;return has.call(this,value);};try{const start=performance.now(),result=await fn();return{result,tokenMembershipChecks:checks,elapsedMs:performance.now()-start};}finally{Set.prototype.has=has;}}
const scenarios=[
 {name:'256-disjoint-work',rows:Array.from({length:256},(_,i)=>entry(i,'benchmarktoken'+i)),expected:0,oldExpected:32640},
 {name:'256-sparse-cluster-work',rows:Array.from({length:256},(_,i)=>entry(i,`benchmarktoken${i} cluster${Math.floor(i/4)}`)),expected:384,oldExpected:32640},
 {name:'dense-shared-control',rows:Array.from({length:32},(_,i)=>entry(i,`benchmarktokencommon benchmarktoken${i}`)),expected:992,oldExpected:992},
 {name:'unicode-empty-tokens',rows:[entry(0,'中文'),entry(1,'中文'),entry(2,'日文')],opts:{k:10}},
 {name:'nontransitive-chain',rows:[entry(0,'a b c'),entry(1,'a b c d e'),entry(2,'c d e')],opts:{k:10}},
 {name:'topk-outside-conflict',rows:[entry(0,'red oak maple'),entry(1,'blue birch cedar'),entry(2,'blue birch cedar pine')],opts:{k:1}},
 {name:'type-score-scope',rows:[entry(0,'unique zero',{scope:'global'}),entry(1,'unique one',{scope:'session'}),entry(2,'unique two',{type:'explicit'}),entry(3,'unique three',{confidence:0,importance:0,stability:0})],opts:{type:'procedural',minScore:.5,k:10}},
 {name:'session-identity',scope:'session',rows:[entry(0,'safe workspace'),entry(1,'private owner',{scope:'session'}),entry(2,'private foreign',{scope:'session',sourceSession:'foreign-owner'}),entry(3,'inactive memory',{state:{kind:'stale',at:NOW}})],opts:{sessionId:OWNER,k:10}},
 {name:'fresh-call-after-update',rows:[entry(0,'oak maple birch'),entry(1,'pine cedar spruce')],opts:{k:10},update:true},
];
try{
 for(const backend of ['jsonl','sqlite'])for(const scenario of scenarios){
  const name=backend+'-'+scenario.name,dir=join(root,name);await fs.mkdir(dir);
  const store=backend==='jsonl'?new JsonlMemoryStore({dataDir:dir}):new SqliteMemoryStore({dataDir:dir});
  try{
   if(backend==='jsonl')await fs.writeFile(join(dir,'memories.jsonl'),scenario.rows.map(e=>JSON.stringify(e)).join('\n')+'\n');else for(const e of scenario.rows)await store.write(e);
   const opts={now:NOW,k:5,...scenario.opts},scope=scenario.scope??'workspace';
   const old=await observe(()=>oldRetrieve(store,scope,opts)),actual=await observe(()=>retrieveMemories(store,'主题',scope,opts));
   assert.deepEqual(actual.result,old.result);
   if(scenario.expected!==undefined){assert.equal(actual.tokenMembershipChecks,scenario.expected);assert.equal(old.tokenMembershipChecks,scenario.oldExpected);}
   if(scenario.update){await store.update({...scenario.rows[0],content:scenario.rows[1].content});assert.deepEqual(await retrieveMemories(store,'主题',scope,opts),await oldRetrieve(store,scope,opts));await store.remove(scenario.rows[1].id);assert.deepEqual(await retrieveMemories(store,'主题',scope,opts),await oldRetrieve(store,scope,opts));}
   report.cases.push({name,status:'PASS',observed:{rows:scenario.rows.length,oldTokenMembershipChecks:old.tokenMembershipChecks,tokenMembershipChecks:actual.tokenMembershipChecks,oldElapsedMs:old.elapsedMs,elapsedMs:actual.elapsedMs,completeObjectsScoresOrderEqual:true,items:actual.result.items.map(i=>i.memory.id),suppressed:actual.result.suppressed.map(i=>({id:i.memory.id,reason:i.reason})),freshUpdateDelete:!!scenario.update}});
  }catch(error){report.cases.push({name,status:'FAIL',error:error.stack});}finally{store.close?.();}
 }
}finally{
 await fs.rm(root,{recursive:true,force:true});report.sourceShaAtEnd=git('rev-parse','HEAD');report.sourceTrackedDirtyAtEnd=!!git('status','--porcelain','--untracked-files=no');report.sourceFingerprintsAfter=fingerprints();report.status=report.cases.length===18&&report.cases.every(c=>c.status==='PASS')?'PASS':'FAIL';await fs.writeFile(join(out,'result.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:report.status,cases:report.cases.length,failures:report.cases.filter(c=>c.status==='FAIL')}));
}
if(report.status!=='PASS')process.exitCode=1;
