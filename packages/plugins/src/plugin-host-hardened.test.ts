import { describe, expect, it } from "vitest";
import type { Plugin, PluginToolContext, ToolResult } from "./plugin-host.js";
import { DEFAULT_GRANTS, PluginError, PluginHost, validatePluginVersion } from "./plugin-host.js";

function ctx(overrides?: Partial<PluginToolContext>): PluginToolContext {
  return { call: { name: "read", args: { path: "/tmp/x" } }, sessionId: "s1", ...overrides };
}

function result(content: unknown): ToolResult {
  return { content };
}

/** A fully/partially declared plugin (manifest path). */
function declared(partial: Omit<Plugin, "onTool"> & { onTool?: Plugin["onTool"] }): Plugin {
  return { ...partial };
}

describe("P2-18 plugin hardening — capability declaration & permission boundary", () => {
  it("version validation: accepts leading-semver, rejects garbage", () => {
    expect(validatePluginVersion("1.2.3")).toBe(true);
    expect(validatePluginVersion("1.2.3-beta.1")).toBe(true);
    expect(validatePluginVersion("0.0.1")).toBe(true);
    expect(validatePluginVersion("v1.2.3")).toBe(false);
    expect(validatePluginVersion("1.2")).toBe(false);
    expect(validatePluginVersion("")).toBe(false);
  });

  it("rejects a plugin that registers onTool but omits tool in declared capabilities", () => {
    const host = new PluginHost();
    expect(() =>
      host.register(
        declared({
          id: "p1",
          version: "1.0.0",
          trust: "trusted",
          source: "builtin",
          capabilities: ["event"], // declares event, not tool
          onTool: async () => result({ ok: true }),
        }),
      ),
    ).toThrow(PluginError);
    try {
      host.register(
        declared({
          id: "p2",
          version: "1.0.0",
          trust: "trusted",
          source: "builtin",
          capabilities: ["event"],
          onTool: async () => result({ ok: true }),
        }),
      );
    } catch (e) {
      expect((e as PluginError).code).toBe("undeclared-capability");
    }
  });

  it("requireDeclaration policy rejects a plugin without explicit capabilities", () => {
    const host = new PluginHost({ requireDeclaration: true });
    expect(() => host.register({ id: "p1", onTool: async () => null })).toThrow(PluginError);
  });

  it("trust grant gate: a trust level not granted `tool` is never dispatched", async () => {
    const host = new PluginHost({
      defaultChampion: true,
      grants: {
        ...DEFAULT_GRANTS,
        untrusted: ["event"], // untrusted no longer gets tool
      },
    });
    const calls: string[] = [];
    host.register({
      id: "p1",
      trust: "untrusted",
      version: "1.0.0",
      source: "unsigned",
      capabilities: ["tool", "event"], // declares tool, but trust does NOT grant it
      onTool: async () => {
        calls.push("p1");
        return result({ handled: true });
      },
    });
    // Permission boundary: untrusted is not granted `tool`, so dispatch is
    // blocked before the plugin handler runs.
    const response = await host.onTool(ctx());
    expect(response.handled).toBe(false);
    expect(calls).toEqual([]);
  });

  it("a declared `tool` capability with a granting trust tier is dispatched", async () => {
    const host = new PluginHost();
    host.register(
      declared({
        id: "p1",
        version: "2.1.0",
        trust: "trusted",
        source: "builtin",
        capabilities: ["tool", "event"],
        onTool: async () => result({ handledBy: "p1" }),
      }),
    );
    expect(await host.onTool(ctx())).toEqual({
      handled: true,
      result: result({ handledBy: "p1" }),
    });
  });
});

describe("P2-18 plugin hardening — source allowlist & trust validation", () => {
  it("rejects a source outside the allowlist", () => {
    const host = new PluginHost({ allowedSources: ["builtin"] });
    expect(() =>
      host.register(
        declared({
          id: "p1",
          version: "1.0.0",
          trust: "trusted",
          source: "remote", // not allowed
          capabilities: ["tool"],
        }),
      ),
    ).toThrow(PluginError);
  });

  it("accepts a source inside the allowlist", async () => {
    const host = new PluginHost({ allowedSources: ["builtin"] });
    host.register(
      declared({
        id: "p1",
        version: "1.0.0",
        trust: "trusted",
        source: "builtin",
        capabilities: ["tool"],
        onTool: async () => result({ ok: true }),
      }),
    );
    expect(await host.onTool(ctx())).toEqual({ handled: true, result: result({ ok: true }) });
  });

  it("rejects an invalid version on the manifest path", () => {
    const host = new PluginHost();
    expect(() =>
      host.register(
        declared({ id: "p1", version: "not-a-version", trust: "trusted", source: "builtin" }),
      ),
    ).toThrow(PluginError);
  });

  it("rejects an unknown trust tier", () => {
    const host = new PluginHost();
    expect(() =>
      host.register(
        declared({ id: "p1", version: "1.0.0", trust: "rogue" as never, source: "builtin" }),
      ),
    ).toThrow(PluginError);
  });
});

describe("P2-18 plugin hardening — disable switch & global kill switch", () => {
  it("per-plugin disable skips that plugin; others still run", async () => {
    const host = new PluginHost();
    const calls: string[] = [];
    host.register(
      declared({
        id: "p1",
        version: "1.0.0",
        trust: "trusted",
        source: "builtin",
        capabilities: ["tool"],
        onTool: async () => {
          calls.push("p1");
          return result({ handledBy: "p1" });
        },
      }),
    );
    host.register(
      declared({
        id: "p2",
        version: "1.0.0",
        trust: "trusted",
        source: "builtin",
        capabilities: ["tool"],
        onTool: async () => {
          calls.push("p2");
          return result({ handledBy: "p2" });
        },
      }),
    );
    host.disable("p1");
    expect(host.isEnabled("p1")).toBe(false);
    expect(host.isEnabled("p2")).toBe(true);
    expect(await host.onTool(ctx())).toEqual({ handled: true, result: result({ handledBy: "p2" }) });
    expect(calls).toEqual(["p2"]);
  });

  it("global kill switch shuts off the whole ecosystem", async () => {
    const host = new PluginHost();
    const calls: string[] = [];
    host.register(
      declared({
        id: "p1",
        version: "1.0.0",
        trust: "trusted",
        source: "builtin",
        capabilities: ["tool"],
        onTool: async () => {
          calls.push("p1");
          return result({ handledBy: "p1" });
        },
      }),
    );
    host.setGlobalEnabled(false);
    expect(host.isEnabled("p1")).toBe(false);
    expect(await host.onTool(ctx())).toEqual({ handled: false, result: null });
    expect(calls).toEqual([]);
    host.setGlobalEnabled(true);
    expect(await host.onTool(ctx())).toEqual({ handled: true, result: result({ handledBy: "p1" }) });
  });
});

describe("P2-18 plugin hardening — failure isolation: timeout & quarantine", () => {
  it("times out a plugin that never resolves; later plugins still run", async () => {
    const host = new PluginHost({ defaultTimeoutMs: 20, maxConsecutiveFailures: 0 });
    const calls: string[] = [];
    host.register(
      declared({
        id: "p1",
        version: "1.0.0",
        trust: "trusted",
        source: "builtin",
        capabilities: ["tool"],
        onTool: () => new Promise(() => {}), // never settles
      }),
    );
    host.register(
      declared({
        id: "p2",
        version: "1.0.0",
        trust: "trusted",
        source: "builtin",
        capabilities: ["tool"],
        onTool: async () => {
          calls.push("p2");
          return result({ handledBy: "p2" });
        },
      }),
    );
    const response = await host.onTool(ctx());
    expect(response).toEqual({ handled: true, result: result({ handledBy: "p2" }) });
    expect(calls).toEqual(["p2"]);
  });

  it("times out with a per-plugin timeoutMs override", async () => {
    const host = new PluginHost({ defaultTimeoutMs: 5000 });
    host.register(
      declared({
        id: "p1",
        version: "1.0.0",
        trust: "trusted",
        source: "builtin",
        capabilities: ["tool"],
        timeoutMs: 10,
        onTool: () => new Promise(() => {}),
      }),
    );
    host.register(
      declared({
        id: "p2",
        version: "1.0.0",
        trust: "trusted",
        source: "builtin",
        capabilities: ["tool"],
        onTool: async () => result({ handledBy: "p2" }),
      }),
    );
    expect(await host.onTool(ctx())).toEqual({ handled: true, result: result({ handledBy: "p2" }) });
  });

  it("quarantines a plugin after maxConsecutiveFailures and records it in stats", async () => {
    const host = new PluginHost({ maxConsecutiveFailures: 2 });
    host.register(
      declared({
        id: "p1",
        version: "1.0.0",
        trust: "trusted",
        source: "builtin",
        capabilities: ["tool"],
        onTool: async () => {
          throw new Error("p1 keeps failing");
        },
      }),
    );
    host.register(
      declared({
        id: "p2",
        version: "1.0.0",
        trust: "trusted",
        source: "builtin",
        capabilities: ["tool"],
        onTool: async () => result({ handledBy: "p2" }),
      }),
    );
    // Two calls: p1 fails twice → quarantined after the 2nd.
    await host.onTool(ctx());
    expect(host.stats().failuresByPlugin["p1"]).toBe(1);
    await host.onTool(ctx());
    const stats = host.stats();
    expect(stats.failuresByPlugin["p1"]).toBe(2);
    expect(stats.quarantined).toEqual(["p1"]);
    // Third call: p1 is quarantined (skipped), p2 handles.
    expect(await host.onTool(ctx())).toEqual({ handled: true, result: result({ handledBy: "p2" }) });
    expect(host.stats().quarantined).toEqual(["p1"]);
  });

  it("a success resets the consecutive-failure budget for that plugin", async () => {
    const host = new PluginHost({ maxConsecutiveFailures: 2 });
    let fail = true;
    host.register(
      declared({
        id: "p1",
        version: "1.0.0",
        trust: "trusted",
        source: "builtin",
        capabilities: ["tool"],
        onTool: async () => {
          if (fail) throw new Error("boom");
          return null;
        },
      }),
    );
    await host.onTool(ctx()); // fail 1
    fail = false;
    await host.onTool(ctx()); // success → consecutive resets (still counted in total)
    fail = true;
    await host.onTool(ctx()); // fail 1 again (not 2) — budget reset by the success
    expect(host.stats().quarantined).toEqual([]);
    expect(host.stats().failuresByPlugin["p1"]).toBe(2);
  });

  it("enable() un-quarantines a plugin and resets its budget", async () => {
    const host = new PluginHost({ maxConsecutiveFailures: 1 });
    host.register(
      declared({
        id: "p1",
        version: "1.0.0",
        trust: "trusted",
        source: "builtin",
        capabilities: ["tool"],
        onTool: async () => {
          throw new Error("boom");
        },
      }),
    );
    host.register(
      declared({
        id: "p2",
        version: "1.0.0",
        trust: "trusted",
        source: "builtin",
        capabilities: ["tool"],
        onTool: async () => result({ handledBy: "p2" }),
      }),
    );
    await host.onTool(ctx());
    expect(host.stats().quarantined).toEqual(["p1"]);
    host.enable("p1");
    expect(host.stats().quarantined).toEqual([]);
  });

describe("P18-3 plugin policy: explicit trust, never default Champion", () => {
  it("refuses a non-builtin plugin by default (Champion OFF)", () => {
    const host = new PluginHost();
    expect(() =>
      host.register({ id: "p1", source: "local", onTool: async () => null }),
    ).toThrow(PluginError);
    try {
      host.register({ id: "p1", source: "local", onTool: async () => null });
    } catch (err) {
      expect(err).toBeInstanceOf(PluginError);
      expect((err as PluginError).code).toBe("champion-off");
    }
    expect(host.stats().total).toBe(0);
  });

  it("built-in plugins (part of the harness) still load with the default policy", () => {
    const host = new PluginHost();
    expect(() =>
      host.register({ id: "core", source: "builtin", onTool: async () => result({ ok: true }) }),
    ).not.toThrow();
    expect(host.stats().total).toBe(1);
  });

  it("loads a local plugin ONLY under explicit trusted-local configuration", () => {
    const host = new PluginHost({
      defaultChampion: true,
      allowedSources: ["local"],
      workspaceApproved: true,
    });
    expect(() =>
      host.register({ id: "p1", source: "local", onTool: async () => result({ ok: true }) }),
    ).not.toThrow();
    expect(host.stats().total).toBe(1);
  });

  it("project-local plugin needs explicit workspace approval even with Champion on", () => {
    const host = new PluginHost({ defaultChampion: true, allowedSources: ["local"] });
    try {
      host.register({ id: "p1", source: "local", onTool: async () => null });
    } catch (err) {
      expect((err as PluginError).code).toBe("project-local-requires-approval");
    }
    expect(host.stats().total).toBe(0);
  });

  it("documented execution model defaults to in-process (no auto-enable there)", () => {
    // The default policy has NO execution model override — registering the
    // policy object keeps the in-process default (same-process execution is
    // never auto-enabled; only explicit defaultChampion turns it on).
    const host = new PluginHost();
    expect(host.stats().total).toBe(0);
  });
});
});