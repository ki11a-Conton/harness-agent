import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
const scratch=await mkdtemp('/tmp/gen1-budget-bootstrap-');
const claims=join(scratch,'claims');await mkdir(claims);
const modulePath=pathToFileURL(join(process.cwd(),'packages/evaluation/dist/r97-budget-ledger.js')).href;
const plan=randomBytes(32).toString('hex');
const running=[];
function child(tag) {
 const dir=join(scratch,tag);
 const script=`
 import fs from 'node:fs/promises';
 import { syncBuiltinESMExports } from 'node:module';
 const origWrite=fs.writeFile;
 fs.writeFile=async function(path,...args){
  if(String(path).includes('budget-ledger.json.tmp-')){
   await origWrite(${JSON.stringify(scratch)}+'/ready-'+${JSON.stringify(tag)},'1');
   for(;;){try{await fs.access(${JSON.stringify(scratch)}+'/release');break}catch{await new Promise(r=>setTimeout(r,5))}}
  }
  return origWrite(path,...args);
 };
 syncBuiltinESMExports();
 const {openR97BudgetLedger}=await import(${JSON.stringify(modulePath)});
 try {const ledger=await openR97BudgetLedger(${JSON.stringify(dir)},{planDigest:${JSON.stringify(plan)},campaignModelCalls:1,mode:'first-run'});
 console.log(JSON.stringify({tag:${JSON.stringify(tag)},ok:true,view:await ledger.view()}));}
 catch(err){console.log(JSON.stringify({tag:${JSON.stringify(tag)},ok:false,error:String(err)}));}
 `;
 const p=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,R97_CAMPAIGN_CLAIMS_DIR:claims},stdio:['ignore','pipe','pipe']});
 running.push(p);
 let stdout='',stderr='';p.stdout.on('data',v=>stdout+=v);p.stderr.on('data',v=>stderr+=v);
 return new Promise((resolve,reject)=>{p.on('error',reject);p.on('close',code=>resolve({code,stdout,stderr}));});
}
async function ready(tag){const deadline=Date.now()+10000;for(;;){try{await access(join(scratch,'ready-'+tag));return;}catch{if(Date.now()>deadline)throw new Error('did not reach ledger write '+tag);await new Promise(r=>setTimeout(r,5));}}}
try {
 const a=child('a');await ready('a');
 const b=child('b');await ready('b');
 await writeFile(join(scratch,'release'),'1');
 const records=await Promise.all([a,b]);
 const result={fault:'delay native ledger temp write while a second legitimate first-run starts',records};
 console.log(JSON.stringify(result,null,2));
 await writeFile('/tmp/gen1-budget-bootstrap-probe.json',JSON.stringify(result,null,2));
} finally {for(const p of running)if(p.exitCode===null)p.kill('SIGKILL');await rm(scratch,{recursive:true,force:true});}
