import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ToolOrchestrator } from '../../packages/tools/dist/orchestrator.js';
import { ToolRegistry } from '../../packages/tools/dist/registry.js';
import { FileSkillLoader } from '../../packages/skills/dist/skill-loader.js';
import { createSkillBodyBlockProvider } from '../../packages/harness/dist/skill-context.js';
const { z } = createRequire(new URL('../../packages/tools/package.json', import.meta.url))('zod');

const root = await mkdtemp(join(tmpdir(), 'harness-source-research-'));
try {
  const registry = new ToolRegistry();
  registry.register({
    name: 'research_output', description: 'deterministic bounded-output probe',
    inputSchema: z.object({}), risk: 'readonly',
    metadata: { name: 'research_output', version: '1', sideEffect: false, network: false, filesystem: false, process: false, interactive: false },
    execute: async () => ({status:'success',output:'汉'.repeat(1000)}),
  });
  const orchestrator = new ToolOrchestrator({ registry, workspaceRoot: root });
  const sessionId = 'research-session', turnId = 'research-turn', agentId = 'research-agent';
  const result = await orchestrator.execute({ id:'research-call', sessionId,turnId,agentId,call:{id:'research-call',name:'research_output',args:{}} }, {
    sessionId,turnId,agentId,cwd:root, signal:new AbortController().signal,
    permissions: {rules:[{action:'read',resource:'file',pattern:'**/*',effect:'allow'}]},
    sandboxPolicy: {filesystem:{mode:'workspace-write',allowedPaths:[root]},network:{mode:'deny'},process:{timeoutMs:500,maxOutputBytes:100}},
  });
  const payload = typeof result.output === 'string' ? result.output.split('\n…[output truncated')[0] : '';
  const byteLimit = { status:result.status, configuredBytes:100, returnedPayloadBytes:Buffer.byteLength(payload), returnedTotalBytes:typeof result.output === 'string' ? Buffer.byteLength(result.output) : 0 };
  const skillsRoot=join(root,'skills'),dataDir=join(root,'data'),skillDir=join(skillsRoot,'lint');
  await mkdir(skillDir,{recursive:true}); await mkdir(dataDir,{recursive:true});
  const path=join(skillDir,'SKILL.md');
  const body = value => `---\nname: lint\ndescription: lint files\nversion: "1.0.0"\n---\n\n# Lint\n${value}\n`;
  await writeFile(path,body('Run old lint command.'));
  const loader=new FileSkillLoader();
  const provider=createSkillBodyBlockProvider({loader,discover:()=>loader.discover({roots:[skillsRoot]}),dataDir});
  const first=await provider.load(['lint']);
  await writeFile(path,body('Run updated lint command.'));
  await utimes(path,new Date(),new Date(Date.now()+5000));
  const second=await provider.load(['lint']);
  const direct=await loader.load((await loader.discover({roots:[skillsRoot]}))[0]);
  const skillRefresh={firstOld:first[0]?.content.includes('old lint'), providerRetainedOld:second[0]?.content.includes('old lint'), providerSawUpdated:second[0]?.content.includes('updated lint'),directLoaderSawUpdated:direct.body.includes('updated lint')};
  await rm(path);
  const afterRemoval=await provider.load(['lint']);
  skillRefresh.providerStillInjectsDeleted=afterRemoval.length>0;
  console.log(JSON.stringify({byteLimit,skillRefresh},null,2));
} finally { await rm(root,{recursive:true,force:true}); }
