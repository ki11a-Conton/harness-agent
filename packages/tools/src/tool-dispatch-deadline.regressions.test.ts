import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventSink, ToolExecutionContext } from "@ar/contracts";
import { newAgentId, newSessionId, newToolCallId, newTurnId, TURN_TIME_LIMIT_EXCEEDED } from "@ar/contracts";
import { ToolRegistry } from "./registry.js";
import { CAMPAIGN_DEADLINE_EXCEEDED, ToolOrchestrator, type ToolDispatchBudget } from "./orchestrator.js";
import { writeFileTool } from "./tools/write-file.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(options: { crossAt?: "reservation" | "started"; withBudget?: boolean; cancelAt?: "reservation" | "started"; expiredInitially?: boolean; turnLimit?: number } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "dispatch-deadline-")); roots.push(cwd);
  const { turnLimit } = options;
  let now = options.expiredInitially ? 1_000 : 900;
  const ac = new AbortController();
  const settle = vi.fn(async (_outcome: string) => {});
  const reserve = vi.fn(async () => {
    if (options.crossAt === "reservation") now = 1_000;
    if (options.cancelAt === "reservation") ac.abort();
    return { ok: true, settle };
  });
  const events: string[] = [];
  const sink: EventSink = {
    async emit(_sessionId, type) {
      events.push(type);
      if (type === "tool.started") {
        if (options.crossAt === "started") now = 1_001;
        if (options.cancelAt === "started") ac.abort();
      }
    },
  };
  const registry = new ToolRegistry(); registry.register(writeFileTool);
  const orchestrator = new ToolOrchestrator({
    registry, workspaceRoot: cwd, events: sink, now: () => now,
    ...(turnLimit === undefined ? { dispatchDeadlineAtMs: () => 1_000 } : {}),
    ...(options.withBudget === false ? {} : { toolBudget: { reserve } satisfies ToolDispatchBudget }),
  });
  const context: ToolExecutionContext = {
    cwd, sessionId: newSessionId(), agentId: newAgentId(), turnId: newTurnId(), signal: ac.signal,
    ...(turnLimit !== undefined && { turnTimeLimitExceeded: () => now > turnLimit }),
    permissions: { rules: [{ action: "edit", resource: "file", pattern: "**/*", effect: "allow" }] },
    sandboxPolicy: { filesystem: { mode: "workspace-write" }, network: { mode: "deny" }, process: { timeoutMs: 500 } },
  };
  const path = join(cwd, "must-not-write.txt");
  const execute = () => orchestrator.execute({
    id: newToolCallId(), sessionId: context.sessionId, agentId: context.agentId, turnId: context.turnId,
    call: { id: newToolCallId(), name: "write_file", args: { path, content: "actual side effect" } },
  }, context);
  return { execute, path, reserve, settle, events };
}

describe("campaign deadline at the actual tool body boundary", () => {
  it("refuses an already expired task before reserving and publishes one failure", async () => {
    const f = fixture({ expiredInitially: true });
    const result = await f.execute();
    expect(result.metadata?.reasonCode).toBe(CAMPAIGN_DEADLINE_EXCEEDED);
    expect(existsSync(f.path)).toBe(false);
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.settle).not.toHaveBeenCalled();
    expect(f.events.filter(type => type === "tool.failed")).toHaveLength(1);
    expect(f.events).not.toContain("tool.started");
  });

  it.each(["reservation", "started"] as const)("refuses an actual write when %s crosses the deadline", async crossAt => {
    const f = fixture({ crossAt });
    const result = await f.execute();
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("RESOURCE_LIMIT");
    expect(result.metadata?.reasonCode).toBe(CAMPAIGN_DEADLINE_EXCEEDED);
    expect(result.metadata?.preDispatch).toBe(true);
    expect(existsSync(f.path)).toBe(false);
    expect(f.reserve).toHaveBeenCalledTimes(1);
    expect(f.settle).toHaveBeenCalledExactlyOnceWith("not_executed");
    expect(f.events.filter(type => type === "tool.failed")).toHaveLength(1);
    expect(f.events).not.toContain("tool.completed");
    if (crossAt === "reservation") expect(f.events).not.toContain("tool.started");
  });

  it("checks after tool.started even without a dispatch budget", async () => {
    const f = fixture({ crossAt: "started", withBudget: false });
    const result = await f.execute();
    expect(result.metadata?.reasonCode).toBe(CAMPAIGN_DEADLINE_EXCEEDED);
    expect(existsSync(f.path)).toBe(false);
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.settle).not.toHaveBeenCalled();
  });

  it("preserves an admitted write and charges the actual dispatch once", async () => {
    const f = fixture();
    const result = await f.execute();
    expect(result.status).toBe("success");
    expect(readFileSync(f.path, "utf8")).toBe("actual side effect");
    expect(f.settle).toHaveBeenCalledExactlyOnceWith("dispatched");
    expect(f.events).toContain("tool.completed");
  });

  it.each(["reservation", "started"] as const)("preserves cancellation at %s and releases its reservation", async cancelAt => {
    const f = fixture({ cancelAt });
    const result = await f.execute();
    expect(result.status).toBe("cancelled");
    expect(existsSync(f.path)).toBe(false);
    expect(f.settle).toHaveBeenCalledExactlyOnceWith("not_executed");
  });
});

describe("turn time limit at the actual tool body boundary", () => {
  it("releases the dispatch reservation if it consumes the remaining turn time", async () => {
    const f = fixture({ crossAt: "reservation", turnLimit: 999 });
    const result = await f.execute();
    expect(result).toMatchObject({ status: "failed", error: { code: "RESOURCE_LIMIT" },
      metadata: { reasonCode: TURN_TIME_LIMIT_EXCEEDED, preDispatch: true } });
    expect(existsSync(f.path)).toBe(false);
    expect(f.settle).toHaveBeenCalledExactlyOnceWith("not_executed");
    expect(f.events).not.toContain("tool.started");
  });

  it("preserves the runtime's inclusive turn time limit", async () => {
    const f = fixture({ crossAt: "started", turnLimit: 1001 });
    expect((await f.execute()).status).toBe("success");
    expect(readFileSync(f.path, "utf8")).toBe("actual side effect");
    expect(f.settle).toHaveBeenCalledExactlyOnceWith("dispatched");
  });
});
