import type { McpServerConfig, McpServerDescriptor, NetworkBoundary } from "@ar/contracts";

/**
 * P24-1 — MCP runtime V2: McpServerCatalog.
 *
 * A catalog is DECLARATION ONLY: it turns configured McpServerConfigs into
 * descriptors WITHOUT connecting (no stdio child, no HTTP initialize).
 * Connection happens later, lazily, when dependency resolution actually
 * needs a server (McpConnectionManager).
 */
export class McpServerCatalog {
  private readonly servers: ReadonlyMap<string, McpServerDescriptor>;

  private constructor(descriptors: readonly McpServerDescriptor[]) {
    this.servers = new Map(descriptors.map((d) => [d.id, d]));
  }

  /** Build descriptors from configs. `trustFor`/`boundaryFor` default per kind. */
  static fromConfig(
    configs: readonly McpServerConfig[],
    opts: {
      trustFor?: (id: string, kind: McpServerConfig["kind"]) => "trusted" | "untrusted";
      boundaryFor?: (id: string, kind: McpServerConfig["kind"]) => NetworkBoundary;
      enabled?: (id: string) => boolean;
    } = {},
  ): McpServerCatalog {
    const descriptors = configs.map((config) => {
      const trust =
        opts.trustFor?.(config.id, config.kind) ??
        (config.kind === "stdio" ? "untrusted" : "untrusted");
      const networkBoundary =
        opts.boundaryFor?.(config.id, config.kind) ??
        (config.kind === "stdio" ? "loopback" : "internet");
      return {
        id: config.id,
        config,
        trust,
        networkBoundary,
        enabled: opts.enabled?.(config.id) ?? true,
        // P24-3: eager/required are OPT-IN — a config existing is never a
        // reason to connect.
        ...(config.eager !== undefined ? { eager: config.eager } : {}),
        ...(config.requiredByDefault !== undefined ? { requiredByDefault: config.requiredByDefault } : {}),
        ...(config.policy !== undefined ? { policy: config.policy } : {}),
      } satisfies McpServerDescriptor;
    });
    return new McpServerCatalog(descriptors);
  }

  list(): readonly McpServerDescriptor[] {
    return [...this.servers.values()];
  }

  get(id: string): McpServerDescriptor | undefined {
    return this.servers.get(id);
  }

  get size(): number {
    return this.servers.size;
  }

  /** Servers explicitly configured to connect at startup (opt-in). */
  eagerServers(): readonly McpServerDescriptor[] {
    return [...this.servers.values()].filter((d) => d.enabled && d.eager === true);
  }

  /** Servers that resolve as needed even without an explicit mention. */
  requiredByDefault(): readonly McpServerDescriptor[] {
    return [...this.servers.values()].filter((d) => d.enabled && d.requiredByDefault === true);
  }
}
