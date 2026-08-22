import { describe, expect, it } from "vitest";
import type { Plugin, PluginToolContext, ToolResult } from "./plugin-host.js";
import { PluginHost } from "./plugin-host.js";

function ctx(overrides?: Partial<PluginToolContext>): PluginToolContext {
  return {
    call: { name: "read", args: { path: "/tmp/x" } },
    sessionId: "s1",
    ...overrides,
  };
}

function result(content: unknown): ToolResult {
  return { content };
}

function plugin(id: string, onTool?: Plugin["onTool"]): Plugin {
  // P18-3: test doubles are built-in plugins (exempt from Champion-off).
  return { id, source: "builtin", onTool };
}

describe("PluginHost", () => {
  it("routes an unhandled call to the registered plugin and marks it handled", async () => {
    const host = new PluginHost();
    const calls: string[] = [];
    host.register(
      plugin("p1", async (c) => {
        calls.push(c.call.name);
        return result({ handledBy: "p1" });
      }),
    );

    const response = await host.onTool(ctx());

    expect(response).toEqual({ handled: true, result: result({ handledBy: "p1" }) });
    expect(calls).toEqual(["read"]);
  });

  it("calls plugins in registration order", async () => {
    const host = new PluginHost();
    const calls: string[] = [];
    host.register(
      plugin("p1", async () => {
        calls.push("p1");
        return null;
      }),
    );
    host.register(
      plugin("p2", async () => {
        calls.push("p2");
        return null;
      }),
    );

    await host.onTool(ctx());

    expect(calls).toEqual(["p1", "p2"]);
  });

  it("returns the first non-null result in registration order", async () => {
    const host = new PluginHost();
    host.register(plugin("p1", async () => null));
    host.register(plugin("p2", async () => result({ handledBy: "p2" })));
    host.register(plugin("p3", async () => result({ handledBy: "p3" })));

    const response = await host.onTool(ctx());

    expect(response).toEqual({ handled: true, result: result({ handledBy: "p2" }) });
  });

  it("short-circuits after the first non-null result", async () => {
    const host = new PluginHost();
    const calls: string[] = [];
    host.register(
      plugin("p1", async () => {
        calls.push("p1");
        return result({ handledBy: "p1" });
      }),
    );
    host.register(
      plugin("p2", async () => {
        calls.push("p2");
        return result({ handledBy: "p2" });
      }),
    );

    const response = await host.onTool(ctx());

    expect(response).toEqual({ handled: true, result: result({ handledBy: "p1" }) });
    expect(calls).toEqual(["p1"]);
  });

  it("reports handled:false when no plugin returns a result", async () => {
    const host = new PluginHost();
    host.register(plugin("p1", async () => null));
    host.register(plugin("p2", async () => null));

    expect(await host.onTool(ctx())).toEqual({ handled: false, result: null });
  });

  it("reports handled:false when no plugin is registered", async () => {
    const host = new PluginHost();

    expect(await host.onTool(ctx())).toEqual({ handled: false, result: null });
  });

  it("skips plugins without an onTool handler", async () => {
    const host = new PluginHost();
    const calls: string[] = [];
    host.register(plugin("p1"));
    host.register(
      plugin("p2", async () => {
        calls.push("p2");
        return result({ handledBy: "p2" });
      }),
    );

    const response = await host.onTool(ctx());

    expect(response).toEqual({ handled: true, result: result({ handledBy: "p2" }) });
    expect(calls).toEqual(["p2"]);
  });

  it("unregister removes the plugin by id", async () => {
    const host = new PluginHost();
    host.register(plugin("p1", async () => result({ handledBy: "p1" })));
    host.register(plugin("p2", async () => result({ handledBy: "p2" })));
    host.unregister("p1");

    expect(await host.onTool(ctx())).toEqual({
      handled: true,
      result: result({ handledBy: "p2" }),
    });
  });

  it("unregister of an unknown id is a no-op", async () => {
    const host = new PluginHost();
    host.register(plugin("p1", async () => result({ handledBy: "p1" })));

    host.unregister("missing");

    expect(await host.onTool(ctx())).toEqual({
      handled: true,
      result: result({ handledBy: "p1" }),
    });
  });

  it("isolates a throwing plugin so later plugins still run", async () => {
    const host = new PluginHost();
    const calls: string[] = [];
    host.register(
      plugin("p1", async () => {
        throw new Error("p1 exploded");
      }),
    );
    host.register(
      plugin("p2", async () => {
        calls.push("p2");
        return result({ handledBy: "p2" });
      }),
    );

    const response = await host.onTool(ctx());

    expect(response).toEqual({ handled: true, result: result({ handledBy: "p2" }) });
    expect(calls).toEqual(["p2"]);
  });

  it("leaves the call unhandled when the only plugin throws", async () => {
    const host = new PluginHost();
    host.register(
      plugin("p1", async () => {
        throw new Error("p1 exploded");
      }),
    );

    expect(await host.onTool(ctx())).toEqual({ handled: false, result: null });
  });

  it("passes the call and sessionId through to the plugin", async () => {
    const host = new PluginHost();
    let seen: PluginToolContext | undefined;
    host.register(
      plugin("p1", async (c) => {
        seen = c;
        return result({ handledBy: "p1" });
      }),
    );

    await host.onTool(ctx({ call: { name: "write", args: { text: "hi" } }, sessionId: "s9" }));

    expect(seen).toEqual({
      call: { name: "write", args: { text: "hi" } },
      sessionId: "s9",
    });
  });
});

describe("PluginHost — P14-4 capability monotonicity", () => {
  const GRANT: {
    policy: {
      filesystem: { mode: "workspace-write"; allowedPaths: string[] };
      network: { mode: "allowlist"; hosts: string[] };
      process: { allowedCommands: string[] };
    };
    toolAllowlist: string[];
  } = {
    policy: {
      filesystem: { mode: "workspace-write", allowedPaths: ["C:\\work"] },
      network: { mode: "allowlist", hosts: ["api.example.com"] },
      process: { allowedCommands: ["pnpm test"] },
    },
    toolAllowlist: ["read", "write", "exec"],
  };

  it("a sandbox declaration that widens the host grant is a typed denial at registration", () => {
    const host = new PluginHost({ capability: GRANT, defaultChampion: true });
    expect(() =>
      host.register({
        id: "evil",
        onTool: async () => result({}),
        sandbox: { filesystem: ["C:\\work", "C:\\Windows"] },
      }),
    ).toThrow(/plugin boundary denied/);
    // the plugin is not registered
    expect(host.stats().total).toBe(0);
  });

  it("a sandbox declaration that narrows the host grant registers fine", () => {
    const host = new PluginHost({ capability: GRANT, defaultChampion: true });
    expect(() =>
      host.register({
        id: "good",
        onTool: async () => result({}),
        sandbox: { filesystem: ["C:\\work\\sub"], network: [] },
      }),
    ).not.toThrow();
    expect(host.stats().total).toBe(1);
  });

  it("a sandbox declaration with NO host grant is denied (unknown bound cannot prove narrowing)", () => {
    const host = new PluginHost({ defaultChampion: true }); // no capability grant
    expect(() =>
      host.register({
        id: "declares",
        onTool: async () => result({}),
        sandbox: { filesystem: ["C:\\work\\sub"] },
      }),
    ).toThrow(/plugin boundary denied/);
  });

  it("sandbox.tool is rejected — the tool surface stays with capabilities (one source of truth)", () => {
    const host = new PluginHost({ capability: GRANT, defaultChampion: true });
    expect(() =>
      host.register({
        id: "toolclaim",
        onTool: async () => result({}),
        sandbox: { tool: ["read"] },
      }),
    ).toThrow(/sandbox.tool is not a plugin surface/);
  });

  it("the denial is observable through the policy callback (typed SecurityDenial)", () => {
    const denials: Array<{ dimension: string; code: string; target?: string }> = [];
    const host = new PluginHost({
      capability: GRANT,
      defaultChampion: true,
      onCapabilityDenied: (denial) => {
        denials.push({ dimension: denial.dimension, code: denial.code, target: denial.target });
      },
    });
    expect(() =>
      host.register({
        id: "evil",
        onTool: async () => result({}),
        sandbox: { network: ["evil.example.com"] },
      }),
    ).toThrow();
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ dimension: "capability", code: "SECURITY_DENIED", target: "evil" });
  });
});
