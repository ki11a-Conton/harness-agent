import { describe, expect, it } from "vitest";
import { DeterministicToolSelector, NoopToolSelector } from "./tool-selector.js";
function spec(name) {
    return { name, description: `tool ${name}`, inputSchema: { type: "object" } };
}
const ALL = [
    spec("read_file"),
    spec("write_file"),
    spec("edit_file"),
    spec("exec"),
    spec("search_files"),
    spec("repo_map"),
    spec("delegate_explore"),
    spec("mcp_remote"),
    spec("weather_lookup"),
];
describe("P7-1/P7-2: DeterministicToolSelector (progressive disclosure)", () => {
    it("always keeps the core tools and drops peripheral schemas", () => {
        const selector = new DeterministicToolSelector();
        const { selected, dropped } = selector.select({ goal: "fix the parser", tools: ALL });
        const names = selected.map((t) => t.name);
        // Core set survives every goal.
        expect(names).toEqual(expect.arrayContaining(["read_file", "write_file", "edit_file", "exec", "repo_map", "delegate_explore"]));
        // Peripheral tools not relevant to "fix the parser" are dropped.
        expect(dropped).toEqual(expect.arrayContaining(["mcp_remote", "weather_lookup"]));
        expect(names).not.toContain("mcp_remote");
        expect(names).not.toContain("weather_lookup");
    });
    it("adds extra tools when the goal keyword matches a category", () => {
        const selector = new DeterministicToolSelector([
            { keywords: ["test", "verify"], tools: ["mcp_remote"] },
        ]);
        const { selected } = selector.select({ goal: "write a unit test for the module", tools: ALL });
        expect(selected.map((t) => t.name)).toContain("mcp_remote");
    });
    it("never drops a tool that is not in the registry (missing specs are harmless)", () => {
        const selector = new DeterministicToolSelector();
        const { selected } = selector.select({ goal: "anything", tools: [spec("custom_tool")] });
        // custom_tool is not core and not category-matched → dropped.
        expect(selected).toHaveLength(0);
    });
    it("NoopToolSelector is the identity (pre-P7 behavior)", () => {
        const selector = new NoopToolSelector();
        const { selected, dropped } = selector.select({ goal: "g", tools: ALL });
        expect(selected).toHaveLength(ALL.length);
        expect(dropped).toHaveLength(0);
    });
});
//# sourceMappingURL=tool-selector.test.js.map