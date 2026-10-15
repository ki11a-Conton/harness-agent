import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';
const before=execFileSync('git',['show','ef0cf955d1b31053d9f87f6d023c1ef384e40458:scripts/research/source-audit-20261007/web-acceptance.mjs'],{encoding:'utf8'});
const start=before.indexOf('async function stop(cp) {'),end=before.indexOf('\nasync function http',start);
if(start<0||end<start)throw new Error('Original stop function not found');
const oldStop=before.slice(start,end);
export default defineConfig({ plugins:[{name:'original-exit-only-stop',enforce:'pre',transform(code,id){
 if(id.endsWith('/source-audit-20261007/process-owner.mjs')){
  const start=code.indexOf('export function ownChildProcess(child) {'),end=code.indexOf('\n/** Select a fresh fixture',start);
  if(start<0||end<start)throw new Error('Process-owner boundary changed');
  return "import {once} from 'node:events';\n"+code.slice(0,start)+oldStop+"\nexport function ownChildProcess(child){let closed=false;const done=new Promise(r=>child.once('close',()=>{closed=true;r()}));return{child,done,get closed(){return closed},stop:()=>stop(child)}}\n"+code.slice(end);
 }
}}],test:{include:['packages/harness/src/source-audit-process-owner.regressions.test.ts'],testTimeout:15000} });
