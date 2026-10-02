/**
 * Offline research probe for the acf8dcc Harness baseline.
 *
 * Every provider fetch is replaced with an in-memory SSE Response. Runtime
 * storage uses the project's MemorySessionStore/MemoryEventStore, and tool
 * dispatch uses its FakeOrchestrator. No model endpoint or production tool is
 * called: actual HTTP requests and actual tool filesystem writes are both 0.
 * This proves dispatch behavior, not a real file write or a permission bypass.
 *
 * Run after the existing project build:
 *   node .ci/source-research/pi-repro.mjs > .ci/source-research/pi-repro.json
 * It can also live at scripts/research/pi-repro.mjs: imports remain relative
 * to the repository root. The probe prints observations, not a pass/fail gate
 * that assumes unfixed behavior; normal controls are asserted independently.
 */
import assert from 'node:assert/strict';
import { OpenAICompatibleProvider } from '../../packages/model/dist/openai.js';
import { ModelCallController } from '../../packages/core/dist/runtime/model-call-controller.js';
import { AgentRuntime } from '../../packages/core/dist/runtime/runtime.js';
import { MemorySessionStore, MemoryEventStore, defaultTestToolCatalog } from '../../packages/core/dist/test/fakes.js';
import { FakeOrchestrator } from '../../packages/core/dist/test/fake-orchestrator.js';
import { newAgentId } from '../../packages/contracts/dist/ids.js';
import { applyLineRange, applyReplace } from '../../packages/tools/dist/edit.js';

const originalFetch = globalThis.fetch;
const sse = (value) => `data: ${JSON.stringify(value)}\n\n`;
const sseResponse = (parts) => new Response(parts.join(''), {
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
});
const writeCallDelta = (content) => ({ choices: [{ delta: { tool_calls: [{
  index: 0,
  id: 'call_1',
  function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content }) },
}] } }] });
const textCompletion = (text, finishReason) => ({ choices: [{
  delta: { content: text },
  finish_reason: finishReason,
}] });
const toolCompletion = (content) => {
  const delta = writeCallDelta(content);
  delta.choices[0].finish_reason = 'tool_calls';
  return delta;
};

const observations = [];
let totalMockFetchCalls = 0;

async function providerAndCoreProbe(label, parts) {
  let mockFetchCalls = 0;
  globalThis.fetch = async () => {
    mockFetchCalls += 1;
    totalMockFetchCalls += 1;
    return sseResponse(parts);
  };

  const provider = new OpenAICompatibleProvider();
  const client = provider.createClient({ providerId: 'openai', modelId: 'offline' }, {
    apiKey: 'offline-test-key',
    baseUrl: 'https://offline.invalid/v1',
    requestTimeoutMs: 0,
    maxProviderRetries: 0,
  });
  const modelEvents = [];
  for await (const event of client.generate({ messages: [] }, new AbortController().signal)) {
    modelEvents.push(event);
  }
  const completed = modelEvents.find((event) => event.type === 'completed');
  const final = completed?.result;
  const providerError = modelEvents.find((event) => event.type === 'error');

  // The baseline emits completed even for the defective fixtures. If a future
  // provider correctly emits an error only, record it without fabricating a
  // ModelCallController completion input.
  if (!completed) {
    observations.push({
      label,
      level: 'provider+completion-controller',
      providerFinishReason: null,
      providerError: providerError?.error ?? null,
      coreAction: 'not_called_without_completion',
      executableCalls: 0,
      mockFetchCalls,
    });
    return;
  }

  const messages = [];
  const controller = new ModelCallController({
    store: { appendMessage: async (message) => { messages.push(message); } },
    emit: async () => {},
    now: () => 0,
    failAt: async () => {},
    wallClockExceeded: () => undefined,
    runVerificationGate: async () => undefined,
    finishTurn: async (_ctx, status, _state, _working, error, terminationReason) => ({
      status,
      ...(error !== undefined ? { error } : {}),
      terminationReason,
    }),
  });
  const result = await controller.handleModelCompletion(
    { sessionId: 'session_offline', turnId: 'turn_offline', signal: new AbortController().signal, agent: {} },
    {
      status: 'completed',
      callId: 'model_offline',
      assistantText: '',
      reasoningText: '',
      calls: [],
      final,
      callStartedAt: 0,
    },
    {},
    {},
    { terminate() {}, nextIteration() {} },
    [],
    undefined,
    0,
  );
  const row = {
    label,
    level: 'provider+completion-controller',
    providerFinishReason: final.finishReason,
    coreAction: result.action,
    outcome: result.outcome ?? null,
    executableCalls: result.toolCalls?.length ?? 0,
    durableMessages: messages.map(({ role, content, toolCallId }) => ({
      role,
      content,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
    })),
    mockFetchCalls,
  };
  observations.push(row);

  if (label === 'normal-stop-control') {
    assert.equal(row.providerFinishReason, 'stop');
    assert.equal(row.outcome?.status, 'completed');
    assert.equal(row.executableCalls, 0);
  }
  if (label === 'normal-tool-call-control') {
    assert.equal(row.providerFinishReason, 'tool_calls');
    assert.equal(row.coreAction, 'proceed');
    assert.equal(row.executableCalls, 1);
  }
}

async function runtimeProbe(label, firstResponse) {
  let mockFetchCalls = 0;
  globalThis.fetch = async () => {
    mockFetchCalls += 1;
    totalMockFetchCalls += 1;
    return sseResponse([sse(mockFetchCalls === 1
      ? firstResponse
      : textCompletion('done', 'stop'))]);
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: 'offline-test-key',
    baseUrl: 'https://offline.invalid/v1',
    modelId: 'offline',
  });
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const orchestrator = new FakeOrchestrator();
  const agent = {
    id: newAgentId(),
    name: 'offline',
    description: 'offline source research',
    mode: 'primary',
    model: { providerId: 'openai', modelId: 'offline' },
    systemPrompt: 'offline',
    tools: {},
    permissions: { rules: [] },
    skills: {},
    limits: { maxToolCalls: 2 },
  };
  const runtime = new AgentRuntime({
    store,
    events,
    modelProvider: provider,
    orchestrator,
    agents: [agent],
    toolRegistry: defaultTestToolCatalog(),
    // Mirrors existing Runtime unit-test infrastructure. It resolves inert
    // catalog definitions; FakeOrchestrator records dispatch without running
    // them. This is not a production permission/sandbox claim.
    permissiveToolResolution: true,
    maxIterationsPerTurn: 3,
  });
  const session = await runtime.createSession({ agent, cwd: process.cwd() });
  const turn = await runtime.startTurn(session.id, 'offline provider probe');
  const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);
  const row = {
    label,
    level: 'real-runtime+fake-orchestrator',
    terminalStatus: outcome.status,
    terminationReason: outcome.terminationReason ?? null,
    fakeOrchestratorDispatches: orchestrator.calls.map(({ request }) => request.call),
    mockFetchCalls,
    actualToolFilesystemWrites: 0,
  };
  observations.push(row);
  if (label === 'runtime-normal-tool-call-control') {
    assert.equal(row.fakeOrchestratorDispatches.length, 1);
    assert.equal(row.fakeOrchestratorDispatches[0].name, 'write_file');
    assert.equal(row.terminalStatus, 'completed');
  }
}

try {
  await providerAndCoreProbe('length-text', [sse(textCompletion('partial answer', 'length'))]);
  await providerAndCoreProbe('content-filter-text', [sse(textCompletion('partial answer', 'content_filter'))]);
  await providerAndCoreProbe('natural-eof-complete-tool-json', [sse(writeCallDelta('partial'))]);
  await providerAndCoreProbe('done-complete-tool-json-no-finish-reason', [sse(writeCallDelta('partial')), 'data: [DONE]\n\n']);
  await providerAndCoreProbe('normal-stop-control', [sse(textCompletion('done', 'stop'))]);
  await providerAndCoreProbe('normal-tool-call-control', [sse(toolCompletion('complete'))]);
  await runtimeProbe('runtime-natural-eof', writeCallDelta('partial'));
  await runtimeProbe('runtime-normal-tool-call-control', toolCompletion('complete'));

  observations.push({
    label: 'crlf-line-range',
    level: 'pure-edit-function',
    input: 'a\r\nb\r\nc\r\n',
    operation: { lineStart: 2, lineEnd: 2, replacement: 'B' },
    result: applyLineRange('a\r\nb\r\nc\r\n', 2, 2, 'B'),
    intendedPreservedEolOutput: 'a\r\nB\r\nc\r\n',
  });
  observations.push({
    label: 'lf-anchor-in-crlf',
    level: 'pure-edit-function',
    input: 'a\r\nb\r\nc\r\n',
    operation: { oldText: 'a\nb', newText: 'A\nB' },
    result: applyReplace('a\r\nb\r\nc\r\n', 'a\nb', 'A\nB'),
  });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    probe: 'pi-source-comparison',
    baselineSourceCommit: 'acf8dcc394de6c6efefed52602e49014b372f372',
    artifactBasis: 'existing project dist; rebuild before comparing another source revision',
    mockBoundary: 'fetch always replaced; MemorySessionStore/MemoryEventStore; FakeOrchestrator only records calls',
    actualHttpRequests: 0,
    actualToolFilesystemWrites: 0,
    mockFetchCalls: totalMockFetchCalls,
    observations,
  }, null, 2)}\n`);
} finally {
  globalThis.fetch = originalFetch;
}
