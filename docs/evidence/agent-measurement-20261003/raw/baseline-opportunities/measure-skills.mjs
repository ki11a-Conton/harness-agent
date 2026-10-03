import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHarness } from '/workspace/harness-agent/packages/harness/dist/index.js';
import { selectSkills } from '/workspace/harness-agent/packages/skills/dist/index.js';

const out = '/workspace/harness-agent/.ci/agent-measurement-20261003/opportunities';
const root = await mkdtemp(join(tmpdir(), 'skill-context-measurement-'));
await mkdir(out, {recursive:true});
const skillRoot = join(root,'skills');
await mkdir(skillRoot);
const fixtureHashes = {};
for (let i=0; i<=20; i++) {
  const relevant=i===20;
  const name=relevant?'zz-port-config':`weather-${String(i).padStart(2,'0')}`;
  const description=relevant?'repair port config':'weather rainfall storm climate forecasts';
  const body=relevant?'# Port config\n'+'Measure the actual port and edit config.cjs to the requested value.\n'.repeat(58):
    `# Weather data ${i}\n` + 'Record daily rainfall, temperature and cloud coverage for climate reporting.\n'.repeat(48);
  const content=`---\nname: ${name}\ndescription: ${description}\nversion: "1.0.0"\n---\n\n${body}`;
  await mkdir(join(skillRoot,name));
  await writeFile(join(skillRoot,name,'SKILL.md'),content);
  fixtureHashes[name]=createHash('sha256').update(content).digest('hex');
}
const checker=join(root,'frozen-source-check.cjs');
const checkerText="const fs=require('node:fs'); const text=fs.readFileSync('config.cjs','utf8'); if(text !== 'module.exports = { port: 8080 };\\n') process.exit(1);\n";
await writeFile(checker,checkerText);
const previousRoots=process.env.AR_SKILL_ROOTS;
process.env.AR_SKILL_ROOTS=skillRoot;
const runs=[];
const goal='repair port config';
async function run(arm,repetition) {
  const cwd=join(root,`${arm}-${repetition}`),dataDir=join(root,`data-${arm}-${repetition}`);
  await mkdir(cwd); await writeFile(join(cwd,'config.cjs'),'module.exports = { port: 3000 };\n');
  const requests=[]; let phase=0;
  const provider={id:'offline-measurement',async listModels(){return [{id:'fixture',name:'fixture',capabilities:{contextWindowTokens:128000}}];},createClient(){return {async *generate(request){
    const n=phase++;
    requests.push({step:n,systemBytes:Buffer.byteLength(request.system??''),toolSchemaBytes:Buffer.byteLength(JSON.stringify(request.tools??[])),weatherBodies:(request.system??'').match(/# Weather data /g)?.length??0,portBody:(request.system??'').includes('# Port config'),toolNames:(request.tools??[]).map(x=>x.name)});
    const call=n===0?{id:`read-${repetition}`,name:'read_file',args:{path:'config.cjs'}}:n===1?{id:`write-${repetition}`,name:'write_file',args:{path:'config.cjs',content:'module.exports = { port: 8080 };\n'}}:undefined;
    yield {type:'completed',timestamp:0,result:call?{finishReason:'tool_calls',toolCalls:[call]}:{finishReason:'stop',text:'done'}};
  }};}};
  const start=performance.now();
  const harness=await createHarness({cwd,dataDir,profile:'test',modelProvider:provider,model:{providerId:provider.id,modelId:'fixture'},contextBudget:{maxTokens:8000,reserved:{system:1500,task:1000,output:1000},dynamic:0},task:{id:`port-${arm}-${repetition}`,goal,verification:[{kind:'command',command:process.execPath,args:[checker]}]},...(arm==='selected'?{skillSelector:entries=>selectSkills(entries,goal).selected}:{})});
  try {
    const session=await harness.runtime.createSession({agent:harness.agents[0],cwd});
    const turn=await harness.runtime.startTurn(session.id,goal);
    const outcome=await harness.runtime.runTurn(session.id,turn.id,new AbortController().signal);
    const events=await harness.events.list(session.id);
    const ledger=await harness.skillBodies.listEffectiveness();
    runs.push({arm,repetition,durationMs:performance.now()-start,status:outcome.status,terminationReason:outcome.terminationReason,requestCount:requests.length,requests,systemBytesTotal:requests.reduce((a,x)=>a+x.systemBytes,0),toolSchemaBytesTotal:requests.reduce((a,x)=>a+x.toolSchemaBytes,0),toolRequested:events.filter(x=>x.type==='tool.requested').map(x=>x.payload.tool),toolCompleted:events.filter(x=>x.type==='tool.completed').map(x=>({tool:x.payload.tool,status:x.payload.status})),verificationPassed:events.some(x=>x.type==='verification.completed'&&x.payload.passed===true),targetLedger:ledger['zz-port-config'],contextSelected:events.filter(x=>x.type==='context.selected'&&x.payload.source==='skill').map(x=>x.payload.id),contextDropped:events.filter(x=>x.type==='context.dropped'&&x.payload.source==='skill').map(x=>({id:x.payload.id,reason:x.payload.reason})),ledgerSkills:Object.keys(ledger).length,loadedCount:Object.values(ledger).reduce((a,x)=>a+x.loadedCount,0),injectedCount:Object.values(ledger).reduce((a,x)=>a+x.injectedCount,0),tokensAttributed:Object.values(ledger).reduce((a,x)=>a+x.tokenCount,0),configText:await readFile(join(cwd,'config.cjs'),'utf8')});
    await writeFile(join(out,`${arm}-${repetition}-events.json`),JSON.stringify(events,null,2)+'\n');
  } finally { await harness.close(); }
}
try {
  // Balanced AB/BA order. This is deterministic wiring / local measurement;
  // no real-model statistical quality claim is derived from this provider.
  for (let r=0;r<3;r++) for(const arm of r%2===0?['default','selected']:['selected','default']) await run(arm,r);
} finally { if(previousRoots===undefined)delete process.env.AR_SKILL_ROOTS;else process.env.AR_SKILL_ROOTS=previousRoots; }
const multilingualIndex=[{name:'配置端口',description:'修复配置端口错误的步骤'},{name:'数据库备份',description:'数据库备份和恢复步骤'},{name:'天气记录',description:'记录每日天气情况'}];
const multilingual = ['修复配置端口','repair port config','请修复 config 的端口配置错误'].map(goal=>({goal,result:selectSkills(multilingualIndex,goal)}));
const result={schema:'agent-layer-measurement.v1',sourceSha:'c31e4a8046f1e22b0da29c9310f5c131c5d9a38f',node:process.version,platform:process.platform,fixtureRoot:root,fixtureHashes,checkerSha256:createHash('sha256').update(checkerText).digest('hex'),provider:'offline-measurement',realModelQuality:'NOT_RUN',paidCalls:0,goal,runs,multilingual};
await writeFile(join(out,'skills-measurement.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({runs:runs.map(({requests,...r})=>r),multilingual},null,2));
