import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { newAgentId, newSessionId, newToolCallId, newTurnId, type ToolExecutionContext } from "@ar/contracts";
import { applyBatchReplace, MAX_BATCH_EDITS, type TextEdit } from "./edit.js";
import { editFileTool, type EditFileInput } from "./tools/edit-file.js";
import { ToolRegistry } from "./registry.js";
import { ToolOrchestrator } from "./orchestrator.js";

const writes = vi.hoisted(() => ({ path: "", count: 0 }));
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]) === writes.path) writes.count++;
    return fs.writeFile(...args);
  } };
});
const roots: string[] = [];
afterEach(async () => {
  writes.path = ""; writes.count = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 8 : 0, retryDelay: 50 });
});
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture(content: string | Buffer = "const first = 1;\nconst second = 2;\nconst third = 3;\n") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "coding-batch-"))); roots.push(root);
  const path = join(root, "code.ts"); await writeFile(path, content);
  const context: ToolExecutionContext = {
    sessionId: newSessionId(), turnId: newTurnId(), agentId: newAgentId(), cwd: root, signal: new AbortController().signal,
    permissions: { rules: [{ action: "*", resource: "*", pattern: "**/*", effect: "allow" }] },
    sandboxPolicy: { filesystem: { mode: "workspace-write", allowedPaths: [root] }, network: { mode: "deny" }, process: {} },
  };
  writes.path = path; writes.count = 0;
  return { root, path, context, content, expectedSha256: hash(content) };
}
const edits: TextEdit[] = [{ oldText: "first = 1", newText: "first = 10" }, { oldText: "second = 2", newText: "second = 20" }, { oldText: "third = 3", newText: "third = 30" }];

it("batch edit preserves BOM and mixed line endings with one real write", async () => {
  const original = "\ufeffconst first = 1;\r\n// untouched 🙂 ‘quoted’  \nconst second = 2;\nconst third = 3;";
  const f = await fixture(original);
  const result = await editFileTool.execute({ path: f.path, expectedSha256: f.expectedSha256, edits }, f.context);
  expect(result.status).toBe("success"); expect(result.output?.replacements).toBe(3); expect(writes.count).toBe(1);
  const expected = "\ufeffconst first = 10;\r\n// untouched 🙂 ‘quoted’  \nconst second = 20;\nconst third = 30;";
  expect(await readFile(f.path)).toEqual(Buffer.from(expected));
});

it("batch anchors all match the original snapshot rather than previous replacements", async () => {
  const f = await fixture("alpha beta");
  const result = await editFileTool.execute({ path: f.path, expectedSha256: f.expectedSha256, edits: [
    { oldText: "alpha", newText: "created" }, { oldText: "created", newText: "incorrect cascade" },
  ] }, f.context);
  expect(result.status).toBe("failed"); expect(result.error?.message).toContain("edits[1]");
  expect(await readFile(f.path, "utf8")).toBe("alpha beta"); expect(writes.count).toBe(0);
});

it.each([
  { name: "missing later anchor", body: "abc def", edits: [{ oldText: "abc", newText: "A" }, { oldText: "missing", newText: "B" }] },
  { name: "nested anchors", body: "abcdef", edits: [{ oldText: "abcde", newText: "A" }, { oldText: "bcd", newText: "B" }] },
  { name: "overlapping anchors", body: "abcdef", edits: [{ oldText: "abcd", newText: "A" }, { oldText: "def", newText: "B" }] },
  { name: "duplicate anchors", body: "abc def", edits: [{ oldText: "abc", newText: "A" }, { oldText: "abc", newText: "B" }] },
  { name: "repeated anchor", body: "abc abc def", edits: [{ oldText: "abc", newText: "A" }] },
  { name: "overlapping occurrences within an anchor", body: "aaa", edits: [{ oldText: "aa", newText: "B" }] },
  { name: "empty anchor", body: "abc", edits: [{ oldText: "", newText: "A" }] },
  { name: "BOM-only anchor", body: "\ufeffabc", edits: [{ oldText: "\ufeff", newText: "A" }] },
])("batch preflight makes zero writes for $name", async sample => {
  const f = await fixture(sample.body);
  const r = await editFileTool.execute({ path: f.path, expectedSha256: f.expectedSha256, edits: sample.edits }, f.context);
  expect(r.status).toBe("failed"); expect(await readFile(f.path, "utf8")).toBe(sample.body); expect(writes.count).toBe(0);
});

it.each<Partial<EditFileInput>>([{ oldText: "x" }, { newText: "x" }, { replaceAll: false }, { occurrence: 1 }, { lineStart: 1 }, { lineEnd: 1 }, { replacement: "x" }])("batch rejects legacy selection fields before writing: %j", async extra => {
  const f = await fixture();
  const r = await editFileTool.execute({ path: f.path, edits, expectedSha256: f.expectedSha256, ...extra }, f.context);
  expect(r.status).toBe("failed"); expect(r.error?.code).toBe("TOOL_SCHEMA_ERROR");
  expect(await readFile(f.path, "utf8")).toBe(f.content); expect(writes.count).toBe(0);
});

it("batch requires a read version even with compatibility profile", async () => {
  const f = await fixture(); const r = await editFileTool.execute({ path: f.path, edits, profile: "compatibility" }, f.context);
  expect(r.error?.code).toBe("TOOL_SCHEMA_ERROR"); expect(writes.count).toBe(0); expect(await readFile(f.path, "utf8")).toBe(f.content);
});
it("batch rejects a stale read without overwriting concurrent content", async () => {
  const f = await fixture(); writes.path = ""; await writeFile(f.path, "user edits retained\n"); writes.path = f.path;
  const r = await editFileTool.execute({ path: f.path, edits, expectedSha256: f.expectedSha256 }, f.context);
  expect(r.status).toBe("failed"); expect(r.error?.safeToRetry).toBe(false); expect(await readFile(f.path, "utf8")).toBe("user edits retained\n"); expect(writes.count).toBe(0);
});
it("two concurrent batches with one read version commit only one whole result", async () => {
  const f = await fixture();
  const results = await Promise.all([editFileTool.execute({ path: f.path, edits, expectedSha256: f.expectedSha256 }, f.context),
    editFileTool.execute({ path: f.path, edits: edits.map(e => ({ ...e, newText: e.newText + "0" })), expectedSha256: f.expectedSha256 }, f.context)]);
  expect(results.filter(r => r.status === "success")).toHaveLength(1); expect(results.filter(r => r.status === "failed")).toHaveLength(1); expect(writes.count).toBe(1);
  const bytes = await readFile(f.path, "utf8"); expect(["const first = 10;\nconst second = 20;\nconst third = 30;\n", "const first = 100;\nconst second = 200;\nconst third = 300;\n"]).toContain(bytes);
});
it("cancelled batch does not read or write its target", async () => {
  const f = await fixture(); const controller = new AbortController(); controller.abort();
  expect((await editFileTool.execute({ path: f.path, edits, expectedSha256: f.expectedSha256 }, { ...f.context, signal: controller.signal })).status).toBe("cancelled");
  expect(writes.count).toBe(0); expect(await readFile(f.path, "utf8")).toBe(f.content);
});
it("batch rejects invalid UTF-8 without a lossy rewrite", async () => {
  const f = await fixture(Buffer.from([0xff, 0xfe, 0x61]));
  expect((await editFileTool.execute({ path: f.path, expectedSha256: f.expectedSha256, edits }, f.context)).status).toBe("failed");
  expect(await readFile(f.path)).toEqual(f.content); expect(writes.count).toBe(0);
});
it.each(["permission", "sandbox"])("batch retains the real orchestrator %s denial boundary", async gate => {
  const f = await fixture(); const registry = new ToolRegistry(); registry.register(editFileTool);
  const orch = new ToolOrchestrator({ registry, workspaceRoot: f.root });
  const context: ToolExecutionContext = gate === "permission" ? { ...f.context, permissions: { rules: [{ action: "*", resource: "*", pattern: "**/*", effect: "deny" as const }] } }
    : { ...f.context, sandboxPolicy: { ...f.context.sandboxPolicy, filesystem: { mode: "read-only" as const } } };
  const r = await orch.execute({ id: newToolCallId(), sessionId: context.sessionId, turnId: context.turnId, agentId: context.agentId,
    call: { id: newToolCallId(), name: "edit_file", args: { path: f.path, expectedSha256: f.expectedSha256, edits } } }, context);
  expect(r.status).toBe("denied"); expect(await readFile(f.path, "utf8")).toBe(f.content); expect(writes.count).toBe(0);
});
it("batch ordering cannot change disjoint results and does not homogenize untouched lines", () => {
  const body = "\ufeffalpha\r\nunchanged\nbravo\ncharlie\r\n";
  const jobs = [{ oldText: "\ufeffalpha\n", newText: "\ufeffALPHA\nMORE\n" }, { oldText: "bravo", newText: "BRAVO\nB" }, { oldText: "charlie", newText: "" }];
  const expected = "\ufeffALPHA\r\nMORE\r\nunchanged\nBRAVO\nB\n\r\n";
  for (const order of [jobs, [...jobs].reverse(), [jobs[1]!, jobs[2]!, jobs[0]!]]) expect(applyBatchReplace(body, order)).toMatchObject({ ok: true, content: expected, count: 3 });
});
it("adjacent original anchors can swap text without cascading", () => {
  expect(applyBatchReplace("leftRIGHT", [{ oldText: "left", newText: "RIGHT" }, { oldText: "RIGHT", newText: "left" }])).toMatchObject({ ok: true, content: "RIGHTleft" });
});
it("batch does not normalize distinct Unicode source characters", () => {
  for (const [body, oldText] of [["Ａ", "A"], ["‘x’", "'x'"]]) expect(applyBatchReplace(body!, [{ oldText: oldText!, newText: "changed" }])).toMatchObject({ ok: false, content: body });
});
it("batch schemas and pure preflight share a bounded 1..64 edit contract", () => {
  for (const count of [0, MAX_BATCH_EDITS + 1]) {
    const jobs = Array.from({ length: count }, () => ({ oldText: "a", newText: "b" }));
    expect(editFileTool.inputSchema.safeParse({ path: "x", edits: jobs }).success).toBe(false); expect(applyBatchReplace("a", jobs).ok).toBe(false);
  }
  const jobs = Array.from({ length: 64 }, (_, i) => ({ oldText: `key_${i}=`, newText: `changed_${i}=` }));
  expect(applyBatchReplace(jobs.map(e => e.oldText).join("\n"), jobs)).toMatchObject({ ok: true, count: 64 });
});
it("a no-op batch never writes", async () => {
  const f = await fixture("retained"); const r = await editFileTool.execute({ path: f.path, expectedSha256: f.expectedSha256, edits: [{ oldText: "retained", newText: "retained" }] }, f.context);
  expect(r.status).toBe("failed"); expect(writes.count).toBe(0); expect(await readFile(f.path, "utf8")).toBe("retained");
});
