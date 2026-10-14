import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [portableRoot, outputDir] = process.argv.slice(2);
assert(portableRoot && outputDir, 'use PORTABLE_ROOT NEW_OUTPUT_DIR');
const root = resolve(portableRoot), output = resolve(outputDir);
await mkdir(output, { recursive: false });
const { verifyPortable } = await import(pathToFileURL(join(root, 'portable-lib.mjs')));
const manifest = await verifyPortable(root);
const assertions = [], requests = []; let scenario = 'question', stage = 0;
const check = (name, value) => { assert.ok(value, name); assertions.push(name); };
const secret = 'sk-' + 'aB7cD8'.repeat(12);
const tool = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: `final_${scenario}_${stage}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); requests.push({ scenario, stage, body });
    let message;
    if (scenario === 'question' && stage === 0) message = tool('write_file', { path: 'app.txt', content: 'actual edited file\n' });
    else if (scenario === 'question' && stage === 1) message = tool('ask_user', { question: 'Which target?', reason: 'choice_required', options: ['blue', 'green'] });
    else if (scenario === 'secret' && stage === 0) message = tool('exec', { command: 'node', args: ['emit-synthetic.cjs'] });
    else message = { role: 'assistant', content: 'done' };
    stage += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const environment = { ...process.env, OPENAI_API_KEY: 'local-final-audit-no-cost', OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
  OPENAI_MODEL: 'final-audit-fixture', OPENAI_MAX_PROVIDER_RETRIES: '0', HARNESS_MEMORY: '0', HARNESS_DATA_DIR: '', HARNESS_AGENT_PROMPT: 'coding-v1' };
delete environment.NODE_OPTIONS; delete environment.NODE_PATH;
async function command(args, cwd, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'agent.mjs'), ...args], { cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('installed CLI timed out')); }, 60_000);
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.on('error', error => { clearTimeout(deadline); reject(error); });
    child.on('close', code => { clearTimeout(deadline); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}
try {
  const cwd = join(output, 'question project with spaces'), dataDir = join(output, 'question-state');
  await mkdir(cwd); await mkdir(dataDir);
  const first = await command(['--data-dir', dataDir, 'chat', cwd], cwd, 'implement the target\nallow\n');
  await writeFile(join(output, 'question-before-restart.json'), JSON.stringify(first, null, 2) + '\n');
  check('EOF actually leaves the question paused', first.code === 1 && first.stdout.includes('waiting_for_user'));
  check('the prior approved write actually landed', await readFile(join(cwd, 'app.txt'), 'utf8') === 'actual edited file\n');
  const session = first.stdout.match(/chat: session (session_[\w-]+)/)?.[1]; assert(session, 'actual CLI session id');
  const firstTurn = first.stdout.match(/^run: session \S+ turn (turn_[\w-]+)/m)?.[1]; assert(firstTurn, 'actual parked turn id');
  const second = await command(['--data-dir', dataDir, 'chat', cwd, '--resume', session], cwd, 'blue\n/quit\n');
  await writeFile(join(output, 'question-after-restart.json'), JSON.stringify(second, null, 2) + '\n');
  check('installed CLI restart answers and completes the original turn', second.code === 0 && second.stdout.includes(`turn ${firstTurn}`) && second.stdout.includes('status: completed'));
  check('original changed-file summary survives process restart', second.stdout.includes('files changed: app.txt'));
  check('original actual tool counter survives process restart', second.stdout.includes('tool calls: 1'));
  check('answer is present exactly once in the real resumed HTTP request', requests[2].body.messages.filter(message => message.role === 'user' && String(message.content).includes('[user reply to your question]')).length === 1);
  check('the real answer reaches the model', JSON.stringify(requests[2].body.messages).includes('blue'));
  check('resuming never re-executes the original write', stage === 3);

  scenario = 'secret'; stage = 0;
  const secretCwd = join(output, 'output project with spaces'), secretData = join(output, 'output-state');
  await mkdir(secretCwd); await mkdir(secretData);
  await writeFile(join(secretCwd, 'emit-synthetic.cjs'), `const key='sk-'+${JSON.stringify('aB7cD8'.repeat(12))}; process.stdout.write(key.slice(0,7)); setTimeout(()=>process.stdout.write(key.slice(7)+'\\n'),10);\n`);
  const actual = await command(['--data-dir', secretData, 'chat', secretCwd], secretCwd, 'run the script\nallow\n/quit\n');
  await writeFile(join(output, 'protected-exec.json'), JSON.stringify(actual, null, 2) + '\n');
  check('the installed CLI actually executes the approved local program', actual.code === 0 && stage === 2 && actual.stdout.includes('tool calls: 1'));
  const last = requests.at(-1).body;
  check('synthetic credential is absent from real model-facing tool output', !JSON.stringify(last.messages).includes(secret));
  check('a real sanitized tool result reaches the model', last.messages.some(message => message.role === 'tool' && String(message.content).toLowerCase().includes('redacted')));
  for (const [name, value] of Object.entries(environment)) if (['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'HARNESS_MEMORY', 'HARNESS_AGENT_PROMPT'].includes(name)) process.env[name] = value;
  const { createDefaultDeps } = await import(pathToFileURL(join(root, 'node_modules/@ar/cli/dist/main.js')));
  const deps = await createDefaultDeps({ cwd: secretCwd, dataDir: secretData, agentPrompt: 'coding-v1' });
  try {
    const sessions = await deps.store.listSessions(), events = await deps.events.list(sessions[0].id);
    check('durable production tool events retain no plaintext synthetic credential', !JSON.stringify(events).includes(secret));
    check('fragmented stdout is represented by observable withheld events', events.some(event => event.type === 'tool.output' && event.payload.withheld === true && typeof event.payload.bytes === 'number'));
    check('pre-truncated preview is withheld', events.some(event => event.type === 'tool.completed' && event.payload.previewWithheld === true && event.payload.outputPreview === undefined));
    check('the original exec approval was resolved through production permission handling', events.some(event => event.type === 'approval.resolved' && event.payload.value === 'allow'));
    await writeFile(join(output, 'protected-events.json'), JSON.stringify(events, null, 2) + '\n');
  } finally { await deps.close?.(); }
  await writeFile(join(output, 'requests.json'), JSON.stringify(requests, null, 2) + '\n');
  const result = { status: 'PASS', sourceSha: manifest.sourceSha, sourceTree: manifest.sourceTree, platform: process.platform, node: process.version,
    assertions, actualHttpRequests: requests.length, actualCliProcesses: 3, syntheticCredentialSha256: createHash('sha256').update(secret).digest('hex'), paidModelCalls: 0 };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
} finally { await new Promise(resolve => server.close(resolve)); }
