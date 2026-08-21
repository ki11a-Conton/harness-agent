import type { PluginCapability, PluginSource, PluginTrust } from "./plugin-host.js";
export interface PluginManifest {
    /** Stable unique id (e.g. "@org/name"). */
    id: string;
    name: string;
    /** Required, leading-semver. */
    version: string;
    source: PluginSource;
    trust: PluginTrust;
    capabilities: PluginCapability[];
}
export interface PluginActivation {
    /** Isolated entry point; may be async. */
    activate(ctx: PluginLoadContext): void | Promise<void>;
}
export interface PluginLoadContext {
    /** Namespace where the plugin may register its contributions. */
    registerContribution(kind: PluginCapability, id: string): void;
}
interface LoadedEntry extends PluginManifest {
    state: "active" | "failed" | "disabled";
    error?: string;
    activatedAt: number;
}
export interface PluginRegistryPolicy {
    requireCapabilities?: boolean;
    allowedSources?: PluginSource[];
    /** Global kill switch: when false, refuse further loads. Default true. */
    enabled?: boolean;
}
export declare class PluginRegistry {
    private readonly entries;
    private readonly policy;
    private accepting;
    constructor(policy?: PluginRegistryPolicy);
    list(): LoadedEntry[];
    get(id: string): LoadedEntry | undefined;
    stats(): {
        total: number;
        active: number;
        failed: number;
        disabled: number;
    };
    /**
     * Load a plugin manifest + activation. Validation failures throw
     * `PluginError`; a throwing/rejecting `activate()` is isolated and recorded,
     * never propagated.
     */
    load(manifest: PluginManifest, activation: PluginActivation): Promise<LoadedEntry>;
    setGlobalEnabled(enabled: boolean): void;
    disable(id: string): void;
    enable(id: string): void;
    unload(id: string): void;
    private validateManifest;
}
export {};
//# sourceMappingURL=plugin-registry.d.ts.map