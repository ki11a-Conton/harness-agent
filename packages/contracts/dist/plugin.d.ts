import type { ToolDefinition } from "./tool.js";
import type { HookName, HookFn } from "./hooks.js";
import type { EventSink } from "./event.js";
/**
 * External plugin surface (PLUGIN-001).
 *
 * A plugin activates against a narrowed view of the runtime: it may register
 * tools and hooks, and sink events. It can never touch permission/sandbox
 * policy — those stay Core-owned (HOOK-001 "no hook can bypass security").
 * Tool definitions registered by a plugin flow through the normal
 * ToolOrchestrator pipeline (permission, approval, sandbox apply).
 */
export interface PluginContext {
    /** Narrow registry: register a tool under its name (duplicate names reject). */
    registerTool?(tool: ToolDefinition): void;
    /** Narrow hook surface: register a lifecycle hook, returns unsubscribe. */
    registerHook?(name: HookName, fn: HookFn): () => void;
    /** Optional event sink for emitting plugin-authored events. */
    events?: EventSink;
}
export interface Plugin {
    name: string;
    version: string;
    activate(ctx: PluginContext): void | Promise<void>;
}
//# sourceMappingURL=plugin.d.ts.map