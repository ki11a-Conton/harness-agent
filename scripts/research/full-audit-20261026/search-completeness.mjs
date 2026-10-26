import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const args=process.argv.slice(2);
const root=args.includes('--repo') ? args[args.indexOf('--repo')+1] : args[0];
if(!root) throw new Error('Usage: node search-completeness-probe.mjs --repo PATH [--expect baseline|fixed]');
const expected=args.includes('--expect') ? args[args.indexOf('--expect')+1] : undefined;
const load=p=>import(pathToFileURL(join(root,p)).href);
const {newAgentId,newSessionId,newTurnId,newToolCallId}=await load('packages/contracts/dist/index.js');
const {ToolRegistry}=await load('packages/tools/dist/registry.js');
const {ToolOrchestrator}=await load('packages/tools/dist/orchestrator.js');
const {searchFilesTool}=await load('packages/tools/dist/tools/search-files.js');
const {repoTreeTool}=await load('packages/tools/dist/tools/navigation-tools.js');
const fixture=await mkdtemp(join(tmpdir(),'harness-search-fixture-'));
const context={cwd:fixture,sessionId:newSessionId(),turnId:newTurnId(),agentId:newAgentId(),signal:new AbortController().signal,permissions:{rules:[{action:'read',resource:'file',effect:'allow'}]},sandboxPolicy:{filesystem:{mode:'workspace-write'},network:{mode:'deny'},process:{timeoutMs:2000,maxOutputBytes:100000}}};
const registry=new ToolRegistry();registry.register(searchFilesTool);registry.register(repoTreeTool);
const orch=new ToolOrchestrator({registry,workspaceRoot:fixture});
async function invoke(name,args){const id=newToolCallId();return await orch.execute({id,sessionId:context.sessionId,turnId:context.turnId,agentId:context.agentId,call:{id,name,args}},context)}
try {
 await writeFile(join(fixture,'a.ts'),'a');await writeFile(join(fixture,'b.ts'),'b');
 const results={
 source:{repo:root,sha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()!==''},
 missingTree:await invoke('repo_tree',{path:'missing'}),
 fileScopeTree:await invoke('repo_tree',{path:'a.ts'}),
 cappedTree:await invoke('repo_tree',{maxEntries:1}),
 cappedSearch:await invoke('search_files',{pattern:'*.ts',maxResults:1}),
 summarizedTree:await invoke('repo_tree',{path:'missing',includeSummary:true}),
 summarizedSearch:await invoke('search_files',{pattern:'*.ts',maxResults:1,includeSummary:true}),
 };
 results.checks={missingScopeFails:results.missingTree.status==='failed',fileScopeFails:results.fileScopeTree.status==='failed',treeSummaryVisible:results.summarizedTree.output?.summary?.unavailableScope===true,searchSummaryVisible:results.summarizedSearch.output?.summary?.complete===false,legacySearchStillArray:Array.isArray(results.cappedSearch.output),legacyTreeStillArray:Array.isArray(results.cappedTree.output)};
 console.log(JSON.stringify(results,null,2));
 if(expected==='fixed'&&!Object.values(results.checks).every(Boolean))process.exitCode=1;
 if(expected==='baseline'&&!(Object.values(results.checks).slice(0,4).every(x=>x===false)&&Object.values(results.checks).slice(4).every(Boolean)))process.exitCode=1;
} finally {await rm(fixture,{recursive:true,force:true});}
