// @ar/plugins public surface.

// PLUGIN-001: plugin host that observes tool calls in registration order.
export { PluginHost } from "./plugin-host.js";
export type {
  Plugin,
  PluginHostResult,
  PluginToolContext,
  ToolResult,
} from "./plugin-host.js";
