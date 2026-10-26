import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const root=process.argv[2], output=process.argv[3];
const load=p=>import(pathToFileURL(join(root,p)).href);
const { createHarness } = await load('packages/harness/dist/index.js');
const { ScriptedModelProvider } = await load('packages/model/dist/index.js');
const { projectSessionHistory } = await load('apps/web/dist/deepseek/projections.js');
const { codingStatusOf } = await load('apps/web/dist/deepseek/coding-status.js');
const cwd=await mkdtemp(join(tmpdir(),'managed-status-audit-'));
let h,step=0,jobId='',state='',pollToken=0;
const requests=[];
const provider={id:'managed-status-audit',listModels:async()=>[{id:'scripted',capabilities:{contextWindowTokens:128000}}],createClient:()=>({async *generate(request){
 requests.push(structuredClone(request));step++;
 for(const message of request.messages.filter(m=>m.role==='tool')){
  jobId=[...message.content.matchAll(/"jobId"\s*:\s*"([^"]+)"/g)].at(-1)?.[1]??jobId;
  state=[...message.content.matchAll(/"state"\s*:\s*"([^"]+)"/g)].at(-1)?.[1]??state;
  pollToken=Number([...message.content.matchAll(/"pollToken"\s*:\s*(\d+)/g)].at(-1)?.[1]??pollToken);
 }
 if(step===1)yield* ScriptedModelProvider.toolCall('exec_start',{command:process.execPath,args:['-e',"require('node:fs').writeFileSync('executed','actual');console.log('ACTUAL_MANAGED_RESULT');setTimeout(()=>{},200)"],yieldMs:0});
 else if(state==='running')yield* ScriptedModelProvider.toolCall('exec_poll',{jobId,pollToken,waitMs:1000});
 else yield* ScriptedModelProvider.text('Command completed.');
}})};
try {
 h=await createHarness({cwd,dataDir:join(cwd,'state'),profile:'test',modelProvider:provider,model:{providerId:provider.id,modelId:'scripted'},featureFlags:{skills:false,delegation:false,mcp:false,memory:false},task:{id:'managed-status-audit',goal:'Run and verify actual command',completionPolicy:{requiresVerification:true},verification:[{kind:'command',command:process.execPath,args:['-e',"if(require('node:fs').readFileSync('executed','utf8')!=='actual')process.exit(1)"]}]},managedCommands:{enabled:true,maxJobMs:5000},limits:{maxDurationMs:10000,maxToolCalls:15}});
 const session=await h.runtime.createSession({agent:h.agents[0],cwd});
 const turn=await h.runtime.startTurn(session.id,'Run the actual command and report its exit.');
 await h.runtime.runTurn(session.id,turn.id,new AbortController().signal);
 const events=await h.events.list(session.id),messages=await h.store.listMessages(session.id);
 const projection=projectSessionHistory({session:await h.store.getSession(session.id),events,messages});
 const status=codingStatusOf(projection);
 const report={sourceSha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceDirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()!=='',paidModelCalls:0,actualWritten:await readFile(join(cwd,'executed'),'utf8'),state,steps:step,toolCalls:projection.records.filter(r=>r.event.type==='tool/call').map(r=>r.event.data),status,confirmedManagedCommandMissing:state==='succeeded'&&!status.commands.some(command=>command.command.includes('ACTUAL_MANAGED_RESULT')),modelSawActualOutput:requests.some(r=>r.messages.some(m=>m.role==='tool'&&m.content.includes('ACTUAL_MANAGED_RESULT')))};
 await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(e){console.error(e);process.exitCode=1;}finally{await h?.close();await rm(cwd,{recursive:true,force:true});}
