import { describe, expect, it } from "vitest";
import type { ToolCall, ToolResult } from "@ar/contracts";
import { errorInfo, newAgentId, newSessionId, newToolCallId, newTurnId } from "@ar/contracts";
import { HookRegistry, type HookContext } from "./hooks.js";

const SID = newSessionId();
const AID = newAgentId();
const ctx = { sessionId: SID, agentId: AID, timestamp: 1 };

describe("HookRegistry", () => {
  it("dispatches lifecycle hooks in order", async () => {
    const reg = new HookRegistry();
    const seen: string[] = [];
    reg.register("session_start", () => seen.push("a"));
    reg.register("session_start", () => seen.push("b"));
    await reg.dispatch("session_start", ctx);
    expect(seen).toEqual(["a", "b"]);
  });

  it("before_tool can block a call", async () => {
    const reg = new HookRegistry();
    reg.register("before_tool", () => null);
    const call = { id: newToolCallId(), name: "x", args: {} };
    expect(await reg.beforeTool(ctx, call)).toBeNull();
  });

  it("before_tool can transform a call", async () => {
    const reg = new HookRegistry();
    reg.register("before_tool", (_c: HookContext, call: ToolCall) => ({ ...call, name: "wrapped" }));
    const call = { id: newToolCallId(), name: "x", args: {} };
    const out = await reg.beforeTool(ctx, call);
    expect(out?.name).toBe("wrapped");
  });

  it("after_tool observes results", async () => {
    const reg = new HookRegistry();
    const seen: unknown[] = [];
    reg.register("after_tool", (_c: HookContext, call: ToolCall, result: ToolResult) => {
      seen.push({ call: call.name, status: result.status });
    });
    const call = { id: newToolCallId(), name: "x", args: {} };
    await reg.afterTool(ctx, call, { status: "success", output: 1 });
    expect(seen).toEqual([{ call: "x", status: "success" }]);
  });

  it("unregister removes the handler", async () => {
    const reg = new HookRegistry();
    let n = 0;
    const off = reg.register("after_model", () => (n += 1));
    await reg.dispatch("after_model", ctx);
    off();
    await reg.dispatch("after_model", ctx);
    expect(n).toBe(1);
    expect(reg.size()).toBe(0);
  });
});

describe("HOOK-001 session hooks", () => {
  it("session_start dispatches multiple handlers in registration order with a full ctx", async () => {
    const reg = new HookRegistry();
    const seen: Array<Partial<HookContext>> = [];
    reg.register("session_start", (c: HookContext) => {
      seen.push({ sessionId: c.sessionId, agentId: c.agentId, timestamp: c.timestamp });
    });
    reg.register("session_start", (c: HookContext) => {
      seen.push({ sessionId: c.sessionId, agentId: c.agentId });
    });
    await reg.dispatch("session_start", ctx);
    expect(seen).toEqual([
      { sessionId: SID, agentId: AID, timestamp: 1 },
      { sessionId: SID, agentId: AID },
    ]);
    expect(typeof seen[0]?.timestamp).toBe("number");
  });

  it("session_end dispatches handlers with the same ctx structure (sessionId, agentId, timestamp)", async () => {
    const reg = new HookRegistry();
    const seen: HookContext[] = [];
    reg.register("session_end", (c: HookContext) => seen.push(c));
    const endCtx: HookContext = { sessionId: SID, agentId: AID, timestamp: 42 };
    await reg.dispatch("session_end", endCtx);
    expect(seen).toEqual([{ sessionId: SID, agentId: AID, timestamp: 42 }]);
    expect(typeof endCtx.timestamp).toBe("number");
  });
});

describe("HOOK-001 compaction hooks", () => {
  it("before_compaction fires before after_compaction, both receive the standard ctx", async () => {
    const reg = new HookRegistry();
    const seen: string[] = [];
    const ctxs: HookContext[] = [];
    reg.register("before_compaction", (c: HookContext) => {
      seen.push("before");
      ctxs.push(c);
    });
    reg.register("after_compaction", (c: HookContext) => {
      seen.push("after");
      ctxs.push(c);
    });
    const beforeCtx: HookContext = { sessionId: SID, turnId: newTurnId(), agentId: AID, timestamp: 7 };
    const afterCtx: HookContext = { sessionId: SID, turnId: newTurnId(), agentId: AID, timestamp: 9 };
    await reg.dispatch("before_compaction", beforeCtx);
    await reg.dispatch("after_compaction", afterCtx);
    expect(seen).toEqual(["before", "after"]);
    expect(ctxs).toEqual([beforeCtx, afterCtx]);
    expect(ctxs.every((c) => typeof c.timestamp === "number")).toBe(true);
  });
});

describe("HOOK-001 tool observation", () => {
  it("after_tool receives the (ctx, call, result) triple with result.status", async () => {
    const reg = new HookRegistry();
    let got: { c: HookContext; call: ToolCall; result: ToolResult } | undefined;
    reg.register("after_tool", (c: HookContext, call: ToolCall, result: ToolResult) => {
      got = { c, call, result };
    });
    const call = { id: newToolCallId(), name: "x", args: {} };
    const result: ToolResult = { status: "success", output: 42 };
    await reg.afterTool(ctx, call, result);
    expect(got?.c).toBe(ctx);
    expect(got?.call).toBe(call);
    expect(got?.result).toBe(result);
    expect(got?.result.status).toBe("success");
    expect(got?.result.output).toBe(42);
  });

  it("tool_error receives the failed result", async () => {
    const reg = new HookRegistry();
    const seen: unknown[] = [];
    reg.register("tool_error", (_c: HookContext, call: ToolCall, result: ToolResult) => {
      seen.push({ call: call.name, status: result.status, code: result.error?.code });
    });
    const call = { id: newToolCallId(), name: "x", args: {} };
    await reg.toolError(ctx, call, { status: "failed", error: errorInfo("PROCESS_ERROR", "boom") });
    expect(seen).toEqual([{ call: "x", status: "failed", code: "PROCESS_ERROR" }]);
  });
});

describe("HOOK-001 security: no hook can bypass security", () => {
  it("a blocking before_tool short-circuits later handlers", async () => {
    const reg = new HookRegistry();
    const seen: string[] = [];
    reg.register("before_tool", () => null);
    reg.register("before_tool", (_c: HookContext, call: ToolCall) => {
      seen.push(call.name);
      return call;
    });
    const call = { id: newToolCallId(), name: "x", args: {} };
    expect(await reg.beforeTool(ctx, call)).toBeNull();
    expect(seen).toEqual([]);
  });

  it("hook context exposes no permission or sandbox surfaces", async () => {
    const reg = new HookRegistry();
    let keys: string[] = [];
    reg.register("before_model", (c: HookContext) => {
      keys = Object.keys(c);
    });
    await reg.dispatch("before_model", ctx);
    expect(keys.sort()).toEqual(["agentId", "sessionId", "timestamp"]);
    expect(keys).not.toContain("permissions");
    expect(keys).not.toContain("sandbox");
    expect(keys).not.toContain("sandboxPolicy");
  });

  it("P2-19: a throwing before_tool hook FAILS CLOSED (denies) instead of allowing", async () => {
    const reg = new HookRegistry();
    const seen: string[] = [];
    reg.register("before_tool", () => {
      throw new Error("hook boom");
    });
    reg.register("before_tool", (_c: HookContext, call: ToolCall) => {
      seen.push(call.name);
      return call;
    });
    const call = { id: newToolCallId(), name: "x", args: {} };
    // 禁止 hook 异常默认 allow: gate hook 抛错 → deny (null), 绝不放行.
    expect(await reg.beforeTool(ctx, call)).toBeNull();
    expect(seen).toEqual([]);
    // ...并且错误被可观测地记录(deny), 而非静默吞掉.
    expect(reg.failureStats()).toMatchObject({ count: 1, denied: 1 });
  });

  it("P2-19: a timing-out before_tool hook FAILS CLOSED (denies)", async () => {
    const reg = new HookRegistry();
    reg.register("before_tool", () => new Promise(() => {}), { timeoutMs: 10 });
    const call = { id: newToolCallId(), name: "x", args: {} };
    expect(await reg.beforeTool(ctx, call)).toBeNull();
    expect(reg.failureStats().denied).toBe(1);
  });

  it("P2-19: before_tool order, source & transformed context threading", async () => {
    const reg = new HookRegistry();
    const order: string[] = [];
    reg.register("before_tool", (_c: HookContext, call: ToolCall) => {
      order.push("a");
      return { ...call, name: "step1" };
    }, { source: "rule-a" });
    reg.register("before_tool", (_c: HookContext, call: ToolCall) => {
      order.push("b");
      return { ...call, name: "step2" };
    }, { source: "rule-b" });
    const call = { id: newToolCallId(), name: "x", args: {} };
    const out = await reg.beforeTool(ctx, call);
    expect(order).toEqual(["a", "b"]);
    expect(out?.name).toBe("step2");
  });

  it("P2-19: a throwing observe hook is swallowed + reported, later hooks still run", async () => {
    const reg = new HookRegistry();
    const seen: string[] = [];
    reg.register("after_tool", () => { throw new Error("observer boom"); });
    reg.register("after_tool", (_c: HookContext, call: ToolCall) => { seen.push(call.name); });
    const call = { id: newToolCallId(), name: "x", args: {} };
    await reg.afterTool(ctx, call, { status: "success", output: 1 });
    expect(seen).toEqual(["x"]);
    expect(reg.failureStats()).toMatchObject({ count: 1, denied: 0, swallowed: 1 });
  });

  it("P2-19: before_permission gate fails closed (false) on throw", async () => {
    const reg = new HookRegistry();
    reg.register("before_permission", () => { throw new Error("perm boom"); });
    expect(await reg.beforePermission(ctx)).toBe(false);
  });

  it("P2-19: a sync-throwing observe hook inside dispatch does not reject", async () => {
    const reg = new HookRegistry();
    reg.register("session_start", () => { throw new Error("sync boom"); });
    await expect(reg.dispatch("session_start", ctx)).resolves.toBeUndefined();
    expect(reg.failureStats().count).toBe(1);
  });
});