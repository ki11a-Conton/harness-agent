import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessExecutor } from '../../../packages/tools/dist/process/executor.js';
import { HTTP_SERVICE_FIXTURE_SOURCE } from './http-service-fixture.mjs';
async function fixture(t) {
  const cwd=await mkdtemp(join(tmpdir(),'paired-http-lifecycle-'));
  await writeFile(join(cwd,'server.cjs'),HTTP_SERVICE_FIXTURE_SOURCE);return cwd;
}
for(const late of [false,true]) test(late?'HTTP service accepts a request after the obsolete 4.5s expiry':'HTTP service serves an ordinary request and records the actual URL',{timeout:15000},async t=>{
  const cwd=await fixture(t);const child=spawn(process.execPath,['server.cjs'],{cwd,stdio:['ignore','pipe','pipe'],windowsHide:true});
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});let output='',stderr='';child.stderr.on('data',b=>{stderr+=b});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;await rm(cwd,{recursive:true,force:true,maxRetries:process.platform==='win32'?8:0,retryDelay:50})});
  const ready=new Promise((resolve,reject)=>{child.stdout.on('data',b=>{output+=b;const m=/LISTENING (\d+)/.exec(output);if(m)resolve(Number(m[1]))});exited.then(e=>reject(new Error('server exited before readiness '+JSON.stringify(e)+' '+stderr)),reject)});
  const port=await ready;
  if(late){const start=JSON.parse((await readFile(join(cwd,'starts.jsonl'),'utf8')).trim());await delay(Math.max(0,start.at+4600-Date.now()));}
  const response=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1000)});assert.equal(response.status,200);assert.equal(await response.text(),'ACTUAL_API_OK');
  assert.equal(JSON.parse(await readFile(join(cwd,'api-observed.json'),'utf8')).url,'/health');
});
test('a service without a request is still terminated by its unchanged 5s command owner',{timeout:15000},async t=>{
  const cwd=await fixture(t);t.after(()=>rm(cwd,{recursive:true,force:true,maxRetries:process.platform==='win32'?8:0,retryDelay:50}));const result=await new ProcessExecutor().runArgv({file:process.execPath,args:['server.cjs'],cwd,timeoutMs:5000});
  assert.equal(result.status,'timeout');const start=JSON.parse((await readFile(join(cwd,'starts.jsonl'),'utf8')).trim());
  assert.throws(()=>process.kill(start.pid,0),e=>e.code==='ESRCH');assert.equal(await readFile(join(cwd,'api-observed.json'),'utf8').catch(e=>e.code),'ENOENT');
});
