/**
 * Hardened plugin tool host (P2-18).
 *
 * The raw PLUGIN-001 host observed tool calls and skipped a throwing plugin —
 * but provided no capability declaration, no trust/permission boundary, no
 * version/source validation, no disable switch, and swallowed failures
 * silently. A misbehaving plugin could still spam retries or sit forever.
 *
 * This hardened host adds the P2-18 controls while staying backward
 * compatible with the legacy `{ id, onTool }` plugin shape:
 *
 *   - capability declaration  ：a plugin declares the capabilities (tool/hook/
 *                               event/mcp/skill) it wants; an undeclared
 *                               capability is blocked before dispatch.
 *   - permission boundary      ：capabilities are granted per trust level
 *                               (trusted/verified/untrusted) via the host
 *                               policy; a trust level outside the grant is
 *                               blocked even if declared — plugins can never
 *                               reach beyond their granted surface.
 *   - failure isolation        ：sync AND async throws are caught; a call is
 *                               bounded by a per-plugin timeout; an error
 *                               budget quarantine disables a plugin after N
 *                               consecutive/successive failures so one bad
 *                               plugin cannot drag the runtime down.
 *   - version / source / trust : validated at registration (typed PluginError).
 *   - disable switch           ：per-plugin disable() plus a global kill
 *                               switch — a crashing plugin ecosystem is shut
 *                               off entirely.
 *   - observability            ：stats() reports enabled/disabled/quarantined
 *                               and per-plugin failure counts (no silent
 *                               swallow).
 */
export interface ToolResult {
    content: unknown;
}
export interface PluginToolContext {
    call: {
        name: string;
        args: Record<string, unknown>;
    };
    sessionId: string;
}
/** Where a plugin came from — gates how much it is trusted. */
export type PluginSource = "builtin" | "local" | "remote" | "unsigned";
/** What a plugin can reach into the runtime. */
export type PluginCapability = "tool" | "hook" | "event" | "mcp" | "skill";
/** Trust tier a plugin's declarations are evaluated against. */
export type PluginTrust = "trusted" | "verified" | "untrusted";
export interface Plugin {
    id: string;
    name?: string;
    version?: string;
    source?: PluginSource;
    trust?: PluginTrust;
    /** Declared capabilities; if absent, legacy permissive (trust-grant only). */
    capabilities?: PluginCapability[];
    onTool?: (ctx: PluginToolContext) => Promise<ToolResult | null>;
    /** Per-call timeout in ms; falls back to policy.defaultTimeoutMs. */
    timeoutMs?: number;
    /** Declared tool definitions contributed by this plugin (boundary bookkeeping). */
    tools?: unknown[];
}
export interface PluginHostResult {
    handled: boolean;
    result: ToolResult | null;
}
export interface PluginPolicy {
    /** Capability grants per trust level (permission boundary). */
    grants: Record<PluginTrust, PluginCapability[]>;
    /** Allow a plugin to invoke a capability it did NOT declare. Default false. */
    allowUndeclared?: boolean;
    /** If true, a plugin without an explicit capability list is rejected. */
    requireDeclaration?: boolean;
    /** Allowlist of accepted sources; empty/unset = accept any declared source. */
    allowedSources?: PluginSource[];
    /** Global kill switch for the whole host. Default true. */
    enabled?: boolean;
    defaultTimeoutMs?: number;
    /** Consecutive failures before a plugin is auto-quarantined. Default 0 (disabled). */
    maxConsecutiveFailures?: number;
}
export declare class PluginError extends Error {
    readonly code: "invalid-version" | "disallowed-source" | "unknown-trust" | "undeclared-capability" | "invalid-manifest" | "not-found";
    constructor(code: "invalid-version" | "disallowed-source" | "unknown-trust" | "undeclared-capability" | "invalid-manifest" | "not-found", message: string);
}
export declare const DEFAULT_GRANTS: Record<PluginTrust, PluginCapability[]>;
export declare function validatePluginVersion(version: string): boolean;
export declare class PluginHost {
    private readonly plugins;
    private readonly policy;
    private globalEnabled;
    constructor(policy?: Partial<PluginPolicy>);
    /**
     * Register a plugin. Legacy `{ id, onTool }` shape gets permissive defaults;
     * a full/invalid manifest is validated and rejected with `PluginError`.
     */
    register(plugin: Plugin): void;
    unregister(id: string): void;
    /** Per-plugin disable switch. A disabled plugin is skipped entirely. */
    disable(id: string): void;
    enable(id: string): void;
    isEnabled(id: string): boolean;
    /** Global kill switch: disables the entire plugin ecosystem. */
    setGlobalEnabled(enabled: boolean): void;
    stats(): {
        total: number;
        enabled: number;
        disabled: number;
        quarantined: string[];
        failuresByPlugin: Record<string, number>;
    };
    private canDispatch;
    onTool(ctx: PluginToolContext): Promise<PluginHostResult>;
}
//# sourceMappingURL=plugin-host.d.ts.map