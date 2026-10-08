import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createCodingPromptPolicy, DEFAULT_MAIN_SYSTEM_PROMPT } from '../../../packages/harness/dist/index.js';
import { DEFAULT_TOKEN_ESTIMATOR, hashRuleContent } from '../../../packages/context/dist/index.js';
import { runCodingAcceptance } from '../coding-audit-20261007/acceptance.mjs';

// Reuse the real CLI/Web/tool/verification acceptance rather than introducing
// another simulated runtime. The local scripted provider proves transport and
// engineering invariants, never causal model-quality or prompt obedience.
const output = resolve(process.argv[2] ?? '.ci/coding-prompts');
const selected = process.argv[3] ?? 'coding-v1';
assert.ok(['legacy', 'coding-v1'].includes(selected), 'closed policy selector');
await mkdir(output, { recursive: true });
const previous = process.env.HARNESS_AGENT_PROMPT;
let coding;
try {
  process.env.HARNESS_AGENT_PROMPT = selected;
  coding = await runCodingAcceptance(join(output, 'coding'));
} finally {
  if (previous === undefined) delete process.env.HARNESS_AGENT_PROMPT;
  else process.env.HARNESS_AGENT_PROMPT = previous;
}
const requests = JSON.parse(await readFile(join(output, 'coding/requests.json'), 'utf8'));
const policy = selected === 'coding-v1' ? createCodingPromptPolicy() : { version: 'legacy', primary: DEFAULT_MAIN_SYSTEM_PROMPT };
const assertions = [];
const check = (name, condition) => { assert.ok(condition, name); assertions.push(name); };
check('real CLI and Web requests were both captured', requests.some(r => r.scenario === 'coding') && requests.some(r => r.scenario === 'web-coding'));
check('every actual HTTP request carries the exact selected compiled primary policy', requests.every(r => r.body.messages.some(m => m.role === 'system' && m.content.includes(policy.primary))));
check('selected policy fits fallback system reserve without raising the budget', DEFAULT_TOKEN_ESTIMATOR.estimate(policy.primary) <= 1500);
const advertised = [...policy.primary.matchAll(/^- ([a-z_]+):/gm)].map(match => match[1]);
check('documented native capabilities exist in the actual request schemas', requests.every(r => advertised.every(name => r.body.tools.some(t => t.function.name === name))));
if (selected === 'coding-v1') {
  check('new requests carry the versioned challenger rather than legacy prompt', requests.every(r => !r.body.messages.some(m => m.role === 'system' && m.content.includes(DEFAULT_MAIN_SYSTEM_PROMPT))));
  check('readonly policy does not advertise mutating/exec/plan capabilities', !/^- (write_file|edit_file|exec|update_plan):/m.test(policy.readonlyWorker));
}

// Invalid selection must fail before provider construction/HTTP/listening.
// Deliberately unusable external endpoint: no network request is needed.
for (const app of ['cli', 'web']) {
  const file = fileURLToPath(new URL(`../../../apps/${app}/dist/main.js`, import.meta.url));
  const run = await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [file, ...(app === 'cli' ? ['agents'] : [])], {
      env: { ...process.env, HARNESS_AGENT_PROMPT: 'invalid-policy', HARNESS_DATA_DIR: '',
        OPENAI_API_KEY: 'local-invalid-never-send', OPENAI_MODEL: 'fixture', OPENAI_BASE_URL: 'http://127.0.0.1:1/v1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${app} invalid startup timed out`)); }, 10_000);
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolveRun({ code, stdout, stderr }); });
  });
  await writeFile(join(output, `${app}-invalid-startup.json`), JSON.stringify(run, null, 2) + '\n');
  check(`${app} rejects invalid policy before provider or listener startup`, run.code === 1 && run.stderr.includes('Unsupported HARNESS_AGENT_PROMPT') && !run.stdout.includes('listening on'));
}
const prompts = {};
for (const key of ['primary', 'readonlyWorker', 'writeWorker']) {
  if (policy[key] === undefined) continue;
  await writeFile(join(output, `${selected}-${key}.txt`), policy[key]);
  prompts[key] = { sha256: hashRuleContent(policy[key]), bytes: Buffer.byteLength(policy[key]), estimatedTokens: DEFAULT_TOKEN_ESTIMATOR.estimate(policy[key]) };
}
const receipt = { schemaVersion: 1, kind: 'coding-prompt-engineering-acceptance', sourceSha: coding.sourceSha,
  sourceTreeClean: coding.sourceTreeClean, platform: process.platform, node: process.version, policy: selected, prompts,
  assertions, inheritedCodingAssertions: coding.assertions.length, requests: requests.length,
  status: 'PASS', paidModelCalls: 0, realModelQuality: 'NOT_PROVEN',
  limitation: 'A scripted local HTTP provider chooses the actions. Passing proves policy installation and runtime/tool invariants; it cannot prove policy obedience or a real-model quality gain.' };
await writeFile(join(output, 'result.json'), JSON.stringify(receipt, null, 2) + '\n');
if (process.env.GITHUB_ACTIONS === 'true') console.log(`::notice title=Coding prompt acceptance receipt::${JSON.stringify({ encoding: 'gzip+base64', data: gzipSync(Buffer.from(JSON.stringify(receipt))).toString('base64') })}`);
console.log(JSON.stringify(receipt));
