import assert from 'node:assert/strict';
import http from 'node:http';
import { once, getEventListeners } from 'node:events';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { OpenAICompatibleProvider } from '../../../packages/model/dist/openai.js';
const receipt={schemaVersion:'provider-retry-baseline-v1',status:'RUNNING',sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceTrackedStatusBefore:execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}),sourceHash:createHash('sha256').update(await readFile('packages/model/src/openai.ts')).digest('hex'),distHash:createHash('sha256').update(await readFile('packages/model/dist/openai.js')).digest('hex'),node:process.version,startedAt:new Date().toISOString(),paidProviderCalls:0,cases:[],requests:[]};
const folder='.ci/agent-next2-20261005/audit-provider';
const save=()=>writeFile(`${folder}/baseline.json`,JSON.stringify(receipt,null,2)+'\n');
await save();
const counts=new Map();
const active=new Set();
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const c of req)raw+=c;
 const body=JSON.parse(raw);const name=body.messages.at(-1).content;
 const n=(counts.get(name)??0)+1;counts.set(name,n);
 const request={name,n,path:req.url,body,at:new Date().toISOString(),closed:false};receipt.requests.push(request);
 active.add(res);res.once('close',()=>{active.delete(res);request.closed=true});
 if(name.includes('network')&&n===1){res.destroy();return;}
 if(name==='http-401-no-retry'){res.writeHead(401,{'content-type':'text/plain'});res.end('fixture unauthorized');return;}
 if(n===1&&(!name.includes('network')&&!name.includes('direct'))){res.writeHead(429,{'content-type':'text/plain','retry-after':name.includes('slow')?'1':'0'});res.end('fixture throttled');return;}
 res.writeHead(200,{'content-type':'text/event-stream'});
 res.end('data: '+JSON.stringify({choices:[{delta:{content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:2}})+'\n\ndata: [DONE]\n\n');
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
async function run(name,{timeout=0,delay=0,retries=2,abortAtRetry=false,abortWhileWaiting=false}={}){
 const c=new AbortController();const adds=[];const removals=[];
 const originalAdd=c.signal.addEventListener.bind(c.signal),originalRemove=c.signal.removeEventListener.bind(c.signal);
 c.signal.addEventListener=function(type,listener,options){if(type==='abort')adds.push({listener,stack:new Error().stack,options});return originalAdd(type,listener,options)};
 c.signal.removeEventListener=function(type,listener,options){if(type==='abort')removals.push(listener);return originalRemove(type,listener,options)};
 const client=new OpenAICompatibleProvider().createClient({providerId:'openai',modelId:'offline-retry-probe'},{apiKey:'offline-fixture-only',baseUrl,requestTimeoutMs:timeout,retryDelayMs:delay,maxProviderRetries:retries});
 const events=[];let timer;const start=performance.now();
 for await(const event of client.generate({messages:[{role:'user',content:name}]},c.signal)){
  events.push({elapsedMs:performance.now()-start,event});
  if(event.type==='retry'&&abortAtRetry)c.abort();
  if(event.type==='retry'&&abortWhileWaiting)timer=setTimeout(()=>c.abort(),40);
 }
 if(timer)clearTimeout(timer);
 const elapsedMs=performance.now()-start;
 const listeners=getEventListeners(c.signal,'abort');
 const backoffAdds=adds.filter(x=>x.stack.includes('backoff'));
 const retained=backoffAdds.filter(x=>listeners.includes(x.listener));
 const record={name,config:{timeout,delay,retries,abortAtRetry,abortWhileWaiting},elapsedMs,httpRequests:counts.get(name)??0,callerAborted:c.signal.aborted,events,ownership:{addedAbortListeners:adds.length,removedAbortListeners:removals.length,remainingAbortListeners:listeners.length,backoffAdded:backoffAdds.length,backoffExplicitlyRemoved:backoffAdds.filter(x=>removals.includes(x.listener)).length,backoffRetained:retained.length,backoffStacks:backoffAdds.map(x=>x.stack),retainedListenerBodies:retained.map(x=>String(x.listener))}};
 receipt.cases.push(record);await save();console.log(JSON.stringify({name,elapsedMs,httpRequests:record.httpRequests,eventTypes:events.map(x=>x.event.type),terminals:events.filter(x=>['error','completed'].includes(x.event.type)).map(x=>x.event),ownership:record.ownership}));
 return record;
}
try{
 await run('direct-success');
 await run('normal-429-recovery',{delay:5});
 await run('normal-network-recovery',{delay:5});
 await run('http-401-no-retry');
 await run('slow-429-deadline',{timeout:50,retries:1});
 await run('slow-caller-abort-at-retry',{timeout:0,retries:1,abortAtRetry:true});
 await run('slow-caller-abort-while-waiting',{timeout:0,retries:1,abortWhileWaiting:true});
 const normal=receipt.cases.find(x=>x.name==='normal-429-recovery');
 const deadline=receipt.cases.find(x=>x.name==='slow-429-deadline');
 const edge=receipt.cases.find(x=>x.name==='slow-caller-abort-at-retry');
 const later=receipt.cases.find(x=>x.name==='slow-caller-abort-while-waiting');
 assert.equal(normal.events.at(-1).event.result.finishReason,'stop');
 assert.equal(normal.httpRequests,2);
 assert.equal(normal.ownership.backoffRetained,1);
 assert.ok(deadline.elapsedMs>=900);
 assert.equal(deadline.events.at(-1).event.type,'error');
 assert.equal(deadline.events.at(-1).event.error.provider.kind,'timeout');
 assert.equal(deadline.httpRequests,1);
 assert.ok(edge.elapsedMs>=900);
 assert.equal(edge.events.at(-1).event.result.finishReason,'cancelled');
 assert.equal(edge.httpRequests,1);
 assert.equal(edge.ownership.backoffRetained,1);
 assert.ok(later.elapsedMs<500);
 assert.equal(later.events.at(-1).event.result.finishReason,'cancelled');
 assert.equal(later.ownership.backoffRetained,0);
 receipt.status='BASELINE_DEFECTS_REPRODUCED';
}catch(error){receipt.status='FAIL';receipt.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1}
finally{
 for(const r of active)r.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 receipt.sourceTrackedStatusAfter=execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'});receipt.endedAt=new Date().toISOString();await save();
}
