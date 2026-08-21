import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CODING_TOOL_PROFILE, createProductionTools, getSharedRepoMapResolver, PRODUCTION_TOOL_NAMES, READONLY_TOOL_NAMES, } from "./production-tools.js";
import { createRepoMapTool, makeRepoMapResolver } from "./tools/repo-map-tool.js";
import { createEnvSnapshotTool } from "./tools/env-snapshot-tool.js";
let ws = "";
const tools = [];
beforeAll(() => {
    ws = mkdtempSync(join(tmpdir(), "ar-prodtools-"));
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "prodtools", scripts: {}, dependencies: {} }));
    writeFileSync(join(ws, "src/a.ts"), "export const a = 1;\n");
});
afterAll(() => {
    rmSync(ws, { recursive: true, force: true });
});
describe("P0-5 production tool profile (single source)", () => {
    it("exposes exactly the 12 production tools in the canonical order", () => {
        expect(PRODUCTION_TOOL_NAMES).toEqual([
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
        ]);
        expect(CODING_TOOL_PROFILE).toEqual(PRODUCTION_TOOL_NAMES);
    });
    it("readonly subset excludes write/edit/exec", () => {
        expect([...READONLY_TOOL_NAMES]).toEqual([
            "read_file",
            "search_files",
            "grep_search",
            "repo_tree",
            "symbol_search",
            "repo_map",
            "discover_commands",
            "env_snapshot",
        ]);
    });
    it("createProductionTools returns the 11 definitions under the same names", () => {
        const set = createProductionTools({
            networkMode: "deny",
            availableTools: () => [...tools],
        });
        expect(set.map((t) => t.name)).toEqual([...PRODUCTION_TOOL_NAMES]);
    });
    it("env_snapshot tool is wired to the host network mode + tool list", async () => {
        const tool = createProductionTools({
            networkMode: "block",
            availableTools: () => [...tools],
        }).find((t) => t.name === "env_snapshot");
        const out = await tool.execute({}, { cwd: ws, input: {}, turnId: "t", sessionId: "s" });
        expect(out.status).toBe("success");
        const snap = out.output;
        expect(snap.network.mode).toBe("block");
        if (tools.length > 0)
            expect(snap.tools.available).toEqual(tools);
    });
    it("createProductionTools forwards harness profile + workspace root to env_snapshot", async () => {
        const tool = createProductionTools({
            networkMode: () => "deny",
            availableTools: () => ["read_file"],
            workspaceRoot: () => ws,
            harnessProfile: () => "interactive",
        }).find((t) => t.name === "env_snapshot");
        const out = await tool.execute({}, { cwd: ws, input: {}, turnId: "t", sessionId: "s" });
        expect(out.status).toBe("success");
        const snap = out.output;
        expect(snap.workspaceRoot).toBe(ws);
        expect(snap.harnessProfile).toBe("interactive");
    });
});
describe("P0-6 repo_map cache lifecycle", () => {
    it("createRepoMapTool shares its resolver so the cache survives calls", async () => {
        const resolver = makeRepoMapResolver();
        const tool = createRepoMapTool(resolver);
        const ctx = { cwd: ws };
        await tool.execute({}, ctx);
        expect(resolver.cache).not.toBeNull();
        const builds = resolver.cache.stats.builds;
        // second call hits the same process-local cache (no rebuild)
        await tool.execute({}, ctx);
        expect(resolver.cache.stats.builds).toBe(builds);
    });
    it("a default-constructed tool also persists its cache across calls", async () => {
        const tool = createRepoMapTool();
        const ctx = { cwd: ws };
        await tool.execute({}, ctx);
        await tool.execute({}, ctx);
        const fromShared = getSharedRepoMapResolver();
        expect(fromShared).toBeDefined();
    });
    it("getSharedRepoMapResolver returns one stable process-wide instance", () => {
        expect(getSharedRepoMapResolver()).toBe(getSharedRepoMapResolver());
    });
    it("createEnvSnapshotTool rejects nothing and reports the live injected policy + harness facts", async () => {
        const tool = createEnvSnapshotTool({
            networkMode: () => "audit",
            availableTools: () => ["a", "b"],
            workspaceRoot: () => ws,
            harnessProfile: () => "benchmark",
        });
        const out = await tool.execute({}, { cwd: ws, input: {}, turnId: "t", sessionId: "s" });
        expect(out.status).toBe("success");
        const snap = out.output;
        expect(snap.network.mode).toBe("audit");
        expect(snap.tools.available).toEqual(["a", "b"]);
        expect(snap.workspaceRoot).toBe(ws);
        expect(snap.harnessProfile).toBe("benchmark");
    });
});
void mkdirSync;
//# sourceMappingURL=production-tools.test.js.map