import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness } from '../../../packages/harness/dist/index.js';
import { newToolCallId } from '../../../packages/contracts/dist/index.js';

const results = [];
for (const maxTokens of [140, 160, 180, 200, 220, 300]) {
  const cwd = await mkdtemp(join(tmpdir(), 'ar-followup-context-audit-'));
  await writeFile(join(cwd, 'big.txt'), 'ordinary data '.repeat(400));
  const path = 'selected-' + 'a'.repeat(170) + '.txt';
  const requests = [], builds = [];
  const calls = [{ id: newToolCallId(), name: 'write_file', args: {path, content: 'small'} }, { id: newToolCallId(), name: 'read_file', args: {path:'big.txt'} }];
  const provider = { id:'context-budget-audit', listModels:async()=>[{id:'scripted',capabilities:{contextWindowTokens:128000}}], createClient:()=>({async *generate(request){
    requests.push(request);
    yield {type:'started',timestamp:0};
    if (requests.length === 1) {
      for (const toolCall of calls) yield {type:'tool_call_delta',toolCall,timestamp:0};
      yield {type:'completed',result:{finishReason:'tool_calls',toolCalls:calls},timestamp:0};
    } else yield {type:'completed',result:{finishReason:'stop',text:'done'},timestamp:0};
  }})};
  let harness;
  try {
    harness = await createHarness({cwd,profile:'test',modelProvider:provider,model:{providerId:provider.id,modelId:'scripted'},contextBudget:{maxTokens,reserved:{system:0,task:0,output:0},dynamic:0}});
    const build = harness.context.pipeline.build.bind(harness.context.pipeline);
    harness.context.pipeline.build = async opts => {const out=await build(opts);builds.push({budget:opts.budget,summaryOverride:opts.summaryOverride,prior:opts.priorBlocks.map(b=>({id:b.id,tokens:b.tokens,source:b.source})),out});return out;};
    const agent={...harness.agents[0],systemPrompt:'sys'};
    const session=await harness.runtime.createSession({agent,cwd});
    const turn=await harness.runtime.startTurn(session.id,'continue');
    const outcome=await harness.runtime.runTurn(session.id,turn.id,new AbortController().signal);
    const events=await harness.events.list(session.id);
    results.push({maxTokens,outcome,requests,builds,events});
  } finally {await harness?.close();await rm(cwd,{recursive:true,force:true});}
}
process.stdout.write(JSON.stringify(results,null,2)+'\n');
