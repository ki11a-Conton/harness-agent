import { describe, expect, it } from "vitest";
import { DefaultCompactor, isCompactable } from "./compaction.js";
let seq = 0;
function block(over = {}) {
    seq += 1;
    return {
        id: `b${seq}`,
        source: "tool",
        trust: "untrusted",
        priority: 500,
        tokens: 100,
        content: `content-${seq}`,
        compressible: true,
        ephemeral: false,
        ...over,
    };
}
function summary(over = {}) {
    return {
        goal: "Build the harness",
        constraints: ["no network access", "windows host"],
        decisions: ["use sqlite"],
        completed: ["wired discovery"],
        filesChanged: ["packages/context/src/compaction.ts"],
        commandsRun: ["pnpm typecheck"],
        tests: ["pnpm test"],
        failures: ["integration flake"],
        openTasks: ["wire discovery"],
        importantFacts: ["token ratio is 4 chars/token"],
        artifactRefs: ["dist/harness.exe"],
        childAgentRefs: ["child-1"],
        ...over,
    };
}
/** Compare blocks ignoring the intentionally non-deterministic `timestamp` of
 *  the generated summary block (Date.now() per CTX-003 spec). */
function sameExceptTimestamp(a, b) {
    const strip = (blocks) => blocks.map((blk) => ({ ...blk, timestamp: undefined }));
    return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}
describe("DefaultCompactor (CTX-003)", () => {
    it("folds all compactable blocks (tool/web/memory/subagent) into one summary block", () => {
        const input = [
            block({ id: "tool-1", source: "tool", trust: "untrusted" }),
            block({ id: "web-1", source: "web", trust: "semi-trusted" }),
            block({ id: "mem-1", source: "memory", trust: "trusted" }),
            block({ id: "sub-1", source: "subagent", trust: "untrusted" }),
        ];
        const result = new DefaultCompactor().compact(input, summary());
        expect(result).toHaveLength(1);
        const s = result[0];
        expect(s.id).toBe("compaction-summary");
        expect(s.source).toBe("memory");
        expect(s.trust).toBe("semi-trusted");
        expect(s.compressible).toBe(false);
        expect(s.ephemeral).toBe(false);
        expect(s.priority).toBeGreaterThan(500);
        expect(s.tokens).toBe(Math.ceil(s.content.length / 4));
        expect(s.content).toContain("# Compaction Summary");
    });
    it("preserves never-compact blocks byte-for-byte in original order", () => {
        const system = block({ id: "sys-1", source: "system", trust: "trusted", content: "security policy: keep exactly" });
        const user = block({ id: "usr-1", source: "user", trust: "trusted", content: "user instruction verbatim" });
        const project = block({ id: "prj-1", source: "project", trust: "trusted", content: "project spec verbatim" });
        const trustedLocal = block({ id: "loc-1", source: "local", trust: "trusted", content: "trusted local doc" });
        const trustedSkill = block({ id: "skl-1", source: "skill", trust: "trusted", content: "trusted skill doc" });
        const trustedMcp = block({ id: "mcp-1", source: "mcp", trust: "trusted", content: "trusted mcp doc" });
        const notCompressible = block({ id: "tool-nc", source: "tool", trust: "untrusted", compressible: false, content: "opted out" });
        const input = [user, system, project, trustedLocal, trustedSkill, trustedMcp, notCompressible];
        const result = new DefaultCompactor().compact(input, summary());
        expect(result).toHaveLength(input.length);
        expect(result.map((b) => b.content)).toEqual(input.map((b) => b.content));
        expect(result.map((b) => b.id)).toEqual(input.map((b) => b.id));
        expect(result).not.toContainEqual(expect.objectContaining({ id: "compaction-summary" }));
    });
    it("never-compact matrix: only compressible tool/web/memory/subagent fold", () => {
        const cases = [
            [{ source: "system", trust: "trusted", compressible: true }, false],
            [{ source: "user", trust: "trusted", compressible: true }, false],
            [{ source: "project", trust: "trusted", compressible: true }, false],
            [{ source: "local", trust: "trusted", compressible: true }, false],
            [{ source: "skill", trust: "trusted", compressible: true }, false],
            [{ source: "mcp", trust: "trusted", compressible: true }, false],
            [{ source: "tool", trust: "trusted", compressible: true }, true],
            [{ source: "web", trust: "untrusted", compressible: true }, true],
            [{ source: "memory", trust: "semi-trusted", compressible: true }, true],
            [{ source: "subagent", trust: "trusted", compressible: true }, true],
            [{ source: "tool", trust: "untrusted", compressible: false }, false],
        ];
        for (const [over, expected] of cases) {
            expect(isCompactable(block(over))).toBe(expected);
        }
    });
    it("renders only non-empty summary fields; empty arrays are omitted", () => {
        const s = summary({ constraints: [], tests: [], failures: [], artifactRefs: [], childAgentRefs: [] });
        const result = new DefaultCompactor().compact([block()], s);
        const content = result[0].content;
        expect(content).toContain("## Goal");
        expect(content).toContain("Build the harness");
        expect(content).toContain("## Decisions\n- use sqlite");
        expect(content).toContain("## Completed Work\n- wired discovery");
        expect(content).toContain("## Files Changed\n- packages/context/src/compaction.ts");
        expect(content).toContain("## Commands Run\n- pnpm typecheck");
        expect(content).toContain("## Open Tasks\n- wire discovery");
        expect(content).toContain("## Important Facts\n- token ratio is 4 chars/token");
        expect(content).not.toContain("## Constraints");
        expect(content).not.toContain("## Tests");
        expect(content).not.toContain("## Failures");
        expect(content).not.toContain("## Artifacts");
        expect(content).not.toContain("## Child Agents");
    });
    it("renders completed work, artifacts and child-agent refs when present (P1-2 must-survive fields)", () => {
        const s = summary({
            constraints: ["no network access"],
            completed: ["wired discovery", "ran integration tests"],
            artifactRefs: ["dist/harness.exe"],
            childAgentRefs: ["child-1", "child-2"],
        });
        const result = new DefaultCompactor().compact([block()], s);
        const content = result[0].content;
        expect(content).toContain("## Completed Work\n- wired discovery\n- ran integration tests");
        expect(content).toContain("## Artifacts\n- dist/harness.exe");
        expect(content).toContain("## Child Agents\n- child-1\n- child-2");
    });
    it("empty summary still yields a summary block with the header", () => {
        const empty = {
            goal: "",
            constraints: [],
            decisions: [],
            completed: [],
            filesChanged: [],
            commandsRun: [],
            tests: [],
            failures: [],
            openTasks: [],
            importantFacts: [],
            artifactRefs: [],
            childAgentRefs: [],
        };
        const result = new DefaultCompactor().compact([block()], empty);
        expect(result).toHaveLength(1);
        expect(result[0].content).toBe("# Compaction Summary");
    });
    it("returns the original array unchanged when nothing is compactable", () => {
        const input = [
            block({ id: "sys", source: "system", trust: "trusted" }),
            block({ id: "prj", source: "project", trust: "trusted" }),
            block({ id: "nc", source: "tool", compressible: false }),
        ];
        const result = new DefaultCompactor().compact(input, summary());
        expect(result).toBe(input);
        expect(result).toHaveLength(3);
    });
    it("places the summary block after the last preserved block", () => {
        const preserved1 = block({ id: "sys", source: "system", trust: "trusted" });
        const folded = block({ id: "tool-1", source: "tool" });
        const preserved2 = block({ id: "usr", source: "user", trust: "trusted" });
        const result = new DefaultCompactor().compact([preserved1, folded, preserved2], summary());
        expect(result.map((b) => b.id)).toEqual(["sys", "usr", "compaction-summary"]);
    });
    it("100k+ token session: folds 30x4000-token blocks, keeps the 5 anchors to continue", () => {
        const input = [];
        for (let i = 0; i < 30; i += 1) {
            input.push(block({
                id: `tool-${i}`,
                source: i % 2 === 0 ? "tool" : "web",
                tokens: 4000,
                content: `transient tool output ${i} `.repeat(400),
            }));
        }
        const anchors = [
            block({ id: "sys", source: "system", trust: "trusted", content: "GOAL: continue the task until all acceptance criteria pass" }),
            block({ id: "usr", source: "user", trust: "trusted", content: "CONSTRAINTS: no network; windows host; never bypass ToolOrchestrator" }),
            block({ id: "prj", source: "project", trust: "trusted", content: "DECISIONS: compaction summary is a single memory block" }),
            block({ id: "loc", source: "local", trust: "trusted", content: "FAILURES: integration test flake on event ordering" }),
            block({ id: "tool-nc", source: "tool", compressible: false, content: "PENDING: approval for publishing the package" }),
        ];
        const input2 = [...anchors, ...input];
        expect(input2.reduce((sum, b) => sum + b.tokens, 0)).toBeGreaterThanOrEqual(100_000);
        const s = summary({
            goal: "GOAL: continue the task until all acceptance criteria pass",
            constraints: ["CONSTRAINTS: no network; windows host; never bypass ToolOrchestrator"],
            decisions: ["DECISIONS: compaction summary is a single memory block"],
            failures: ["FAILURES: integration test flake on event ordering"],
            openTasks: ["PENDING: approval for publishing the package"],
        });
        const result = new DefaultCompactor().compact(input2, s);
        expect(result.length).toBeLessThanOrEqual(anchors.length + 1);
        expect(result.map((b) => b.id)).toEqual([...anchors.map((b) => b.id), "compaction-summary"]);
        for (const anchor of anchors) {
            expect(result).toContainEqual(anchor);
        }
        const content = result[result.length - 1].content;
        expect(content).toContain("GOAL: continue the task until all acceptance criteria pass");
        expect(content).toContain("CONSTRAINTS: no network; windows host; never bypass ToolOrchestrator");
        expect(content).toContain("DECISIONS: compaction summary is a single memory block");
        expect(content).toContain("FAILURES: integration test flake on event ordering");
        expect(content).toContain("PENDING: approval for publishing the package");
    });
    it("is deterministic for identical input (except Date.now() timestamp per spec)", () => {
        const input = [
            block({ id: "sys", source: "system", trust: "trusted" }),
            block({ id: "t1", source: "tool" }),
            block({ id: "t2", source: "web", trust: "semi-trusted" }),
            block({ id: "usr", source: "user", trust: "trusted" }),
            block({ id: "t3", source: "memory" }),
        ];
        const s = summary();
        const compactor = new DefaultCompactor();
        const r1 = compactor.compact(input, s);
        const r2 = compactor.compact(input, s);
        expect(sameExceptTimestamp(r1, r2)).toBe(true);
        expect(r1[r1.length - 1].content).toBe(r2[r2.length - 1].content);
        for (let i = 0; i < r1.length - 1; i += 1) {
            expect(r1[i]).toEqual(r2[i]);
        }
    });
});
//# sourceMappingURL=compaction.test.js.map