import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rename,mkdir,rmdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const root=process.argv[2],out=process.argv[3];
const {JSONLInboxStore}=await import('file://'+root+'/packages/session/dist/inbox.js');
const {InboxSessionInputQueue}=await import('file://'+root+'/packages/core/dist/runtime/session-actor.js');
const {newSessionId,newPromptId,newTurnId}=await import('file://'+root+'/packages/contracts/dist/index.js');
const dir=await mkdtemp('/dev/shm/harness-next-comprehensive-audit-20261106/tmp/inbox-');const cases=[];
const prompt=(sessionId,text)=>({id:newPromptId(),sessionId,text,kind:'followup',status:'pending',admittedAt:Date.now()});
async function fixture(name){const path=join(dir,name);await mkdir(path);const sid=newSessionId(),store=new JSONLInboxStore({dataDir:path});const original=prompt(sid,'original pending task');await store.admit(original);return{path,sid,original,file:join(path,'inbox.jsonl')}}
async function block(file){await rename(file,file+'.kept');await mkdir(file)}
async function unblock(file){await rmdir(file);await rename(file+'.kept',file)}
try{
 {
  const f=await fixture('concurrent-load'),store=new JSONLInboxStore({dataDir:f.path}),next=prompt(f.sid,'newly admitted task');
  await Promise.all([store.listPending(f.sid),store.admit(next)]);
  const durable=await new JSONLInboxStore({dataDir:f.path}).listPending(f.sid);
  cases.push({name:'initial read cannot race a writer into overwriting existing tasks',durable,pass:durable.length===2&&durable.some(p=>p.id===f.original.id)&&durable.some(p=>p.id===next.id)});
 }
 {
  const f=await fixture('load-retry'),store=new JSONLInboxStore({dataDir:f.path});await block(f.file);let error;try{await store.listPending(f.sid)}catch(e){error={name:e.name,code:e.code}}finally{await unblock(f.file)}
  assert(error,'controlled physical read must fail');const next=prompt(f.sid,'task after read recovered');await store.admit(next);const durable=await new JSONLInboxStore({dataDir:f.path}).listPending(f.sid);
  cases.push({name:'read failure cannot permanently latch an empty cache',error,durable,pass:durable.length===2&&durable.some(p=>p.id===f.original.id)});
 }
 {
  const f=await fixture('failed-admission'),store=new JSONLInboxStore({dataDir:f.path});await store.listPending(f.sid);await block(f.file);const refused=prompt(f.sid,'MUST_NOT_APPEAR_AFTER_FAILED_ADMISSION');let error;
  try{await store.admit(refused)}catch(e){error={name:e.name,code:e.code}}finally{await unblock(f.file)}assert(error,'controlled physical write must fail');const next=prompt(f.sid,'successful later task');await store.admit(next);const durable=await new JSONLInboxStore({dataDir:f.path}).listPending(f.sid);
  cases.push({name:'failed write cannot publish an uncommitted task through a later successful write',error,durable,pass:durable.length===2&&!durable.some(p=>p.id===refused.id)&&durable.some(p=>p.id===f.original.id)});
 }
 {
  const f=await fixture('failed-promotion'),store=new JSONLInboxStore({dataDir:f.path});await store.listPending(f.sid);await block(f.file);let error;try{await store.bindPromotion(f.original.id,newTurnId())}catch(e){error={name:e.name,code:e.code}}finally{await unblock(f.file)}assert(error,'controlled physical promotion must fail');let consumeError;try{await store.markConsumed(f.original.id)}catch(e){consumeError={name:e.name,code:e.code}}
  const durable=await new JSONLInboxStore({dataDir:f.path}).listAll(f.sid);cases.push({name:'failed durable bind cannot authorize consuming an unpromoted prompt',error,consumeError,durable,pass:consumeError?.code==='CONSUME_NOT_PROMOTED'&&durable[0]?.status==='pending'});
 }
 for(const warm of [false,true]){
  const path=join(dir,'reservation-'+warm);await mkdir(path);const sid=newSessionId(),inbox=new JSONLInboxStore({dataDir:path}),queue=new InboxSessionInputQueue({sessionId:sid,inbox});const a=await queue.enqueueFollowup({sessionId:sid,text:'first'}),b=await queue.enqueueFollowup({sessionId:sid,text:'second'});if(warm)await queue.hydratePendingFollowups();
  const reservations=await Promise.all([queue.reservePendingFollowup(),queue.reservePendingFollowup()]);const tid=newTurnId();await queue.bindReservedFollowup(a,tid);const durable=await new JSONLInboxStore({dataDir:path}).listAll(sid);
  cases.push({name:'concurrent reservations are single flight (warm='+warm+')',reservations,pending:queue.pendingCount,durable,pass:reservations.filter(Boolean).length===1&&reservations[0]?.id===a&&queue.pendingCount===1&&durable.find(p=>p.text==='first')?.promotedTurnId===tid});
 }
 const report={sourceSha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceStatus:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}),cases,passed:cases.filter(c=>c.pass).length,failed:cases.filter(c=>!c.pass).length,actualFilesystem:true,paidModelCalls:0};await writeFile(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report));assert.equal(report.failed,0,'Inbox atomicity/reservation regressions remain');
}finally{await rm(dir,{recursive:true,force:true})}
