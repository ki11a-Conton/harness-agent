import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { newAgentId, newSessionId, newToolCallId, newTurnId, type ToolExecutionContext } from "@ar/contracts";
import { ToolRegistry } from "./registry.js";
import { ToolOrchestrator } from "./orchestrator.js";
import { readFileTool } from "./tools/read-file.js";

let cwd: string;
let orchestrator: ToolOrchestrator;

beforeEach(async () => {
  cwd = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "ar-window-read-")));
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  orchestrator = new ToolOrchestrator({ registry, workspaceRoot: cwd });
});
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await fs.rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

async function invoke(args: Record<string, unknown>, options: { signal?: AbortSignal; deny?: boolean } = {}) {
  syncBuiltinESMExports();
  const id = newToolCallId();
  const ctx: ToolExecutionContext = {
    cwd, sessionId: newSessionId(), turnId: newTurnId(), agentId: newAgentId(),
    signal: options.signal ?? new AbortController().signal,
    permissions: { rules: [{ action: "read", resource: "file", effect: options.deny ? "deny" : "allow" }] },
    sandboxPolicy: { filesystem: { mode: "read-only" }, network: { mode: "deny" }, process: { maxOutputBytes: 65536 } },
  };
  return orchestrator.execute({ id, sessionId: ctx.sessionId, turnId: ctx.turnId, agentId: ctx.agentId,
    call: { id, name: "read_file", args: { path: "target.txt", ...args } } }, ctx);
}

function measureReads(onRead?: () => void) {
  const open = fs.open.bind(fs);
  const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  let bytes = 0;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    handles.push(handle);
    const read = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementation((async (buffer: Buffer, offset: number, length: number, position: number | null) => {
      const result = await read(buffer, offset, length, position);
      bytes += result.bytesRead;
      onRead?.();
      return result;
    }) as typeof handle.read);
    return handle;
  });
  return { handles, bytes: () => bytes };
}

it("reads one native block for a four-line window and preserves full-file reads when requested", async () => {
  const head = "ignore\r\nsource😀\r\n\r\nthird\r\nfourth\r\n";
  const file = head + "untouched trailer\n".repeat(500_000);
  const bytes = Buffer.byteLength(file);
  await fs.writeFile(join(cwd, "target.txt"), file);
  const meter = measureReads();
  const range = { offset: 2, limit: 4 };
  const baseline = await invoke(range);
  expect(baseline.output).toMatchObject({ content: "source😀\r\n\r\nthird\r\nfourth\r", startLine: 2,
    endLine: 5, nextOffset: 6, totalLines: 500005, truncated: true, bytes });
  const baselineBytes = meter.bytes();
  expect(baselineBytes).toBe(bytes);
  const window = await invoke({ ...range, scan: "window" });
  const windowBytes = meter.bytes() - baselineBytes;
  expect(windowBytes).toBeLessThanOrEqual(65536);
  expect(window.output).toMatchObject({ content: "source😀\r\n\r\nthird\r\nfourth\r", startLine: 2,
    endLine: 5, nextOffset: 6, scanComplete: false, scannedBytes: windowBytes, truncatedBy: "lines" });
  expect(window.output).not.toHaveProperty("totalLines");
  expect(window.output).not.toHaveProperty("sha256");
  expect(window.output).not.toHaveProperty("bytes");
  const versioned = await invoke({ ...range, versioned: true });
  expect(versioned.output).toMatchObject({ totalLines: 500005, bytes, sha256: createHash("sha256").update(file).digest("hex") });
  expect(meter.bytes() - baselineBytes - windowBytes).toBe(bytes);
  expect(meter.handles).toHaveLength(3);
  expect(meter.handles.every(handle => handle.fd === -1)).toBe(true);
  console.log(JSON.stringify({ baselineBytes, windowBytes, versionedBytes: bytes, sameWindow: true }));
});

it.each([
  ["empty file", "", 1, 1, "", 0],
  ["blank line", "\n", 1, 1, "", 1],
  ["terminal newline", "one\n", 1, 1, "one", 1],
  ["unterminated last line", "first\n最后😀", 2, 1, "最后😀", 2],
  ["newline at native chunk edge", "a".repeat(65535) + "\n", 1, 1, "a".repeat(65535), 1],
  ["UTF-8 across reads", "a".repeat(65535) + "😀", 1, 1, "a".repeat(65535) + "😀", 1],
] as const)("keeps exact EOF semantics for %s", async (_name, file, offset, limit, content, totalLines) => {
  await fs.writeFile(join(cwd, "target.txt"), file);
  const result = await invoke({ scan: "window", offset, limit, maxBytes: 80000 });
  expect(result.output).toMatchObject({ content, totalLines, truncated: false, scanComplete: true, bytes: Buffer.byteLength(file) });
  expect(result.output).not.toHaveProperty("nextOffset");
});

it("proves continuation at a chunk boundary without returning a partial line", async () => {
  await fs.writeFile(join(cwd, "target.txt"), "a".repeat(65535) + "\n\nend");
  const result = await invoke({ scan: "window", limit: 1, maxBytes: 65535 });
  expect(result.output).toMatchObject({ content: "a".repeat(65535), endLine: 1, nextOffset: 2,
    scanComplete: false, scannedBytes: 65540, truncated: true, truncatedBy: "lines" });
  const next = await invoke({ scan: "window", offset: 2, limit: 2 });
  expect(next.output).toMatchObject({ content: "\nend", totalLines: 3, scanComplete: true, truncated: false });
});

it("stops after proving first-line overflow without walking a giant line", async () => {
  await fs.writeFile(join(cwd, "target.txt"), "a".repeat(2 * 1024 * 1024));
  const meter = measureReads();
  const result = await invoke({ scan: "window", maxBytes: 10 });
  expect(result.output).toMatchObject({ firstLineExceedsLimit: true, content: "", scanComplete: false, truncatedBy: "bytes" });
  expect(result.output).not.toHaveProperty("nextOffset");
  expect(result.output).not.toHaveProperty("totalLines");
  expect(meter.bytes()).toBeLessThanOrEqual(65536);
});

it("returns a continuation when only a subsequent selected line exceeds the byte budget", async () => {
  await fs.writeFile(join(cwd, "target.txt"), "ok\r\n" + "中".repeat(30000));
  const result = await invoke({ scan: "window", limit: 2, maxBytes: 12 });
  expect(result.output).toMatchObject({ content: "ok\r", endLine: 1, nextOffset: 2, scanComplete: false,
    truncated: true, truncatedBy: "bytes" });
  expect(result.output).not.toHaveProperty("firstLineExceedsLimit");
});

it("rejects window plus versioned mode before opening and keeps permission denial authoritative", async () => {
  await fs.writeFile(join(cwd, "target.txt"), "first\nsecond");
  const meter = measureReads();
  const result = await invoke({ scan: "window", versioned: true });
  expect(result).toMatchObject({ status: "failed", error: { code: "TOOL_SCHEMA_ERROR", message: expect.stringContaining("versioned") } });
  expect((await invoke({ scan: "window" }, { deny: true })).status).toBe("denied");
  expect(meter.handles).toHaveLength(0);
});

it("cancels after an actual window read and closes the owned file without returning a page", async () => {
  await fs.writeFile(join(cwd, "target.txt"), "first\nsecond\n");
  const owner = new AbortController();
  const meter = measureReads(() => owner.abort());
  const result = await invoke({ scan: "window", limit: 1 }, { signal: owner.signal });
  expect(result).toMatchObject({ status: "cancelled" });
  expect(result.output).toBeUndefined();
  expect(meter.handles).toHaveLength(1);
  expect(meter.handles[0]?.fd).toBe(-1);
});
