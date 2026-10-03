import { createHash } from 'node:crypto';

export const PILOT_SCHEMA = 'agent-measurement-pilot-v1';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The checker is a host-owned argv string, never a file in the agent workspace.
// A child imports the edited module. The parent requires the complete proof,
// so an implementation that calls process.exit(0) cannot satisfy the checker.
function checkerFor(id, fixture, targetPath, assertions, checks) {
  const immutableHashes = Object.fromEntries(Object.entries(fixture)
    .filter(([path]) => path !== targetPath).sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) => [path, sha256(content)]));
  const proof = JSON.stringify({ checker: id, checks });
  const child = [
    "import assert from 'node:assert/strict';",
    "import { pathToFileURL } from 'node:url';",
    'Object.freeze(assert);',
    `const m = await import(pathToFileURL(${JSON.stringify(targetPath)}).href);`,
    assertions,
    `process.stdout.write(${JSON.stringify(`${proof}\n`)});`,
  ].join('\n');
  return [
    "const assert = require('node:assert/strict');",
    "const fs = require('node:fs');",
    "const { createHash } = require('node:crypto');",
    "const { execFileSync } = require('node:child_process');",
    `const immutableHashes = ${JSON.stringify(immutableHashes)};`,
    'function checkImmutable() { for (const [path, hash] of Object.entries(immutableHashes)) {',
    '  const st = fs.lstatSync(path);',
    "  assert(st.isFile() && !st.isSymbolicLink(), `non-regular fixture: ${path}`);",
    "  assert.equal(createHash('sha256').update(fs.readFileSync(path)).digest('hex'), hash, `immutable fixture changed: ${path}`);",
    '} }',
    'checkImmutable();',
    `const target = fs.lstatSync(${JSON.stringify(targetPath)});`,
    "assert(target.isFile() && !target.isSymbolicLink(), 'target must be a regular file');",
    `const actual = execFileSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(child)}], { encoding: 'utf8', timeout: 4000, maxBuffer: 65536 });`,
    'checkImmutable();',
    `assert.equal(actual, ${JSON.stringify(`${proof}\n`)}, 'module exited before completing independent checks');`,
  ].join('\n');
}

function makeCase({ strategy, candidate, id, request, expected, fixture, targetPath, solution, assertions, checks, contextBudgetTokens }) {
  const checker = checkerFor(id, fixture, targetPath, assertions, checks);
  const metadata = {
    expected: { status: 'completed' }, suite: 'regression',
    tags: ['agent-measurement-20261003', 'exploratory-pilot', strategy],
    contextBudgetTokens, timeoutMs: 120000, maxDurationMs: 120000,
    verification: [{ kind: 'command', command: 'node', args: ['-e', checker],
      description: `${id}: immutable host checker; behavior and non-target fixture integrity` }],
  };
  return { strategy, candidate, id, request, expected, fixture, targetPath, solution, metadata };
}

function skillsCase() {
  const fixture = {
    'package.json': '{"name":"port-config-pilot","private":true,"type":"module"}\n',
    'src/port-config.js': 'export function parsePort(value) { return Number(value); }\n',
  };
  for (let i = 0; i < 20; i++) {
    const name = `weather-${String(i).padStart(2, '0')}`;
    fixture[`skills/${name}/SKILL.md`] = [
      '---', `name: ${name}`, 'description: Meteorology station cloud rainfall humidity observations', 'version: 1.0.0', '---',
      `# ${name}\n`,
      'Weather observation reference. Record cloud cover, rainfall, humidity, wind speed and station location.\n'.repeat(41),
    ].join('\n');
  }
  fixture['skills/zz-port-config/SKILL.md'] = [
    '---', 'name: zz-port-config', 'description: port-config 端口配置 parsePort 数值边界与十进制输入', 'version: 1.0.0', '---',
    '# Port configuration contract',
    'parsePort(value) returns an integer port for number inputs and decimal digit strings after trimming surrounding whitespace.',
    'Valid ports are 1 through 65535 inclusive. Null, undefined and a blank string mean no setting and return default port 3000.',
    'Every other value is invalid and returns null: zero, negative, larger ports, fractions, booleans, objects, NaN, Infinity, exponent strings, hex strings, signed strings and strings containing non-digits.',
    'Only src/port-config.js may change. Keep all skill packages and package.json intact.',
  ].join('\n') + '\n';
  return makeCase({
    strategy: 'skills', candidate: 'task_scoped_skills_v1', id: 'skills-port-config', fixture,
    targetPath: 'src/port-config.js', contextBudgetTokens: 8192,
    request: '请按仓库的 zz-port-config 技能说明修复 src/port-config.js 中的 parsePort(value)，使默认端口、十进制字符串和有效范围处理符合技能协议。只修改该源码文件，保留所有技能文件与 package.json。\n',
    expected: 'parsePort follows the zz-port-config protocol on valid inputs, unset values and invalid values. Original non-target files remain byte-identical. The host command checker is outside the agent workspace.\n',
    solution: [
      'export function parsePort(value) {',
      "  if (value == null || (typeof value === 'string' && value.trim() === '')) return 3000;",
      "  if (typeof value === 'string') { if (!/^\\d+$/.test(value.trim())) return null; value = Number(value.trim()); }",
      "  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;",
      '}', '',
    ].join('\n'),
    assertions: [
      'assert.equal(typeof m.parsePort, "function");',
      'for (const value of [1, 3000, 65535, "1", "3000", " 65535 ", "00123"]) assert.equal(m.parsePort(value), Number(value));',
      'for (const value of [undefined, null, "", " ", "\\t\\n"]) assert.equal(m.parsePort(value), 3000);',
      'for (const value of [0, -1, 65536, 1.2, NaN, Infinity, true, false, {}, [], "0", "65536", "1.2", "1e3", "0x50", "+80", "-1", "8 0", "80x"]) assert.equal(m.parsePort(value), null);',
    ].join('\n'), checks: 32,
  });
}

function diagnosticCase() {
  return makeCase({
    strategy: 'diagnostic', candidate: 'diagnostic_first_repair_v1', id: 'reg-24-error-handling',
    request: '`readJson(path)` in src/io.js should catch JSON parse errors and return null instead of throwing.\n',
    expected: 'Original reg-24-error-handling behavior: invalid JSON returns null and valid JSON still returns its object. Original data fixtures remain byte-identical. The immutable host checker also rejects early module termination.\n',
    fixture: {
      'src/io.js': "import { readFileSync } from 'node:fs';\nexport function readJson(path) {\n  return JSON.parse(readFileSync(path, 'utf8'));\n}\n",
      'data/good.json': '{"a":1}\n',
      'data/bad.json': '{not json\n',
    },
    targetPath: 'src/io.js', contextBudgetTokens: 32000,
    solution: "import { readFileSync } from 'node:fs';\nexport function readJson(path) {\n  const text = readFileSync(path, 'utf8');\n  try { return JSON.parse(text); } catch { return null; }\n}\n",
    assertions: [
      'assert.equal(typeof m.readJson, "function");',
      'assert.equal(m.readJson("data/bad.json"), null);',
      'assert.deepEqual(m.readJson("data/good.json"), { a: 1 });',
    ].join('\n'), checks: 3,
  });
}

function instructionsCase() {
  return makeCase({
    strategy: 'instructions', candidate: 'path_scoped_instructions_v1', id: 'instructions-api-retry-label',
    request: '请修复 packages/api/src/retry-label.js 的 makeRetryLabel(attempt)，遵守该路径适用的 AGENTS.md 协议。只修改该源码；保留 web/jobs 包及所有规则文档。\n',
    expected: 'Only the API target changes. Its marker is api-r3, attempts 1..3 yield api-r3/retry-N, and invalid attempts return null. Root/API rule documents apply; web/jobs rule markers must not leak. All original non-target files remain byte-identical.\n',
    fixture: {
      'package.json': '{"name":"scoped-instructions-pilot","private":true,"type":"module"}\n',
      'AGENTS.md': '# Repository rules\nOnly modify the requested package source. Preserve every AGENTS.md and all sibling package sources. Public functions use named exports.\n',
      'packages/api/AGENTS.md': '# API package rules\nmakeRetryLabel(attempt) uses marker api-r3. An integer attempt from 1 to 3 returns api-r3/retry-N. All other inputs return null, including strings, fractions, NaN and Infinity.\n',
      'packages/api/src/retry-label.js': 'export function makeRetryLabel(attempt) { return `shared/retry-${attempt}`; }\n',
      'packages/web/AGENTS.md': '# Web package rules\nThis package uses marker web-w9. Web retry labels use web-w9/retry-N. This rule applies only inside packages/web.\n',
      'packages/web/src/retry-label.js': 'export const WEB_MARKER = "web-w9";\n',
      'packages/jobs/AGENTS.md': '# Jobs package rules\nThis package uses marker jobs-j5. Jobs retry labels use jobs-j5/retry-N. This rule applies only inside packages/jobs.\n',
      'packages/jobs/src/retry-label.js': 'export const JOBS_MARKER = "jobs-j5";\n',
    },
    targetPath: 'packages/api/src/retry-label.js', contextBudgetTokens: 8192,
    solution: 'export function makeRetryLabel(attempt) { return Number.isInteger(attempt) && attempt >= 1 && attempt <= 3 ? `api-r3/retry-${attempt}` : null; }\n',
    assertions: [
      'assert.equal(typeof m.makeRetryLabel, "function");',
      'for (const attempt of [1, 2, 3]) assert.equal(m.makeRetryLabel(attempt), `api-r3/retry-${attempt}`);',
      'for (const attempt of [0, -1, 4, 1.5, "1", undefined, null, true, false, NaN, Infinity, {}, []]) assert.equal(m.makeRetryLabel(attempt), null);',
    ].join('\n'), checks: 17,
  });
}

export function pilotCases() { return [skillsCase(), diagnosticCase(), instructionsCase()]; }

export function caseFiles(caseDef) {
  return {
    'case.json': `${JSON.stringify(caseDef.metadata, null, 2)}\n`,
    'request.md': caseDef.request,
    'expected.md': caseDef.expected,
    ...Object.fromEntries(Object.entries(caseDef.fixture).map(([path, content]) => [`fixture/${path}`, content])),
  };
}

export function inputManifest() {
  const cases = pilotCases().map(caseDef => {
    const files = Object.fromEntries(Object.entries(caseFiles(caseDef)).sort(([a], [b]) => a.localeCompare(b))
      .map(([path, content]) => [path, sha256(content)]));
    return { strategy: caseDef.strategy, candidate: caseDef.candidate, caseId: caseDef.id,
      targetPath: caseDef.targetPath, fixtureFiles: Object.keys(caseDef.fixture).length,
      inputDigest: sha256(JSON.stringify(files)), files };
  });
  return { schemaVersion: PILOT_SCHEMA, purpose: 'exploratory-only', paidCalls: 0,
    repeat: 2, orderSeed: 19, armsPerStrategy: 4,
    inputDigest: sha256(JSON.stringify(cases)), cases };
}
