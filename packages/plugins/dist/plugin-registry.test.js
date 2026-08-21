import { describe, expect, it } from "vitest";
import { PluginRegistry } from "./plugin-registry.js";
import { PluginError } from "./plugin-host.js";
function manifest(overrides) {
    return {
        id: "p1",
        name: "p1",
        version: "1.0.0",
        source: "builtin",
        trust: "trusted",
        capabilities: ["tool"],
        ...overrides,
    };
}
describe("P2-18 plugin registry — manifest validation & activate isolation", () => {
    it("loads a valid plugin as active", async () => {
        const reg = new PluginRegistry();
        const entry = await reg.load(manifest(), { activate: async () => { } });
        expect(entry.state).toBe("active");
        expect(reg.stats()).toEqual({ total: 1, active: 1, failed: 0, disabled: 0 });
    });
    it("rejects an invalid version", async () => {
        const reg = new PluginRegistry();
        await expect(reg.load(manifest({ version: "nope" }), { activate: async () => { } })).rejects.toThrow(PluginError);
    });
    it("rejects an unknown trust tier", async () => {
        const reg = new PluginRegistry();
        await expect(reg.load(manifest({ trust: "rogue" }), { activate: async () => { } })).rejects.toThrow(PluginError);
    });
    it("rejects a source outside the allowlist", async () => {
        const reg = new PluginRegistry({ allowedSources: ["builtin"] });
        await expect(reg.load(manifest({ source: "remote" }), { activate: async () => { } })).rejects.toThrow(PluginError);
    });
    it("rejects a duplicate id", async () => {
        const reg = new PluginRegistry();
        await reg.load(manifest(), { activate: async () => { } });
        await expect(reg.load(manifest(), { activate: async () => { } })).rejects.toThrow(PluginError);
    });
    it("requireCapabilities rejects a plugin declaring no capabilities", async () => {
        const reg = new PluginRegistry({ requireCapabilities: true });
        await expect(reg.load(manifest({ capabilities: [] }), { activate: async () => { } })).rejects.toThrow(PluginError);
    });
    it("isolates a throwing activate() — records failure, never propagates", async () => {
        const reg = new PluginRegistry();
        const entry = await reg.load(manifest(), {
            activate: async () => {
                throw new Error("activation exploded");
            },
        });
        expect(entry.state).toBe("failed");
        expect(entry.error).toContain("activation exploded");
        expect(reg.stats().failed).toBe(1);
    });
    it("isolates an async-rejecting activate() and lets later plugins load", async () => {
        const reg = new PluginRegistry();
        await reg.load(manifest({ id: "bad", name: "bad" }), {
            activate: () => Promise.reject(new Error("reject")),
        });
        await reg.load(manifest({ id: "good", name: "good" }), { activate: async () => { } });
        const stats = reg.stats();
        expect(stats.failed).toBe(1);
        expect(stats.active).toBe(1);
    });
    it("disable/enable switch the plugin state", async () => {
        const reg = new PluginRegistry();
        await reg.load(manifest(), { activate: async () => { } });
        reg.disable("p1");
        expect(reg.get("p1")?.state).toBe("disabled");
        reg.enable("p1");
        expect(reg.get("p1")?.state).toBe("active");
    });
    it("disable does not resurrect a failed plugin", async () => {
        const reg = new PluginRegistry();
        await reg.load(manifest(), { activate: async () => { throw new Error("boom"); } });
        reg.disable("p1");
        expect(reg.get("p1")?.state).toBe("failed");
    });
    it("global kill switch refuses further loads", async () => {
        const reg = new PluginRegistry();
        reg.setGlobalEnabled(false);
        await expect(reg.load(manifest(), { activate: async () => { } })).rejects.toThrow(PluginError);
    });
    it("unload removes the plugin", async () => {
        const reg = new PluginRegistry();
        await reg.load(manifest(), { activate: async () => { } });
        reg.unload("p1");
        expect(reg.get("p1")).toBeUndefined();
        expect(reg.stats().total).toBe(0);
    });
});
//# sourceMappingURL=plugin-registry.test.js.map