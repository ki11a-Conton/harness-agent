import { constants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { newAgentId, newSessionId, newToolCallId, newTurnId, type ToolExecutionContext } from "@ar/contracts";
import { editFileTool, type EditFileInput } from "./tools/edit-file.js";
import { ToolRegistry } from "./registry.js";
import { ToolOrchestrator } from "./orchestrator.js";

const control = vi.hoisted(() => ({ diffFailure: false }));
vi.mock("./edit.js", async original => {
  const actual = await original<typeof import("./edit.js")>();
  return { ...actual, lineDiff: (...args: Parameters<typeof actual.lineDiff>) => {
    if (control.diffFailure) throw new Error("injected diff receipt failure");
    return actual.lineDiff(...args);
  } };
});
vi.mock("node:fs/promises", async original => ({
  ...await original<typeof import("node:fs/promises")>(),
  open: (...args: Parameters<typeof fs.open>) => fs.open(...args),
}));
const roots: string[] = [];
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
afterEach(async () => {
  control.diffFailure = false; vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 8 : 0, retryDelay: 50 });
});
async function fixture(body: string) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "edit-receipt-"))); roots.push(root);
  const path = join(root, "source.txt"); await fs.writeFile(path, body);
  const context: ToolExecutionContext = {
    sessionId: newSessionId(), turnId: newTurnId(), agentId: newAgentId(), cwd: root, signal: new AbortController().signal,
    permissions: { rules: [{ action: "*", resource: "*", effect: "allow" }] },
    sandboxPolicy: { filesystem: { mode: "workspace-write", allowedPaths: [root] }, network: { mode: "deny" }, process: {} },
  };
  let writes = 0;
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (String(args[0]) === path && typeof args[1] === "number" && (args[1] & constants.O_WRONLY)) writes++;
    return open(...args);
  });
  return { root, path, context, writes: () => writes,
    edit: (input: Omit<EditFileInput, "path">) => editFileTool.execute({ path: "source.txt", expectedSha256: digest(body), ...input }, context) };
}

it.each<{ name: string; body: string; input: Omit<EditFileInput, "path"> }>([
  { name: "anchor", body: "alpha\nbravo\n", input: { oldText: "alpha", newText: "alpha" } },
  { name: "occurrence", body: "repeat repeat\n", input: { oldText: "repeat", newText: "repeat", occurrence: 2 } },
  { name: "replaceAll", body: "repeat repeat\n", input: { oldText: "repeat", newText: "repeat", replaceAll: true } },
  { name: "range", body: "alpha\nbravo\n", input: { lineStart: 1, lineEnd: 1, replacement: "alpha" } },
  { name: "strict range", body: "alpha\nbravo\n", input: { profile: "strict", lineStart: 1, lineEnd: 1, replacement: "alpha" } },
  { name: "BOM and CRLF normalization", body: "\ufeffalpha\r\nbravo\r\n", input: { oldText: "alpha\nbravo", newText: "alpha\r\nbravo" } },
  { name: "batch", body: "alpha bravo", input: { edits: [{ oldText: "alpha", newText: "alpha" }, { oldText: "bravo", newText: "bravo" }] } },
  { name: "trailing empty logical line", body: "alpha\n", input: { lineStart: 2, lineEnd: 2, replacement: "" } },
  { name: "empty range beyond EOF", body: "alpha\n", input: { lineStart: 999, lineEnd: 999, replacement: "" } },
  { name: "empty file", body: "", input: { lineStart: 1, lineEnd: 1, replacement: "" } },
])("$name no-op makes no write and cannot claim a successful edit", async ({ body, input }) => {
  const f = await fixture(body); const result = await f.edit(input);
  expect(result.status).toBe("failed"); expect(result.error?.message).toMatch(/no change|identical/i);
  expect(result.output).toBeUndefined(); expect(result.evidence).toBeUndefined();
  expect(f.writes()).toBe(0); expect(await fs.readFile(f.path)).toEqual(Buffer.from(body));
});

it.each<Omit<EditFileInput, "path">>([
  { oldText: "alpha", newText: "ALPHA" },
  { oldText: "alpha", newText: "汉字😀" },
  { oldText: "alpha", newText: "�" },
  { oldText: "repeat", newText: "changed", occurrence: 2 },
  { oldText: "repeat", newText: "changed", replaceAll: true },
  { lineStart: 1, lineEnd: 1, replacement: "ALPHA", profile: "strict" },
  { edits: [{ oldText: "alpha", newText: "ALPHA" }, { oldText: "bravo", newText: "BRAVO" }] },
])("successful edit returns the SHA of the actual written bytes: %j", async input => {
  const body = "\ufeffalpha\r\nbravo\nrepeat repeat\r\n";
  const f = await fixture(body); const result = await f.edit(input); const bytes = await fs.readFile(f.path);
  expect(result.status).toBe("success"); expect(f.writes()).toBe(1);
  expect(result.output).toMatchObject({ sha256: digest(bytes) }); expect(digest(bytes)).not.toBe(digest(body));
  expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
});

it.each<{ name: string; input: Omit<EditFileInput, "path"> }>([
  { name: "high surrogate", input: { oldText: "alpha", newText: "\ud800" } },
  { name: "low surrogate", input: { oldText: "alpha", newText: "\udc00" } },
  { name: "split existing emoji", input: { oldText: "\ud83d", newText: "x" } },
  { name: "range", input: { lineStart: 1, lineEnd: 1, replacement: "\ud800" } },
])("unpaired Unicode is refused before writing: $name", async ({ input }) => {
  const body = "alpha🙂\n"; const f = await fixture(body); const result = await f.edit(input);
  expect(result.status).toBe("failed"); expect(result.error?.message).toMatch(/unicode|surrogate/i);
  expect(result.output).toBeUndefined(); expect(result.evidence).toBeUndefined();
  expect(f.writes()).toBe(0); expect(await fs.readFile(f.path)).toEqual(Buffer.from(body));
});

it("a diff preparation failure leaves the real file untouched", async () => {
  const f = await fixture("alpha\nbravo\n"); control.diffFailure = true;
  const result = await f.edit({ oldText: "alpha", newText: "ALPHA" });
  expect(result.status).toBe("failed"); expect(result.error?.message).toContain("injected diff receipt failure");
  expect(f.writes()).toBe(0); expect(await fs.readFile(f.path, "utf8")).toBe("alpha\nbravo\n");
});

it("the returned version does not authorize overwriting a later external change", async () => {
  const f = await fixture("alpha\nbravo\n"); const first = await f.edit({ oldText: "alpha", newText: "ALPHA" });
  expect(first.status).toBe("success");
  const receipt = first.output as unknown as { sha256: string }; expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
  await fs.writeFile(f.path, "external writer wins\n");
  const next = await f.edit({ expectedSha256: receipt.sha256, oldText: "ALPHA", newText: "wrong overwrite" });
  expect(next.status).toBe("failed"); expect(next.error?.safeToRetry).toBe(false);
  expect(f.writes()).toBe(1); expect(await fs.readFile(f.path, "utf8")).toBe("external writer wins\n");
});

it.each(["permission", "sandbox"])("no-op detection retains the actual orchestrator %s boundary", async gate => {
  const f = await fixture("alpha\n"); const registry = new ToolRegistry(); registry.register(editFileTool);
  const orchestrator = new ToolOrchestrator({ registry, workspaceRoot: f.root });
  const context: ToolExecutionContext = gate === "permission"
    ? { ...f.context, permissions: { rules: [{ action: "*", resource: "*", effect: "deny" }] } }
    : { ...f.context, sandboxPolicy: { ...f.context.sandboxPolicy, filesystem: { mode: "read-only" } } };
  const id = newToolCallId(); const result = await orchestrator.execute({ id, sessionId: context.sessionId, turnId: context.turnId,
    agentId: context.agentId, call: { id, name: "edit_file", args: { path: "source.txt", oldText: "alpha", newText: "alpha" } } }, context);
  expect(result.status).toBe("denied"); expect(f.writes()).toBe(0); expect(await fs.readFile(f.path, "utf8")).toBe("alpha\n");
});
