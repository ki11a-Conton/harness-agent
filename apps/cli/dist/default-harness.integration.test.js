import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultDeps } from "./main.js";
let tempDirs = [];
async function tempDir() {
    const dir = await mkdtemp(join(tmpdir(), "cli-harness-"));
    tempDirs.push(dir);
    return dir;
}
afterEach(async () => {
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
    tempDirs = [];
});
/** Minimal fake provider (mirrors packages/harness/src/create-harness.test.ts). */
function fakeProvider() {
    return {
        id: "fake",
        listModels: async () => [
            { id: "test-model", name: "Test Model", capabilities: { contextWindowTokens: 128_000 } },
        ],
        createClient: () => {
            throw new Error("fake provider never streams — assertions target the default host wiring");
        },
    };
}
const ADVANCED_TOOLS = [
    "grep_search",
    "repo_tree",
    "symbol_search",
    "repo_map",
    "discover_commands",
    "env_snapshot",
];
const PRODUCTION_TOOL_ORDER = [
    "read_file",
    "write_file",
    "edit_file",
    "search_files",
    "grep_search",
    "repo_tree",
    "symbol_search",
    "repo_map",
    "discover_commands",
    "env_snapshot",
    "exec",
    "update_plan",
];
describe("P0-3: createDefaultDeps via the @ar/harness composition root", () => {
    it("wires the interactive profile: 11 tools, context pipeline, skills, artifacts", async () => {
        const deps = await createDefaultDeps({ provider: fakeProvider() });
        const info = deps.introspection;
        expect(info.profile).toBe("interactive");
        expect(info.registeredTools).toHaveLength(12);
        for (const name of ADVANCED_TOOLS) {
            expect(info.registeredTools).toContain(name);
        }
        expect(info.features.context).toBe(true);
        expect(info.features.skills).toBe(true);
        expect(info.features.artifacts).toBe(true);
        expect(info.stores.artifacts).toBe("InMemoryArtifactStore");
        expect(info.features.memory).toBe(false);
        expect(info.features.delegation).toBe(false);
    });
    it("without a dataDir uses in-memory stores and no checkpoint", async () => {
        const deps = await createDefaultDeps({ provider: fakeProvider() });
        const info = deps.introspection;
        expect(info.features.checkpoint).toBe(false);
        expect(info.stores.checkpoint).toBeUndefined();
        expect(info.stores.session).toBe("MemSessionStore");
        expect(info.stores.events).toBe("MemEventStore");
        expect(info.stores.approval).toBe("InMemoryApprovalStore");
    });
    it("with a dataDir wires JSONL + durable checkpoint and approval stores", async () => {
        const dataDir = await tempDir();
        const deps = await createDefaultDeps({ provider: fakeProvider(), dataDir });
        const info = deps.introspection;
        expect(info.features.checkpoint).toBe(true);
        expect(info.stores.checkpoint).toBe("DurableCheckpointStore");
        expect(info.stores.session).toBe("JSONLSessionStore");
        expect(info.stores.events).toBe("JSONLEventStore");
        expect(info.stores.approval).toBe("DurableApprovalStore");
    });
    it("exposes the harness runtime surface: agents and tools over the RPC", async () => {
        const deps = await createDefaultDeps({ provider: fakeProvider() });
        expect(deps.runtime).toBeDefined();
        expect(deps.sessionService).toBeDefined();
        expect(deps.store).toBeDefined();
        expect(deps.events).toBeDefined();
        expect(deps.approvalStore).toBeDefined();
        const agents = (await deps.rpc.request("agent.list"));
        expect(agents.map((a) => a.name)).toEqual(["main"]);
        const tools = (await deps.rpc.request("tool.list"));
        expect(tools.map((t) => t.name)).toEqual(PRODUCTION_TOOL_ORDER);
    });
});
//# sourceMappingURL=default-harness.integration.test.js.map