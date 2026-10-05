#!/usr/bin/env node
// Production retry-wait acceptance: native loopback fetch/signals/timers only.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once, getEventListeners } from 'node:events';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const [repoArgument, outputArgument] = process.argv.slice(2);
assert.ok(repoArgument && outputArgument && process.argv.length === 4, 'usage: provider-retry-probe.mjs <repo> <fresh-output-directory>');
const repo=path.resolve(repoArgument), output=path.resolve(outputArgument);
await mkdir(path.dirname(output), {recursive:true});await mkdir(output);
const git=(...a)=>execFileSync('git',a,{cwd:repo,encoding:'utf8'}).trim();
const sha=b=>createHash('sha256').update(b).digest('hex');
const paths=['packages/model/src/openai.ts','packages/model/dist/openai.js','packages/model/src/openai-retry-wait.regressions.test.ts','scripts/research/agent-next2-20261005/provider-retry-probe.mjs'];
const fingerprints=async()=>Object.fromEntries(await Promise.all(paths.map(async p=>[p,sha(await readFile(path.join(repo,p)))])));
const receipt={schemaVersion:'agent-next2-provider-retry-v1',status:'RUNNING',sourceSha:git('rev-parse','HEAD'),sourceTrackedDirtyAtStart:git('status','--porcelain','--untracked-files=no')!=='',sourceStatusAtStart:git('status','--porcelain'),sourceFingerprintsBefore:await fingerprints(),probeSha256:sha(await readFile(fileURLToPath(import.meta.url))),node:process.version,startedAt:new Date().toISOString(),paidProviderCalls:0,realModelQuality:'NOT_RUN',cases:[],requests:[]};
const save=()=>writeFile(path.join(output,'result.json'),JSON.stringify(receipt,null,2)+'\n');await save();
const {OpenAICompatibleProvider}=await import(pathToFileURL(path.join(repo,'packages/model/dist/openai.js')));
const nativeFetch=globalThis.fetch, nativeSetTimeout=globalThis.setTimeout, nativeClearTimeout=globalThis.clearTimeout;
const nativeAdd=AbortSignal.prototype.addEventListener, nativeRemove=AbortSignal.prototype.removeEventListener;
const sleep=ms=>new Promise(resolve=>nativeSetTimeout(resolve,ms));
const routes=new Map(), counts=new Map(), responses=new Set();
const frame='data: '+JSON.stringify({choices:[{delta:{content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:2}})+'\n\ndata: [DONE]\n\n';
const server=http.createServer(async(req,res)=>{
 try{
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw),name=body.messages.at(-1).content;
  const route=routes.get(name);assert.ok(route,'unknown fixture');const n=(counts.get(name)??0)+1;counts.set(name,n);
  const entry={name,n,path:req.url,body,closed:false,at:new Date().toISOString()};receipt.requests.push(entry);
  responses.add(res);res.once('close',()=>{responses.delete(res);entry.closed=true});
  if(route.kind==='network'&&n===1){res.destroy();return;}
  if(route.kind==='stream-failure'){
   res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'partial'},finish_reason:null}]})+'\n\n');
   nativeSetTimeout(()=>res.destroy(),10);return;
  }
  if(route.kind==='401'||route.kind==='503'||(route.kind==='429'&&n===1)){
   const status=Number(route.kind);res.writeHead(status,{'content-type':'text/plain',...(route.retryAfter?{'retry-after':route.retryAfter}:{})});res.end('offline fixture');return;
  }
  res.writeHead(200,{'content-type':'text/event-stream'});res.end(frame);
 }catch(error){receipt.serverError={name:error.name,message:error.message};res.destroy(error)}
});
server.listen(0,'127.0.0.1');await once(server,'listening');const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
const completion=events=>{
 const matched=events.filter(e=>e.event.type==='completed');assert.equal(matched.length,1,'one completed');assert.equal(events.filter(e=>e.event.type==='error').length,0,'no error alongside completion');return matched[0].event.result;
};
const failure=(events,kind)=>{
 assert.equal(events.filter(e=>e.event.type==='completed'||e.event.type==='tool_call_delta').length,0,'failure cannot authorize success/tools');
 const errors=events.filter(e=>e.event.type==='error');assert.equal(errors.length,1,'one error');assert.equal(errors[0].event.error.provider.kind,kind);return errors[0].event.error;
};
async function sample(name,{kind='429',retryAfter,timeout=0,delay=0,retries=1,abortAtRetry=false,abortAfterRetryMs,delayResumeMs=0,abortBeforeResume=false,preAborted=false,controller=new AbortController()}={}){
 routes.set(name,{kind,retryAfter});const beforeRequests=receipt.requests.length;const registrations=[],removals=[],timers=[];let attempts=0,abortTimer;
 globalThis.fetch=(...args)=>{attempts+=1;return nativeFetch(...args)};
 AbortSignal.prototype.addEventListener=function(type,listener,opts){
  const stack=new Error().stack;if(type==='abort'&&stack.includes('backoff'))registrations.push({signal:this,listener,stack,once:opts?.once===true});return nativeAdd.call(this,type,listener,opts);
 };
 AbortSignal.prototype.removeEventListener=function(type,listener,opts){if(type==='abort')removals.push({signal:this,listener});return nativeRemove.call(this,type,listener,opts)};
 globalThis.setTimeout=function(callback,ms,...args){
  const stack=new Error().stack;if(!stack.includes('backoff'))return nativeSetTimeout(callback,ms,...args);
  const entry={delay:ms,stack,fired:false,cleared:false};
  entry.handle=nativeSetTimeout((...callbackArgs)=>{entry.fired=true;callback(...callbackArgs)},ms,...args);timers.push(entry);return entry.handle;
 };
 globalThis.clearTimeout=function(handle){const timer=timers.find(t=>t.handle===handle);if(timer)timer.cleared=true;return nativeClearTimeout(handle)};
 const start=performance.now(),events=[];
 try{
  if(preAborted)controller.abort();
  const c=new OpenAICompatibleProvider().createClient({providerId:'openai',modelId:'offline-retry-probe'},{apiKey:'offline-fixture-only',baseUrl,requestTimeoutMs:timeout,retryDelayMs:delay,maxProviderRetries:retries});
  for await(const event of c.generate({messages:[{role:'user',content:name}]},controller.signal)){
   events.push({elapsedMs:performance.now()-start,event});
   if(event.type==='retry'){
    if(abortAtRetry)controller.abort();
    if(abortAfterRetryMs!==undefined)abortTimer=nativeSetTimeout(()=>controller.abort(),abortAfterRetryMs);
    if(delayResumeMs>0)await sleep(delayResumeMs);
    if(abortBeforeResume)controller.abort();
   }
  }
  const elapsedMs=performance.now()-start;
  const ownership={waitListenersRegistered:registrations.length,waitListenersExplicitlyRemoved:registrations.filter(r=>removals.some(x=>x.signal===r.signal&&x.listener===r.listener)).length,waitListenersRetained:registrations.filter(r=>getEventListeners(r.signal,'abort').includes(r.listener)).length,waitTimersAllocated:timers.length,waitTimersPending:timers.filter(t=>!t.fired&&!t.cleared).length,waitTimersFired:timers.filter(t=>t.fired).length,waitTimersCleared:timers.filter(t=>t.cleared).length,registrations:registrations.map(r=>({stack:r.stack,once:r.once,source:String(r.listener),effectiveSignalIsCaller:r.signal===controller.signal})),timers:timers.map(({handle,...rest})=>rest)};
  const result={name,config:{kind,retryAfter,timeout,delay,retries,abortAtRetry,abortAfterRetryMs,delayResumeMs,abortBeforeResume,preAborted},elapsedMs,fetchAttempts:attempts,httpRequests:receipt.requests.length-beforeRequests,callerAborted:controller.signal.aborted,events,ownership};
  return result;
 }finally{
  if(abortTimer)nativeClearTimeout(abortTimer);
  globalThis.fetch=nativeFetch;globalThis.setTimeout=nativeSetTimeout;globalThis.clearTimeout=nativeClearTimeout;
  AbortSignal.prototype.addEventListener=nativeAdd;AbortSignal.prototype.removeEventListener=nativeRemove;
 }
}
async function test(name,opts,check){
 const entry={name,status:'RUNNING'};receipt.cases.push(entry);await save();
 try{entry.result=await sample(name,opts);assert.equal(entry.result.ownership.waitListenersRetained,0,'no retained wait listener');assert.equal(entry.result.ownership.waitTimersPending,0,'no pending wait timer');await check(entry.result);entry.status='PASS'}catch(error){entry.status='FAIL';entry.failure={name:error.name,message:error.message,stack:error.stack}}
 await save();console.log(JSON.stringify({name,status:entry.status,elapsedMs:entry.result?.elapsedMs,httpRequests:entry.result?.httpRequests,fetchAttempts:entry.result?.fetchAttempts,failure:entry.failure?.message}));
}
const successful=r=>{assert.equal(completion(r.events).finishReason,'stop');assert.deepEqual(completion(r.events).usage,{inputTokens:7,outputTokens:2});assert.equal(r.httpRequests,2);assert.equal(r.fetchAttempts,2);assert.equal(r.events.filter(e=>e.event.type==='retry').length,1)};
const timedout=r=>{assert.ok(r.elapsedMs<250,`deadline completion ${r.elapsedMs}ms exceeds 250ms`);failure(r.events,'timeout');assert.equal(r.httpRequests,1);assert.equal(r.fetchAttempts,2);assert.equal(r.callerAborted,false)};
const cancelled=r=>{assert.ok(r.elapsedMs<250,`cancel completion ${r.elapsedMs}ms exceeds 250ms`);assert.equal(completion(r.events).finishReason,'cancelled');assert.equal(r.httpRequests,1);assert.equal(r.fetchAttempts,2)};
try{
 await test('direct-success',{kind:'direct'},r=>{assert.equal(completion(r.events).finishReason,'stop');assert.deepEqual(completion(r.events).usage,{inputTokens:7,outputTokens:2});assert.equal(r.httpRequests,1);assert.equal(r.fetchAttempts,1);assert.equal(r.ownership.waitTimersAllocated,0)});
 await test('normal-429-recovery',{delay:10},successful);
 await test('normal-network-recovery',{kind:'network',delay:10},successful);
 await test('non-transient-401',{kind:'401'},r=>{failure(r.events,'http');assert.equal(r.httpRequests,1);assert.equal(r.fetchAttempts,1);assert.equal(r.events.filter(e=>e.event.type==='retry').length,0);assert.equal(r.ownership.waitTimersAllocated,0)});
 await test('retry-after-deadline',{retryAfter:'1',timeout:50},timedout);
 await test('network-backoff-deadline',{kind:'network',timeout:50,delay:1000},timedout);
 await test('caller-abort-at-retry',{retryAfter:'1',abortAtRetry:true},cancelled);
 await test('caller-abort-at-network-retry',{kind:'network',delay:1000,abortAtRetry:true},cancelled);
 await test('caller-abort-during-wait',{retryAfter:'1',abortAfterRetryMs:40},r=>{cancelled(r);assert.equal(r.ownership.waitTimersCleared,1)});
 await test('deadline-expired-before-wait',{retryAfter:'1',timeout:50,delayResumeMs:70},r=>{timedout(r);assert.equal(r.ownership.waitTimersAllocated,0);assert.equal(r.ownership.waitListenersRegistered,0)});
 await test('caller-wins-expired-deadline',{retryAfter:'1',timeout:50,delayResumeMs:70,abortBeforeResume:true},r=>{cancelled(r);assert.equal(r.ownership.waitTimersAllocated,0);assert.equal(r.ownership.waitListenersRegistered,0)});
 await test('deadline-budget-preserved',{retryAfter:'1',timeout:50,retries:3},r=>{assert.ok(r.elapsedMs<250);failure(r.events,'timeout');assert.equal(r.fetchAttempts,4);assert.equal(r.httpRequests,1);assert.equal(r.events.filter(e=>e.event.type==='retry').length,3)});
 await test('retry-after-preserved',{retryAfter:'1'},r=>{successful(r);assert.ok(r.elapsedMs>=900,`Retry-After violated at ${r.elapsedMs}ms`);assert.ok(r.elapsedMs<2000)});
 await test('retry-budget-zero',{retryAfter:'1',retries:0},r=>{failure(r.events,'rate_limit');assert.equal(r.httpRequests,1);assert.equal(r.fetchAttempts,1);assert.equal(r.ownership.waitTimersAllocated,0)});
 await test('caller-preaborted',{kind:'direct',preAborted:true},r=>{assert.equal(completion(r.events).finishReason,'cancelled');assert.equal(r.httpRequests,0);assert.equal(r.fetchAttempts,0);assert.equal(r.ownership.waitTimersAllocated,0)});
 await test('exhausted-server-budget',{kind:'503',retries:2},r=>{failure(r.events,'server_error');assert.equal(r.httpRequests,3);assert.equal(r.fetchAttempts,3);assert.equal(r.events.filter(e=>e.event.type==='retry').length,2)});
 await test('streaming-failure-never-retried',{kind:'stream-failure',retries:2},r=>{const e=failure(r.events,'network');assert.equal(e.retryable,false);assert.equal(e.safeToRetry,false);assert.equal(r.httpRequests,1);assert.equal(r.fetchAttempts,1);assert.equal(r.events.filter(e=>e.event.type==='retry').length,0);assert.equal(r.ownership.waitTimersAllocated,0)});
 await test('zero-delay-retry',{},successful);
 const repeated={name:'reuse-caller-12-calls',status:'RUNNING',results:[]};receipt.cases.push(repeated);await save();
 try{const controller=new AbortController();for(let i=0;i<12;i+=1){const r=await sample(`reuse-caller-${i}`,{controller});repeated.results.push(r);assert.equal(r.ownership.waitListenersRetained,0);assert.equal(r.ownership.waitTimersPending,0);successful(r)}repeated.status='PASS'}catch(error){repeated.status='FAIL';repeated.failure={name:error.name,message:error.message,stack:error.stack}}await save();
 assert.equal(receipt.cases.length,19);receipt.status=receipt.cases.every(c=>c.status==='PASS')?'PASS':'FAIL';if(receipt.status!=='PASS')process.exitCode=1;
}catch(error){receipt.status='FAIL';receipt.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1}
finally{
 for(const res of responses)res.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 receipt.sourceShaAtEnd=git('rev-parse','HEAD');receipt.sourceStatusAtEnd=git('status','--porcelain');receipt.sourceTrackedDirtyAtEnd=git('status','--porcelain','--untracked-files=no')!=='';receipt.sourceFingerprintsAfter=await fingerprints();
 receipt.endedAt=new Date().toISOString();await save();
}
