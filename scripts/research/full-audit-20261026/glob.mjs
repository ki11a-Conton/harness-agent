import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";
const root=process.argv[2], mode=process.argv[3];
const load=p=>import(pathToFileURL(join(root,p)).href);
const {newAgentId,newSessionId,newTurnId,newToolCallId}=await load("packages/contracts/dist/index.js");
const {ToolRegistry}=await load("packages/tools/dist/registry.js");
const {ToolOrchestrator}=await load("packages/tools/dist/orchestrator.js");
const {searchFilesTool}=await load("packages/tools/dist/tools/search-files.js");
const {DeterministicPermissionEngine}=await load("packages/security/dist/permission.js");
const fixture=await mkdtemp(join(tmpdir(),"harness-glob-fixture-"));
const target="a".repeat(100)+".ts",pattern="*a".repeat(24)+"b";
await writeFile(join(fixture,target),"real file\n");
const context={cwd:fixture,sessionId:newSessionId(),turnId:newTurnId(),agentId:newAgentId(),signal:new AbortController().signal,permissions:{rules:[{action:"read",resource:"file",effect:"allow"}]},sandboxPolicy:{filesystem:{mode:"workspace-write"},network:{mode:"deny"},process:{timeoutMs:50,maxOutputBytes:100000}}};
const start=performance.now();
console.log(JSON.stringify({event:"ready",mode,patternLength:pattern.length,targetLength:target.length,fixture}));
let heartbeat=false;const heartbeatTimer=setTimeout(()=>{heartbeat=true;console.log(JSON.stringify({event:"heartbeat",afterMs:performance.now()-start}));},100);
try{
let result;
if(mode==="permission")result=await new DeterministicPermissionEngine().evaluate({action:"read",resource:"file",target,agentId:context.agentId,sessionId:context.sessionId},{rules:[{action:"read",resource:"file",effect:"deny",pattern}],defaultEffect:"ask"});
else{const registry=new ToolRegistry();registry.register(searchFilesTool);const orch=new ToolOrchestrator({registry,workspaceRoot:fixture});const id=newToolCallId();result=await orch.execute({id,sessionId:context.sessionId,turnId:context.turnId,agentId:context.agentId,call:{id,name:"search_files",args:{pattern}}},context);}
console.log(JSON.stringify({event:"result",mode,elapsedMs:performance.now()-start,heartbeat,result}));
}finally{clearTimeout(heartbeatTimer);await rm(fixture,{recursive:true,force:true});}
