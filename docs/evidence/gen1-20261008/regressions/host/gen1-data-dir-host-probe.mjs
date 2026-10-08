import { mkdtemp,mkdir,writeFile,readFile,access,rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const scratch=await mkdtemp('/tmp/gen1-host-owners-');
const dataDir=join(scratch,'data'); await mkdir(dataDir);
const modulePath=pathToFileURL(join(process.cwd(),'packages/harness/dist/create-harness.js')).href;
const children=[];
function start(tag){const script=`
 import fs from 'node:fs/promises';
 const {createHarness}=await import(${JSON.stringify(modulePath)});
 const provider={id:'offline',listModels:async()=>[{id:'offline',name:'offline',capabilities:{contextWindowTokens:128000}}],createClient:()=>{throw new Error('no model calls');}};
 const h=await createHarness({cwd:${JSON.stringify(scratch)},profile:'test',modelProvider:provider,model:{providerId:'offline',modelId:'offline'},dataDir:${JSON.stringify(dataDir)},dataStore:'sqlite'});
 await fs.writeFile(${JSON.stringify(scratch)}+'/ready-'+${JSON.stringify(tag)},'1');
 for(;;){try{await fs.access(${JSON.stringify(scratch)}+'/go-'+${JSON.stringify(tag)});break}catch{await new Promise(r=>setTimeout(r,5));}}
 h.approvalStore.create({id:'approval-'+${JSON.stringify(tag)},sessionId:'session-'+${JSON.stringify(tag)},agentId:'a',action:'edit',target:'file-'+${JSON.stringify(tag)},reason:'test',createdAt:1,expiresAt:100000,scope:'one_call'});
 await fs.writeFile(${JSON.stringify(scratch)}+'/done-'+${JSON.stringify(tag)},'1');
 for(;;){try{await fs.access(${JSON.stringify(scratch)}+'/close');break}catch{await new Promise(r=>setTimeout(r,5));}}
 await h.close();console.log(JSON.stringify({host:${JSON.stringify(tag)},pending:h.approvalStore.listPending().map(r=>r.id)}));
 `;const p=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});children.push(p);let out='',err='';p.stdout.on('data',v=>out+=v);p.stderr.on('data',v=>err+=v);return new Promise((res,rej)=>{p.on('error',rej);p.on('close',code=>res({code,out,err}));});}
async function wait(name){let deadline=Date.now()+10000;for(;;){try{await access(join(scratch,name));return}catch{if(Date.now()>deadline)throw Error('barrier '+name);await new Promise(r=>setTimeout(r,5));}}}
try{const a=start('a'),b=start('b');await Promise.all([wait('ready-a'),wait('ready-b')]);
 await writeFile(join(scratch,'go-a'),'1');await wait('done-a');await writeFile(join(scratch,'go-b'),'1');await wait('done-b');
 const durable=JSON.parse(await readFile(join(dataDir,'approval-store.json'),'utf8'));
 await writeFile(join(scratch,'close'),'1');
 const results=await Promise.all([a,b]);const report={results,durablePending:durable.pending.map(r=>r.id),expected:['approval-a','approval-b'],calls:0};
 console.log(JSON.stringify(report,null,2));await writeFile('/tmp/gen1-data-dir-host-probe.json',JSON.stringify(report,null,2));
}finally{for(const p of children)if(p.exitCode===null)p.kill('SIGKILL');await rm(scratch,{recursive:true,force:true});}
