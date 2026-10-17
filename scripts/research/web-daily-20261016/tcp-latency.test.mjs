import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, connect } from 'node:net';
import { finished } from 'node:stream/promises';
import test from 'node:test';
import { createLatencyStream } from './tcp-latency.mjs';

test('fragmentation does not multiply the configured propagation latency', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const stream = createLatencyStream(() => 350), chunks = [];
  stream.on('data', chunk => chunks.push(chunk));
  for (let i = 0; i < 40; i++) stream.write(Buffer.from([i]));
  stream.end(); const end = finished(stream);
  context.mock.timers.tick(349); assert.equal(chunks.length, 0);
  context.mock.timers.tick(1);
  await new Promise(resolve => process.nextTick(resolve));
  assert.equal(Buffer.concat(chunks).length, 40, 'All forty arrivals have the same due time');
  await end;
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(Array.from({ length: 40 }, (_, i) => i)));
});

test('turning latency off cannot let newer bytes overtake queued bytes or EOF', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let delay = 350;
  const stream = createLatencyStream(() => delay), chunks = [];
  stream.on('data', chunk => chunks.push(chunk));
  stream.write('before'); delay = 0; stream.end('after'); const end = finished(stream);
  context.mock.timers.tick(349); assert.equal(chunks.length, 0);
  context.mock.timers.tick(1); await end;
  assert.equal(Buffer.concat(chunks).toString(), 'beforeafter');
});

test('queued byte limit applies writable backpressure and releases it after delivery', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const stream = createLatencyStream(() => 350, { maxQueuedBytes: 2 }), chunks = [];
  stream.on('data', chunk => chunks.push(chunk));
  let confirmed = false;
  stream.write('ab', () => { confirmed = true; }); stream.end('cd');
  const end = finished(stream); assert.equal(confirmed, false);
  context.mock.timers.tick(350); assert.equal(confirmed, true);
  context.mock.timers.tick(350); await end;
  assert.equal(Buffer.concat(chunks).toString(), 'abcd');
});

test('destroy cancels delayed delivery and closes with buffered input', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const stream = createLatencyStream(() => 350, { maxQueuedBytes: 2 }), chunks = [];
  stream.on('data', chunk => chunks.push(chunk)); stream.write('buffered');
  const close = once(stream, 'close'); stream.destroy(); await close;
  context.mock.timers.tick(1000); assert.equal(chunks.length, 0);
});

test('actual TCP forwarding preserves binary bytes and graceful EOF', async () => {
  const sockets = new Set();
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.pipe(createLatencyStream(() => 5, { maxQueuedBytes: 1024 })).pipe(socket);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const socket = connect(server.address().port, '127.0.0.1');
    const chunks = []; socket.on('data', chunk => chunks.push(chunk));
    const end = once(socket, 'end');
    const payload = Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => i % 256));
    await once(socket, 'connect');
    socket.write(payload.subarray(0, 3)); socket.write(payload.subarray(3, 1000)); socket.end(payload.subarray(1000));
    await end;
    assert.equal(Buffer.concat(chunks).length, payload.length);
    assert.deepEqual(Buffer.concat(chunks), payload);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
