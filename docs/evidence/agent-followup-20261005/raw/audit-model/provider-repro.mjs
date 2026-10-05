import http from 'node:http';
import { once } from 'node:events';
import { writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { OpenAICompatibleProvider } from '../../../packages/model/dist/openai.js';

const sse = value => `data: ${JSON.stringify(value)}\n\n`;
const observations = [];
let activeResponses = new Set();
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  observations.push({ path:req.url, body:JSON.parse(body) });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(sse({ choices:[{ index:0, delta:{content:'complete'}, finish_reason:null }] }));
  res.write(sse({ choices:[{ index:0, delta:{}, finish_reason:'stop' }] }));
  // Standard include_usage footer is a distinct chunk after the finish_reason.
  res.write(sse({ choices:[], usage:{prompt_tokens:137,completion_tokens:23,total_tokens:160} }));
  res.end('data: [DONE]\n\n');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const addr = server.address();
const events = [];
const client = new OpenAICompatibleProvider().createClient({providerId:'openai',modelId:'probe'}, {
  apiKey:'offline-probe-only',baseUrl:`http://127.0.0.1:${addr.port}/v1`,requestTimeoutMs:0,maxProviderRetries:0,
});
for await (const event of client.generate({messages:[]},new AbortController().signal)) events.push(event);
server.close();
server.closeAllConnections();
await once(server,'close');

const realFetch = globalThis.fetch;
let cancellationCount = 0;
let stream;
globalThis.fetch = async () => {
  stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse({ choices:[{delta:{content:'first'},finish_reason:null}] })));
    },
    cancel() { cancellationCount += 1; },
  });
  return new Response(stream, {status:200});
};
const cleanupEvents = [];
for await (const event of client.generate({messages:[]},new AbortController().signal)) {
  cleanupEvents.push(event);
  if(event.type === 'text_delta') break;
}
globalThis.fetch = realFetch;
const result = {
  schemaVersion:1,
  sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  sourceFileSha256:createHash('sha256').update(await readFile('packages/model/src/openai.ts')).digest('hex'),
  distFileSha256:createHash('sha256').update(await readFile('packages/model/dist/openai.js')).digest('hex'),
  runtime:process.version,
  usageFooter:{ expected:{inputTokens:137,outputTokens:23}, actual:events.find(e=>e.type==='completed')?.result.usage??null, usageEventCount:events.filter(e=>e.type==='usage').length,events,requests:observations },
  earlyReturnCleanup:{expectedCancellationCount:1,actualCancellationCount:cancellationCount,readerRemainsLocked:stream.locked,events:cleanupEvents},
};
result.usageFooter.actualFailure=result.usageFooter.actual?.inputTokens!==137||result.usageFooter.actual?.outputTokens!==23||result.usageFooter.usageEventCount!==1;
result.earlyReturnCleanup.actualFailure=cancellationCount!==1||stream.locked;
const path = process.argv[2];
if(path) await writeFile(path,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
