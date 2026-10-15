// Offline observations against the unchanged, built Harness baseline.
// Usage: node .../probe.mjs --runtime-root <clean-built-worktree> --out <json>
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const BASELINE = '2a141309f01acae3707060faf1fab8aa247ed31d';
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  assert(index >= 0 && args[index + 1], `missing ${name}`);
  return resolve(args[index + 1]);
}
const runtimeRoot = option('--runtime-root');
const output = option('--out');
const researchRoot = fileURLToPath(new URL('../../../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: runtimeRoot, encoding: 'utf8' }).trim();
assert.equal(git('rev-parse', 'HEAD'), BASELINE, 'build the pinned baseline, not an arbitrary checkout');
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'tracked baseline must be clean');
const sourcePaths = [
  'packages/model/src/openai.ts', 'packages/contracts/src/model.ts',
  'packages/agents/src/coding-prompt.ts', 'packages/harness/src/create-harness.ts',
  'packages/harness/src/coding-prompt-policy.ts', 'packages/harness/src/tool-names.ts',
  'packages/harness/src/profiles.ts', 'packages/harness/src/compose/compose-tools.ts',
];
const sourceHashes = [];
for (const path of sourcePaths) {
  const bytes = await readFile(join(runtimeRoot, path));
  assert.deepEqual(bytes, await readFile(join(researchRoot, path)), `${path} differs from the research baseline`);
  sourceHashes.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const load = path => import(pathToFileURL(join(runtimeRoot, path)).href);
const { OpenAICompatibleProvider } = await load('packages/model/dist/openai.js');
const { createHarness, DEFAULT_MAIN_SYSTEM_PROMPT } = await load('packages/harness/dist/create-harness.js');
const { createCodingPromptPolicy, resolveAgentPromptPolicy } = await load('packages/harness/dist/coding-prompt-policy.js');
const { buildCodingSystemPrompt } = await load('packages/agents/dist/coding-prompt.js');
const { PRODUCTION_TOOL_NAMES, READONLY_TOOL_NAMES } = await load('packages/harness/dist/tool-names.js');

const observations = {
  schemaVersion: 1, createdAt: new Date().toISOString(), baseline: BASELINE,
  paidCalls: 0, transport: 'real loopback HTTP/SSE; production provider; no fetch replacement',
  limits: ['Synthetic responses do not measure model quality or real provider cache hit rate.',
    'SDK composition is not CLI/Web end-to-end or a paid coding benchmark.'],
  sourceHashes, cacheUsage: [], promptComposition: [],
};
const usageCases = [
  { name: 'openai-details-hit', wire: { prompt_tokens_details: { cached_tokens: 128 } }, expectedCacheReadTokens: 128 },
  { name: 'deepseek-hit-miss', wire: { prompt_cache_hit_tokens: 128, prompt_cache_miss_tokens: 72 }, expectedCacheReadTokens: 128 },
  { name: 'openai-explicit-zero', wire: { prompt_tokens_details: { cached_tokens: 0 } }, expectedCacheReadTokens: 0 },
  { name: 'cache-details-absent', wire: {}, expectedCacheReadTokens: null },
];
for (const scenario of usageCases) {
  let requestBody;
  const footerUsage = { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220, ...scenario.wire };
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.method, 'POST');
      let text = '';
      for await (const part of req) { text += part; assert(text.length < 1_000_000); }
      requestBody = JSON.parse(text);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const frame of [
        { choices: [{ delta: { content: 'offline fixture' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: footerUsage },
      ]) res.write(`data: ${JSON.stringify(frame)}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new OpenAICompatibleProvider().createClient({ providerId: 'openai', modelId: 'offline-fixture' }, {
      apiKey: 'offline-placeholder', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 5000,
    });
    const events = [];
    for await (const event of client.generate({ messages: [], system: 'Offline parser observation.' }, AbortSignal.timeout(10000))) events.push(event);
    assert.equal(events.filter(e => e.type === 'error').length, 0);
    const completed = events.filter(e => e.type === 'completed');
    assert.equal(completed.length, 1);
    const result = completed[0].result;
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.text, 'offline fixture');
    assert.equal(result.usage.inputTokens, 200);
    assert.equal(result.usage.outputTokens, 20);
    assert.equal(requestBody.stream_options.include_usage, true);
    const actual = result.usage.cacheReadTokens ?? null;
    const usageEvents = events.filter(e => e.type === 'usage').map(e => e.usage);
    assert.equal(usageEvents.length, 1);
    assert.deepEqual(usageEvents[0], result.usage);
    observations.cacheUsage.push({ name: scenario.name, inputUsage: footerUsage, returnedUsage: result.usage,
      usageEvents, expectedCacheReadTokens: scenario.expectedCacheReadTokens, actualCacheReadTokens: actual,
      verdict: actual === scenario.expectedCacheReadTokens ? 'PASS_CONTROL' : 'OBSERVED_GAP' });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

assert.equal(resolveAgentPromptPolicy(undefined), undefined);
const policy = createCodingPromptPolicy();
assert.equal(policy.primary, buildCodingSystemPrompt({ role: 'primary', toolNames: [...PRODUCTION_TOOL_NAMES].reverse() }));
assert.equal(policy.readonlyWorker, buildCodingSystemPrompt({ role: 'readonly-worker', toolNames: [...READONLY_TOOL_NAMES, ...READONLY_TOOL_NAMES] }));
for (const selected of ['legacy', 'coding-v1']) {
  const dir = await mkdtemp(join(tmpdir(), 'coding-research-sdk-'));
  let harness;
  try {
    await writeFile(join(dir, 'AGENTS.md'), '# Offline coding research fixture\n');
    const requests = [];
    const provider = { id: 'offline-research', listModels: async () => [{ id: 'fixture' }],
      createClient: () => ({ generate: async function* (request) {
        requests.push(structuredClone(request));
        yield { type: 'started', timestamp: 0 };
        yield { type: 'completed', timestamp: 0, result: { finishReason: 'stop', text: 'fixture completed' } };
      } }) };
    harness = await createHarness({ cwd: dir, dataDir: join(dir, 'data'), profile: 'test', modelProvider: provider,
      model: { providerId: provider.id, modelId: 'fixture' }, agentPromptPolicy: resolveAgentPromptPolicy(selected),
      featureFlags: { skills: false, mcp: false, delegation: false, learning: false } });
    const session = await harness.runtime.createSession({ agent: harness.agents[0], cwd: dir });
    const turn = await harness.runtime.startTurn(session.id, 'Inspect this offline fixture.');
    const outcome = await harness.runtime.runTurn(session.id, turn.id, AbortSignal.timeout(10000));
    assert.equal(outcome.status, 'completed');
    assert.equal(requests.length, 1);
    const expected = selected === 'legacy' ? DEFAULT_MAIN_SYSTEM_PROMPT : policy.primary;
    assert(requests[0].system.includes(expected));
    const tools = (requests[0].tools ?? []).map(t => t.name);
    // ask_user is injected by the Runtime as a core phase, not registered
    // in PRODUCTION_TOOL_NAMES as a normal ToolDefinition.
    assert.deepEqual([...tools].sort(), [...PRODUCTION_TOOL_NAMES, 'ask_user'].sort());
    observations.promptComposition.push({ selection: selected, verdict: 'PASS_CONTROL',
      policyChars: expected.length, policySha256: createHash('sha256').update(expected).digest('hex'),
      requestContainsSelectedPolicy: true, actualToolNames: tools, memoryStorePresentByDefaultInTestProfile: !!harness.memoryStore,
      modelCallableMemoryToolPresent: tools.some(name => /memory|session_search/.test(name)) });
  } finally { await harness?.close(); await rm(dir, { recursive: true, force: true }); }
}
observations.summary = {
  execution: 'PASS', observedGaps: observations.cacheUsage.filter(c => c.verdict === 'OBSERVED_GAP').length,
  realModelQuality: 'NOT_PROVEN', realDeepSeekCacheHitRate: 'NOT_MEASURED', productionChanges: false,
};
await writeFile(output, JSON.stringify(observations, null, 2) + '\n');
process.stdout.write(JSON.stringify(observations.summary) + '\n');
