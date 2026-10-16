import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ToolExecutionContext } from '@ar/contracts';
import { execTool } from './exec.js';
import { ExecDiagnosticTail } from '../process/exec-diagnostics.js';
import { Utf8OutputCollector } from '../process/utf8-output.js';

let cwd: string;
beforeAll(async () => { cwd = await realpath(await mkdtemp(join(tmpdir(), 'exec-tail-'))); });
afterAll(async () => { await rm(cwd, { recursive: true, force: true }); });
function context(cap = 64): ToolExecutionContext {
  return { sessionId: 'session_tail' as never, agentId: 'agent_tail' as never, cwd, signal: new AbortController().signal,
    permissions: { rules: [{ action: 'exec', resource: 'command', effect: 'allow' }] },
    sandboxPolicy: { filesystem: { mode: 'workspace-write' }, network: { mode: 'deny' }, process: { timeoutMs: 10000, maxOutputBytes: cap } } };
}

it.each([[1, '界', ''], [3, '🙂x', 'x'], [4, 'a🙂', '🙂'], [5, '界🙂', '🙂'], [7, '界🙂', '界🙂']] as const)('UTF-8 tail budget %i retains complete suffix characters', (cap, input, expected) => {
  const tail = new ExecDiagnosticTail(cap); tail.append(input);
  expect(tail.text).toBe(expected); expect(Buffer.byteLength(tail.text)).toBeLessThanOrEqual(cap);
  expect(tail.text).not.toContain('\uFFFD');
});

it('a rolling tail complements the existing prefix without reopening a closed prefix capture', () => {
  const prefix = new Utf8OutputCollector(5), tail = new ExecDiagnosticTail(5);
  tail.append(prefix.write(Buffer.from('abcd🙂'))); tail.append(prefix.write(Buffer.from('x'))); tail.append(prefix.end());
  expect(prefix.text).toBe('abcd'); expect(prefix.truncated).toBe(true);
  expect(tail.text).toBe('🙂x'); expect(tail.observedBytes).toBe(9);
});

it('even unlimited or malformed policy values cannot allocate an unbounded diagnostic tail', () => {
  for (const cap of [Infinity, Number.MAX_SAFE_INTEGER, 768]) {
    const tail = new ExecDiagnosticTail(cap);
    for (let index = 0; index < 10; index++) tail.append('界🙂'.repeat(10000) + 'END');
    expect(Buffer.byteLength(tail.text)).toBeLessThanOrEqual(768); expect(tail.text.endsWith('END')).toBe(true);
  }
  for (const cap of [0, -1, NaN]) { const tail = new ExecDiagnosticTail(cap); tail.append('not retained'); expect(tail.text).toBe(''); }
});

it('real failed exec preserves exact prefixes, independent tails and full live delivery', async () => {
  const ctx = context(), live = { stdout: '', stderr: '' };
  ctx.onOutput = event => { if (event.stream !== 'progress') live[event.stream] += event.text; };
  const result = await execTool.execute({ command: process.execPath, args: ['-e', "process.stdout.write('a'.repeat(512)+'OUT界🙂');process.stderr.write('b'.repeat(512)+'ERR界🙂');process.exitCode=3;"] }, ctx);
  expect(result.status).toBe('failed'); expect(result.output).toBeDefined();
  const output = result.output!;
  expect(output.exitCode).toBe(3); expect(output.stdout).toBe('a'.repeat(64)); expect(output.stderr).toBe('b'.repeat(64)); expect(output.truncated).toBe(true);
  expect(output.diagnostics?.incomplete).toBe(true);
  expect(output.diagnostics?.stdoutTail?.endsWith('OUT界🙂')).toBe(true); expect(output.diagnostics?.stderrTail?.endsWith('ERR界🙂')).toBe(true);
  expect(Buffer.byteLength(output.diagnostics!.stdoutTail!)).toBeLessThanOrEqual(64); expect(Buffer.byteLength(output.diagnostics!.stderrTail!)).toBeLessThanOrEqual(64);
  expect(live).toEqual({ stdout: 'a'.repeat(512) + 'OUT界🙂', stderr: 'b'.repeat(512) + 'ERR界🙂' });
});

it('small complete output adds no diagnostic fields or duplicate text', async () => {
  const result = await execTool.execute({ command: process.execPath, args: ['-e', "process.stdout.write('hello');process.stderr.write('note');"] }, context());
  expect(result.status).toBe('success'); expect(result.output).toMatchObject({ stdout: 'hello', stderr: 'note', truncated: false, exitCode: 0 });
  expect(result.output).not.toHaveProperty('diagnostics');
});

it('zero capture policy does not expose a new tail channel', async () => {
  const result = await execTool.execute({ command: process.execPath, args: ['-e', "process.stdout.write('not retained');"] }, context(0));
  expect(result.output).toMatchObject({ stdout: '', stderr: '', truncated: true }); expect(result.output).not.toHaveProperty('diagnostics');
});

it('a throwing live observer cannot discard the already collected diagnostic', async () => {
  const ctx = context(16); ctx.onOutput = () => { throw new Error('fixture observer disconnected'); };
  const result = await execTool.execute({ command: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(512)+'END');"] }, ctx);
  expect(result.status).toBe('success'); expect(result.output?.diagnostics?.stdoutTail?.endsWith('END')).toBe(true);
});

it('cancellation after actual live readiness preserves the existing cancelled-result contract', async () => {
  const controller = new AbortController(), ctx = context(); let live = '';
  ctx.signal = controller.signal; ctx.onOutput = event => { live += event.text; if (live.includes('READY')) controller.abort(); };
  const result = await execTool.execute({ command: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(2048)+'READY');setInterval(()=>{},1000);"] }, ctx);
  expect(live).toContain('READY'); expect(result.status).toBe('cancelled'); expect(result.output).toBeUndefined();
});
