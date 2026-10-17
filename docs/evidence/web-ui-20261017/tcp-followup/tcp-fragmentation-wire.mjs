import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { Transform } from 'node:stream';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { createLatencyStream } from '/workspace/harness-agent-web-interactions-20261016/scripts/research/web-daily-20261016/tcp-latency.mjs';
const original = () => new Transform({ transform(chunk, _encoding, done) { setTimeout(() => done(null, chunk), 40); } });
const fixed = () => createLatencyStream(() => 40);
const results = [];
for (const [name, make] of [['original-serial', original], ['fixed-arrival', fixed]]) {
 let inputChunks = 0;
 const server = createServer({ allowHalfOpen: true }, socket => { socket.setNoDelay(true); socket.on('data', () => inputChunks++); socket.pipe(make()).pipe(socket); });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 try {
  const client = connect(server.address().port, '127.0.0.1');client.setNoDelay(true);await once(client, 'connect');
  const got=[];client.on('data', chunk => got.push(chunk));const end=once(client,'end');const began=performance.now();
  for (let i=0;i<12;i++) {client.write(Buffer.from([i]));await pause(5);}
  const lastInputAt=performance.now()-began;client.end();await end;const elapsedMs=performance.now()-began;
  assert.deepEqual(Buffer.concat(got),Buffer.from(Array.from({length:12},(_,i)=>i)));
  results.push({name,configuredDelayMs:40,inputChunks,bytes:12,lastInputAtMs:lastInputAt,elapsedMs,tailDelayMs:elapsedMs-lastInputAt,exactBytes:true});
 }finally{await new Promise(resolve=>server.close(resolve));}
}
console.log(JSON.stringify({kind:'owned-real-TCP-ordered-binary-replay',results,paidModelCalls:0},null,2));
