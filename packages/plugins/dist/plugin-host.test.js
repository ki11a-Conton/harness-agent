import { describe, expect, it } from "vitest";
import { PluginHost } from "./plugin-host.js";
function ctx(overrides) {
    return {
        call: { name: "read", args: { path: "/tmp/x" } },
        sessionId: "s1",
        ...overrides,
    };
}
function result(content) {
    return { content };
}
function plugin(id, onTool) {
    return { id, onTool };
}
describe("PluginHost", () => {
    it("routes an unhandled call to the registered plugin and marks it handled", async () => {
        const host = new PluginHost();
        const calls = [];
        host.register(plugin("p1", async (c) => {
            calls.push(c.call.name);
            return result({ handledBy: "p1" });
        }));
        const response = await host.onTool(ctx());
        expect(response).toEqual({ handled: true, result: result({ handledBy: "p1" }) });
        expect(calls).toEqual(["read"]);
    });
    it("calls plugins in registration order", async () => {
        const host = new PluginHost();
        const calls = [];
        host.register(plugin("p1", async () => {
            calls.push("p1");
            return null;
        }));
        host.register(plugin("p2", async () => {
            calls.push("p2");
            return null;
        }));
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
        const calls = [];
        host.register(plugin("p1", async () => {
            calls.push("p1");
            return result({ handledBy: "p1" });
        }));
        host.register(plugin("p2", async () => {
            calls.push("p2");
            return result({ handledBy: "p2" });
        }));
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
        const calls = [];
        host.register(plugin("p1"));
        host.register(plugin("p2", async () => {
            calls.push("p2");
            return result({ handledBy: "p2" });
        }));
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
        const calls = [];
        host.register(plugin("p1", async () => {
            throw new Error("p1 exploded");
        }));
        host.register(plugin("p2", async () => {
            calls.push("p2");
            return result({ handledBy: "p2" });
        }));
        const response = await host.onTool(ctx());
        expect(response).toEqual({ handled: true, result: result({ handledBy: "p2" }) });
        expect(calls).toEqual(["p2"]);
    });
    it("leaves the call unhandled when the only plugin throws", async () => {
        const host = new PluginHost();
        host.register(plugin("p1", async () => {
            throw new Error("p1 exploded");
        }));
        expect(await host.onTool(ctx())).toEqual({ handled: false, result: null });
    });
    it("passes the call and sessionId through to the plugin", async () => {
        const host = new PluginHost();
        let seen;
        host.register(plugin("p1", async (c) => {
            seen = c;
            return result({ handledBy: "p1" });
        }));
        await host.onTool(ctx({ call: { name: "write", args: { text: "hi" } }, sessionId: "s9" }));
        expect(seen).toEqual({
            call: { name: "write", args: { text: "hi" } },
            sessionId: "s9",
        });
    });
});
//# sourceMappingURL=plugin-host.test.js.map