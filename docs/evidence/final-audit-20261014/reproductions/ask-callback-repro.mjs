import { AgentRuntime } from '/workspace/harness-agent-final-audit-20261014/packages/core/dist/runtime/runtime.js';
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from '/workspace/harness-agent-final-audit-20261014/packages/core/dist/test/fakes.js';
import { FakeOrchestrator } from '/workspace/harness-agent-final-audit-20261014/packages/core/dist/test/fake-orchestrator.js';
import { ScriptedModelProvider } from '/workspace/harness-agent-final-audit-20261014/packages/model/dist/index.js';
import { newAgentId } from '/workspace/harness-agent-final-audit-20261014/packages/contracts/dist/index.js';
const agent = { id: newAgentId(), name: 'callback-repro', description: 'test', mode: 'primary', model: { providerId: 'scripted', modelId: 'scripted-model' },
  systemPrompt: 'test', tools: {}, permissions: { rules: [] }, skills: {}, limits: {} };
const runtime = new AgentRuntime({ store: new MemorySessionStore(), events: new MemoryEventStore(), agents: [agent], orchestrator: new FakeOrchestrator(), toolRegistry: defaultTestToolCatalog(),
  modelProvider: new ScriptedModelProvider([ScriptedModelProvider.toolCall('ask_user', { question: 'Which target?', reason: 'choice_required' })]),
  askUser: async () => { throw new Error('controlled asynchronous host question failure'); },
});
const session = await runtime.createSession({ agent, cwd: '.' }), turn = await runtime.startTurn(session.id, 'choose target');
const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);
console.log(JSON.stringify({ status: outcome.status, pendingQuestion: outcome.pendingAsk?.question }));
await new Promise(resolve => setTimeout(resolve, 20));
