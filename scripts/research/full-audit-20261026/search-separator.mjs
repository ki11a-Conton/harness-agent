import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const root=process.argv[2];
const { ToolRegistry }=await import(pathToFileURL(join(root,'packages/tools/dist/registry.js')));
const { ToolOrchestrator }=await import(pathToFileURL(join(root,'packages/tools/dist/orchestrator.js')));
const { searchFilesTool }=await import(pathToFileURL(join(root,'packages/tools/dist/tools/search-files.js')));
const cwd=await mkdtemp(join(tmpdir(),'harness-search-separator-'));
try{
 await mkdir(join(cwd,'src'));await writeFile(join(cwd,'src','a.ts'),'export const a=1;\n');
 const registry=new ToolRegistry();registry.register(searchFilesTool);
 const orchestrator=new ToolOrchestrator({registry,workspaceRoot:cwd});
 const context={cwd,sessionId:'session_separator',turnId:'turn_separator',agentId:'agent_separator',signal:new AbortController().signal,
  permissions:{rules:[{action:'read',resource:'file',effect:'allow'}]},
  sandboxPolicy:{filesystem:{mode:'workspace-write'},network:{mode:'deny'},process:{maxOutputBytes:100000}}};
 const results=[];
 for(const pattern of ['src/*.ts','src\\*.ts']){
  const id='tool_'+results.length;
  const result=await orchestrator.execute({id,sessionId:context.sessionId,turnId:context.turnId,agentId:context.agentId,call:{id,name:'search_files',args:{pattern,includeSummary:true}}},context);
  results.push({pattern,status:result.status,output:result.output});
 }
 console.log(JSON.stringify({sourceRoot:root,sourceSha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceDirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()!=='',results}));
}finally{await rm(cwd,{recursive:true,force:true});}
