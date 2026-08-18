/**
 * Plugin tool host (PLUGIN-001 surface).
 *
 * Plugins observe tool calls in registration order; the first plugin that
 * returns a non-null result handles the call. A plugin that throws is skipped
 * so it cannot affect later plugins.
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

export interface Plugin {
  id: string;
  name?: string;
  version?: string;
  onTool?: (ctx: PluginToolContext) => Promise<ToolResult | null>;
}

export interface PluginHostResult {
  handled: boolean;
  result: ToolResult | null;
}

export class PluginHost {
  private readonly plugins: Plugin[] = [];

  register(plugin: Plugin): void {
    this.plugins.push(plugin);
  }

  unregister(id: string): void {
    const index = this.plugins.findIndex((plugin) => plugin.id === id);
    if (index >= 0) {
      this.plugins.splice(index, 1);
    }
  }

  async onTool(ctx: PluginToolContext): Promise<PluginHostResult> {
    for (const plugin of this.plugins) {
      if (plugin.onTool === undefined) continue;
      // Isolation: a throwing plugin is skipped so later plugins still run.
      let result: ToolResult | null;
      try {
        result = await plugin.onTool(ctx);
      } catch {
        continue;
      }
      if (result !== null) {
        return { handled: true, result };
      }
    }
    return { handled: false, result: null };
  }
}
