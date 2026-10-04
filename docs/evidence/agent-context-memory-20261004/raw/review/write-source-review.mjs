import fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { stableFingerprint } from '../../../packages/contracts/dist/index.js';
import { JSONLEventStore } from '../../../packages/events/dist/index.js';

const repo='/workspace/harness-agent';
const review=join(repo,'.ci/agent-context-memory-20261004/review');
const candidate=join(repo,'.ci/agent-context-memory-20261004/frozen-ecc45e5');
const expected='ecc45e51055de66506e0bde2b42e0f8ebc098606';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=async path=>JSON.parse(await fs.readFile(path,'utf8'));
const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();
const independent=await read(join(review,'independent-results-ecc45e5.json'));
const context=await read(join(candidate,'context-probe/report.json'));
const memory=await read(join(candidate,'memory-probe/baseline.json'));
const performance=await read(join(candidate,'memory-performance/report.json'));
const baselinePerf=await read(join(repo,'.ci/agent-context-memory-20261004/baseline-performance-final/report.json'));
const manifest=await read(join(candidate,'manifest.json'));
const receipt={observedAt:new Date().toISOString(),testedSourceSha:expected,currentSourceSha:git('rev-parse','HEAD'),clean:git('status','--porcelain')==='',
  role:'Independent source and targeted evidence reviewer; no production source, tests, docs, or plan edited; no build/full-suite invocation',
  paidCalls:0,realModelQuality:'NOT_RUN',promotion:'NOT_RUN',checks:[],performanceComparison:[],resolvedFindings:[],limitations:[]};
const check=(name,pass,details={})=>receipt.checks.push({name,pass:!!pass,...details});
check('frozen source is current and clean',receipt.currentSourceSha===expected&&receipt.clean);
check('independent 512 cap controls and 44 scenarios pass',independent.sourceHead===expected&&independent.status==='PASS'&&independent.contextChecks===512&&independent.summary.passed===44&&independent.sourceHashesUnchanged,
  {sourceHashes:independent.sourceHashes});
check('targeted context probe clean and pass',context.status==='PASS'&&context.sourceHead===expected&&context.sourceStatus===''&&context.sourceHeadAfter===expected&&context.sourceStatusAfter==='');
for(const wire of context.wire.filter(row=>row.kind==='harness')) {
  const requests=await read(join(candidate,'context-probe',`harness-${wire.mode}-requests.json`));
  const events=await read(join(candidate,'context-probe',`harness-${wire.mode}-events.json`));
  const models=events.filter(event=>event.type==='model.started');
  const sessionId=events[0].sessionId;
  const persisted=await new JSONLEventStore({dataDir:join(candidate,'context-probe/fixtures',`data-${wire.mode}`)}).list(sessionId);
  const computed=requests.map((request,index)=>stableFingerprint([wire.steps[index].instructionSources.map(source=>({kind:source.kind,source:source.source,contentHash:source.contentHash,...(source.path!==undefined?{path:source.path}:{})})),request.system]));
  const expectedVisibility=wire.mode==='allowed';
  check(`actual request/step/persisted event identity ${wire.mode}`,
    requests.length===2&&models.length===2&&wire.steps.length===2&&
    computed.every((value,index)=>value===wire.steps[index].instructionFingerprint&&value===models[index].payload.instructionFingerprint)&&
    stableFingerprint([persisted])===stableFingerprint([events])&&wire.bodiesVisible.every(value=>value===expectedVisibility)&&
    (wire.mode==='allowed'?wire.fingerprintChanged:!wire.fingerprintChanged)&&
    wire.steps.every(step=>step.instructionSources.filter(source=>source.kind==='project_instruction').length===(expectedVisibility?1:0)),
    {requestCount:requests.length,modelEventCount:models.length,persistedEvents:events.length,computedFingerprints:computed,bodiesVisible:wire.bodiesVisible});
}
check('raw ContextPipeline denied document debug preserved',context.wire.filter(row=>row.kind==='pipeline'&&row.mode!=='allowed').every(row=>row.discovered.length===1&&row.admitted.length===0));
check('memory original 30 store /12 actual Harness controls /2 supplement controls pass',memory.sourceHead===expected&&memory.sourceStatus===''&&memory.sourceUnchanged&&memory.status==='PASS'&&memory.storeSummary.passed===30&&memory.harnessSummary.passed===12&&memory.supplementCase.every(row=>row.pass),{store:memory.storeSummary,harness:memory.harnessSummary});
check('paired 10k performance fixtures identical and candidate correctness passes',performance.sourceHead===expected&&performance.sourceUnchanged&&performance.status==='PASS'&&performance.correctnessFailures.length===0&&performance.rowCount===10000&&performance.fixtureSha256===baselinePerf.fixtureSha256);
for(const row of performance.cases) {
  const old=baselinePerf.cases.find(item=>item.backend===row.backend&&item.name===row.name);
  receipt.performanceComparison.push({backend:row.backend,case:row.name,baselineCandidates:old.candidateCounts,candidateCandidates:row.candidateCounts,
    baselineMedianSearchMs:old.search.medianMs,candidateMedianSearchMs:row.search.medianMs,
    baselineRetrievalMs:old.retrievalMs,candidateRetrievalMs:row.retrievalMs});
}
const untouched=['packages/context/src/pipeline.ts','packages/core/src/runtime/context-controller.ts','packages/harness/src/path-scoped-instructions.ts','packages/memory/src/retrieval.ts','packages/memory/src/security-gate.ts','packages/memory/src/lifecycle.ts'];
for(const path of untouched) {
  const old=execFileSync('git',['show',`17aa6c7471faf8bdec020b45bfe7b9bb45470131:${path}`],{cwd:repo});
  const current=await fs.readFile(join(repo,path));
  check('unchanged architecture/security seam '+path,old.equals(current),{sha256:hash(current)});
}
check('Core tree unchanged',git('diff','--name-only','17aa6c7471faf8bdec020b45bfe7b9bb45470131',expected,'--','packages/core')==='');
check('frozen typecheck/build/security/docs passed', ['typecheck','build','security','docs-verify'].every(name=>manifest.commands.some(row=>row.name===name&&row.status==='PASS'&&row.cleanBefore&&row.cleanAfter)));
receipt.fullAcceptance={status:manifest.status,full:manifest.commands.find(row=>row.name==='full')?.status??'NOT_RUN',usageAudit:manifest.commands.find(row=>row.name==='usage-audit')?.status??'NOT_RUN'};
receipt.resolvedFindings=[
  {kind:'implementation correctness',description:'FileHandle close EIO in finally aborted all default discovery, independently reproduced with actual fd closure followed by synthetic EIO. Isolated cleanup now preserves unrelated documents and emits generic degraded status.',red:'close-failure-result.json',green:'close-failure-ecc45e5-green.json'},
  {kind:'required security gate',description:'Frozen616ef30 had two comment-only catches rejected by existing no-silent-catch test. Frozen ecc45e5 adds generic degraded stderr without query/body/secrets; security2135 tests now pass.',failedRun:'../frozen-616ef30/security.log'},
  {kind:'probe oracle',description:'First independent cap/memory probe expected only literal row for underscore, despite actual underscores in command_alpha/command_beta. Original42/44 FAIL retained; corrected oracle includes legal strategy matches. Production code unchanged by oracle correction.',failed:'independent-results-616ef30.json',firstProbe:'independent-probe-first.mjs',corrected:'independent-results-616ef30-corrected.json'},
  {kind:'probe invalid boundary',description:'Initial close probe decorated FileHandle prototype close, while Node24 close is an own property, so it never injected. That observation is invalid evidence and retained separately. Correct repro decorates returned actual handle own close and asserts one injected close call.',invalid:'close-failure-invalid-probe-observation.json'}
  ,{kind:'review formatter oracle',description:'First review compared persisted JSONL schemaVersion/event envelopes directly with decoded AgentEvent records. Actual request recomputed fingerprints already matched. Corrected review uses a fresh production JSONLEventStore to decode and verify persisted records; first failed review retained.',failed:'independent-source-review-ecc45e5-envelope-oracle-failed.json',firstBuilder:'write-source-review-first.mjs'}
];
receipt.limitations=[
  'Source and targeted evidence approval only; full joint suite/strict usage-audit completion and remote publication are root acceptance responsibilities. Their state at review time is recorded above.',
  'Scripted providers test actual request/event wiring and deterministic recall correctness; they do not measure real model quality, promotion, or task-success benefit.',
  'SQLite now supplements ranked FTS hits with an O(n) scan of live rows passing type/scope filters. Warm-hit and actual-miss latency materially increases. Numeric paired costs are recorded; no throughput improvement claim.',
  'Existing Chinese retrieval dedup work can cost roughly half a second for 2000 candidates; similar cost already exists in JSONL baseline. TopK/security/lifecycle/session/dedup contracts were intentionally preserved.',
  'Independent probe is Linux Node24. Real file symlink and FIFO controls ran here; Windows matrix is not claimed by this reviewer.'
];
const paths=['independent-probe-first.mjs','independent-probe.mjs','independent-results-616ef30.json','independent-results-616ef30-corrected.json','independent-results-ecc45e5.json',
  'close-failure-red-probe.mjs','close-failure-repro.mjs','close-failure-invalid-probe-observation.json','close-failure-result.json','close-failure-green.json','close-failure-ecc45e5-green.json'];
paths.push('write-source-review-first.mjs','independent-source-review-ecc45e5-envelope-oracle-failed.json');
receipt.localReviewArtifacts=await Promise.all(paths.map(async path=>{const bytes=await fs.readFile(join(review,path));return{path,bytes:bytes.length,sha256:hash(bytes)};}));
receipt.summary={checks:receipt.checks.length,passed:receipt.checks.filter(row=>row.pass).length,failed:receipt.checks.filter(row=>!row.pass).map(row=>row.name)};
receipt.verdict=receipt.summary.failed.length===0?'SOURCE_AND_TARGETED_EVIDENCE_PASS':'FAIL';
await fs.writeFile(join(review,'independent-source-review-ecc45e5.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({verdict:receipt.verdict,summary:receipt.summary,fullAcceptance:receipt.fullAcceptance}));
process.exitCode=receipt.verdict==='FAIL'?1:0;
