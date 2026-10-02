// Offline source-research reproducer. Existing build artifacts; no network or writes to source.
import { AgentRuntime } from '../../packages/core/dist/runtime/runtime.js';
import { MemorySessionStore, MemoryEventStore, defaultTestToolCatalog } from '../../packages/core/dist/test/fakes.js';
import { FakeOrchestrator } from '../../packages/core/dist/test/fake-orchestrator.js';
import { ScriptedModelProvider } from '../../packages/model/dist/index.js';
import { ContextPipeline } from '../../packages/context/dist/index.js';
import { newAgentId, newToolCallId, DEFAULT_TOOL_SEMANTICS } from '../../packages/contracts/dist/index.js';
function makeAgent(limits={}) {
  return {id:newAgentId(),name:'hermes-source-repro',description:'offline research',mode:'primary',model:{providerId:'scripted',modelId:'scripted-model'},systemPrompt:'help',tools:{},permissions:{rules:[]},skills:{},limits};
}
async function steeringCase() {
  const agent=makeAgent(), store=new MemorySessionStore(), events=new MemoryEventStore();
  const requests=[]; let count=0, consumed=false;
  const provider={id:'scripted',createClient(){return {async *generate(input){
    requests.push({call:count+1,steerVisible:JSON.stringify(input).includes('DO_NOT_TOUCH_CONFIG'),userMessages:input.messages.filter(m=>m.role==='user').length,modelMessages:input.messages.length});
    const result=count++<5 ? {finishReason:'tool_calls',toolCalls:[{id:newToolCallId(),name:'read_file',args:{path:`file${count}.txt`}}]} : {finishReason:'stop',text:'done'};
    yield {type:'completed',result,timestamp:0};
  }}}};
  const inbox={async listPending(){return consumed?[]:[{id:'steer-one',kind:'steer',text:'DO_NOT_TOUCH_CONFIG',status:'pending'}]},async markPromoted(){},async markConsumed(){consumed=true}};
  const runtime=new AgentRuntime({store,events,modelProvider:provider,orchestrator:new FakeOrchestrator({status:'success',output:'x'.repeat(1800)}),agents:[agent],toolRegistry:defaultTestToolCatalog(),permissiveToolResolution:true,inbox,toolSemanticsOf:()=>({...DEFAULT_TOOL_SEMANTICS,readOnly:true,retrySafety:'safe'}),context:{pipeline:new ContextPipeline({discovery:{async discover(){return []}}}),budget:{maxTokens:1600,reserved:{system:0,task:0,output:0},dynamic:0}}});
  const session=await runtime.createSession({agent,cwd:process.cwd()}), turn=await runtime.startTurn(session.id,'Review and modify code');
  const outcome=await runtime.runTurn(session.id,turn.id,new AbortController().signal);
  return {case:'steer-survival-after-history-trim',outcome:outcome.status,requests,steerDurable:store.messages.some(m=>m.promptId==='steer-one'),digests:store.messages.filter(m=>m.content.includes('message history trimmed')).length,allDigestsPreserveSteer:store.messages.filter(m=>m.content.includes('message history trimmed')).every(m=>m.content.includes('DO_NOT_TOUCH_CONFIG'))};
}
async function memoryCase(shouldAbort) {
  const agent=makeAgent({maxDurationMs:5}), store=new MemorySessionStore(), events=new MemoryEventStore();
  let entered,release; const reached=new Promise(r=>entered=r);
  const runtime=new AgentRuntime({store,events,modelProvider:new ScriptedModelProvider([ScriptedModelProvider.text('done')]),orchestrator:new FakeOrchestrator(),agents:[agent],toolRegistry:defaultTestToolCatalog(),memoryBlocks:async()=>{entered();return await new Promise(r=>release=r);}});
  const session=await runtime.createSession({agent,cwd:process.cwd()}), turn=await runtime.startTurn(session.id,'do task'), controller=new AbortController();
  const run=runtime.runTurn(session.id,turn.id,controller.signal); await reached;
  if(shouldAbort)controller.abort();
  const statusAfter50ms=await Promise.race([run.then(r=>r.status),new Promise(r=>setTimeout(()=>r('STILL_PENDING'),50))]);
  const result={case:shouldAbort?'pre-turn-memory-abort':'pre-turn-memory-duration',maxDurationMs:5,statusAfter50ms,storedTurnStatus:(await store.getTurn(turn.id)).status,modelCalls:events.events.filter(e=>e.type==='model.started').length};
  release([]);result.statusAfterRelease=(await run).status;return result;
}
const results=[await steeringCase(),await memoryCase(false),await memoryCase(true)];
console.log(JSON.stringify({targetSource:'acf8dcc394de6c6efefed52602e49014b372f372',results},null,2));
