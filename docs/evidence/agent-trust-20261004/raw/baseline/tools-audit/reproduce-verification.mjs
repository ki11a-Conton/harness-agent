import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const repo = resolve(process.argv[2] ?? '/workspace/harness-agent');
const out = resolve(process.argv[3] ?? join(repo, '.ci/agent-round2-20261004/tools-audit'));
await mkdir(out, { recursive: true });
const { createHarness } = await import(pathToFileURL(join(repo, 'packages/harness/dist/index.js')));
const { TaskVerifier, ProcessExecutor, discoverCommands, summarize, planToVerificationSpecs, buildVerificationPlan } = await import(pathToFileURL(join(repo, 'packages/tools/dist/index.js')));
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim();
const fingerprintFiles = ['packages/tools/src/verification/plan-builder.ts', 'packages/tools/src/verification/task-verifier.ts', 'packages/tools/src/command-discovery.ts', 'packages/harness/src/verification-planner.ts', 'packages/harness/src/compose/compose-verification.ts', 'packages/tools/dist/verification/plan-builder.js', 'packages/tools/dist/verification/task-verifier.js', 'packages/tools/dist/command-discovery.js', 'packages/harness/dist/verification-planner.js'];
const fingerprints = Object.fromEntries(await Promise.all(fingerprintFiles.map(async path => [path, createHash('sha256').update(await readFile(join(repo,path))).digest('hex')])));
const executor = new ProcessExecutor();
const verifier = new TaskVerifier();
const receipts = [];
function context(cwd) { return { sessionId: 'audit-verification', cwd, changedPaths: [], transcript: '', runStartedAt: Date.now() }; }
async function setupFixture(name, files, scripts) {
  const cwd = join(out, 'fixtures', name); await mkdir(cwd, { recursive: true });
  for(const [path, text] of Object.entries(files)) { await mkdir(join(cwd,path,'..'),{recursive:true}); await writeFile(join(cwd,path),text); }
  await writeFile(join(cwd,'package.json'),JSON.stringify({name,private:true,scripts},null,2)+'\n');
  return cwd;
}
async function runHarness(name,cwd) {
  let scriptedCalls=0;
  const provider = { id:'audit-scripted', async listModels(){return [{id:'stop',name:'stop',capabilities:{contextWindowTokens:128000}}];},createClient(){return {async *generate(){scriptedCalls++; yield {type:'completed',timestamp:0,result:{finishReason:'stop',text:'done'}};}};}};
  const harness = await createHarness({cwd,dataDir:join(out,'sessions',name),profile:'test',modelProvider:provider,model:{providerId:provider.id,modelId:'stop'},task:{id:name,goal:'finish the task'}});
  try {
    const session=await harness.runtime.createSession({agent:harness.agents[0],cwd});
    const turn=await harness.runtime.startTurn(session.id,'finish the task');
    const outcome=await harness.runtime.runTurn(session.id,turn.id,new AbortController().signal);
    const events=await harness.events.list(session.id);
    await writeFile(join(out,`${name}-events.json`),JSON.stringify(events,null,2)+'\n');
    return {outcome,scriptedCalls,verificationEvents:events.filter(event=>event.type.startsWith('verification.')),paidCalls:0};
  } finally {await harness.close();}
}
const quotedRecipe = 'node -e "process.exit(7)"';
const quoteCwd=await setupFixture('quoted-required-failure',{}, {test:quotedRecipe});
const quoteDiscovery=await discoverCommands(quoteCwd);
const quotePlan=buildVerificationPlan({root:quoteCwd,filesChanged:[],commands:summarize(quoteDiscovery.discovered)});
const quoteSpecs=planToVerificationSpecs(quotePlan);
const quoteRaw=await executor.run({command:quotedRecipe,cwd:quoteCwd,timeoutMs:5000});
const quoteConverted=await verifier.verify({id:'quote',goal:'check',verification:quoteSpecs},context(quoteCwd));
const quoteExplicitArgv=await verifier.verify({id:'argv-negative',goal:'check',verification:[{kind:'command',command:process.execPath,args:['-e','process.exit(7)']}]},context(quoteCwd));
const quoteHarness=await runHarness('quoted-required-failure',quoteCwd);
receipts.push({name:'quoted-required-failure',recipe:quotedRecipe,discovery:quoteDiscovery,plan:quotePlan,specs:quoteSpecs,rawOutcome:quoteRaw,convertedResult:quoteConverted,explicitArgvResult:quoteExplicitArgv,harness:quoteHarness,bugObserved:quoteRaw.exitCode===7 && quoteConverted.passed && !quoteExplicitArgv.passed && quoteHarness.outcome.terminationReason==='verified_complete'});
const chainRecipe='node pass.cjs && node required-fail.cjs';
const chainCwd=await setupFixture('compound-required-failure',{'pass.cjs':'console.log("FIRST_COMMAND_RAN");\n','required-fail.cjs':'console.log("REQUIRED_TEST_RAN");process.exit(9);\n'},{test:chainRecipe});
const chainPlan=buildVerificationPlan({root:chainCwd,filesChanged:[],commands:{test:chainRecipe}});
const chainSpecs=planToVerificationSpecs(chainPlan);
const chainRaw=await executor.run({command:chainRecipe,cwd:chainCwd,timeoutMs:5000});
const chainConverted=await verifier.verify({id:'chain',goal:'check',verification:chainSpecs},context(chainCwd));
const chainHarness=await runHarness('compound-required-failure',chainCwd);
receipts.push({name:'compound-required-failure',recipe:chainRecipe,plan:chainPlan,specs:chainSpecs,rawOutcome:chainRaw,convertedResult:chainConverted,harness:chainHarness,bugObserved:chainRaw.exitCode===9 && chainConverted.passed && chainHarness.outcome.terminationReason==='verified_complete'});
const capFiles={'required-fail.cjs':'console.log("ROOT_REQUIRED_TEST_RAN");process.exit(11);\n','smoke.cjs':'console.log("UNRELATED_SMOKE_RAN");\n'};
for(let i=0;i<61;i++) capFiles[`packages/p${String(i).padStart(2,'0')}/package.json`]=JSON.stringify({name:`p${i}`,scripts:{test:'node smoke.cjs'}})+'\n';
const capCwd=await setupFixture('discovery-root-truncated',capFiles,{test:'node required-fail.cjs',build:'node required-fail.cjs'});
const capDiscovery=await discoverCommands(capCwd);
const capSummary=summarize(capDiscovery.discovered);
const capRaw=await executor.run({command:'node required-fail.cjs',cwd:capCwd,timeoutMs:5000});
const capHarness=await runHarness('discovery-root-truncated',capCwd);
receipts.push({name:'discovery-root-truncated',expectedRootTest:'node required-fail.cjs',rootManifestChecked:capDiscovery.sourceFilesChecked.includes('package.json'),returnedCommandCount:capDiscovery.discovered.length,rootCommandsRetained:capDiscovery.discovered.filter(x=>x.file==='package.json'),discovery:capDiscovery,summary:capSummary,rawOutcome:capRaw,harness:capHarness,bugObserved:capRaw.exitCode===11 && capDiscovery.discovered.length===60 && !capDiscovery.discovered.some(x=>x.file==='package.json') && capHarness.outcome.terminationReason==='verified_complete'});
const pathCwd=await setupFixture('quoted-space-path',{'test suite/required-check.cjs':'console.log("SPACE_PATH_CHECK_RAN");\n'},{test:'node "test suite/required-check.cjs"'});
const pathRaw=await executor.run({command:'node "test suite/required-check.cjs"',cwd:pathCwd,timeoutMs:5000});
const pathSpecs=planToVerificationSpecs({steps:[{kind:'command',command:'node "test suite/required-check.cjs"',required:true}],rationale:[]});
const pathConverted=await verifier.verify({id:'space-path',goal:'check',verification:pathSpecs},context(pathCwd));
receipts.push({name:'quoted-space-path',rawOutcome:pathRaw,specs:pathSpecs,convertedResult:pathConverted,bugObserved:pathRaw.status==='success' && !pathConverted.passed});
const result={schema:'agent-round2-tools-audit.v1',sourceSha,dirty:Boolean(dirty),node:process.version,platform:process.platform,fingerprints,paidCalls:0,liveModelQuality:'NOT_RUN',scope:'Built production Harness, planner, TaskVerifier and real local Node processes; scripted stop provider supplies no quality evidence.',receipts,allDefectsReproduced:receipts.every(x=>x.bugObserved)};
await writeFile(join(out,'verification-defects.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({sourceSha,dirty:Boolean(dirty),allDefectsReproduced:result.allDefectsReproduced,receipts:receipts.map(x=>({name:x.name,bugObserved:x.bugObserved,rawExitCode:x.rawOutcome.exitCode,convertedPassed:x.convertedResult?.passed,harnessStatus:x.harness?.outcome.status,harnessTermination:x.harness?.outcome.terminationReason,rootCommandsRetained:x.rootCommandsRetained?.length}))},null,2));
if(!result.allDefectsReproduced) process.exitCode=1;
