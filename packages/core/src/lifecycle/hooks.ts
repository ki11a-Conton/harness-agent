export {
  HOOK_NAMES,
  type HookName,
  type HookContext,
  type HookFn,
  type BeforeToolHook,
  type AfterToolHook,
} from "@ar/contracts";
import type {
  AfterToolHook,
  BeforeToolHook,
  HookContext,
  HookFn,
  HookName,
  ToolCall,
  ToolResult,
} from "@ar/contracts";

/**
 * Lifecycle hook registry per AGENT_ARCHITECTURE_PLAN §51.
 * Hooks may observe, annotate, block, transform — but may never bypass security.
 * HOOK-001 (P5) hardens blocking/transform semantics; this registry is the
 * interception surface Core owns.
 */

type StoredFn = (ctx: HookContext, ...args: never[]) => Promise<unknown> | unknown;

export class HookRegistry {
  private handlers = new Map<HookName, StoredFn[]>();

  register(hook: HookName, fn: HookFn): () => void {
    const list = this.handlers.get(hook) ?? [];
    list.push(fn as StoredFn);
    this.handlers.set(hook, list);
    return () => {
      const current = this.handlers.get(hook) ?? [];
      this.handlers.set(
        hook,
        current.filter((h) => h !== fn),
      );
    };
  }

  async dispatch(hook: HookName, ctx: HookContext): Promise<void> {
    const list = this.handlers.get(hook);
    if (!list) return;
    for (const fn of list) {
      await fn(ctx);
    }
  }

  /** before_tool hooks may return null to block the call (normal policy still applies). */
  async beforeTool(ctx: HookContext, call: ToolCall): Promise<ToolCall | null> {
    const list = this.handlers.get("before_tool");
    if (!list) return call;
    let current: ToolCall | null = call;
    for (const fn of list) {
      const next = await (fn as BeforeToolHook)(ctx, current);
      if (next === null) return null;
      current = next;
    }
    return current;
  }

  async afterTool(ctx: HookContext, call: ToolCall, result: ToolResult): Promise<void> {
    const list = this.handlers.get("after_tool");
    if (!list) return;
    for (const fn of list) {
      await (fn as AfterToolHook)(ctx, call, result);
    }
  }

  async toolError(ctx: HookContext, call: ToolCall, result: ToolResult): Promise<void> {
    const list = this.handlers.get("tool_error");
    if (!list) return;
    for (const fn of list) {
      await (fn as AfterToolHook)(ctx, call, result);
    }
  }

  size(): number {
    let n = 0;
    for (const list of this.handlers.values()) n += list.length;
    return n;
  }
}