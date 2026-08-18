import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ApprovalResolver,
  EventSink,
  PermissionPolicy,
  SandboxPolicy,
  ToolCallRequest,
  ToolExecutionContext,
} from "@ar/contracts";
import { newAgentId, newSessionId, newToolCallId, newTurnId } from "@ar/contracts";
import { InMemoryApprovalStore, StoreApprovalResolver } from "@ar/security";
import { ToolRegistry } from "./registry.js";
import { ToolOrchestrator } from "./orchestrator.js";
import { readFileTool } from "./tools/read-file.js";
import { writeFileTool } from "./tools/write-file.js";
import { editFileTool } from "./tools/edit-file.js";
import { searchFilesTool } from "./tools/search-files.js";
import { execTool } from "./tools/exec.js";

const AID = newAgentId();
const SID = newSessionId();
const TID = newTurnId();

let ws = "";

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "ar-vs-"));
});

afterAll(() => {
  // Windows: freshly-spawned child processes (or AV scan) can transiently
  // hold a handle; retry before giving up so a clean exit is the norm.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(ws, { recursive: true, force: true });
      return;
    } catch {
      const wait = (attempt + 1) * 50;
      const end = Date.now() + wait;
      // eslint-disable-next-line no-empty
      while (Date.now() < end) {}
    }
  }
  rmSync(ws, { recursive: true, force: true });
});

const ALLOW_ALL_EDIT: PermissionPolicy = {
  rules: [
    { action: "read", resource: "file", pattern: "**/*", effect: "allow" },
    { action: "edit", resource: "file", pattern: "**/*", effect: "allow" },
    { action: "exec", resource: "command", pattern: "**/*", effect: "allow" },
  ],
};

const sandbox: SandboxPolicy = {
  filesystem: { mode: "workspace-write", allowedPaths: [ws] },
  network: { mode: "deny" },
  process: { timeoutMs: 10_000, maxOutputBytes: 1_000_000 },
};

function ctx(over: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    sessionId: SID,
    turnId: TID,
    agentId: AID,
    cwd: ws,
    signal: new AbortController().signal,
    permissions: ALLOW_ALL_EDIT,
    sandboxPolicy: sandbox,
    ...over,
  };
}

function req(name: string, args: Record<string, unknown>): ToolCallRequest {
  return {
    id: newToolCallId(),
    sessionId: SID,
    turnId: TID,
    agentId: AID,
    call: { id: newToolCallId(), name, args },
  };
}

function makeOrch(opts: { approval?: ApprovalResolver; events?: EventSink } = {}) {
  const registry = new ToolRegistry();
  for (const t of [readFileTool, writeFileTool, editFileTool, searchFilesTool, execTool]) {
    registry.register(t);
  }
  return new ToolOrchestrator({ registry, approval: opts.approval, events: opts.events, workspaceRoot: ws });
}

describe("filesystem tool set (VS-001)", () => {
  it("write_file then read_file roundtrip", async () => {
    const orch = makeOrch();
    const w = await orch.execute(req("write_file", { path: "a.txt", content: "line1\nline2" }), ctx());
    expect(w.status).toBe("success");
    expect(w.evidence?.[0]).toMatchObject({ type: "file" });
    const r = await orch.execute(req("read_file", { path: join(ws, "a.txt") }), ctx());
    expect(r.status).toBe("success");
    expect(r.output).toBe("line1\nline2");
  });

  it("write_file append mode", async () => {
    const orch = makeOrch();
    await orch.execute(req("write_file", { path: "b.txt", content: "x" }), ctx());
    const app = await orch.execute(req("write_file", { path: "b.txt", content: "y", append: true }), ctx());
    expect(app.status).toBe("success");
    const r = await orch.execute(req("read_file", { path: join(ws, "b.txt") }), ctx());
    expect(r.output).toBe("xy");
  });

  it("write_file denied outside workspace by sandbox", async () => {
    const orch = makeOrch();
    const r = await orch.execute(req("write_file", { path: join(ws, "..", "evil.txt"), content: "x" }), ctx());
    expect(r.status).toBe("denied");
    expect(r.error?.code).toBe("SANDBOX_FILESYSTEM_DENIED");
  });

  it("edit_file replaces first occurrence; failed when anchor missing", async () => {
    const orch = makeOrch();
    await orch.execute(req("write_file", { path: "e.txt", content: "aaa bbb aaa" }), ctx());
    const e = await orch.execute(req("edit_file", { path: "e.txt", oldText: "aaa", newText: "X" }), ctx());
    expect(e.status).toBe("success");
    expect((e.output as { replacements: number }).replacements).toBe(1);
    const r = await orch.execute(req("read_file", { path: join(ws, "e.txt") }), ctx());
    expect(r.output).toBe("X bbb aaa");

    const miss = await orch.execute(req("edit_file", { path: "e.txt", oldText: "zzz", newText: "X" }), ctx());
    expect(miss.status).toBe("failed");
    expect(miss.error?.message).toContain("anchor not found");
  });

  it("edit_file replaceAll", async () => {
    const orch = makeOrch();
    await orch.execute(req("write_file", { path: "f.txt", content: "a-a-a" }), ctx());
    const e = await orch.execute(req("edit_file", { path: "f.txt", oldText: "a", newText: "b", replaceAll: true }), ctx());
    expect(e.status).toBe("success");
    expect((e.output as { replacements: number }).replacements).toBe(3);
  });

  it("search_files finds files by basename and glob", async () => {
    mkdirSync(join(ws, "sub"), { recursive: true });
    writeFileSync(join(ws, "x.ts"), "hi");
    writeFileSync(join(ws, "sub", "y.ts"), "hi");
    writeFileSync(join(ws, "z.txt"), "hi");
    const orch = makeOrch();
    const byExt = await orch.execute(req("search_files", { pattern: "**/*.ts" }), ctx());
    expect(byExt.status).toBe("success");
    expect(byExt.output).toEqual(expect.arrayContaining(["x.ts", "sub/y.ts"]));
    const byName = await orch.execute(req("search_files", { pattern: "z.txt" }), ctx());
    expect(byName.output).toEqual(["z.txt"]);
  });
});

describe("exec tool through orchestrator (EXEC-001)", () => {
  it("runs allowed commands with sandbox allowlist gate", async () => {
    const orch = makeOrch();
    const r = await orch.execute(req("exec", { command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('ok')"` }), ctx({
      sandboxPolicy: {
        ...sandbox,
        process: { timeoutMs: 10_000, maxOutputBytes: 1_000_000, allowedCommands: ["**/*"] },
      },
    }));
    expect(r.status).toBe("success");
    expect((r.output as { stdout: string }).stdout).toBe("ok");
  });

  it("denies commands not in the allowlist", async () => {
    const orch = makeOrch();
    const r = await orch.execute(req("exec", { command: `${JSON.stringify(process.execPath)} -e "1"` }), ctx({
      sandboxPolicy: {
        ...sandbox,
        process: { timeoutMs: 10_000, maxOutputBytes: 1_000_000, allowedCommands: ["pnpm test"] },
      },
    }));
    expect(r.status).toBe("denied");
    expect(r.error?.code).toBe("SANDBOX_PROCESS_DENIED");
  });

  it("streams tool.output events", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sink: EventSink = {
      async emit(_sid, type, payload) {
        events.push({ type, payload });
      },
    };
    const orch = makeOrch({ events: sink });
    const r = await orch.execute(
      req("exec", { command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('chunk1')"` }),
      ctx({ sandboxPolicy: { ...sandbox, process: { timeoutMs: 10_000, maxOutputBytes: 1_000_000, allowedCommands: ["**/*"] } } }),
    );
    expect(r.status).toBe("success");
    const outputs = events.filter((e) => e.type === "tool.output");
    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs.map((o) => o.payload.text).join("")).toContain("chunk1");
  });

  it("times out long-running commands with PROCESS_TIMEOUT", async () => {
    const orch = makeOrch();
    const r = await orch.execute(req("exec", { command: `${JSON.stringify(process.execPath)} -e "setTimeout(()=>{},10000)"` }), ctx({
      sandboxPolicy: { ...sandbox, process: { timeoutMs: 200, maxOutputBytes: 1_000_000, allowedCommands: ["**/*"] } },
    }));
    expect(r.status).toBe("timeout");
    expect(r.error?.code).toBe("PROCESS_TIMEOUT");
  });

  it("routes elevated exec through approval when policy asks", async () => {
    const store = new InMemoryApprovalStore();
    const approval = new StoreApprovalResolver(store);
    const orch = makeOrch({ approval });
    const askCtx = ctx({
      permissions: { rules: [], defaultEffect: "ask" },
      sandboxPolicy: { ...sandbox, process: { timeoutMs: 10_000, maxOutputBytes: 1_000_000, allowedCommands: ["**/*"] } },
    });
    const p = orch.execute(req("exec", { command: `${JSON.stringify(process.execPath)} -e "1"` }), askCtx);
    await new Promise((r) => setTimeout(r, 20));
    const pending = store.listPending(SID);
    expect(pending.length).toBe(1);
    store.resolve(pending[0]!.id, "allow");
    const result = await p;
    expect(result.status).toBe("success");
  });
});