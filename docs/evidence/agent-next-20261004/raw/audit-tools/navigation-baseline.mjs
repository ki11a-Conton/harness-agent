import fs from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ToolRegistry, ToolOrchestrator, grepSearchTool, repoTreeTool } from '../../../packages/tools/dist/index.js';
import { newAgentId, newSessionId, newTurnId, newToolCallId } from '../../../packages/contracts/dist/index.js';
const workspace = process.cwd();
const root = mkdtempSync(join(tmpdir(), 'harness-next-navigation-'));
const outside = mkdtempSync(join(tmpdir(), 'harness-next-navigation-outside-'));
const dirReads = [];
const originalReaddir = fs.readdir;
fs.readdir = async function(path, ...rest) {
  if (String(path).startsWith(root)) dirReads.push(relative(root, String(path)) || '.');
  return originalReaddir.call(this, path, ...rest);
};
const registry = new ToolRegistry(); registry.register(grepSearchTool); registry.register(repoTreeTool);
const orch = new ToolOrchestrator({ registry, workspaceRoot: root });
const sessionId = newSessionId(), agentId = newAgentId(), turnId = newTurnId();
const ctx = () => ({ sessionId, agentId, turnId, cwd: root, signal: new AbortController().signal,
  permissions: { rules: [{ action: 'read', resource:'file', pattern:'**/*', effect:'allow' }] },
  sandboxPolicy: { filesystem: { mode:'workspace-write', allowedPaths:[root] }, network:{mode:'deny'}, process:{timeoutMs:5000,maxOutputBytes:4096} } });
const req = (name,args) => ({ id:newToolCallId(), sessionId,turnId,agentId,call:{id:newToolCallId(), name,args} });
const checks = [];
try {
  mkdirSync(join(root,'a-hit'));
  writeFileSync(join(root,'a-hit','match.txt'),'needle\n');
  mkdirSync(join(root,'empty'));
  for(let i=0;i<64;i++) { const p=join(root,'z'+String(i).padStart(2,'0'),'sub'); mkdirSync(p,{recursive:true}); writeFileSync(join(p,'tail.txt'),'needle\n'); }
  for (const hidden of ['.git','dist','node_modules']) { mkdirSync(join(root,hidden)); writeFileSync(join(root,hidden,'secret.txt'),'needle secret\n'); }
  writeFileSync(join(outside,'secret.txt'),'needle outside\n');
  symlinkSync(outside,join(root,'external-link'),'dir');
  dirReads.length=0;
  const shallow=await orch.execute(req('repo_tree',{depth:1,maxEntries:1000}),ctx());
  checks.push({ id:'TREE_DEPTH_ONE_RETURNS_IMMEDIATE_EMPTY_AND_POPULATED_DIRS', expected:{entries:66,contains:['a-hit','empty','z00','z63'],descendantDirectoryReads:0}, actual:{status:shallow.status,output:shallow.output, directoryReads:dirReads.length,descendantDirectoryReads:dirReads.filter(p=>p!=='.').length}, verdict: shallow.status==='success' && shallow.output.length===66 && shallow.output.some(e=>e.path==='empty') && dirReads.length===1?'PASS':'FAIL' });
  dirReads.length=0;
  const zero=await orch.execute(req('repo_tree',{depth:0,maxEntries:1000}),ctx());
  checks.push({id:'TREE_DEPTH_ZERO_HAS_ZERO_DESCENT_AND_NO_ENTRY',expected:{entries:0,directoryReads:0},actual:{status:zero.status,output:zero.output,directoryReads:dirReads.length},verdict:zero.status==='success'&&zero.output.length===0&&dirReads.length===0?'PASS':'FAIL'});
  dirReads.length=0;
  const capTree=await orch.execute(req('repo_tree',{depth:6,maxEntries:1}),ctx());
  checks.push({id:'TREE_ENTRY_CAP_COUNTS_DIRECTORIES_AND_STOPS_GLOBALLY',expected:{entries:1,directoryReadsAtMost:1},actual:{status:capTree.status,output:capTree.output,directoryReads:dirReads.length},verdict:capTree.status==='success'&&capTree.output.length===1&&dirReads.length<=1?'PASS':'FAIL'});
  dirReads.length=0;
  const capped=await orch.execute(req('grep_search',{pattern:'needle',maxResults:1}),ctx());
  checks.push({ id:'GREP_CAP_STOPS_GLOBAL_RECURSION', expected:{hits:1,directoryReadsAtMost:2}, actual:{status:capped.status,hits:capped.output,directoryReads:dirReads.length,visited:[...dirReads]}, verdict: capped.status==='success' && capped.output.length===1 && dirReads.length<=2?'PASS':'FAIL' });
  dirReads.length=0;
  const broad=await orch.execute(req('repo_tree',{depth:6,maxEntries:1000}),ctx());
  const broadPaths=broad.output.map(e=>e.path);
  checks.push({id:'TREE_SKIP_GENERATED_AND_SYMLINK_DIRS',expected:{hiddenPaths:[],foreignPaths:[]},actual:{status:broad.status,hiddenPaths:broadPaths.filter(p=>['.git','dist','node_modules'].some(prefix=>p===prefix||p.startsWith(prefix+'/'))),foreignPaths:broadPaths.filter(p=>p.startsWith('external-link'))},verdict:broad.status==='success'&&!broadPaths.some(p=>['.git','dist','node_modules','external-link'].some(prefix=>p===prefix||p.startsWith(prefix+'/')))?'PASS':'FAIL'});
  dirReads.length=0;
  const escaped=await orch.execute(req('repo_tree',{path:outside}),ctx());
  checks.push({id:'SANDBOX_OUTSIDE_PATH_PREVENTS_TREE_READ',expected:{status:'denied',directoryReads:0},actual:{status:escaped.status,directoryReads:dirReads.length},verdict:escaped.status==='denied'&&dirReads.length===0?'PASS':'FAIL'});
  dirReads.length=0;
  const deniedContext=ctx(); deniedContext.permissions={rules:[],defaultEffect:'deny'};
  const denied=await orch.execute(req('repo_tree',{}),deniedContext);
  checks.push({id:'PERMISSION_DENY_PREVENTS_TREE_READ',expected:{status:'denied',directoryReads:0},actual:{status:denied.status,directoryReads:dirReads.length},verdict:denied.status==='denied'&&dirReads.length===0?'PASS':'FAIL'});
  const paths=['packages/tools/src/navigate.ts','packages/tools/src/tools/navigation-tools.ts','packages/tools/src/orchestrator.ts','packages/tools/dist/navigate.js','packages/tools/dist/tools/navigation-tools.js'];
  const report={schema:'HARNESS_NAVIGATION_BASELINE_V1',observedAt:new Date().toISOString(),head:execFileSync('git',['rev-parse','HEAD'],{cwd:workspace,encoding:'utf8'}).trim(),profile:'actual ToolOrchestrator + production registry/tools + real filesystem; read-only tool permission/sandbox preserved',modelsPaid:0,hashes:Object.fromEntries(paths.map(path=>[path,createHash('sha256').update(readFileSync(join(workspace,path))).digest('hex')])),checks};
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
} finally { fs.readdir=originalReaddir; rmSync(root,{recursive:true,force:true}); rmSync(outside,{recursive:true,force:true}); }
