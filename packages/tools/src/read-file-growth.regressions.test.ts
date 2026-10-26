import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { newAgentId, newSessionId, newToolCallId, newTurnId, type ToolExecutionContext } from "@ar/contracts";
import { ToolRegistry } from "./registry.js";
import { ToolOrchestrator } from "./orchestrator.js";
import { MAX_FULL_READ_BYTES, readFileTool } from "./tools/read-file.js";
import { fileLockEntryCount } from "./file-coordination.js";

vi.mock("node:fs/promises", async original => ({
  ...await original<typeof import("node:fs/promises")>(),
  open: (...args: Parameters<typeof fs.open>) => fs.open(...args),
}));
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), "ar-read-growth-")); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

async function invoke(versioned: boolean) {
  const registry = new ToolRegistry(); registry.register(readFileTool);
  const orchestrator = new ToolOrchestrator({ registry, workspaceRoot: root });
  const ctx: ToolExecutionContext = {
    cwd: root, sessionId: newSessionId(), turnId: newTurnId(), agentId: newAgentId(), signal: new AbortController().signal,
    permissions: { rules: [{ action: "read", resource: "file", effect: "allow" }] },
    sandboxPolicy: { filesystem: { mode: "workspace-write" }, network: { mode: "deny" }, process: { maxOutputBytes: 100000 } },
  };
  const id = newToolCallId();
  return orchestrator.execute({ id, sessionId: ctx.sessionId, turnId: ctx.turnId, agentId: ctx.agentId,
    call: { id, name: "read_file", args: { path: "growing", versioned } } }, ctx);
}

it.each([false, true])("rejects actual external growth beyond the full-read limit (versioned=%s)", async versioned => {
  const path = join(root, "growing"); await fs.writeFile(path, "small");
  const open = fs.open.bind(fs); let owned: Awaited<ReturnType<typeof fs.open>> | undefined;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args); owned = handle;
    const stat = handle.stat.bind(handle);
    vi.spyOn(handle, "stat").mockImplementation(async () => {
      const original = await stat();
      // A separate writer changes the real opened file after its genuine stat.
      await fs.truncate(path, MAX_FULL_READ_BYTES + 1);
      return original;
    });
    return handle;
  });
  const result = await invoke(versioned);
  expect(result.status).toBe("failed");
  expect(result.error?.message).toContain("READ_FILE_TOO_LARGE");
  expect(result.output).toBeUndefined(); expect(result.evidence).toBeUndefined();
  expect(owned?.fd).toBe(-1); expect(fileLockEntryCount()).toBe(0);
});

it("accepts an exact-limit file without consuming an unbounded read", async () => {
  await fs.writeFile(join(root, "growing"), Buffer.alloc(MAX_FULL_READ_BYTES, 65));
  const result = await invoke(true);
  expect(result.status).toBe("success");
  expect(result.output).toMatchObject({ bytes: MAX_FULL_READ_BYTES });
  expect((result.output as { content: string }).content.length).toBe(MAX_FULL_READ_BYTES);
});

it("bounds actual bytes when a separate writer grows the file during reading", async () => {
  const path = join(root, "growing"); await fs.writeFile(path, Buffer.alloc(65536, 65));
  const open = fs.open.bind(fs); let observedBytes = 0, grew = false;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args); const read = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementation(async (...args: Parameters<typeof handle.read>) => {
      const result = await read(...args); observedBytes += result.bytesRead;
      if (!grew) { grew = true; await fs.truncate(path, MAX_FULL_READ_BYTES * 2); }
      return result;
    });
    return handle;
  });
  const result = await invoke(true);
  expect(result.status).toBe("failed"); expect(result.error?.message).toContain("READ_FILE_TOO_LARGE");
  expect(observedBytes).toBe(MAX_FULL_READ_BYTES + 1); expect(fileLockEntryCount()).toBe(0);
});

it("preserves UTF-8 and CRLF across short native reads", async () => {
  const bytes = Buffer.from("中文\r\n".repeat(120)); await fs.writeFile(join(root, "growing"), bytes);
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args); const read = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementation(async (...args: Parameters<typeof handle.read>) => {
      const [buffer, offset, length, position] = args as unknown as [Buffer, number, number, number | null];
      return read(buffer, offset, Math.min(length, 7), position);
    });
    return handle;
  });
  const result = await invoke(true);
  expect(result.status).toBe("success"); expect(result.output).toMatchObject({ content: bytes.toString("utf8"), bytes: bytes.length });
});
