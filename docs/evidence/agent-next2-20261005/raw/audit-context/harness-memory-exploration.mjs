import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness } from '../../../packages/harness/dist/index.js';
import { newMemoryId, newSessionId } from '../../../packages/contracts/dist/index.js';
const results = [];
for (const maxTokens of [155, 160, 165, 170, 180, 220]) {
  const cwd = await mkdtemp(join(tmpdir(), 'ar-memory-context-audit-'));
  const requests=[],builds=[];
  const provider={id:'context-audit',listModels:async()=>[{id:'scripted',capabilities:{contextWindowTokens:128000}}],createClient:()=>({async *generate(request){requests.push(structuredClone(request));yield {type:'started',timestamp:0};yield {type:'completed',result:{finishReason:'stop',text:'done'},timestamp:0};}})};
  let h;
  try {
    h=await createHarness({cwd,dataDir:join(cwd,'data'),profile:'test',modelProvider:provider,model:{providerId:provider.id,modelId:'scripted'},memory:{enabled:true,scope:'workspace'},featureFlags:{skills:false,mcp:false,delegation:false,learning:false},contextBudget:{maxTokens,reserved:{system:0,task:0,output:0},dynamic:0}});
    const stamp=Date.now();
    for(const content of ['continue useful hint', 'continue detailed '+ 'other '.repeat(1000)]) await h.memoryStore.write({id:newMemoryId(),sourceSession:newSessionId(),content,type:'procedural',importance:0.9,confidence:0.9,novelty:0.5,stability:0.6,createdAt:stamp,updatedAt:stamp,deleted:false,scope:'global'});
    const build=h.context.pipeline.build.bind(h.context.pipeline);
    h.context.pipeline.build=async opts=>{const input=structuredClone(opts);const out=await build(opts);builds.push({input,out:structuredClone(out)});return out;};
    const session=await h.runtime.createSession({agent:h.agents[0],cwd});
    const turn=await h.runtime.startTurn(session.id,'continue');
    const outcome=await h.runtime.runTurn(session.id,turn.id,new AbortController().signal);
    results.push({maxTokens,outcome,requests,builds,events:await h.events.list(session.id)});
  } finally {await h?.close();await rm(cwd,{recursive:true,force:true});}
}
process.stdout.write(JSON.stringify(results,null,2)+'\n');
