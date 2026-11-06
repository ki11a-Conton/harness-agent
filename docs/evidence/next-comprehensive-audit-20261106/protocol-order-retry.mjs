import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const root=process.argv[2],out=process.argv[3];
const {OpenAICompatibleProvider}=await import('file://'+root+'/packages/model/dist/index.js');
const {createHarness}=await import('file://'+root+'/packages/harness/dist/index.js');
const frame=v=>'data: '+JSON.stringify(v)+'\n\n';let codingRequests=0,retryRequests=0;const captured=[];
const server=createServer(async(req,res)=>{
 let data='';for await(const part of req)data+=part;
 if(req.url==='/retry/chat/completions'){retryRequests++;res.writeHead(429,{'retry-after':'2147484','content-type':'text/plain'});res.end('controlled rate limit');return;}
 codingRequests++;captured.push(JSON.parse(data));res.writeHead(200,{'content-type':'text/event-stream'});
 if(codingRequests===1){
  const calls=[{index:1,id:'call_edit',function:{name:'edit_file',arguments:JSON.stringify({path:'result.ts',oldText:'= 1',newText:'= 2'})}},{index:0,id:'call_write',function:{name:'write_file',arguments:JSON.stringify({path:'result.ts',content:'export const result = 1;\n'})}}];
  for(const call of calls)res.write(frame({choices:[{delta:{tool_calls:[call]},finish_reason:null}]}));
  res.end(frame({choices:[{delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:10}})+'data: [DONE]\n\n');
 }else res.end(frame({choices:[{delta:{content:'Both file changes completed.'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10}})+'data: [DONE]\n\n');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const ws=await mkdtemp('/dev/shm/harness-next-comprehensive-audit-20261106/tmp/order-');let harness;
try{
 const provider=new OpenAICompatibleProvider({apiKey:'local-fixture-only',baseUrl:origin+'/coding',modelId:'offline-order',maxProviderRetries:0,requestTimeoutMs:2000});
 harness=await createHarness({cwd:ws,profile:'test',modelProvider:provider,model:{providerId:'openai',modelId:'offline-order'},limits:{maxIterations:4,maxToolCalls:4,maxDurationMs:10000},task:{id:'ordered-edits',goal:'Create result.ts then change its value to 2',completionPolicy:{requiresVerification:true},verification:[{kind:'command',command:process.execPath,args:['-e',"require('node:assert/strict').match(require('node:fs').readFileSync('result.ts','utf8'),/= 2/)"]}]}});
 const session=await harness.runtime.createSession({agent:harness.agents[0],cwd:ws});const turn=await harness.runtime.startTurn(session.id,'Create result.ts with result=1, then edit it to result=2 and verify.');
 const outcome=await harness.runtime.runTurn(session.id,turn.id,new AbortController().signal);
 const actual=await readFile(join(ws,'result.ts'),'utf8');const events=await harness.events.list(session.id);
 const client=new OpenAICompatibleProvider().createClient({providerId:'openai',modelId:'retry-fixture'},{apiKey:'local-fixture-only',baseUrl:origin+'/retry',maxProviderRetries:1,retryDelayMs:0,requestTimeoutMs:100});const retries=[];const start=Date.now();
 for await(const event of client.generate({messages:[]},new AbortController().signal))retries.push(event);
 const terminal=retries.filter(e=>e.type==='error'||e.type==='completed');
 const report={sourceSha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceStatus:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}),wireArrivalIndexes:[1,0],toolOrder:events.filter(e=>e.type==='tool.requested').map(e=>e.payload.name),actualFile:actual,outcome:{status:outcome.status,error:outcome.error},verification:events.filter(e=>e.type.startsWith('verification.')),codingRequests,retryRequests,retryElapsedMs:Date.now()-start,retryTerminal:terminal,checks:{orderedActualTools:events.filter(e=>e.type==='tool.requested').slice(0,2).map(e=>e.payload.name).join(',')==='write_file,edit_file',correctActualFile:actual.includes('= 2'),completed:outcome.status==='completed',longRetryHonored:retryRequests===1,deadlineReported:terminal.some(e=>e.type==='error'&&e.error.provider?.kind==='timeout')},paidModelCalls:0,quality:'Scripted loopback protocol/coding harness proof, not model quality'};
 await writeFile(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report));assert(Object.values(report.checks).every(Boolean),'Protocol order/retry regressions remain');
}finally{await harness?.close();await new Promise(r=>server.close(r));await rm(ws,{recursive:true,force:true})}
