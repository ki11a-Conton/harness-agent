import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const repo='/workspace/harness-agent-release-refresh-20261018';
const { acquireDataDirLease }=await import(pathToFileURL(repo+'/apps/cli/src/data-dir-lease.ts'));
const test=await readFile(repo+'/apps/cli/src/data-dir-lease.test.ts','utf8');
const source=test.match(/const childSource = `([\s\S]*?)`;/)[1];
const root=await mkdtemp(join(tmpdir(),'harness-lease-fixture-repro-'));let held,child;
try {
 held=await acquireDataDirLease(root);
 child=spawn(process.execPath,['--input-type=module','-e',source],{env:{...process.env,LEASE_MODULE:pathToFileURL(repo+'/apps/cli/src/data-dir-lease.ts').href,LEASE_DIRECTORY:root,LEASE_MODE:'owner',LEASE_MARKER:join(root,'durable-approval.json')},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const timeout=setTimeout(()=>child.kill('SIGKILL'),15000);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});clearTimeout(timeout);
 assert.equal(code,73);assert(!stdout.includes('"status":"OWNED"'));assert.equal(JSON.parse(stderr.trim()).code,'HARNESS_DATA_DIR_IN_USE');
 const record={status:'REPRODUCED',sourceSha:'60bc1a5fbd8582bc4ced86363492bb90c2355b8e',scenario:'A fresh temporary directory has an occupied fixed port before the first test owner is admitted. Original unqualified owner setup fails before SIGKILL or any ownership assertion.',controlledBusyPort:held.lockPort,originalOwnerExitCode:code,stdout,stderr,productionRefusalPreserved:true,originalCIBusyPortHolder:'NOT_IDENTIFIED'};
 await writeFile('/tmp/harness-release-refresh-20261018/lease-fixture-red.json',JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify(record));
} finally {if(child&&child.exitCode===null)child.kill('SIGKILL');await held?.release();await rm(root,{recursive:true,force:true});}
