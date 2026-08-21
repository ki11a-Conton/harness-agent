// P3-5: physical parent merge — workspace patch applied under conflict
// detection and reconciled with the metadata merge.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newSessionId, newWorkingState } from "@ar/contracts";
import { applyChildResult } from "./child-merge.js";
import { DefaultChildWorkspaceManager } from "./workspace-manager.js";
let tempDirs = [];
async function tempDir() {
    const dir = await mkdtemp(join(tmpdir(), "ar-merge-"));
    tempDirs.push(dir);
    return dir;
}
afterEach(async () => {
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
    tempDirs = [];
});
function delegationResult(overrides = {}) {
    return {
        status: "success",
        summary: "child done",
        childSessionId: newSessionId(),
        toolCalls: 2,
        durationMs: 10,
        evidence: [],
        artifacts: [],
        answer: "done",
        findings: [],
        changedArtifacts: [],
        testsRun: [],
        openQuestions: [],
        blockers: [],
        suggestedNextActions: [],
        budgetUsed: { toolCalls: 2, durationMs: 10 },
        verified: false,
        ...overrides,
    };
}
describe("P3-5: applyChildResult (physical + metadata merge)", () => {
    it("applies the child's workspace patch and records it on the parent state", async () => {
        const parentRoot = await tempDir();
        await writeFile(join(parentRoot, "keep.ts"), "keep\n");
        const manager = new DefaultChildWorkspaceManager();
        const handle = await manager.create({ parentRoot, childSessionId: newSessionId(), writable: true });
        let patch;
        try {
            await writeFile(join(handle.root, "added.ts"), "brand new\n");
            patch = await handle.diff();
        }
        finally {
            await handle.dispose();
        }
        const parent = newWorkingState("parent goal");
        const result = delegationResult({ workspacePatch: patch });
        const merged = await applyChildResult(parentRoot, parent, result, manager);
        // Physical: the file landed in the parent workspace.
        expect(merged.physical.applied).toEqual(["added.ts"]);
        expect(await readFile(join(parentRoot, "added.ts"), "utf8")).toBe("brand new\n");
        // Metadata reconciled: the applied path is on the working state.
        expect(parent.filesChanged).toContain("added.ts");
        expect(parent.artifactRefs).toContain("added.ts");
        expect(merged.metadata.mergedPaths).toContain("added.ts");
    });
    it("surfaces a parent-side conflict and never overwrites the parent version", async () => {
        const parentRoot = await tempDir();
        await writeFile(join(parentRoot, "change.ts"), "old\n");
        const manager = new DefaultChildWorkspaceManager();
        const handle = await manager.create({ parentRoot, childSessionId: newSessionId(), writable: true });
        let patch;
        try {
            await writeFile(join(handle.root, "change.ts"), "child version\n");
            patch = await handle.diff();
        }
        finally {
            await handle.dispose();
        }
        // Parent modifies the same path while the child ran.
        await writeFile(join(parentRoot, "change.ts"), "parent version\n");
        const parent = newWorkingState("parent goal");
        const result = delegationResult({ workspacePatch: patch });
        const merged = await applyChildResult(parentRoot, parent, result, manager);
        expect(merged.physical.conflicts.map((c) => c.path)).toEqual(["change.ts"]);
        expect(merged.metadata.conflicts.some((c) => c.path === "change.ts")).toBe(true);
        // The parent version survives; the child path is NOT claimed as merged.
        expect(await readFile(join(parentRoot, "change.ts"), "utf8")).toBe("parent version\n");
        expect(merged.metadata.mergedPaths).not.toContain("change.ts");
        expect(parent.filesChanged).not.toContain("change.ts");
    });
    it("a read-only child (no patch) is a metadata-only merge", async () => {
        const parentRoot = await tempDir();
        const manager = new DefaultChildWorkspaceManager();
        const parent = newWorkingState("parent goal");
        const result = delegationResult({
            findings: [{ claim: "the API is stable", evidenceRefs: ["ev-1"], confidence: "high" }],
        });
        const merged = await applyChildResult(parentRoot, parent, result, manager);
        expect(merged.physical.applied).toEqual([]);
        expect(parent.decisions.some((d) => d.includes("the API is stable"))).toBe(true);
        expect(merged.metadata.adoptedFindings).toHaveLength(1);
    });
});
//# sourceMappingURL=child-merge.test.js.map