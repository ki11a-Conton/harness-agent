import {mkdtemp,mkdir,writeFile,access,readFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {hostname} from 'node:os';
const root=await mkdtemp('/tmp/gen1-ledger-reclaim-');
const lock=join(root,'budget-ledger.lock');
await writeFile(lock,JSON.stringify({token:'dead',pid:2147483647,host:hostname(),acquiredAt:0}));
const source=pathToFileURL(join(process.cwd(),'packages/evaluation/dist/r97-budget-ledger.js')).href;
const children=[];
function start(tag){const script=`
 import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
 const originalRm=fs.rm;let first=true;
 fs.rm=async function(path,...args){if(String(path)===${JSON.stringify(lock)} && first){first=false;await fs.writeFile(${JSON.stringify(root)}+'/rm-ready-'+${JSON.stringify(tag)},'1');for(;;){try{await fs.access(${JSON.stringify(root)}+'/remove-'+${JSON.stringify(tag)});break}catch{await new Promise(r=>setTimeout(r,5));}}}return originalRm(path,...args);};
 syncBuiltinESMExports();const {withR97CampaignLock}=await import(${JSON.stringify(source)});
 try{await withR97CampaignLock(${JSON.stringify(root)},async()=>{await fs.writeFile(${JSON.stringify(root)}+'/held-'+${JSON.stringify(tag)},'1');for(;;){try{await fs.access(${JSON.stringify(root)}+'/release');break}catch{await new Promise(r=>setTimeout(r,5));}}},{lockTimeoutMs:5000});console.log(JSON.stringify({tag:${JSON.stringify(tag)},ok:true}));}
 catch(error){console.log(JSON.stringify({tag:${JSON.stringify(tag)},ok:false,error:String(error)}));}
 `;const p=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});children.push(p);let out='',err='';p.stdout.on('data',s=>out+=s);p.stderr.on('data',s=>err+=s);return new Promise((res,rej)=>{p.on('error',rej);p.on('close',code=>res({code,out,err}));});}
async function wait(name){const deadline=Date.now()+10000;for(;;){try{await access(join(root,name));return}catch{if(Date.now()>deadline)throw new Error('barrier '+name);await new Promise(r=>setTimeout(r,5));}}}
try{const a=start('a'),b=start('b');await Promise.all([wait('rm-ready-a'),wait('rm-ready-b')]);await writeFile(join(root,'remove-a'),'1');await wait('held-a');await writeFile(join(root,'remove-b'),'1');await wait('held-b');const liveLock=JSON.parse(await readFile(lock,'utf8'));await writeFile(join(root,'release'),'1');const results=await Promise.all([a,b]);const report={fault:'delay both stale-owner removals, remove A stale lock then B removes the current live A lock',overlappingCriticalSections:true,liveLock,results};console.log(JSON.stringify(report,null,2));await writeFile('/tmp/gen1-ledger-takeover-probe.json',JSON.stringify(report,null,2));}finally{for(const p of children)if(p.exitCode===null)p.kill('SIGKILL');await rm(root,{recursive:true,force:true});}
