/** Offline comparison. Pass a checkout's compiled packages/tools/dist/index.js. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2]))
  : new URL('../../packages/tools/dist/index.js', import.meta.url);
const { editFileTool, readFileTool, ToolOrchestrator, ToolRegistry } = await import(entry.href);
const registry = new ToolRegistry();
registry.register(editFileTool);
registry.register(readFileTool);
const cwd = await realpath(await mkdtemp(join(tmpdir(), 'edit-anchor-recovery-')));
const file = 'example.ts';
const target = join(cwd, file);
const tools = new ToolOrchestrator({ registry, workspaceRoot: cwd });
const context = {
  cwd, signal: new AbortController().signal, sessionId: randomUUID(), turnId: randomUUID(), agentId: randomUUID(),
  permissions: { rules: [{ action: '*', resource: '*', effect: 'allow' }] },
  sandboxPolicy: { filesystem: { mode: 'workspace-write', allowedPaths: [cwd] }, network: { mode: 'deny' }, process: {} },
};
const digest = text => createHash('sha256').update(text).digest('hex');
function call(name, args) {
  const id = randomUUID();
  return tools.execute({ id, sessionId: context.sessionId, turnId: context.turnId, agentId: context.agentId,
    call: { id, name, args: { path: file, ...args } } }, context);
}

const location = /read_file with offset=(\d+), limit=(\d+), versioned=true/;
const result = { positiveCases: 0, initialFailuresUnmodified: 0, correctReadWindows: 0, versionCheckedRepairs: 0, negativeControls: 0 };
try {
  for (const eol of ['\n', '\r\n']) {
    for (const [mode, offset, limit] of [['single', 2, 1], ['multi', 50, 2], ['batch', 104, 2]]) {
      const block = ['\tlet quantity = 1;', '  return quantity;'].slice(0, limit);
      const before = ['// header', ...Array(offset - 2).fill('// fixture'), ...block, '// footer'].join(eol) + eol;
      await writeFile(target, before);
      const oldText = block.map(line => '        ' + line.trimStart()).join('\n');
      const edit = { oldText, newText: 'let quantity = 2;' };
      const batch = mode === 'batch';
      const failure = await call('edit_file', batch ? { expectedSha256: digest(before), edits: [edit] } : edit);
      result.positiveCases++;
      assert.equal(failure.status, 'failed');
      assert.equal(await readFile(target, 'utf8'), before);
      result.initialFailuresUnmodified++;

      const hint = location.exec(failure.error.message);
      if (!hint) continue; // A baseline without this diagnostic is a valid comparison.
      const window = { offset: Number(hint[1]), limit: Number(hint[2]) };
      assert.deepEqual(window, { offset, limit });
      result.correctReadWindows++;
      const page = await call('read_file', { ...window, versioned: true });
      assert.equal(page.status, 'success');
      assert.equal(page.output.sha256, digest(before));
      const copied = page.output.content;
      assert.equal(copied, block.join(eol));
      const exact = { oldText: copied, newText: copied.replace('= 1;', '= 2;') };
      const repaired = await call('edit_file', { ...(batch ? { edits: [exact] } : exact), profile: 'strict', expectedSha256: page.output.sha256 });
      const after = before.replace('= 1;', '= 2;');
      assert.equal(repaired.status, 'success');
      assert.equal(await readFile(target, 'utf8'), after);
      assert.equal(repaired.output.sha256, digest(after));
      result.versionCheckedRepairs++;
    }
  }
  const controls = [
    ['  return x;\n\treturn x;', '     return x;'], ['return xy;', '   return x;'],
    ['return x + y;', '  return x+y;'], ['x\ny', '  x\n\n  y'], ['\n\n', '   '], ['return x;', '   return x;\n'],
  ];
  for (const [before, oldText] of controls) {
    await writeFile(target, before);
    const response = await call('edit_file', { oldText, newText: 'unused' });
    assert.equal(response.status, 'failed');
    assert.doesNotMatch(response.error.message, location);
    assert.equal(await readFile(target, 'utf8'), before);
    result.negativeControls++;
  }
  console.log(JSON.stringify(result));
} finally {
  await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
