const stage = process.argv[2];
if (!["normal", "before", "after"].includes(stage)) throw new Error("Unknown terminal observer scenario");
const paths = {
  harness: new URL("../../../packages/harness/dist/index.js", import.meta.url).href,
  model: new URL("../../../packages/model/dist/index.js", import.meta.url).href,
  composition: new URL("../dist/deepseek/composition.js", import.meta.url).href,
  server: new URL("../dist/server.js", import.meta.url).href,
  adapter: new URL("../dist/adapter.js", import.meta.url).href,
  bindings: new URL("../dist/bindings.js", import.meta.url).href,
};
const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');
const { randomUUID } = await import('node:crypto');
const { createHarness } = await import(paths.harness);
const { ScriptedModelProvider } = await import(paths.model);
const { createDeepseekComposition } = await import(paths.composition);
const { WebServer } = await import(paths.server);
const { WebChannelAdapter } = await import(paths.adapter);
const { SessionBindings } = await import(paths.bindings);
const trace = [], roots = [];
let first, composition, server, report;
const within = async (promise, label, milliseconds=4000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer=setTimeout(()=>reject(new Error(label+' did not settle')), milliseconds); })]); }
  finally { clearTimeout(timer); }
};
const until = async (test, label) => {
  const deadline=Date.now()+4000;
  while(Date.now()<deadline){if(await test())return;await new Promise(resolve=>setTimeout(resolve,5));}
  throw new Error(label+' did not settle');
};
let emitted=false;
const emit = value => { if(!emitted){emitted=true;console.log('TERMINAL_OBSERVER_RECEIPT '+JSON.stringify(value));} };
const watchdog=setTimeout(()=>{emit({status:'FAIL',stage,reason:'isolated host watchdog',trace});process.exit(1)},12000);
try {
  const cwd=await mkdtemp(join(tmpdir(),'harness-observer-http-'));roots.push(cwd);
  await writeFile(join(cwd,'demo.js'),'export const before = 1;\n');
  const provider=new ScriptedModelProvider([
    ScriptedModelProvider.toolCall('write_file',{path:'generated.txt',content:'actual controlled write\n'}),
    ScriptedModelProvider.text('first actual answer'),ScriptedModelProvider.text('next actual answer'),
  ]);
  let models=0;
  const client=provider.createClient.bind(provider);
  provider.createClient=(...args)=>{const actual=client(...args);return {generate:async function*(...params){models++;yield* actual.generate(...params);}}};
  first=await createHarness({cwd,profile:'interactive',modelProvider:provider,model:{providerId:provider.id,modelId:'scripted-model'}});
  composition=await createDeepseekComposition(first);
  server=new WebServer({adapter:new WebChannelAdapter(),bindings:new SessionBindings(),events:first.events,store:first.store,
    approvalStore:first.approvalStore,deepseekServices:composition.services,deepseekHttp:composition.http,host:'127.0.0.1',port:0});
  const {port}=await server.start(),origin='http://127.0.0.1:'+port;
  const rpc=async(endpoint,args)=>{
    const response=await fetch(origin+'/api/deepseek/call',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({requestId:randomUUID(),endpoint,args}),signal:AbortSignal.timeout(4000)});
    const value=await response.json();if(!value.ok)throw new Error(endpoint+': '+JSON.stringify(value.error));return value.value;
  };
  const {sessionId}=await rpc('session/create',{request:{}});
  const owner=await composition.owners.ownerOf(sessionId), runs=[];
  const run=owner.runtime.runTurn.bind(owner.runtime);
  owner.runtime.runTurn=(...args)=>{
    const entry={settled:false};runs.push(entry);
    return run(...args).then(value=>{Object.assign(entry,{settled:true,status:value.status});return value},error=>{Object.assign(entry,{settled:true,error:error.message});throw error});
  };
  const append=owner.events.appendNew.bind(owner.events);let fault=stage!=='normal',terminalAwaiting=false;
  owner.events.appendNew=async event=>{
    const terminal=['turn.completed','turn.failed','turn.cancelled'].includes(event.type);
    if(terminal&&fault&&stage==='before'){fault=false;trace.push('injected before commit');throw new Error('terminal publication before commit');}
    if(terminal){terminalAwaiting=true;trace.push('terminal observer entered');}
    const committed=await append(event);
    if(terminal){terminalAwaiting=false;trace.push('terminal observer completed');}
    if(terminal&&fault&&stage==='after'){fault=false;trace.push('injected after commit');throw new Error('terminal publication after commit');}
    return committed;
  };
  await rpc('session/prompt',{request:{sessionId,requestId:'first-http-task',mode:'queue',content:[{type:'text',text:'write generated.txt'}]}});
  await until(()=>owner.approvalStore.listPending().length===1,'actual write approval');
  owner.approvalStore.resolve(owner.approvalStore.listPending()[0].id,'allow','local-http-regression');
  await until(()=>runs[0]?.settled,'first actual actor result');
  if(stage==='normal'&&runs[0].status!=='completed')throw new Error('normal turn did not complete');
  if(stage!=='normal'&&!runs[0].error?.includes('terminal publication '+stage+' commit'))throw new Error('fault did not reach actual actor result');
  if(await readFile(join(cwd,'generated.txt'),'utf8')!=='actual controlled write\n')throw new Error('controlled write missing');
  const modelsBeforeRepair=models;
  const nativeId=composition.owners.nativeSessionId(sessionId);
  // Retain the public full lookup's cold repair contract. Its observer must
  // authorize capture through a policy-only lookup without reentering repair.
  await within(owner.runtime.getSessionAgent(nativeId),'cold terminal repair');
  const policy=await within(composition.harness.runtime.getSessionAgentPolicy(sessionId),'stable owner policy lookup');
  if(policy.id!==(await owner.runtime.getSessionAgentPolicy(nativeId)).id)throw new Error('policy facade used the wrong owner');
  if(models!==modelsBeforeRepair)throw new Error('terminal repair sampled another model');
  const journal=await composition.harness.events.list(sessionId),turns=await composition.harness.store.listTurns(sessionId);
  const terminals=journal.filter(event=>event.turnId===turns[0].id&&['turn.completed','turn.failed','turn.cancelled'].includes(event.type));
  if(terminals.length!==1)throw new Error('terminal publication was lost or duplicated');
  const changes=journal.filter(event=>event.type==='tool.completed'&&event.payload.tool==='web_workspace_changes');
  if(changes.length!==1)throw new Error('actual comparison observer did not finish exactly once');
  const summary=composition.deliverables.summary(sessionId,changes[0].sequence);
  const diff=await composition.deliverables.diff(sessionId,changes[0].sequence,0,new AbortController().signal);
  if(summary?.files?.[0]?.path!=='generated.txt'||diff?.path!=='generated.txt'||diff.kind!=='text')throw new Error('actual changed-file diff missing');
  const renamed=await rpc('session/rename',{request:{sessionId,title:'after terminal observer'}});
  if(renamed.title!=='after terminal observer')throw new Error('rename did not reach production metadata');
  await rpc('session/prompt',{request:{sessionId,requestId:'next-http-task',mode:'queue',content:[{type:'text',text:'continue after completion'}]}});
  await until(()=>runs[1]?.settled,'next actual actor result');
  if(runs[1].status!=='completed')throw new Error('next task did not complete');
  const finalJournal=await composition.harness.events.list(sessionId);
  if(finalJournal.filter(event=>event.type==='tool.requested'&&event.payload.name==='write_file').length!==1)throw new Error('write request was lost or duplicated');
  const actor=await owner.sessions.load(nativeId);
  if(actor.status().activeTurn)throw new Error('actor retained an active turn');
  report={status:'PASS',stage,models,runs,terminals:terminals.length,changes:changes.length,summary,diff,terminalAwaiting,trace};
  await within(server.stop(),'actual HTTP host shutdown');server=undefined;
  await within(composition.close(),'actual composition shutdown');composition=undefined;
  await within(first.close(),'actual base shutdown');first=undefined;
  for(const path of roots)await rm(path,{recursive:true,force:true,maxRetries:8,retryDelay:50});
  clearTimeout(watchdog);emit(report);
} catch(error) {
  clearTimeout(watchdog);emit({status:'FAIL',stage,reason:error.message,trace});
  // The baseline self-deadlock cannot complete normal actor shutdown. This
  // isolated diagnostic process owns only memory stores and loopback listeners.
  for(const path of roots)await rm(path,{recursive:true,force:true,maxRetries:8,retryDelay:50}).catch(cleanupError=>console.error('Isolated fixture cleanup unavailable',path,cleanupError.message));
  process.exit(1);
}
