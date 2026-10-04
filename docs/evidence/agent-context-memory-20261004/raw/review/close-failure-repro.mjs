import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { HierarchicalInstructionDiscovery } from '../../../packages/context/src/discovery.ts';

const repo='/workspace/harness-agent';
const root=await fs.mkdtemp(join(tmpdir(),'harness-close-review-'));
await fs.mkdir(join(root,'nested'));await fs.writeFile(join(root,'AGENTS.md'),'safe root');
await fs.writeFile(join(root,'nested','AGENTS.md'),'SAFE_NESTED_CONTROL');
const originalOpen=fs.open;let calls=0;
fs.open=async function(path,...args) {
  const handle=await originalOpen.call(this,path,...args);
  if(String(path)===join(root,'AGENTS.md')) {
    const close=handle.close.bind(handle);
    handle.close=async (...closeArgs)=> { const value=await close(...closeArgs);calls++;throw Object.assign(new Error('Synthetic close EIO after real descriptor closure'),{code:'EIO'}); };
  }
  return handle;
};
syncBuiltinESMExports();
const result={sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),
  discoverySourceHash:createHash('sha256').update(await fs.readFile(join(repo,'packages/context/src/discovery.ts'))).digest('hex'),
  mechanism:'fs.open/FileHandle own close boundary: actually closes descriptor, then throws EIO only for cwd AGENTS; all reads/stat/candidate selection are production code',
  expected:'One problematic document must not abort all discovery or suppress remaining regular nested documents',paidCalls:0};
try { result.documents=await new HierarchicalInstructionDiscovery().discover(root); result.passed=result.documents.some(doc=>doc.content==='SAFE_NESTED_CONTROL'); }
catch(error) { result.error={message:error.message,code:error.code};result.passed=false; }
finally { fs.open=originalOpen;syncBuiltinESMExports();await fs.rm(root,{recursive:true,force:true}); }
result.injectedCloseCalls=calls;
result.passed=result.passed&&calls===1;
await fs.writeFile(process.argv[2]??join(repo,'.ci/agent-context-memory-20261004/review/close-failure-result.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
