import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
it("edits an 8MiB ordinary source file in an isolated 128MiB Node heap", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "ar-edit-heap-"));
  const target = join(root, "generated.ts");
  const original = "MARKER=1;\n" + "// Ordinary generated source line\n".repeat(254200);
  try {
    await fs.writeFile(target, original);
    // pnpm test builds before Vitest. Use the actual built tool in a separate
    // Node process so the runner's own heap cannot hide per-character maps.
    const program = `
      import { editFileTool } from ${JSON.stringify(new URL("../dist/tools/edit-file.js", import.meta.url).href)};
      const result = await editFileTool.execute({ path: process.argv[1], oldText: "MARKER=1", newText: "MARKER=2" },
        { cwd: process.argv[2], signal: new AbortController().signal });
      if (result.status !== "success" || result.output.replacements !== 1) throw new Error(JSON.stringify(result));
      console.log(JSON.stringify({ status: result.status, replacements: result.output.replacements }));
    `;
    const child = await execute(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", program, target, root], { timeout: 20000, maxBuffer: 64 * 1024 });
    expect(JSON.parse(child.stdout)).toEqual({ status: "success", replacements: 1 }); expect(child.stderr).toBe("");
    expect(await fs.readFile(target, "utf8")).toBe(original.replace("MARKER=1", "MARKER=2"));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("edits eight million short lines and returns a bounded receipt inside a 64MiB Node heap", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "ar-edit-short-lines-"));
  const target = join(root, "generated.txt"); const original = "MARKER=1;\n" + "\n".repeat(8_000_000);
  try {
    await fs.writeFile(target, original);
    const program = `
      import {editFileTool} from ${JSON.stringify(new URL("../dist/tools/edit-file.js", import.meta.url).href)};
      import {createHash} from 'node:crypto';import {readFile} from 'node:fs/promises';
      const result=await editFileTool.execute({path:process.argv[1],oldText:'MARKER=1',newText:'MARKER=2'},
        {cwd:process.argv[2],signal:new AbortController().signal});
      if(result.status!=='success')throw new Error(JSON.stringify(result));
      const actual=createHash('sha256').update(await readFile(process.argv[1])).digest('hex');
      if(result.output.sha256!==actual)throw new Error('receipt version differs from actual bytes');
      console.log(JSON.stringify({status:result.status,diff:result.output.diff,replacements:result.output.replacements,sha256:actual}));
    `;
    const child = await execute(process.execPath, ["--max-old-space-size=64", "--input-type=module", "-e", program, target, root], { timeout: 20000, maxBuffer: 64 * 1024 });
    expect(JSON.parse(child.stdout)).toMatchObject({ status: "success", replacements: 1, diff: ["- MARKER=1;", "+ MARKER=2;"] });
    expect(child.stderr).toBe(""); expect(await fs.readFile(target, "utf8")).toBe(original.replace("MARKER=1", "MARKER=2"));
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 8 : 0, retryDelay: 50 }); }
});

it.each(["line range", "last occurrence", "replace all"] as const)("edits a dense generated file by %s inside a 64 MiB Node heap", async mode => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "ar-edit-offsets-")));
  const target = join(root, "generated.txt");
  const count = 8_000_000;
  const range = mode === "line range";
  const body = range ? "MARKER=1;\n" + "\n".repeat(12_000_000) : "a".repeat(count);
  const expected = range ? body.replace("MARKER=1;", "MARKER=2;") : mode === "replace all" ? "b".repeat(count) : "a".repeat(count - 1) + "b";
  const edit = range
    ? { lineStart: 1, lineEnd: 1, replacement: "MARKER=2;" }
    : { oldText: "a", newText: "b", ...(mode === "replace all" ? { replaceAll: true } : { occurrence: count }) };
  try {
    await fs.writeFile(target, body);
    const program = `
      import assert from "node:assert/strict";
      import { createHash } from "node:crypto";
      import { readFile } from "node:fs/promises";
      import { ToolOrchestrator } from ${JSON.stringify(new URL("../dist/orchestrator.js", import.meta.url).href)};
      import { ToolRegistry } from ${JSON.stringify(new URL("../dist/registry.js", import.meta.url).href)};
      import { editFileTool } from ${JSON.stringify(new URL("../dist/tools/edit-file.js", import.meta.url).href)};
      const [target, cwd, serializedEdit] = process.argv.slice(1);
      const sha256 = async () => createHash("sha256").update(await readFile(target)).digest("hex");
      const expectedSha256 = await sha256();
      const registry = new ToolRegistry();
      registry.register(editFileTool);
      const orchestrator = new ToolOrchestrator({ registry, workspaceRoot: cwd });
      const context = { cwd, sessionId: "session_fixture", turnId: "turn_fixture", agentId: "agent_fixture",
        signal: new AbortController().signal,
        permissions: { rules: [{ action: "*", resource: "*", effect: "allow" }] },
        sandboxPolicy: { filesystem: { mode: "workspace-write", allowedPaths: [cwd] }, network: { mode: "deny" }, process: {} } };
      const id = "toolcall_fixture";
      const { sessionId, turnId, agentId } = context;
      const result = await orchestrator.execute({ id, sessionId, turnId, agentId,
        call: { id, name: "edit_file", args: { path: target, expectedSha256, profile: "strict", ...JSON.parse(serializedEdit) } } },
        context);
      assert.equal(result.status, "success", JSON.stringify(result.error));
      assert.equal(result.output.sha256, await sha256());
      console.log(JSON.stringify(result.output));
    `;
    const child = await execute(process.execPath,
      ["--max-old-space-size=64", "--input-type=module", "-e", program, target, root, JSON.stringify(edit)],
      { timeout: 20000, maxBuffer: 64 * 1024 });
    expect(JSON.parse(child.stdout)).toMatchObject(range ? { replacedLines: 1 } : { replacements: mode === "replace all" ? count : 1 });
    expect(child.stderr).toBe("");
    expect(Buffer.compare(await fs.readFile(target), Buffer.from(expected))).toBe(0);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

it("refuses a repeated unversioned strict replaceAll before expanding the replacement", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "ar-edit-ambiguity-"));
  const target = join(root, "source.txt");
  const body = "a".repeat(8_000_000);
  try {
    await fs.writeFile(target, body);
    const program = `
      import assert from "node:assert/strict";
      import { editFileTool } from ${JSON.stringify(new URL("../dist/tools/edit-file.js", import.meta.url).href)};
      const [path, cwd] = process.argv.slice(1);
      const result = await editFileTool.execute({ path, profile: "strict", oldText: "a", newText: "bb", replaceAll: true },
        { cwd, signal: new AbortController().signal });
      assert.equal(result.status, "failed");
      assert.match(result.error.message, /line 1, column 1 and line 1, column 2/);
    `;
    await execute(process.execPath, ["--max-old-space-size=64", "--input-type=module", "-e", program, target, root], { timeout: 20000 });
    expect(await fs.readFile(target, "utf8")).toBe(body);
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); }
});
