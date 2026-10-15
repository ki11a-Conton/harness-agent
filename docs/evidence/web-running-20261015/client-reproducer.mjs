import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
const path='/workspace/harness-agent-models-merge-20261015/apps/web/public/deepseek/plugins/dsh-api-session-controller/client.js';
const raw=await readFile(path,'utf8');
let exports;
const source=raw.replace('exports.MutableSessionEventSource = MutableSessionEventSource;','exports.__inspectSessionManager = SessionManager;\nexports.MutableSessionEventSource = MutableSessionEventSource;');
assert.notEqual(source,raw);
const dependencies={
 '@deepseek-ai/cordis':{Context:{filter:Symbol('filter')}},
 '@deepseek-ai/dsh-api-gateway/client':{RemoteJournalStream:class{},RemoteStreamCarrierError:class extends Error{},isRemoteFailure:()=>false},
 '@deepseek-ai/dsh-client-store':{notifySubscribers:listeners=>{for(const listener of listeners)listener();}},
};
runInNewContext(source,{window:{__ModuleLoader__:{load:({factory})=>{exports=factory(name=>{assert(name in dependencies,name);return dependencies[name];});}}},queueMicrotask,AbortController,console,setTimeout,clearTimeout,structuredClone});
const id='session_exact_running_transition';
const summary={sessionId:id,agentAvailable:true,blank:false,running:true,updatedAt:1,cwd:'/project'};
const manager=new exports.__inspectSessionManager({session:{list:async()=>({ok:true,value:{items:[summary]}})}});
await manager.refreshList();
const resident=manager.get(id);
assert.equal(resident.getSnapshot().running,true);
manager.handleSessionAdded({...summary,running:false});
await Promise.resolve();
const afterAdded=resident.getSnapshot().running;
assert.equal(afterAdded,true,'The original backend notification does not clear the resident running bit');
manager.handleSessionStatus(id,false);
await Promise.resolve();
const afterStatus=resident.getSnapshot().running;
assert.equal(afterStatus,false,'The protocol status notification clears the same actual client state');
const result={sourceSha:'847e245228ffb24fce6eb99400a8f04b5f302b4f',clientBundleSha256:createHash('sha256').update(raw).digest('hex'),runningAfterInitialList:true,runningAfterAddedFalse:afterAdded,runningAfterStatusFalse:afterStatus,actualPackagedClient:true,scope:'Only an in-memory diagnostic export is added; production state handlers are unchanged. Cold session does not open history streams; unused infrastructure dependencies are inert.'};
await writeFile('/tmp/harness-ui-running-rootcause-20261015/client-reproducer.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
await manager.dispose();
