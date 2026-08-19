/**
 * Hardened plugin load registry (P2-18).
 *
 * The tool host (`PluginHost`) hardens the *dispatch* side. This registry
 * hardens the *load/manifest* side: a plugin's `load(manifest, activate)`
 * path declares what it is (version/source/trust) and what capabilities it
 * wants, and the `activate()` entry point is failure-isolated so a throwing
 * plugin cannot crash the runtime.
 *
 * Controls:
 *   - manifest validation   ：name (non-empty), version (semver-leading),
 *                             source (allowlisted), trust (known tier),
 *                             capabilities (declared).
 *   - failure isolation     ：`activate()` may throw (sync) or reject (async);
 *                             the registry catches it, marks the plugin
 *                             `failed`, and does NOT propagate. Later plugins
 *                             still load.
 *   - disable switch        ：`disable()`/`enable()` per plugin; a disabled
 *                             plugin is recorded but inert.
 *   - observability         ：`list()` / `stats()` expose source/trust/state.
 */
import { PluginError } from "./plugin-host.js";
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

const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const KNOWN_TRUSTS: PluginTrust[] = ["trusted", "verified", "untrusted"];

export class PluginRegistry {
  private readonly entries: LoadedEntry[] = [];
  private readonly policy: PluginRegistryPolicy;
  private accepting = true;

  constructor(policy?: PluginRegistryPolicy) {
    this.policy = policy ?? {};
    this.accepting = this.policy.enabled ?? true;
  }

  list(): LoadedEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  get(id: string): LoadedEntry | undefined {
    const e = this.entries.find((x) => x.id === id);
    return e === undefined ? undefined : { ...e };
  }

  stats(): { total: number; active: number; failed: number; disabled: number } {
    let active = 0;
    let failed = 0;
    let disabled = 0;
    for (const e of this.entries) {
      if (e.state === "active") active += 1;
      else if (e.state === "failed") failed += 1;
      else disabled += 1;
    }
    return { total: this.entries.length, active, failed, disabled };
  }

  /**
   * Load a plugin manifest + activation. Validation failures throw
   * `PluginError`; a throwing/rejecting `activate()` is isolated and recorded,
   * never propagated.
   */
  async load(manifest: PluginManifest, activation: PluginActivation): Promise<LoadedEntry> {
    if (!this.accepting) {
      throw new PluginError("invalid-manifest", "plugin loading is globally disabled");
    }
    this.validateManifest(manifest);
    if (this.entries.some((e) => e.id === manifest.id)) {
      throw new PluginError(
        "invalid-manifest",
        `${manifest.id}: already loaded (duplicate id)`,
      );
    }
    const entry: LoadedEntry = {
      ...manifest,
      capabilities: [...manifest.capabilities],
      state: "active",
      activatedAt: Date.now(),
    };
    this.entries.push(entry);
    const ctx: PluginLoadContext = {
      registerContribution: (kind, id) => {
        // Permission boundary: contributions outside the declared capability
        // set are ignored (the plugin cannot extend its own grant).
        if (!entry.capabilities.includes(kind)) return;
      },
    };
    try {
      await activation.activate(ctx);
    } catch (error) {
      // Failure isolation: a broken activate() must not crash the runtime.
      entry.state = "failed";
      entry.error = error instanceof Error ? error.message : String(error);
    }
    return { ...entry };
  }

  setGlobalEnabled(enabled: boolean): void {
    this.accepting = enabled;
  }

  disable(id: string): void {
    const e = this.entries.find((x) => x.id === id);
    if (e !== undefined && e.state !== "failed") e.state = "disabled";
  }

  enable(id: string): void {
    const e = this.entries.find((x) => x.id === id);
    if (e !== undefined && e.state === "disabled") e.state = "active";
  }

  unload(id: string): void {
    const index = this.entries.findIndex((x) => x.id === id);
    if (index >= 0) this.entries.splice(index, 1);
  }

  private validateManifest(m: PluginManifest): void {
    if (
      typeof m.id !== "string" ||
      m.id.trim() === "" ||
      typeof m.name !== "string" ||
      m.name.trim() === ""
    ) {
      throw new PluginError("invalid-manifest", "plugin manifest requires a non-empty id and name");
    }
    if (typeof m.version !== "string" || !SEMVER_RE.test(m.version)) {
      throw new PluginError("invalid-version", `${m.name}: invalid plugin version "${m.version}"`);
    }
    if (!KNOWN_TRUSTS.includes(m.trust)) {
      throw new PluginError("unknown-trust", `${m.name}: unknown trust tier "${m.trust}"`);
    }
    if (this.policy.allowedSources !== undefined && this.policy.allowedSources.length > 0) {
      if (!this.policy.allowedSources.includes(m.source)) {
        throw new PluginError(
          "disallowed-source",
          `${m.name}: source "${m.source}" not allowed`,
        );
      }
    }
    if (this.policy.requireCapabilities && (!Array.isArray(m.capabilities) || m.capabilities.length === 0)) {
      throw new PluginError(
        "undeclared-capability",
        `${m.name}: policy requires at least one declared capability`,
      );
    }
  }
}