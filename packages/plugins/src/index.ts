// @ar/plugins public surface.

// PLUGIN-001 / P2-18: hardened plugin host (capability declaration, permission
// boundary, failure isolation, version/source/trust validation, disable switch).
export { PluginHost, PluginError, validatePluginVersion, DEFAULT_GRANTS } from "./plugin-host.js";
export type {
  Plugin,
  PluginCapability,
  PluginHostResult,
  PluginPolicy,
  PluginSource,
  PluginToolContext,
  PluginTrust,
  ToolResult,
} from "./plugin-host.js";

// P2-18: hardened load registry — manifest validation + activate isolation + disable.
export { PluginRegistry } from "./plugin-registry.js";
export type {
  PluginActivation,
  PluginLoadContext,
  PluginManifest,
  PluginRegistryPolicy,
} from "./plugin-registry.js";