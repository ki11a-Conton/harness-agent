import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
const argv = process.argv.slice(2);
const value = (name) => { const at = argv.indexOf(name); return at < 0 ? undefined : argv[at + 1]; };
const repo = resolve(value('--repo') ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
const outArg = value('--out');
if (!outArg) throw new Error('Pass --out <evidence directory>; use --repo to select an already built worktree');
const { createHarness } = await import(pathToFileURL(join(repo, 'packages/harness/dist/index.js')).href);
const { FileSkillLoader, selectSkills, selectTaskScopedSkills } = await import(pathToFileURL(join(repo, 'packages/skills/dist/index.js')).href);
const { DeterministicToolSelector } = await import(pathToFileURL(join(repo, 'packages/core/dist/index.js')).href);

const out = resolve(outArg);
await fs.mkdir(out, {recursive:true});
const fixture = join(out, 'fixture');
const root = join(fixture, 'skills');
const cwd = join(fixture, 'workspace');
await fs.mkdir(root, {recursive:true});
await fs.mkdir(cwd, {recursive:true});
await fs.writeFile(join(cwd,'input.txt'), 'test fixture input\n');
const names = [];
for (let i=0;i<100;i++) {
  const name = i === 0 ? 'compile-check' : `specialty-${String(i).padStart(3,'0')}`;
  names.push(name);
  const description = i === 0 ? 'typescript compiler diagnostic errors' : `opaque topic${i} specialty${i} procedure${i}`;
  const body = `# ${name}\nSKILL_FIXTURE_${i}_BODY\n` + (`Procedural reference for ${name}. Preserve source locations and report concrete observations.\n`).repeat(20);
  const folder = join(root,name);
  await fs.mkdir(folder,{recursive:true});
  await fs.writeFile(join(folder,'SKILL.md'),`---\nname: ${name}\ndescription: ${description}\nversion: "1.0.0"\n---\n\n${body}`);
}
const skillFileSha = Object.fromEntries(await Promise.all(names.map(async n => [n, createHash('sha256').update(await fs.readFile(join(root,n,'SKILL.md'))).digest('hex')])));
const old = process.env.AR_SKILL_ROOTS;
process.env.AR_SKILL_ROOTS = root;
const goal = 'typescript compiler fix diagnostic errors';

async function run(label, {strategy='baseline', maxTokens=128000, toolSelector=false}={}) {
  const captured=[];
  const model={providerId:'engineering-probe',modelId:'scripted-model'};
  const modelProvider={
    id:model.providerId,
    async listModels(){return [{id:model.modelId,capabilities:{contextWindowTokens:128000}}];},
    createClient(){return {async *generate(request){
      captured.push(structuredClone(request));
      yield {type:'started',timestamp:Date.now()};
      if(captured.length === 1){
        const call={id:'call-read-fixture',name:'read_file',args:{path:'input.txt'}};
        yield {type:'completed',result:{finishReason:'tool_calls',toolCalls:[call]},timestamp:Date.now()};
      }else{
        yield {type:'completed',result:{finishReason:'stop',text:'engineering probe finished'},timestamp:Date.now()};
      }
    }};}
  };
  const dataDir=join(out,`data-${label}`);
  await fs.rm(dataDir,{recursive:true,force:true});
  await fs.mkdir(dataDir,{recursive:true});
  const t=performance.now();
  const harness=await createHarness({cwd,dataDir,profile:'test',model,modelProvider,
    contextBudget:{maxTokens,reserved:{system:1500,task:2000,output:2000},dynamic:0},
    ...(strategy === 'legacy-selector' ? {skillSelector:entries=>selectSkills(entries,goal).selected} : {}),
    ...(strategy === 'task-scoped' ? {skillSelection:{strategy:'task_scoped_skills_v1',maxRelevantSkills:5,requiredSkillNames:[]}} : {}),
    ...(toolSelector? {toolSelector:new DeterministicToolSelector()}:{}),
  });
  try {
    const session=await harness.runtime.createSession({agent:harness.agents[0],cwd});
    const turn=await harness.runtime.startTurn(session.id,goal);
    const outcome=await harness.runtime.runTurn(session.id,turn.id,new AbortController().signal);
    const elapsed=performance.now()-t;
    const events=await harness.events.list(session.id);
    const ledger=await harness.skillBodies.listEffectiveness();
    const result={label,status:outcome.status,elapsedMs:elapsed,maxTokens,
      modelCalls:captured.length,
      requests:captured.map(r=>({systemBytes:Buffer.byteLength(r.system??''),requestBytes:Buffer.byteLength(JSON.stringify(r)),toolsBytes:Buffer.byteLength(JSON.stringify(r.tools??[])),toolsCount:r.tools?.length??0,toolNames:r.tools?.map(t=>t.name)??[],bodyCount:(r.system??'').match(/SKILL_FIXTURE_\d+_BODY/g)?.length??0,relevantBody:(r.system??'').includes('SKILL_FIXTURE_0_BODY'),skillBodies:(r.system??'').match(/SKILL_FIXTURE_\d+_BODY/g)??[],userGoalPresent:r.messages?.some(m=>m.role==='user'&&m.content===goal)})),
      ledgerNames:Object.keys(ledger),
      ledgerInjected:Object.fromEntries(Object.entries(ledger).map(([n,v])=>[n,{loaded:v.loadedCount,injected:v.injectedCount,completed:v.completedCount,tokens:v.tokenCount}])),
      contextBuilt:events.filter(e=>e.type==='context.built').map(e=>e.payload),
      contextSelected:events.filter(e=>e.type==='context.selected').map(e=>({id:e.payload.id,source:e.payload.source,tokens:e.payload.tokens})),
      modelStarted:events.filter(e=>e.type==='model.started').map(e=>e.payload),
      toolRequests:events.filter(e=>e.type==='tool.requested').map(e=>({name:e.payload.name,args:e.payload.args})),
      failure:outcome.error??null,
    };
    assert.equal(result.status,'completed');
    assert.equal(result.modelCalls,2);
    assert.ok(result.requests.every(r=>r.userGoalPresent));
    await fs.writeFile(join(out,`${label}.json`),JSON.stringify(result,null,2)+'\n');
    return result;
  } finally {await harness.close();}
}

try {
  const runs=[];
  for(const [label,opts] of [['baseline-full',{maxTokens:128000}],['legacy-selector-one',{strategy:'legacy-selector'}],['task-scoped-one',{strategy:'task-scoped'}],['baseline-tight',{maxTokens:16384}],['task-scoped-one-tight',{strategy:'task-scoped',maxTokens:16384}],['tool-selector',{strategy:'task-scoped',toolSelector:true}],['paired-ab-baseline',{}],['paired-ab-task-scoped',{strategy:'task-scoped'}],['paired-ba-task-scoped',{strategy:'task-scoped'}],['paired-ba-baseline',{}]]) {
    const r=await run(label,opts);runs.push(r);
    console.log(JSON.stringify({label,status:r.status,elapsedMs:r.elapsedMs,requests:r.requests.map(({systemBytes,requestBytes,toolsCount,toolsBytes,bodyCount,relevantBody})=>({systemBytes,requestBytes,toolsCount,toolsBytes,bodyCount,relevantBody})),ledgerNames:r.ledgerNames.length}));
  }
  const full = runs.find(r=>r.label==='baseline-full');
  const candidate = runs.find(r=>r.label==='task-scoped-one');
  assert.ok(full.requests.every(r=>r.bodyCount===100 && r.relevantBody));
  assert.ok(candidate.requests.every(r=>r.bodyCount===1 && r.relevantBody));
  assert.ok(candidate.requests.every((r,i)=>r.systemBytes < full.requests[i].systemBytes*0.1));
  assert.deepEqual(candidate.requests.map(r=>({names:r.toolNames,bytes:r.toolsBytes})),full.requests.map(r=>({names:r.toolNames,bytes:r.toolsBytes})));
  assert.deepEqual(candidate.toolRequests,full.toolRequests);
  let io={readdir:0,lstat:0,open:0,readFile:0};
  const loader = new FileSkillLoader({fs:{...fs,
    readdir:async(...a)=>{io.readdir++;return fs.readdir(...a);},
    lstat:async(...a)=>{io.lstat++;return fs.lstat(...a);},
    open:async(...a)=>{io.open++;return fs.open(...a);},
    readFile:async(...a)=>{io.readFile++;return fs.readFile(...a);},
  }});
  const ioRuns=[];
  for(let step=0;step<3;step++) {
    const before={...io};
    const skills=await loader.discover({roots:[root],maxSkills:100});
    for(const s of skills) await loader.loadSnapshot(s);
    ioRuns.push({step,delta:Object.fromEntries(Object.keys(io).map(k=>[k,io[k]-before[k]]))});
  }
  let selectedIo={readdir:0,lstat:0,open:0,readFile:0};
  const selectedLoader = new FileSkillLoader({fs:{...fs,
    readdir:async(...a)=>{selectedIo.readdir++;return fs.readdir(...a);},
    lstat:async(...a)=>{selectedIo.lstat++;return fs.lstat(...a);},
    open:async(...a)=>{selectedIo.open++;return fs.open(...a);},
    readFile:async(...a)=>{selectedIo.readFile++;return fs.readFile(...a);},
  }});
  const selectedIoRuns=[];
  for(let step=0;step<3;step++) {
    const before={...selectedIo};
    const skills=await selectedLoader.discover({roots:[root],maxSkills:100});
    const selectedNames=new Set(selectTaskScopedSkills(skills.map(s=>({name:s.manifest.name,description:s.manifest.description})),goal).selected.map(s=>s.name));
    for(const s of skills) if(selectedNames.has(s.manifest.name)) await selectedLoader.loadSnapshot(s);
    selectedIoRuns.push({step,delta:Object.fromEntries(Object.keys(selectedIo).map(k=>[k,selectedIo[k]-before[k]]))});
  }
  const index=(await new FileSkillLoader().discover({roots:[root],maxSkills:100})).map(s=>({name:s.manifest.name,description:s.manifest.description}));
  const lexical = [goal,'修复类型检查错误','修复 TypeScript 类型检查错误','compile-check'].map(g=>({goal:g,...selectSkills(index,g)}));
  const summary={sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),sourceDirty:execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}).trim() !== '',sourceSha256:Object.fromEntries(await Promise.all(['packages/skills/src/task-scoped-selection.ts','packages/harness/src/create-harness.ts','packages/harness/src/skill-context.ts','packages/core/src/runtime/context-controller.ts','packages/core/src/runtime/runtime.ts'].map(async p=>[p,createHash('sha256').update(await fs.readFile(join(repo,p))).digest('hex')]))),platform:process.platform,node:process.version,kind:'REAL_FILESYSTEM_REAL_HARNESS_SCRIPTED_MODEL_ENGINEERING_PROBE',liveModelQuality:'NOT_RUN',paidModelCalls:0,skillCount:100,fixtureSkillSha256:skillFileSha,
    runs:runs.map(r=>({label:r.label,status:r.status,elapsedMs:r.elapsedMs,requests:r.requests.map(({systemBytes,requestBytes,toolsCount,toolsBytes,bodyCount,relevantBody})=>({systemBytes,requestBytes,toolsCount,toolsBytes,bodyCount,relevantBody})),ledgerNames:r.ledgerNames.length})),
    loaderRealIo:ioRuns,loaderSelectedRealIo:selectedIoRuns,
    lexical:lexical.map(r=>({goal:r.goal,selected:r.selected.map(s=>s.name),excludedCount:r.excluded.length})),
  };
  await fs.writeFile(join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify({ioRuns,lexical:summary.lexical}));
} finally {if(old===undefined)delete process.env.AR_SKILL_ROOTS;else process.env.AR_SKILL_ROOTS=old;}
