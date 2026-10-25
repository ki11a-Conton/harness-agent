import { describe, expect, it } from 'vitest';
import { ManagedOutput } from './managed-output.js';
describe('managed UTF-8 incremental output', () => {
  it('preserves stream order, byte cursors and no repeated delivery', () => {
    const output = new ManagedOutput(32); output.append('stdout', '你🙂'); output.append('stderr', '好');
    const one = output.read(0); expect(one.chunks.map(c => c.text).join('')).toBe('你🙂好'); expect(one.nextCursor).toBe(10);
    expect(output.read(one.nextCursor).chunks).toEqual([]); expect(one.lostBytes).toBe(0);
  });
  it('bounds a large burst and explicitly reports discarded bytes on a character boundary', () => {
    const output = new ManagedOutput(10); output.append('stdout', '🙂'.repeat(50000));
    const delta = output.read(0); expect(delta.retainedBytes).toBe(8); expect(delta.lostBytes).toBe(199992); expect(delta.chunks[0]!.text).toBe('🙂🙂'); expect(delta.incomplete).toBe(true);
  });
  it('never invents replacement characters for a cursor inside UTF-8', () => {
    const output = new ManagedOutput(20); output.append('stdout', '你🙂好');
    const delta = output.read(1); expect(delta.chunks.map(c => c.text).join('')).toBe('🙂好'); expect(delta.lostBytes).toBe(2); expect(delta.nextCursor).toBe(10);
  });
  it('zero capture remains explicit missing output, never fabricated success', () => {
    const output = new ManagedOutput(0); output.append('stderr', 'ERR'); expect(output.read(0)).toMatchObject({ chunks: [], nextCursor: 3, lostBytes: 3, retainedBytes: 0 });
  });
  it('bounds pages at whole code points and preserves omitted bytes for the next page', () => {
    const output = new ManagedOutput(32); output.append('stdout', '🙂你好');
    expect(output.read(0, 5)).toMatchObject({ nextCursor: 4, lostBytes: 0 }); expect(output.read(4).chunks[0]!.text).toBe('你好');
  });
  it('rejects invalid, future and unbounded cursors/capacities', () => {
    const output = new ManagedOutput(4); for (const n of [-1, 0.1, Infinity, NaN, 1]) expect(() => output.read(n)).toThrow();
    for (const n of [-1, 0.1, 65537, Infinity]) expect(() => new ManagedOutput(n)).toThrow();
  });
});
