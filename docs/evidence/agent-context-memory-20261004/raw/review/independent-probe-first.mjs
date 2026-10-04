import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve('/workspace/harness-agent');
const output = resolve(process.argv[2] ?? join(repo,'.ci/agent-context-memory-20261004/review/independent-results.json'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = ['packages/context/src/discovery.ts','packages/context/dist/discovery.js',
  'packages/harness/src/compose/compose-context.ts','packages/harness/dist/compose/compose-context.js',
  'packages/harness/src/effective-instruction-context.ts','packages/harness/dist/effective-instruction-context.js',
  'packages/memory/src/memory-store.ts','packages/memory/dist/memory-store.js',
  'packages/memory/src/search-text.ts','packages/memory/dist/search-text.js',
  'packages/memory/src/sqlite-memory-store.ts','packages/memory/dist/sqlite-memory-store.js'];
const initialHashes = Object.fromEntries(await Promise.all(paths.map(async path => [path,hash(await fs.readFile(join(repo,path)))])));
const report={ observedAt:new Date().toISOString(), sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),
  sourceStatus:execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}).trim(), sourceHashes:initialHashes,
  probeHash:hash(await fs.readFile(new URL(import.meta.url))), paidCalls:0, realModelQuality:'NOT_RUN', promotion:'NOT_RUN',
  scenarios:[], contextChecks:0, contextFailures:[] };
const check = (name, condition, details={}) => { report.scenarios.push({name,pass:!!condition,...details}); };
const originalOpen=fs.open, originalReadFile=fs.readFile;
let captures=[];
fs.open=async function(path,...args) {
  const handle=await originalOpen.call(this,path,...args);
  if(String(path).endsWith('AGENTS.md')) {
    const original=handle.read.bind(handle);
    handle.read=async function(...readArgs) {
      const value=await original(...readArgs);
      captures.push({path:String(path),allocatedBytes:readArgs[0]?.byteLength,requestedBytes:readArgs[2],returnedBytes:value.bytesRead});
      return value;
    };
  }
  return handle;
};
let fullReads=0;
fs.readFile=async function(path,...args) { if(String(path).endsWith('AGENTS.md'))fullReads++; return originalReadFile.call(this,path,...args); };
syncBuiltinESMExports();
const {HierarchicalInstructionDiscovery}=await import(pathToFileURL(join(repo,'packages/context/dist/index.js')));
const {JsonlMemoryStore,SqliteMemoryStore,retrieveMemories}=await import(pathToFileURL(join(repo,'packages/memory/dist/index.js')));
const fixture=await fs.mkdtemp(join(tmpdir(),'harness-independent-context-memory-'));
const discovery=new HierarchicalInstructionDiscovery();
try {
  const contextRoot=join(fixture,'context');await fs.mkdir(contextRoot,{recursive:true});
  const bodies=[Buffer.from('α中🙂éabc\n'.repeat(40)),Buffer.from('x'.repeat(600)),Buffer.from('\ufeffvisible BOM and 汉字'.repeat(40)),Buffer.alloc(600,0)];
  for(let bodyIndex=0;bodyIndex<bodies.length;bodyIndex++) {
    await fs.writeFile(join(contextRoot,'AGENTS.md'),bodies[bodyIndex]);
    for(let cap=0;cap<=127;cap++) {
      captures=[];fullReads=0;
      const docs=await discovery.discover(contextRoot,{maxBytesPerFile:cap});
      const doc=docs[0]; const captureTotal=captures.reduce((sum,row)=>sum+row.returnedBytes,0);
      const pass=docs.length===1 && Buffer.byteLength(doc.content)<=cap && !doc.content.includes('\ufffd') &&
        doc.sizeBytes===bodies[bodyIndex].length && doc.truncated===true && fullReads===0 && captureTotal<=cap+4 &&
        captures.every(row=>row.allocatedBytes<=cap+4);
      report.contextChecks++;
      if(!pass)report.contextFailures.push({bodyIndex,cap,documents:docs,fullReads,captures});
    }
  }
  check('512 exhaustive cap and bounded IO controls',report.contextFailures.length===0,{checks:report.contextChecks,failures:report.contextFailures});
  for(const [name,body] of [['BOM',Buffer.from('\ufeff漢🙂abc')],['ASCII',Buffer.from('ab\ncd\n')],['empty',Buffer.alloc(0)]]) {
    await fs.writeFile(join(contextRoot,'AGENTS.md'),body); const docs=await discovery.discover(contextRoot,{maxBytesPerFile:body.length});
    check('exact cap preserves '+name,docs.length===1&&docs[0].content===body.toString('utf8')&&!docs[0].truncated,{output:docs[0]?.content});
  }
  for(const [name,value] of [['NaN',NaN],['positive infinity',Infinity],['negative infinity',-Infinity],['negative',-1]]) {
    let rejected=false;try{await discovery.discover(contextRoot,{maxBytesPerFile:value});}catch{rejected=true;}
    check('invalid cap '+name+' fails closed',rejected);
  }
  for(const [name,body] of [['invalid leading',Buffer.from([0xff,0xfe,0xfd])],['overlong',Buffer.from([0xc0,0xaf])],
    ['incomplete final',Buffer.from([0x61,0xe4,0xb8])],['surrogate',Buffer.from([0xed,0xa0,0x80])]]) {
    await fs.writeFile(join(contextRoot,'AGENTS.md'),body);
    check('malformed UTF-8 omitted '+name,(await discovery.discover(contextRoot,{maxBytesPerFile:body.length})).length===0);
  }
  await fs.rm(join(contextRoot,'AGENTS.md')); await fs.writeFile(join(fixture,'outside.md'),'FOREIGN_SYMLINK_BODY');
  await fs.symlink(join(fixture,'outside.md'),join(contextRoot,'AGENTS.md'));
  check('actual file symlink omitted',(await discovery.discover(contextRoot)).length===0);
  await fs.rm(join(contextRoot,'AGENTS.md'));execFileSync('mkfifo',[join(contextRoot,'AGENTS.md')]);
  check('actual FIFO omitted without blocking',(await discovery.discover(contextRoot)).length===0);
  await fs.rm(join(contextRoot,'AGENTS.md'));
  await fs.mkdir(join(contextRoot,'AGENTS.md'));
  check('actual directory document omitted',(await discovery.discover(contextRoot)).length===0);

  const now=Date.now();
  const lesson={when:'Chinese 端口配置 review',do:'run command_alpha once',avoid:'duplicate command_beta',rootCause:'metadataonlyneedle',outcome:'ignored',evidenceRefs:['metadataevidenceonlyneedle']};
  const entry=(id,extra={})=>({id,content:'safe distinct '+id,type:'procedural',sourceSession:'owner',scope:'workspace',importance:.9,confidence:.9,novelty:.9,stability:.9,createdAt:now,updatedAt:now,deleted:false,...extra});
  for(const backend of ['jsonl','sqlite']) {
    const dir=join(fixture,backend);await fs.mkdir(dir);
    const store=backend==='jsonl'?new JsonlMemoryStore({dataDir:dir}):new SqliteMemoryStore({dataDir:dir});
    try {
      const memories=[entry('literal',{content:'literal % _ " only'}),entry('ordinary',{content:'ordinary unrelated only'}),
        entry('structured',{structured:lesson}),entry('retired',{structured:lesson,state:{kind:'deprecated',at:now}}),
        entry('foreign',{structured:lesson,scope:'session',sourceSession:'foreign'}),entry('deleted',{structured:lesson,deleted:true}),
        entry('wrong-type',{structured:lesson,type:'explicit'})];
      for(const memory of memories)await store.write(memory);
      for(const query of ['%','_','"'])check(backend+' punctuation '+query+' literal',JSON.stringify((await store.search(query)).map(row=>row.id))===JSON.stringify(['literal']));
      for(const query of ['端口配置','command_alpha','command_beta']) {
        const raw=await store.search(query,{scope:'workspace',type:'procedural'});
        check(backend+' supplemental exact filters '+query,JSON.stringify(raw.map(row=>row.id))===JSON.stringify(['structured','retired']),{ids:raw.map(row=>row.id)});
      }
      for(const query of ['metadataonlyneedle','metadataevidenceonlyneedle','When:','Avoid:','\t  \n','absentneedle'])check(backend+' non-search projection '+JSON.stringify(query),(await store.search(query)).length===0);
      const safe=await retrieveMemories(store,'command_alpha','session',{sessionId:'owner',type:'procedural',now});
      check(backend+' lifecycle/session gates',JSON.stringify(safe.items.map(row=>row.memory.id))===JSON.stringify(['structured'])&&
        safe.suppressed.some(row=>row.memory.id==='retired'&&row.reason==='inactive')&&safe.suppressed.some(row=>row.memory.id==='foreign'&&row.reason==='session-mismatch'),
        {ids:safe.items.map(row=>row.memory.id),suppressed:safe.suppressed.map(row=>({id:row.memory.id,reason:row.reason}))});
      if(backend==='sqlite') {
        const typed=entry('exact-token',{content:'端口配置'});const sub=entry('substring',{content:'嵌入端口配置提醒'});await store.write(typed);await store.write(sub);
        const raw=await store.search('端口配置'); const ids=raw.map(row=>row.id);
        check('SQLite positive FTS supplemented once',ids[0]==='exact-token'&&ids.includes('substring')&&ids.includes('structured')&&new Set(ids).size===ids.length,{ids});
        store.database.prepare('UPDATE memories SET metadata = ? WHERE id = ?').run('{"structured":', 'structured');
        check('SQLite corrupt metadata stays non-retrievable',(await retrieveMemories(store,'safe distinct structured','workspace',{now})).items.every(row=>row.memory.id!=='structured'));
      }
    } finally { if(backend==='sqlite')store.close(); }
  }
} finally {
  fs.open=originalOpen;fs.readFile=originalReadFile;syncBuiltinESMExports();await fs.rm(fixture,{recursive:true,force:true});
}
const finalHashes=Object.fromEntries(await Promise.all(paths.map(async path=>[path,hash(await fs.readFile(join(repo,path)))])));
report.sourceHashesUnchanged=JSON.stringify(finalHashes)===JSON.stringify(initialHashes);
check('source and distribution hashes unchanged during independent probe',report.sourceHashesUnchanged);
report.status=report.scenarios.every(row=>row.pass)?'PASS':'FAIL';report.summary={scenarios:report.scenarios.length,passed:report.scenarios.filter(row=>row.pass).length,failed:report.scenarios.filter(row=>!row.pass).map(row=>row.name)};
await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,summary:report.summary,sourceHead:report.sourceHead,output}));
process.exitCode=report.status==='PASS'?0:1;
