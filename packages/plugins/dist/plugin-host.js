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
export class PluginError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "PluginError";
    }
}
export const DEFAULT_GRANTS = {
    trusted: ["tool", "hook", "event", "mcp", "skill"],
    // verified: signed + curated — still cannot auto-reach everything by default.
    verified: ["tool", "hook", "event", "mcp"],
    untrusted: ["tool", "event"],
};
const DEFAULT_POLICY = {
    grants: DEFAULT_GRANTS,
    allowUndeclared: false,
    requireDeclaration: false,
    allowedSources: [],
    enabled: true,
    defaultTimeoutMs: 30_000,
    maxConsecutiveFailures: 5,
};
// Leading-semver check: "1.2.3" or "1.2.3-beta.1". Legacy plugins may omit.
const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
export function validatePluginVersion(version) {
    return SEMVER_RE.test(version);
}
const TIMEOUT_SENTINEL = Symbol("plugin-timeout");
function withTimeout(promise, ms) {
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            resolve(TIMEOUT_SENTINEL);
        }, ms);
        promise.then((value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        }, () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(TIMEOUT_SENTINEL); // failure treated like a skipped plugin
        });
    });
}
export class PluginHost {
    plugins = [];
    policy;
    globalEnabled;
    constructor(policy) {
        this.policy = { ...DEFAULT_POLICY, ...policy, grants: { ...DEFAULT_GRANTS, ...policy?.grants } };
        this.globalEnabled = this.policy.enabled ?? true;
    }
    /**
     * Register a plugin. Legacy `{ id, onTool }` shape gets permissive defaults;
     * a full/invalid manifest is validated and rejected with `PluginError`.
     */
    register(plugin) {
        const name = plugin.name ?? plugin.id;
        const version = plugin.version ?? "0.0.0";
        if (typeof version === "string" && !validatePluginVersion(version)) {
            throw new PluginError("invalid-version", `${name}: invalid plugin version "${version}"`);
        }
        const source = plugin.source ?? "unsigned";
        if (this.policy.allowedSources !== undefined && this.policy.allowedSources.length > 0) {
            if (!this.policy.allowedSources.includes(source)) {
                throw new PluginError("disallowed-source", `${name}: source "${source}" not in allowlist {${this.policy.allowedSources.join(", ")}}`);
            }
        }
        const trust = plugin.trust ?? "untrusted";
        if (DEFAULT_GRANTS[trust] === undefined) {
            throw new PluginError("unknown-trust", `${name}: unknown trust tier "${trust}"`);
        }
        // Capability declaration gate.
        const declared = plugin.capabilities !== undefined ? plugin.capabilities : [];
        if (this.policy.requireDeclaration && plugin.capabilities === undefined) {
            throw new PluginError("undeclared-capability", `${name}: policy requires explicit capability declaration but none provided`);
        }
        // Permission boundary: an onTool handler is the "tool" capability. If the
        // plugin declares capabilities and omits "tool", block it here.
        if (plugin.onTool !== undefined && declared.length > 0 && !declared.includes("tool")) {
            throw new PluginError("undeclared-capability", `${name}: registers a tool handler but "tool" is not in declared capabilities`);
        }
        this.plugins.push({
            manifest: { id: plugin.id, name, version, source, trust },
            declaredCapabilities: declared,
            onTool: plugin.onTool,
            timeoutMs: plugin.timeoutMs ?? this.policy.defaultTimeoutMs ?? 30_000,
            disabled: false,
            quarantined: false,
            consecutiveFailures: 0,
            totalFailures: 0,
        });
    }
    unregister(id) {
        const index = this.plugins.findIndex((p) => p.manifest.id === id);
        if (index >= 0)
            this.plugins.splice(index, 1);
    }
    /** Per-plugin disable switch. A disabled plugin is skipped entirely. */
    disable(id) {
        const p = this.plugins.find((x) => x.manifest.id === id);
        if (p !== undefined)
            p.disabled = true;
    }
    enable(id) {
        const p = this.plugins.find((x) => x.manifest.id === id);
        if (p !== undefined) {
            p.disabled = false;
            p.quarantined = false;
            p.consecutiveFailures = 0;
        }
    }
    isEnabled(id) {
        return this.globalEnabled && !this.plugins.find((x) => x.manifest.id === id)?.disabled;
    }
    /** Global kill switch: disables the entire plugin ecosystem. */
    setGlobalEnabled(enabled) {
        this.globalEnabled = enabled;
    }
    stats() {
        const failuresByPlugin = {};
        let enabled = 0;
        const quarantined = [];
        for (const p of this.plugins) {
            failuresByPlugin[p.manifest.id] = p.totalFailures;
            if (p.quarantined)
                quarantined.push(p.manifest.id);
            if (!p.disabled && !p.quarantined)
                enabled += 1;
        }
        return {
            total: this.plugins.length,
            enabled,
            disabled: this.plugins.length - enabled,
            quarantined,
            failuresByPlugin,
        };
    }
    canDispatch(p) {
        if (!this.globalEnabled)
            return false;
        if (p.disabled || p.quarantined)
            return false;
        if (p.onTool === undefined)
            return false;
        // Capability declaration: explicitly declared capabilities without "tool"
        // were already rejected at registration; a declared list is honored.
        if (p.declaredCapabilities.length > 0 && !p.declaredCapabilities.includes("tool")) {
            return false;
        }
        // Permission boundary: trust must grant "tool".
        const grants = this.policy.grants[p.manifest.trust];
        if (grants === undefined)
            return false;
        if (!grants.includes("tool"))
            return false;
        return true;
    }
    async onTool(ctx) {
        for (const plugin of this.plugins) {
            if (!this.canDispatch(plugin))
                continue;
            let result = null;
            let failed = false;
            try {
                const outcome = await withTimeout(plugin.onTool(ctx), plugin.timeoutMs);
                if (outcome === TIMEOUT_SENTINEL) {
                    failed = true;
                }
                else {
                    result = outcome;
                }
            }
            catch {
                failed = true;
            }
            if (failed) {
                plugin.totalFailures += 1;
                plugin.consecutiveFailures += 1;
                if (this.policy.maxConsecutiveFailures !== undefined &&
                    this.policy.maxConsecutiveFailures > 0 &&
                    plugin.consecutiveFailures >= this.policy.maxConsecutiveFailures) {
                    plugin.quarantined = true; // auto-disable the misbehaving plugin
                }
                continue; // failure isolation: later plugins still run
            }
            plugin.consecutiveFailures = 0;
            if (result !== null) {
                return { handled: true, result };
            }
        }
        return { handled: false, result: null };
    }
}
//# sourceMappingURL=plugin-host.js.map