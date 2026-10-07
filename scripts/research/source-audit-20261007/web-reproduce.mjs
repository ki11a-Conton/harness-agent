// Counterexamples for the reviewed source, not acceptance tests for a fix.
// Exit 0 means the recorded defects were reproduced. No paid provider is used.
// Rebuild the checkout first. Results go to HARNESS_SOURCE_AUDIT_OUT or .ci/source-audit-20261007.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const root=await mkdtemp(join(tmpdir(),'harness-web-audit-'));
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const sourceSha=execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const outputDir=resolve(process.env.HARNESS_SOURCE_AUDIT_OUT ?? join(repo,'.ci','source-audit-20261007'));
await mkdir(outputDir,{recursive:true});
const processes=[]; const records=[];
async function start() {
  const cp=spawn(process.execPath,[join(repo,'apps/web/dist/main.js')],{cwd:root,env:{...process.env,OPENAI_API_KEY:'',OPENAI_MODEL:'',HARNESS_DATA_DIR:join(root,'data'),HARNESS_WEB_PORT:'0',HARNESS_WEB_HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
  processes.push(cp); let out='',err=''; cp.stderr.on('data',s=>{err+=s.toString();});
  const port=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('web startup timeout: '+err)),10000);
    cp.once('exit',code=>{clearTimeout(timer);reject(new Error('web exited '+code+': '+err));});
    cp.stdout.on('data',s=>{out+=s.toString();const m=/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);if(m){clearTimeout(timer);resolve(Number(m[1]));}});
  });
  return {cp,port,stderr:()=>err};
}
async function stop(cp) {if(cp.exitCode!==null)return;cp.kill('SIGTERM');await Promise.race([once(cp,'exit'),new Promise((_,reject)=>{const timer=setTimeout(()=>{cp.kill('SIGKILL');reject(new Error('shutdown timeout'));},5000);timer.unref();})]);}
async function http(port,path,headers={},body) {
  return await new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,path,method:body===undefined?'GET':'POST',headers:{...headers,...(body===undefined?{}:{'Content-Length':Buffer.byteLength(body)})}},res=>{let bytes='';res.setEncoding('utf8');res.on('data',s=>{bytes+=s;});res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(bytes)}));});req.on('error',reject);req.end(body);
  });
}
try {
  const first=await start(); const from='audit-session-20261007';
  const post=await http(first.port,'/api/messages',{'Content-Type':'application/json'},JSON.stringify({from,text:'audit persistence message'}));assert.equal(post.status,200);
  let before;
  for(let i=0;i<50;i++){before=await http(first.port,'/api/history?from='+from);if(before.body.messages.length>0)break;await new Promise(r=>setTimeout(r,20));}
  assert(before.body.messages.length>0);
  const hostileHost=await http(first.port,'/api/sessions',{Host:'rebind.audit.invalid:'+first.port});assert.equal(hostileHost.status,200);assert.equal(hostileHost.body.sessions[0].from,from);
  const crossOrigin=await http(first.port,'/api/messages',{'Content-Type':'text/plain',Origin:'https://cross-origin.audit.invalid','Sec-Fetch-Site':'cross-site'},JSON.stringify({from:'audit-external-20261007',text:'untrusted cross-origin message'}));assert.equal(crossOrigin.status,200);
  const foreignHistory=await http(first.port,'/api/history?from=audit-external-20261007');assert(foreignHistory.body.messages.some(m=>m.content==='untrusted cross-origin message'));
  records.push({id:'B14-web-host-origin-boundary',confirmed:true,observed:{foreignHostReadStatus:hostileHost.status,foreignHostSessionCount:hostileHost.body.sessions.length,crossOriginTextPlainPostStatus:crossOrigin.status,crossOriginMessagePersisted:true,note:'native HTTP reproduction of accepted Host/Origin; no browser DNS exploit claimed'}});
  await stop(first.cp); const saved=await readdir(join(root,'data','sessions'));assert(saved.length>=1);
  const second=await start();const after=await http(second.port,'/api/history?from='+from);const sessions=await http(second.port,'/api/sessions');
  assert.equal(after.body.sessionId,null);assert.deepEqual(after.body.messages,[]);assert.deepEqual(sessions.body.sessions,[]);
  await http(second.port,'/api/messages',{'Content-Type':'application/json'},JSON.stringify({from,text:'message after restart'}));
  const reopened=await http(second.port,'/api/history?from='+from);assert.notEqual(reopened.body.sessionId,before.body.sessionId);
  records.push({id:'B15-web-restart-session-binding-lost',confirmed:true,observed:{beforeSessionId:before.body.sessionId,beforeMessageCount:before.body.messages.length,persistedSessionFiles:saved.length,afterRestartHistory:after.body,afterRestartSessionList:sessions.body.sessions,newSessionIdForSameFrom:reopened.body.sessionId}});
  await stop(second.cp);
} finally {for(const cp of processes)if(cp.exitCode===null)cp.kill('SIGKILL');await rm(root,{recursive:true,force:true});}
await writeFile(join(outputDir,'web-repro-results.json'),JSON.stringify({sourceSha,paidProviderCalls:0,kind:'native-http-production-web-reproduction',records},null,2)+'\n');
console.log(JSON.stringify(records,null,2));
