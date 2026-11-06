import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=process.argv[2],out=process.argv[3];let effects=0;
const load=p=>import(new URL('file://'+root+'/'+p).href);
const [{AgentRuntime,RuntimeKilledError},{RunBudgetTracker},{RecoveryController},{MemorySessionStore,MemoryEventStore},{ScriptedModelProvider},{ToolRegistry},{ToolOrchestrator},{writeFileTool},c]=await Promise.all([
load('packages/core/dist/runtime/runtime.js'),load('packages/core/dist/runtime/run-budget.js'),load('packages/core/dist/runtime/recovery-controller.js'),load('packages/core/dist/test/fakes.js'),load('packages/model/dist/index.js'),load('packages/tools/dist/registry.js'),load('packages/tools/dist/orchestrator.js'),load('packages/tools/dist/tools/write-file.js'),load('packages/contracts/dist/index.js')]);
const source=()=>({sha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),status:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()});
const before=source(),abort=new AbortController();
const compiled={};for(const f of ['packages/core/dist/runtime/runtime.js','packages/core/dist/runtime/recovery-controller.js','packages/tools/dist/orchestrator.js','packages/tools/dist/tools/write-file.js'])compiled[f]=createHash('sha256').update(await readFile(join(root,f))).digest('hex');
const ws=await mkdtemp('/dev/shm/harness-comprehensive-audit-20261106/tmp/reused-replay-');
try{
 const store=new MemorySessionStore(),events=new MemoryEventStore();
 const emit=async(sessionId,type,payload,turnId)=>events.appendNew({id:c.newEventId(),sessionId,type,payload,timestamp:Date.now(),...(turnId?{turnId}:{})});
 const registry=new ToolRegistry();registry.register(writeFileTool);
 const semantics=()=>c.toToolSemantics(writeFileTool.metadata,writeFileTool.risk);
 const orchestrator=new ToolOrchestrator({registry,workspaceRoot:ws,events:{emit},persistIntent:async i=>emit(i.sessionId,'tool.intent_persisted',{...i},i.turnId)});
 const agent={id:c.newAgentId(),name:'actual-replay',description:'actual guarded writes and crash recovery',mode:'primary',model:{providerId:'scripted',modelId:'scripted-model'},systemPrompt:'code',tools:{},permissions:{rules:[{action:'*',resource:'*',effect:'allow'}]},skills:{},limits:{maxToolCalls:2}};
 const checkpoints={saved:[],async save(v){this.saved.push(v)},async loadLatest(){return this.saved.at(-1)},async list(){return this.saved.toReversed()}};
 const options={store,events,orchestrator,agents:[agent],modelProvider:new ScriptedModelProvider(['a.ts','b.ts','c.ts'].map((path,index)=>[{type:'completed',timestamp:0,result:{finishReason:'tool_calls',toolCalls:[{id:'toolcall_reused_valid_id',name:'write_file',args:{path,content:'export const value = '+index+';\n'}}]}}])),toolRegistry:registry,toolSemanticsOf:semantics,checkpointStore:checkpoints,checkpointPolicy:{everyNIterations:0,afterSideEffectTools:false},sandboxPolicy:{filesystem:{mode:'workspace-write',allowedPaths:[ws]},network:{mode:'deny'},process:{timeoutMs:2000}},failpoint(point){if(point==='tool.effect_committed'&&++effects===2)throw new RuntimeKilledError(point)}};
 const runtime=new AgentRuntime(options),session=await runtime.createSession({agent,cwd:ws}),turn=await runtime.startTurn(session.id,'Modify both source files');
 const budget=new RunBudgetTracker(agent.limits,()=>turn.startedAt);budget.onTurnStart();
 const checkpoint=c.buildCheckpoint({checkpointId:c.newCheckpointId(),schemaVersion:1,sessionId:session.id,turnId:turn.id,agentId:agent.id,createdAt:Date.now(),reason:'before-model',phase:'thinking',iteration:0,state:c.newWorkingState('Modify both source files'),toolLedger:[],childSessions:[],lastEventSequence:(await events.list(session.id)).at(-1)?.sequence??0,effectiveAgentConfigRef:'effectiveAgent',contextRefs:[],budgetUsage:{maxTokens:0,run:budget.snapshot()}});
 await checkpoints.save(checkpoint);
 let killed;try{await runtime.runTurn(session.id,turn.id,abort.signal)}catch(e){killed={name:e.name,point:e.point,message:e.message}}
 assert.equal(killed?.name,'RuntimeKilledError');
 const recovered=await new RecoveryController({store,events,emit,now:()=>Date.now(),semanticsOf:semantics}).reconstructResumeState(session.id,turn.id,checkpoint);
 const actual=await Promise.all(['a.ts','b.ts'].map(path=>readFile(join(ws,path),'utf8'))),beforeResumeEvents=await events.list(session.id);
 const restarted=new AgentRuntime({...options,failpoint:undefined});let resumed,resumeError;try{resumed=await restarted.resumeTurn(session.id,new AbortController().signal)}catch(e){resumeError={name:e.name,message:e.message}}
 let thirdExists=false;try{await readFile(join(ws,'c.ts'));thirdExists=true}catch(e){if(e.code!=='ENOENT')throw e}
 const checks={bothActualWrites:actual.length===2&&actual.every(text=>text.startsWith('export const value')),bothRecovered:recovered.working.filesChanged.includes('a.ts')&&recovered.working.filesChanged.includes('b.ts')&&recovered.committedSideEffects.length===2,noThirdWrite:!thirdExists};
 const report={sourceBefore:before,sourceAfter:source(),compiled,qualification:'RED uses dist built from byte-qualified main before production edits; GREEN is rebuilt from the recorded candidate. Source and compiled hashes are kept separately.',checks,killed,actualFiles:actual,thirdExists,resumedStatus:resumed?.outcome?.status,resumedError:resumed?.outcome?.error,resumeError,effects,requested:beforeResumeEvents.filter(e=>e.type==='tool.requested'),terminalEvents:beforeResumeEvents.filter(e=>['tool.completed','tool.failed'].includes(e.type)),...recovered,paidModelCalls:0};
 await writeFile(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report));assert(Object.values(checks).every(Boolean),'Actual file and budget recovery regressions remain');
}finally{await rm(ws,{recursive:true,force:true})}
