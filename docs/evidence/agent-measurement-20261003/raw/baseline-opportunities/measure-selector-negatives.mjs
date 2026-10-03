import { createHash } from 'node:crypto';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {join} from 'node:path';
import { createHarness } from '/workspace/harness-agent/packages/harness/dist/index.js';
import {selectSkills} from '/workspace/harness-agent/packages/skills/dist/index.js';
const out='/workspace/harness-agent/.ci/agent-measurement-20261003/opportunities';
const root=await mkdtemp(join(tmpdir(),'skill-selector-negative-'));
const skills=join(root,'skills');
const names=['port-config','weather'];
const descriptions=['repair port config '+Array.from({length:80},(_,i)=>`reference${i}`).join(' '),'weather rainfall storm forecasts'];
for(let i=0;i<2;i++){
 await mkdir(join(skills,names[i]),{recursive:true});
 await writeFile(join(skills,names[i],'SKILL.md'),`---\nname: ${names[i]}\ndescription: ${descriptions[i]}\nversion: "1.0.0"\n---\n\n# ${names[i]} body\nRead the corresponding reference data.\n`);
}
const checker=join(root,'frozen-negative-check.cjs');
const check="const fs=require('node:fs');if(fs.readFileSync('untouched.txt','utf8')!=='fixed-content')process.exit(1);\n";
await writeFile(checker,check);
const before=process.env.AR_SKILL_ROOTS;process.env.AR_SKILL_ROOTS=skills;
const results=[];
try {
 for(const goal of ['Use skill port-config','帮我使用 port-config 技能','Do the unspecified task']){
  const cwd=await mkdtemp(join(root,'workspace-')),dataDir=await mkdtemp(join(root,'data-'));
  await writeFile(join(cwd,'untouched.txt'),'fixed-content');
  const requests=[];
  const provider={id:'negative-offline',async listModels(){return[{id:'fake',name:'fake',capabilities:{contextWindowTokens:128000}}];},createClient(){return{async *generate(request){requests.push({systemBytes:Buffer.byteLength(request.system??''),targetBody:(request.system??'').includes('# port-config body'),indexMentions:(request.system??'').includes('port-config'),weatherBody:(request.system??'').includes('# weather body')});yield{type:'completed',timestamp:0,result:{finishReason:'stop',text:'done'}};}};}};
  const harness=await createHarness({cwd,dataDir,profile:'test',modelProvider:provider,model:{providerId:provider.id,modelId:'fake'},task:{id:'negative',goal,verification:[{kind:'command',command:process.execPath,args:[checker]}]},skillSelector:entries=>selectSkills(entries,goal).selected});
  try {
   const session=await harness.runtime.createSession({agent:harness.agents[0],cwd});
   const turn=await harness.runtime.startTurn(session.id,goal);
   const outcome=await harness.runtime.runTurn(session.id,turn.id,new AbortController().signal);
   const events=await harness.events.list(session.id);
   results.push({goal,selection:selectSkills(names.map((name,i)=>({name,description:descriptions[i]})),goal),requests,status:outcome.status,verified:events.some(x=>x.type==='verification.completed'&&x.payload.passed===true)});
  }finally{await harness.close();}
 }
}finally{if(before===undefined)delete process.env.AR_SKILL_ROOTS;else process.env.AR_SKILL_ROOTS=before;}
const result={schema:'skill-selector-negative.v1',sourceSha:'c31e4a8046f1e22b0da29c9310f5c131c5d9a38f',realModelQuality:'NOT_RUN',paidCalls:0,fixtureRoot:root,checkerSha256:createHash('sha256').update(check).digest('hex'),names,descriptions,results};
await writeFile(join(out,'selector-negatives.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(results,null,2));
