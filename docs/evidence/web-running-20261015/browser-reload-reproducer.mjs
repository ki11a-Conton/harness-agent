import assert from 'node:assert/strict';
import { spawn,execFileSync } from 'node:child_process';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const out='/tmp/harness-ui-running-rootcause-20261015/browser-reload';
await mkdir(out,{recursive:true});
const {chromium}=await import(pathToFileURL('/tmp/harness-ui-running-rootcause-20261015/browser-tools/node_modules/playwright/index.mjs'));
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
const timeout=(promise,ms,label)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(label)),ms);promise.then(v=>{clearTimeout(timer);resolve(v);},e=>{clearTimeout(timer);reject(e);});});
const records=[];
try {
 for(const [name,source,expectedStuck] of [
  ['baseline','/workspace/harness-agent-models-merge-20261015',true],
  ['fixed','/workspace/harness-agent-ui-running-fix-20261015',false],
 ]) {
  const directory=path.join(out,name);await mkdir(directory,{recursive:true});
  const sha=execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim();
  assert.equal(execFileSync('git',['status','--porcelain'],{cwd:source,encoding:'utf8'}),'');
  const child=spawn(process.execPath,[path.join(source,'scripts/research/deepseek-live-host.mjs'),'--root',path.join(directory,'fixture'),'--ipc-control'],{cwd:source,stdio:['ignore','pipe','pipe','ipc']});
  let stdout='',stderr='',context,page,promptSessionId;
  const ready=new Promise((resolve,reject)=>{child.stdout.on('data',bytes=>{stdout+=bytes;const m=stdout.match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});child.stderr.on('data',bytes=>{stderr+=bytes;});child.once('error',reject);child.once('exit',code=>reject(new Error('Fixture exited before readiness '+code+' '+stderr)));});
  const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  const lists=[],notices=[],errors=[];let reloadStarted=false;
  try {
   const origin=await timeout(ready,60000,'Fixture readiness');
   context=await browser.newContext({viewport:{width:320,height:1100},locale:'en-US'});page=await context.newPage();page.setDefaultTimeout(10000);
   page.on('pageerror',e=>errors.push(String(e)));
   page.on('websocket',socket=>{const calls=new Map();socket.on('framesent',event=>{let f;try{f=JSON.parse(String(event.payload));}catch{return;}if(f.type==='request'){calls.set(f.id,f.body?.endpoint);if(f.body?.endpoint==='session/prompt')promptSessionId=f.body.args.request.sessionId;}});socket.on('framereceived',event=>{let f;try{f=JSON.parse(String(event.payload));}catch{return;}if(f.type==='result'&&calls.get(f.id)==='session/list')lists.push({afterReload:reloadStarted,items:f.value?.value?.items?.map(s=>({id:s.sessionId,running:s.running}))});if(f.type==='frame'&&f.value?.type==='emit'&&['api-session/added','api-session/status'].includes(f.value.event)){const n=f.value;notices.push(n.event==='api-session/added'?{event:n.event,id:n.args[0].sessionId,running:n.args[0].running}:{event:n.event,id:n.args[0],running:n.args[1]});}});});
   await page.goto(origin,{waitUntil:'domcontentloaded'});
   await page.getByRole('button',{name:'Choose workspace',exact:true}).click();
   await page.getByRole('menuitem',{name:'project',exact:true}).click();
   const input=page.locator('[data-composer-input=true][contenteditable=true]').filter({visible:true});
   await input.fill('[fixture:slow] Render the fixture while I reload this active session.');
   await page.getByRole('button',{name:'Send message',exact:true}).click();
   await page.getByRole('heading',{name:'Actual Harness browser answer',exact:true}).waitFor({state:'visible',timeout:15000});
   reloadStarted=true;await page.reload({waitUntil:'domcontentloaded'});
   await page.getByRole('heading',{name:'Actual Harness browser answer',exact:true}).waitFor({state:'visible',timeout:15000});
   await page.locator('pre code').filter({hasText:'export const value = 1;'}).waitFor({state:'visible',timeout:15000});
   await page.getByRole('button',{name:/^Completed in /}).waitFor({state:'visible',timeout:15000});
   const stop=page.getByRole('button',{name:'Stop generating',exact:true});
   let stuck=false;try{await stop.waitFor({state:'hidden',timeout:1500});}catch{stuck=await stop.isVisible();}
   const observed=await page.locator('body').innerText();
   const runningList=lists.some(l=>l.afterReload&&l.items?.some(s=>s.id===promptSessionId&&s.running));
   assert(runningList,'The actual reconnect list must prove the target was running');
   assert.equal(stuck,expectedStuck,'Actual completion-control state on '+name);
   assert.equal(errors.length,0);
   if(expectedStuck)assert(observed.includes('Completed')&&observed.includes('Deep diving'));
   else assert(notices.some(n=>n.event==='api-session/status'&&n.id===promptSessionId&&n.running===false));
   await page.screenshot({path:path.join(directory,'completion.png'),fullPage:true});
   const record={name,sourceSha:sha,sourceTreeClean:true,promptSessionId,runningListConfirmed:runningList,stuckAfterDurableCompletion:stuck,expectedStuck,paidModelCalls:0,errors,lists,notices,observed};
   records.push(record);await writeFile(path.join(directory,'result.json'),JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify({name,sourceSha:sha,runningListConfirmed:runningList,stuckAfterDurableCompletion:stuck,correctedStatusSeen:notices.some(n=>n.event==='api-session/status'&&n.id===promptSessionId&&n.running===false)}));
  } finally {
   await context?.close();if(child.connected)child.send({type:'fixture-stop'});
   try{assert.equal((await timeout(exit,15000,'Fixture shutdown')).code,0);}finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await writeFile(path.join(directory,'host-stdout.log'),stdout);await writeFile(path.join(directory,'host-stderr.log'),stderr);}
  }
 }
 await writeFile(path.join(out,'result.json'),JSON.stringify({status:'PASS',realBrowser:true,productionHttp:true,rpcMocks:false,paidModelCalls:0,records:records.map(({name,sourceSha,runningListConfirmed,stuckAfterDurableCompletion})=>({name,sourceSha,runningListConfirmed,stuckAfterDurableCompletion}))},null,2)+'\n');
} finally {await browser.close();}
