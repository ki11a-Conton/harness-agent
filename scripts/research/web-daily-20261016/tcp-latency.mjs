import { Duplex } from 'node:stream';

/** Delay byte arrival, preserving order and backpressure without limiting bandwidth. */
export function createLatencyStream(readDelay, { maxQueuedBytes = 1024 * 1024 } = {}) {
  const queue = [];
  let bytes = 0, lastDue = 0, timer, heldWrite, finalWrite, blocked = false, pumping = false;
  const hasRoom = () => bytes < maxQueuedBytes && queue.length < 1024;
  function schedule() {
    if (stream.destroyed || pumping) return;
    if (!queue.length && finalWrite) {
      const done = finalWrite; finalWrite = undefined;
      stream.push(null); done();
    } else if (queue.length && !blocked && timer === undefined) {
      timer = setTimeout(pump, Math.max(0, queue[0].due - Date.now()));
    }
  }
  function pump() {
    timer = undefined; pumping = true;
    try {
      while (!stream.destroyed && !blocked && queue.length && queue[0].due <= Date.now()) {
        const item = queue.shift(); bytes -= item.chunk.length;
        blocked = !stream.push(item.chunk);
        if (heldWrite && hasRoom()) {
          const done = heldWrite; heldWrite = undefined; done();
        }
      }
    } finally { pumping = false; schedule(); }
  }
  const stream = new Duplex({
    write(chunk, _encoding, done) {
      let delay;
      try {
        delay = readDelay();
        if (!Number.isFinite(delay) || delay < 0) throw new RangeError('TCP latency must be a finite nonnegative number');
      } catch (error) { done(error); return; }
      // TCP segmentation varies by OS and load. A queued chunk must not add a
      // second full round of latency, or many small frames starve later RPCs.
      lastDue = Math.max(lastDue, Date.now() + delay);
      queue.push({ chunk, due: lastDue }); bytes += chunk.length;
      if (hasRoom()) done(); else heldWrite = done;
      schedule();
    },
    read() { blocked = false; schedule(); },
    final(done) { finalWrite = done; schedule(); },
    destroy(error, done) {
      clearTimeout(timer); queue.length = 0; bytes = 0;
      const write = heldWrite, final = finalWrite; heldWrite = finalWrite = undefined;
      write?.(error); final?.(error); done(error);
    },
  });
  return stream;
}
