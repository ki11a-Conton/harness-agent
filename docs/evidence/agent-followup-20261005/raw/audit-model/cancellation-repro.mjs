import http from 'node:http';
import { once } from 'node:events';
import { writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { OpenAICompatibleProvider } from '../../../packages/model/dist/openai.js';
const sse=value=>`data: ${JSON.stringify(value)}\n\n`;
const realFetch=globalThis.fetch;
const provider=new OpenAICompatibleProvider();
const makeClient=baseUrl=>provider.createClient({providerId:'openai',modelId:'probe'},{apiKey:'offline-only',baseUrl,requestTimeoutMs:0,maxProviderRetries:0});
globalThis.fetch=async()=>new Response(sse({choices:[{delta:{content:'first'},finish_reason:null}]})+sse({choices:[{delta:{},finish_reason:'stop'}]}));
const bufferedEvents=[];
const bufferedAbort=new AbortController();
for await(const ev of makeClient('https://offline.invalid/v1').generate({messages:[]},bufferedAbort.signal)){
  bufferedEvents.push(ev);
  if(ev.type==='text_delta')bufferedAbort.abort();
}
globalThis.fetch=realFetch;
let response;
const server=http.createServer(async(req,res)=>{
  for await(const c of req){}
  response=res;
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.write(sse({choices:[{delta:{content:'first'},finish_reason:null}]}));
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const nativeEvents=[];
const nativeAbort=new AbortController();
let nativeError;
try{
  for await(const ev of makeClient(`http://127.0.0.1:${server.address().port}/v1`).generate({messages:[]},nativeAbort.signal)){
    nativeEvents.push(ev);
    if(ev.type==='text_delta')nativeAbort.abort();
  }
}catch(error){nativeError={name:error.name,message:error.message};}
server.close();server.closeAllConnections();await once(server,'close');
const result={buffered:{expectedReason:'cancelled',actualReason:bufferedEvents.find(e=>e.type==='completed')?.result.finishReason,events:bufferedEvents},native:{events:nativeEvents,error:nativeError??null}};
result.sourceSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
result.sourceFileSha256=createHash('sha256').update(await readFile('packages/model/src/openai.ts')).digest('hex');
result.distFileSha256=createHash('sha256').update(await readFile('packages/model/dist/openai.js')).digest('hex');
result.runtime=process.version;
result.buffered.actualFailure=result.buffered.actualReason!=='cancelled';
result.native.expectedReason='cancelled';
result.native.actualReason=nativeEvents.find(e=>e.type==='completed')?.result.finishReason??null;
result.native.actualFailure=result.native.actualReason!=='cancelled'||nativeError!==undefined;
if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
