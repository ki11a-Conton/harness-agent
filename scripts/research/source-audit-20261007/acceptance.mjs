// Post-fix acceptance: exit 0 means the expected safe behavior was observed.
// Real files/runtime are used; no paid provider is used.
// Rebuild the checkout first. Results go to HARNESS_SOURCE_AUDIT_OUT or .ci/source-audit-20261007.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, stat, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { newWorkingState, newAgentId, newSessionId, newApprovalId, newMemoryId, errorInfo } from '../../../packages/contracts/dist/index.js';
import { Delegator, AgentExecutionScheduler, scopedContextFromWorkingState } from '../../../packages/agents/dist/index.js';
import { MemSessionStore, MemEventStore, DefaultChildWorkspaceManager, applyChildResult, createHarness, defaultSandboxPolicy } from '../../../packages/harness/dist/index.js';
import { AgentRuntime } from '../../../packages/core/dist/index.js';
import { ScriptedModelProvider } from '../../../packages/model/dist/index.js';
import { ToolRegistry, execTool, TaskVerifier } from '../../../packages/tools/dist/index.js';
import { DurableApprovalStore } from '../../../packages/security/dist/index.js';
import { getArmFactory, computeSnapshotDigest } from '../../../packages/evaluation/dist/index.js';
import { execFileSync } from 'node:child_process';
import { jsonSchemaToZod } from '../../../packages/mcp/dist/index.js';
import { writeJson } from '../../../scripts/research/agent-next7-20261006/execution-common.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const sourceSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
const outputDir = resolve(process.env.HARNESS_SOURCE_AUDIT_OUT ?? join(repo, '.ci', 'source-audit-20261007'));
await mkdir(outputDir, {recursive:true});
const root = await mkdtemp(join(tmpdir(), 'harness-source-audit-'));
const records = [];
async function check(id, fn) {
  try { const observed = await fn(); records.push({ id, passed: true, observed }); }
  catch (error) { records.push({ id, passed: false, error: error.stack }); }
}
const signal = new AbortController().signal;
const child = overrides => ({ status:'success',summary:'done',childSessionId:newSessionId(),toolCalls:0,durationMs:0,evidence:[],artifacts:[],answer:'done',findings:[],changedArtifacts:[],testsRun:[],openQuestions:[],blockers:[],suggestedNextActions:[],budgetUsed:{toolCalls:0,durationMs:0},verified:false,...overrides });
function agent() { return {id:newAgentId(),name:'audit-child',description:'audit',mode:'primary',model:{providerId:'scripted',modelId:'scripted-model'},systemPrompt:'audit',tools:{},permissions:{rules:[]},skills:{},limits:{}}; }
class FilteredStore extends MemSessionStore {
  async listSessions(opts={}) { return (await super.listSessions()).filter(s => (opts.parentId===undefined || s.parentId===opts.parentId) && (opts.status===undefined || s.status===opts.status)); }
}
function runtime(store, scripts=[ScriptedModelProvider.text('done')], orchestrator) {
  const registry = new ToolRegistry(); registry.register(execTool);
  const a=agent(); const events=new MemEventStore();
  const rt=new AgentRuntime({store,events,agents:[a],modelProvider:new ScriptedModelProvider(scripts),toolRegistry:registry,permissiveToolResolution:true,orchestrator:orchestrator ?? {executeBound:async()=>({status:'success',output:'ok'}),execute:async()=>({status:'success',output:'ok'})}});
  return {rt,a,events};
}
try {
  await check('B01-scoped-entry-budget',async()=>{
    const s=newWorkingState('goal'); for(const k of ['plan','decisions'])s[k]=Array.from({length:30},(_,i)=>`${k}-${i}`);
    const b=scopedContextFromWorkingState(s,{maxEntries:20}); const entries=b.reduce((n,v)=>n+v.content.split('\n').length-1,0);
    assert.equal(entries,20); return {maxEntries:20,actualEntries:entries,blocks:b.length};
  });
  await check('B02-scoped-constraint-truncation',async()=>{
    const s=newWorkingState('DO NOT DELETE protected-marker'); assert.throws(()=>scopedContextFromWorkingState(s,{maxBlockChars:8}), /complete Goal/); const b=scopedContextFromWorkingState(s,{maxBlockChars:100}); assert(b[0].content.includes(s.goal)); return {original:s.goal,forwarded:b[0].content,oversizeRejected:true};
  });
  await check('B03-added-file-overwrite',async()=>{
    const parent=join(root,'add-conflict'); await mkdir(parent); const manager=new DefaultChildWorkspaceManager(); const h=await manager.create({parentRoot:parent,childSessionId:newSessionId(),writable:true});
    await writeFile(join(h.root,'new.txt'),'child'); const patch=await h.diff(); await h.dispose();
    await writeFile(join(parent,'new.txt'),'parent'); const out=await manager.apply(parent,patch); const actual=await readFile(join(parent,'new.txt'),'utf8');
    assert.equal(actual,'parent'); assert.equal(out.conflicts.length,1); return {parentBefore:'parent',parentAfter:actual,result:out};
  });
  await check('B04-binary-patch-corruption',async()=>{
    const parent=join(root,'binary'); await mkdir(parent); const manager=new DefaultChildWorkspaceManager(); const h=await manager.create({parentRoot:parent,childSessionId:newSessionId(),writable:true});
    const expected=Buffer.from([0,255,254,128,65]); await writeFile(join(h.root,'image.bin'),expected); const patch=await h.diff(); await h.dispose(); await manager.apply(parent,patch);
    const actual=await readFile(join(parent,'image.bin')); assert.deepEqual(actual,expected); const sha=b=>createHash('sha256').update(b).digest('hex');
    return {expectedHex:expected.toString('hex'),actualHex:actual.toString('hex'),recordedHash:patch.entries[0].contentHash,actualHash:sha(actual)};
  });
  await check('B05-executable-mode-lost',async()=>{
    const parent=join(root,'mode'); await mkdir(parent); await writeFile(join(parent,'test.sh'),'#!/bin/sh\nexit 0\n'); await chmod(join(parent,'test.sh'),0o755);
    const manager=new DefaultChildWorkspaceManager(); const h=await manager.create({parentRoot:parent,childSessionId:newSessionId(),writable:true});
    const before=(await stat(join(parent,'test.sh'))).mode&0o777, after=(await stat(join(h.root,'test.sh'))).mode&0o777; await h.dispose();
    assert.equal(after,before); return {parentMode:before.toString(8),childMode:after.toString(8)};
  });
  await check('B06-physical-conflict-false-metadata',async()=>{
    const parent=join(root,'metadata'); await mkdir(parent); await writeFile(join(parent,'a.txt'),'old'); const manager=new DefaultChildWorkspaceManager(); const h=await manager.create({parentRoot:parent,childSessionId:newSessionId(),writable:true});
    await writeFile(join(h.root,'a.txt'),'child'); const patch=await h.diff(); await h.dispose(); await writeFile(join(parent,'a.txt'),'parent');
    const state=newWorkingState('parent'); const out=await applyChildResult(parent,state,child({workspacePatch:patch,changedArtifacts:[{path:'a.txt',sourceRef:'working-state'}]}),manager);
    assert.equal(out.physical.applied.length,0); assert(!state.filesChanged.includes('a.txt')); assert(!out.metadata.mergedPaths.includes('a.txt'));
    return {physical:out.physical,parentFilesChanged:state.filesChanged,claimedMerged:out.metadata.mergedPaths};
  });
  await check('B07-memory-session-filter-ignored',async()=>{
    const store=new MemSessionStore(); const {rt,a}=runtime(store); const parent=await rt.createSession({agent:a,cwd:root});
    const returned=await store.listSessions({parentId:parent.id}); assert.equal(returned.length,0);
    const d=new Delegator({runtime:rt,store,agentId:a.id,limits:{maxActiveChildren:1,timeoutMs:1000}});
    const out=await d.delegate({parentSessionId:parent.id,goal:'read'},signal); assert.equal(out.status,'success'); return {matchingChildCount:returned.length,childStatus:out.status};
  });
  await check('B08-scheduler-reservation-leak',async()=>{
    const store=new FilteredStore(); const {rt,a}=runtime(store); const parent=await rt.createSession({agent:a,cwd:root}); const scheduler=new AgentExecutionScheduler({store});
    scheduler.setRootBudget(parent.id,{maxToolCalls:100,maxTokens:1}); const before=scheduler.treeBudgetRemaining(parent.id);
    await assert.rejects(()=>scheduler.acquire({parentSessionId:parent.id,agentId:a.id,toolBudget:10},signal),/token budget exhausted/);
    const after=scheduler.treeBudgetRemaining(parent.id); assert.equal(before.remaining,after.remaining); assert.equal(scheduler.snapshot().length,0);
    return {before,after,runningOrQueued:0};
  });
  await check('B09-delegator-initialization-resource-leak',async()=>{
    const store=new FilteredStore(); const {rt,a,events}=runtime(store); const parent=await rt.createSession({agent:a,cwd:root}); const scheduler=new AgentExecutionScheduler({store,limits:{maxGlobalAgents:1,maxAgentsPerRoot:1,maxDurationMs:0}});
    const manager=new DefaultChildWorkspaceManager(); let disposed=false, workspaceRoot, admitted=false;
    const wrapper={create:async input=>{const h=await manager.create(input);workspaceRoot=h.root;return {...h,root:h.root,mode:h.mode,diff:()=>h.diff(),dispose:async()=>{disposed=true;await h.dispose();}};},apply:(...args)=>manager.apply(...args)};
    const d=new Delegator({runtime:rt,store,events,agentId:a.id,scheduler,workspaceManager:wrapper,onChildWorkspace:()=>{admitted=true;},onChildWorkspaceDisposed:()=>{admitted=false;}});
    store.appendMessage=async()=>{throw new Error('audit: disk full during context seed');};
    await assert.rejects(()=>d.delegate({parentSessionId:parent.id,goal:'read',writable:true,context:[{id:'ctx',source:'system',trust:'trusted',priority:1,tokens:1,content:'seed',compressible:false,ephemeral:false}]},signal),/disk full/);
    const snapshot=scheduler.snapshot(); assert.equal(snapshot.length,0); assert.equal(disposed,true); assert.equal(admitted,false);
    const children=await store.listSessions({parentId:parent.id}); const observed={schedulerEntries:snapshot.map(s=>({state:s.state,parentSessionId:s.parentSessionId})),workspaceDisposed:disposed,sandboxRootStillAdmitted:admitted,childStatus:children[0].status};
    scheduler.cancelSubtree(parent.id); if(workspaceRoot)await rm(workspaceRoot,{recursive:true,force:true}); return observed;
  });
  await check('B10-failed-test-reported-passed',async()=>{
    const store=new FilteredStore(); const failure={status:'failed',output:{exitCode:1,stdout:'',stderr:'test failed'},error:errorInfo('PROCESS_ERROR','exit code 1',{retryable:false,safeToRetry:false})};
    const orch={executeBound:async()=>failure,execute:async()=>failure};
    const {rt,a,events}=runtime(store,[ScriptedModelProvider.toolCall('exec',{command:'npm test'}),ScriptedModelProvider.text('stopped after failure')],orch);
    const parent=await rt.createSession({agent:a,cwd:root}); const d=new Delegator({runtime:rt,store,events,agentId:a.id,workspaceManager:new DefaultChildWorkspaceManager(),limits:{timeoutMs:1000}});
    const out=await d.delegate({parentSessionId:parent.id,goal:'test',writable:true},signal); const test=out.testsRun.find(t=>t.description==='npm test'); assert.equal(test?.passed,false); assert(out.workingState.failures.includes('exec: exit code 1')); assert(test.sourceRef);
    return {childStatus:out.status,workingFailures:out.workingState.failures,reportedTest:test};
  });
  await check('B11-mcp-optional-field-rejected',async()=>{
    const schema=jsonSchemaToZod({type:'object',properties:{name:{type:'string'},count:{type:'integer'}},required:['name'],additionalProperties:false});
    const valid={name:'sample'}; const result=schema.safeParse(valid); assert.equal(result.success,true); assert.equal(schema.safeParse({}).success,false); return {validJsonSchemaInput:valid,accepted:result.success};
  });
  await check('B12-mcp-integer-constraint-ignored',async()=>{
    const schema=jsonSchemaToZod({type:'object',properties:{count:{type:'integer',minimum:1}},required:['count'],additionalProperties:false});
    assert.equal(schema.safeParse({count:0.5}).success,false); assert.equal(schema.safeParse({count:0}).success,false); assert.equal(schema.safeParse({count:1}).success,true); return {invalidJsonSchemaInput:{count:0.5},accepted:false};
  });
  await check('B13-crashed-campaign-unresumable',async()=>{
    const { startAttempt, recordCheckpoint, validateResumeAttempts, sealRecoveredAttempt } = await import('../agent-next7-20261006/attempt-checkpoint.mjs');
    const dir=join(root,'interrupted-campaign');const attempt=join(dir,'attempts','0001');await mkdir(attempt,{recursive:true});await mkdir(join(dir,'requests'));const header={campaignDigest:'audit-bound-identity'};writeJson(join(dir,'campaign-header.json'),header);
    startAttempt(dir,attempt,header);writeJson(join(dir,'requests','0001.json'),{requestId:1,status:'committed'});recordCheckpoint(dir,attempt);
    assert.equal(validateResumeAttempts(dir,header),attempt);await writeFile(join(dir,'requests','0001.json'),'tampered');assert.throws(()=>validateResumeAttempts(dir,header),/UNCHECKPOINTED/);await writeFile(join(dir,'requests','0001.json'),JSON.stringify({requestId:1,status:'committed'},null,2)+'\n');sealRecoveredAttempt(dir,attempt,header);assert.equal(validateResumeAttempts(dir,header),undefined);return {openAttemptRecovered:true,tamperingRejected:true,sealedWithoutFakeCompletion:true};
  });
  await check('B16-verification-command-bypasses-sandbox',async()=>{
    const workspace=join(root,'verification-workspace');await mkdir(workspace);const marker=join(root,'outside-verification-workspace.txt');
    const base=defaultSandboxPolicy();const policy={...base,filesystem:{...base.filesystem,mode:'read-only'},process:{...base.process,confinement:'strong'},network:{mode:'deny'}};
    const h=await createHarness({cwd:workspace,profile:'test',model:{providerId:'scripted',modelId:'scripted-model'},modelProvider:new ScriptedModelProvider([ScriptedModelProvider.text('complete')]),sandboxPolicy:policy,task:{id:'audit-verification',goal:'verify',verification:[{kind:'command',command:process.execPath,args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'verifier escaped')`]}]}});
    // Set the real AgentDefinition owned by Runtime before creating/freezing
    // the session; HarnessConfig has no permissions override field.
    h.agents[0].permissions={rules:[{action:'exec',resource:'command',effect:'deny'}],defaultEffect:'deny'};
    assert.equal(h.runtime.getAgent(h.agents[0].id).permissions.rules[0].effect,'deny');
    try {const session=await h.runtime.createSession({agent:h.agents[0],cwd:workspace});const turn=await h.runtime.startTurn(session.id,'verify');const out=await h.runtime.runTurn(session.id,turn.id,signal);await assert.rejects(()=>readFile(marker),{code:'ENOENT'});const events=await h.events.list(session.id,{});
      assert.equal(out.status,'failed');assert.equal(events.filter(e=>e.type==='tool.started').length,0);
      return {requestedConfinement:'strong',filesystemPolicy:'read-only',execPermission:'deny',outsideFileCreated:false,toolStartedEvents:0,turnStatus:out.status,terminationReason:out.terminationReason};
    }finally{await h.close();}
  });
  await check('B17-approval-persist-failure-still-allows',async()=>{
    const dir=join(root,'approval');await mkdir(dir);const path=join(dir,'approvals.json');const store=new DurableApprovalStore(path);const request={id:newApprovalId(),sessionId:newSessionId(),agentId:newAgentId(),action:'exec',target:'audit-only',reason:'audit',createdAt:Date.now(),expiresAt:Date.now()+10000};
    const entry=store.create(request);const ac=new AbortController();let released;const waiting=entry.wait(ac.signal).then(d=>{released=d;return d;});await mkdir(path+'.tmp');let failure;
    try{store.resolve(request.id,'allow','audit-user');}catch(e){failure=e;}
    assert.equal(failure?.code,'EISDIR');await Promise.resolve();await Promise.resolve();assert.equal(released,undefined);assert.equal(store.listPending().length,1);const disk=JSON.parse(await readFile(path,'utf8'));assert.equal(disk.decisions.length,0);await rm(path+'.tmp',{recursive:true});store.resolve(request.id,'allow','audit-user');assert.equal((await waiting).value,'allow');const saved=JSON.parse(await readFile(path,'utf8'));assert.equal(saved.decisions.length,1);assert.equal(saved.pending.length,0);return {persistFailureDidNotRelease:true,pendingPreserved:true,retryDurablyGranted:true};
  });
  await check('B18-repository-memory-cross-contamination',async()=>{
    const a=join(root,'repo-a'),b=join(root,'repo-b');await mkdir(a);await mkdir(b);for(const dir of [a,b])execFileSync('git',['init','--quiet',dir]);
    execFileSync('git',['-C',a,'remote','add','origin','https://example.invalid/project-a.git']);execFileSync('git',['-C',b,'remote','add','origin','https://example.invalid/project-b.git']);
    const data=join(root,'shared-memory');const cfg=cwd=>({cwd,dataDir:data,profile:'test',model:{providerId:'scripted',modelId:'scripted-model'},modelProvider:new ScriptedModelProvider([]),memory:{enabled:true}});
    const first=await createHarness(cfg(a));const id=newMemoryId();
    await first.memoryStore.write({id,content:'Project A audit policy uses a unique deployment channel',type:'explicit',sourceSession:newSessionId(),importance:1,confidence:1,novelty:1,stability:1,scope:'repository',createdAt:Date.now(),updatedAt:Date.now(),deleted:false});await first.close();
    const second=await createHarness(cfg(b));try{const result=await second.memoryBridge.retrieve({sessionId:newSessionId(),goal:'unique deployment channel',cwd:b,recordFeedback:false});assert(!result.items.some(i=>i.memory.id===id));return {sourceRepository:'project-a',queryRepository:'project-b',sharedDataDirectory:true,foreignRepositoryMemoryReturned:false};}finally{await second.close();}
  });
  await check('B19-cancel-during-verification-is-completed',async()=>{
    const workspace=join(root,'cancel-verification');await mkdir(workspace);const marker=join(workspace,'after-cancel.txt');const ac=new AbortController();
    const verifier=new TaskVerifier({onStep:e=>{if(e.phase==='started')ac.abort();}});
    const h=await createHarness({cwd:workspace,profile:'test',model:{providerId:'scripted',modelId:'scripted-model'},modelProvider:new ScriptedModelProvider([ScriptedModelProvider.text('complete')]),verification:{verifier},task:{id:'audit-cancel',goal:'verify',verification:[{kind:'command',command:process.execPath,args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran after abort')`]}]}});
    try{const session=await h.runtime.createSession({agent:h.agents[0],cwd:workspace});const turn=await h.runtime.startTurn(session.id,'verify');const out=await h.runtime.runTurn(session.id,turn.id,ac.signal);assert.equal(ac.signal.aborted,true);await assert.rejects(()=>readFile(marker),{code:'ENOENT'});assert.equal(out.status,'cancelled');return {signalAborted:true,commandExecutedAfterAbort:false,turnStatus:out.status,terminationReason:out.terminationReason};}finally{await h.close();}
  });
  await check('B20-baseline-identity-depends-on-inactive-candidate',async()=>{
    const factory=getArmFactory();const current=factory.resolveArm(null);const priorActivations=current.mechanisms.activations.filter(m=>m.mechanism!=='verified_completion_gate_v1');const {digest:ignored,...snapshot}=current;
    const prior={...snapshot,mechanisms:{...snapshot.mechanisms,activations:priorActivations}};const digestWithoutUninstalledGate=computeSnapshotDigest(prior);
    assert.equal(current.digest,digestWithoutUninstalledGate);return {currentDigest:current.digest,digestWithoutUninstalledGate,installedGuidanceDigest:current.promptAdditionsDigest,baselineConfigUnchanged:true,inactiveGateChangesIdentity:false,note:'remove only the newly registered OFF activation from the real resolved snapshot'};
  });
  await check('B21-memory-store-drops-frozen-tool-policy',async()=>{
    const store=new MemSessionStore();let executed=0;const orch={executeBound:async()=>{executed++;return {status:'success',output:'ok'};},execute:async()=>{executed++;return {status:'success',output:'ok'};}};
    const {rt,a,events}=runtime(store,[ScriptedModelProvider.toolCall('exec',{command:'audit-command'}),ScriptedModelProvider.text('done')],orch);
    const parent=await rt.createSession({agent:a,cwd:root});const d=new Delegator({runtime:rt,store,events,agentId:a.id,limits:{timeoutMs:1000}});
    const out=await d.delegate({parentSessionId:parent.id,goal:'read only',toolPolicy:{allow:['read_file']},writable:false},signal);
    assert.equal(executed,0);assert(await store.loadStateSnapshot(out.childSessionId));
    return {requestedChildToolAllow:['read_file'],executedDisallowedExec:executed,frozenSessionSnapshotRetained:true,childStatus:out.status,note:'real AgentRuntime + real exported MemSessionStore; orchestrator capture has no side effect'};
  });
} finally { await rm(root,{recursive:true,force:true}); }
await writeFile(join(outputDir, 'acceptance-results.json'),JSON.stringify({sourceSha,kind:'post-fix-acceptance',paidProviderCalls:0,records},null,2)+'\n');
console.log(JSON.stringify(records,null,2));
process.exitCode=records.some(r=>!r.passed)?1:0;
