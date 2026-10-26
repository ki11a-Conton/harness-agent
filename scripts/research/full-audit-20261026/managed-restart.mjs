import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const root=process.argv[2], output=process.argv[3];
const load=p=>import(pathToFileURL(join(root,p)).href);
const { ManagedCommands, ManagedCommandOrchestrator } = await load('packages/tools/dist/managed-commands.js');
const { ToolRegistry }=await load('packages/tools/dist/registry.js');
const { TaskVerifier }=await load('packages/tools/dist/verification/task-verifier.js');
const cwd = await realpath(await mkdtemp(join(tmpdir(),'audit-managed-close-')));
const journal=join(cwd,'journal.json');
let managed;
const context={cwd,sessionId:'audit-session',turnId:'audit-turn',agentId:'audit-agent',signal:new AbortController().signal,permissions:{rules:[],defaultEffect:'allow'},sandboxPolicy:{filesystem:{mode:'workspace-write',allowedPaths:[cwd]},network:{mode:'deny'},process:{timeoutMs:5000,maxOutputBytes:65536}}};
function create(recovered){
 const manager=new ManagedCommands({maxJobMs:5000,resolveAuthority:async(ctx)=>({signal:ctx.signal,deadlineAt:Date.now()+10000}),save:async records=>writeFile(journal,JSON.stringify(records)),...(recovered?{recovered}:{})});
 const registry=new ToolRegistry();for(const tool of manager.tools())registry.register(tool);
 const orch=new ManagedCommandOrchestrator({registry,workspaceRoot:cwd},manager);
 return {manager,call:(name,args)=>orch.execute({id:crypto.randomUUID(),sessionId:context.sessionId,turnId:context.turnId,agentId:context.agentId,call:{id:crypto.randomUUID(),name,args}},context)};
}
try {
 let f=create();managed=f.manager;
 let start=await f.call('exec_start',{command:process.execPath,args:['-e',"require('node:fs').writeFileSync('proof','once')"],yieldMs:0});
 if(start.status!=='success')throw new Error(JSON.stringify(start));
 let poll;
 do{poll=await f.call('exec_poll',{jobId:start.output.jobId,waitMs:100});}while(poll.output.state==='running');
 const beforeClose={state:poll.output.state,commandStatus:poll.output.commandStatus,exitCode:poll.output.exitCode,proof:await readFile(join(cwd,'proof'),'utf8')};
 await f.manager.close();
 const afterCloseJournal=JSON.parse(await readFile(journal,'utf8'));
 f=create(afterCloseJournal);managed=f.manager;
 const reopened=await f.call('exec_start',{command:process.execPath,args:['-e',"require('node:fs').writeFileSync('second','normal')"],yieldMs:0});
 if(reopened.status==='success'){let next;do{next=await f.call('exec_poll',{jobId:reopened.output.jobId,waitMs:100});}while(next.output.state==='running');}
 const verification=await f.manager.verifier(new TaskVerifier()).verify({id:'actual-check',goal:'read actual proof',verification:[]},{cwd,sessionId:context.sessionId,turnId:context.turnId,changedPaths:[],transcript:'',runStartedAt:Date.now(),executeCommand:()=>{throw new Error('should not run')}});
 const result={sourceSha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceDirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()!=='',beforeClose,afterCloseJournal,reopened,verification};
 await writeFile(output,JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({beforeClose,closedJournalStates:afterCloseJournal.map(r=>r.state),reopenedStatus:reopened.status,reopenedError:reopened.error?.message,verificationPassed:verification.passed}));
}finally{await managed?.close().catch(()=>{});await rm(cwd,{recursive:true,force:true});}
