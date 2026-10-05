import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = resolve(process.argv[2] ?? '.');
const out = resolve(process.argv[3]);
const { JsonlMemoryStore, SqliteMemoryStore, retrieveMemories } = await import(pathToFileURL(join(root, 'packages/memory/dist/index.js')));
const { MemoryRuntimeBridge } = await import(pathToFileURL(join(root, 'packages/harness/dist/memory-runtime-bridge.js')));
const files = ['packages/harness/src/memory-runtime-bridge.ts','packages/harness/dist/memory-runtime-bridge.js','packages/memory/src/memory-store.ts','packages/memory/dist/memory-store.js','packages/memory/src/sqlite-memory-store.ts','packages/memory/dist/sqlite-memory-store.js'];
const result = { sourceSha: execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(), dirty: execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(), artifacts: [], cases: [], paidRequests: 0 };
for (const file of files) result.artifacts.push({file,sha256:createHash('sha256').update(await readFile(join(root,file))).digest('hex')});
function memory() { return {id:'memory_audit', content:'use memory-audit-needle to validate exact feedback', type:'procedural', sourceSession:'session_audit', scope:'workspace', importance:.9, confidence:.9, novelty:.9, stability:.9, createdAt:1, updatedAt:1, deleted:false}; }
for (const backend of ['jsonl','sqlite']) {
  const dataDir = await mkdtemp(join(tmpdir(),'harness-memory-feedback-audit-'));
  const store = backend==='jsonl'?new JsonlMemoryStore({dataDir}):new SqliteMemoryStore({dataDir});
  try {
    await store.write(memory());
    const bridge = new MemoryRuntimeBridge({store,scope:'workspace',now:()=>1});
    await Promise.all(Array.from({length:8},()=>bridge.recordInjected(['memory_audit'])));
    result.cases.push({name:'concurrent-feedback-count',backend, expectedInjectedCount:8, actualInjectedCount:(await store.get('memory_audit')).usefulness.injectedCount});
    await store.write(memory());
    let hooked = false;
    const wrapped = {get:async id=>{const snapshot=await store.get(id); if(!hooked){hooked=true; await store.remove(id);} return snapshot;}, update:entry=>store.update(entry), write:entry=>store.write(entry), search:(q,o)=>store.search(q,o), list:o=>store.list(o),remove:id=>store.remove(id)};
    const deletingBridge = new MemoryRuntimeBridge({store:wrapped,scope:'workspace',now:()=>1});
    await deletingBridge.recordInjected(['memory_audit']);
    const deleted = await store.get('memory_audit');
    const recalled = await retrieveMemories(store,'memory-audit-needle','workspace',{now:1});
    result.cases.push({name:'delete-between-feedback-read-and-write',backend, expectedDeleted:true, actualDeleted:deleted.deleted, expectedRecallCount:0, actualRecallCount:recalled.items.length, actualMemory:deleted});
    await store.write(memory());
    let edited=false;
    const editWrapper={...wrapped,get:async id=>{const snapshot=await store.get(id); if(!edited){edited=true;await store.update({...snapshot,content:'changed memory content preserved by user',state:{kind:'deprecated',at:2,reason:'user retired'},updatedAt:2});}return snapshot;}};
    const editingBridge = new MemoryRuntimeBridge({store:editWrapper,scope:'workspace',now:()=>1});
    await editingBridge.recordInjected(['memory_audit']);
    const stale=await store.get('memory_audit');
    result.cases.push({name:'edit-retirement-between-feedback-read-and-write',backend,expectedContent:'changed memory content preserved by user',actualContent:stale.content, expectedState:'deprecated',actualState:stale.state?.kind??'absent',actualMemory:stale});
    await store.write(memory());
    await bridge.recordInjected(['memory_audit']);
    result.cases.push({name:'sequential-feedback-control',backend,expectedInjectedCount:1,actualInjectedCount:(await store.get('memory_audit')).usefulness.injectedCount});
    await store.remove('memory_audit');
    await bridge.recordInjected(['memory_audit']);
    result.cases.push({name:'delete-before-feedback-control',backend,expectedDeleted:true,actualDeleted:(await store.get('memory_audit')).deleted});
  } finally { store.close?.(); await rm(dataDir,{recursive:true,force:true}); }
}
await writeFile(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result.cases.map(({name,backend,...e})=>({name,backend,...Object.fromEntries(Object.entries(e).filter(([k])=>k!=='actualMemory'))})),null,2));
